/**
 * PodcastRenderer — turns an approved script into a single-channel MP4.
 *
 *   chunk (per beat, +context) → text-to-dialogue(+timestamps) [cached] →
 *   decode + per-chunk loudness → recut each line by voice_segments (guard-banded)
 *   + edge/intra silence trim + gain → absolute timeline (gaps + ducked overlaps)
 *   → amix(normalize=0) + room tone + limiter → two-pass loudnorm → mp4 + mp3.
 *
 * Chunk audio is cached by the exact request-payload hash, so re-exporting after a
 * small edit re-synthesizes only the beats that changed.
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_chunk_audio, podcast_renders, podcast_episodes, podcast_shows, podcast_scripts } from '../../../db/schema.js';
import type { PodcastShow, PodcastEpisode } from '../../../db/schema.js';
import { getStorageAdapter } from '../../storage/getStorageAdapter.js';
import { PodcastVoiceService } from '../PodcastVoiceService.js';
import { ElevenLabsDialogue, type VoiceSegment } from './ElevenLabsDialogue.js';
import { planChunks, type Chunk, type BackchannelJob } from './chunker.js';
import { buildTimeline, type TimelineTurn } from './timeline.js';
import {
  decodeToWav, measureLufs, gainToTarget, extractClip, mixClips, applyTempo,
  loudnormTwoPass, encodeMp4, encodeMp3, probeDurationMs, type TimelineClip,
} from './ffmpegAudio.js';
import type { PodcastScriptBody, PodcastTurn } from 'shared';
import { logger } from '../../../lib/logger.js';
import { computeClipBounds, segmentsAligned, HEAD_GUARD_SEC, TAIL_GUARD_SEC } from './clipBounds.js';

const OUTPUT_FORMAT = process.env.PODCAST_TTS_FORMAT ?? 'mp3_44100_128';
const STABILITY = 0.5;
const SYNTH_CONCURRENCY = 3;

type RenderStage = 'synthesizing' | 'stitching' | 'encoding' | 'ready';

async function runLimited<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export class PodcastRenderer {
  private el = new ElevenLabsDialogue();
  private voices = new PodcastVoiceService();
  private storage = getStorageAdapter();

  async render(renderId: string, episodeId: string): Promise<void> {
    const episode = await db.query.podcast_episodes.findFirst({ where: eq(podcast_episodes.id, episodeId) });
    if (!episode) throw new Error('Episode not found');
    const show = await db.query.podcast_shows.findFirst({ where: eq(podcast_shows.id, episode.show_id) });
    if (!show) throw new Error('Show not found');

    // Render the EXACT version this render was created for (the approved one at
    // enqueue time) — never "latest", which could be an unapproved mid-edit fork.
    const render = await db.query.podcast_renders.findFirst({ where: eq(podcast_renders.id, renderId) });
    const script = render?.script_version != null
      ? await db.query.podcast_scripts.findFirst({
          where: and(eq(podcast_scripts.episode_id, episodeId), eq(podcast_scripts.version, render.script_version)),
        })
      : await db.query.podcast_scripts.findFirst({
          where: eq(podcast_scripts.episode_id, episodeId),
          orderBy: (s, { desc }) => [desc(s.version)],
        });
    const body = script?.body_json as PodcastScriptBody | undefined;
    if (!body || !body.turns.length) throw new Error('No script to render');
    const language = episode.language ?? show.language ?? 'en';

    const workDir = await mkdtemp(join(tmpdir(), 'podcast-render-'));
    try {
      const { clipPath, clipDurMs } = await this.synthesizeAndRecut(episodeId, episode, show, body, language, workDir, {
        onProgress: (d, total) => this.setProgress(renderId, 'synthesizing', d, total),
      });

      // ── Timeline ──────────────────────────────────────────────────────────────
      await this.setProgress(renderId, 'stitching', 0, 1);
      const tTurns: TimelineTurn[] = body.turns
        .filter((t) => clipPath.has(t.id))
        .map((t) => ({
          turnId: t.id, speaker: t.speaker, overlap: t.overlap,
          durationMs: clipDurMs.get(t.id) ?? 0, pauseAfterMs: t.pause_after_ms ?? undefined,
          beat: t.beat, text: t.text,
        }));
      if (tTurns.length === 0) throw new Error('No audible turns were produced');
      const { placements, totalMs } = buildTimeline(tTurns);

      const clips: TimelineClip[] = placements.map((p) => ({ path: clipPath.get(p.turnId)!, delayMs: p.delayMs, gainDb: p.gainDb }));

      // ── Mix → tempo → loudnorm → encode ───────────────────────────────────────
      const mixWav = join(workDir, 'mix.wav');
      await mixClips(clips, totalMs, mixWav, workDir, true);
      const tempoWav = join(workDir, 'tempo.wav');
      await applyTempo(mixWav, tempoWav);
      const finalWav = join(workDir, 'final.wav');
      await loudnormTwoPass(tempoWav, finalWav);

      await this.setProgress(renderId, 'encoding', 0, 1);
      const mp4Path = join(workDir, 'master.mp4');
      const mp3Path = join(workDir, 'master.mp3');
      await encodeMp4(finalWav, mp4Path);
      await encodeMp3(finalWav, mp3Path);
      const durationMs = await probeDurationMs(mp4Path);

      // ── Publish ───────────────────────────────────────────────────────────────
      const { readFile } = await import('fs/promises');
      const mp4Key = `podcasts/${episodeId}/renders/${renderId}/master.mp4`;
      const mp3Key = `podcasts/${episodeId}/renders/${renderId}/master.mp3`;
      await this.storage.uploadFile(mp4Key, await readFile(mp4Path), 'video/mp4', 'public, max-age=31536000, immutable');
      await this.storage.uploadFile(mp3Key, await readFile(mp3Path), 'audio/mpeg', 'public, max-age=31536000, immutable');

      await db.update(podcast_renders).set({
        status: 'ready',
        master_mp4_key: mp4Key,
        master_mp3_key: mp3Key,
        duration_ms: durationMs,
        script_hash: script?.content_hash ?? null,
        timeline_json: { placements, totalMs },
        progress: { stage: 'ready' as RenderStage, chunksDone: clipPath.size, chunksTotal: clipPath.size },
        claimed_at: null,
        updated_at: new Date(),
      }).where(eq(podcast_renders.id, renderId));

      await db.update(podcast_episodes).set({ status: 'ready', updated_at: new Date() }).where(eq(podcast_episodes.id, episodeId));
      logger.info({ renderId, durationMs, turns: tTurns.length }, 'podcast render complete');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Synthesize + recut every turn to its own clean WAV clip (NOT tempo-baked).
   * Shared by the one-click renderer (which bakes tempo over the whole mix) and the
   * Audio Studio clips job (which bakes tempo per clip). Behavior for the renderer
   * is byte-for-byte unchanged — this is a pure extraction of its synth loop.
   *
   * Returns per-turn maps: turnId → clip path, turnId → clip duration (ms).
   */
  async synthesizeAndRecut(
    episodeId: string,
    episode: PodcastEpisode,
    show: PodcastShow,
    body: PodcastScriptBody,
    language: string,
    workDir: string,
    opts: { onProgress?: (done: number, total: number) => Promise<void> | void } = {},
  ): Promise<{ clipPath: Map<string, string>; clipDurMs: Map<string, number> }> {
    const { teacherVoice, learnerVoice } = await this.resolveVoices(show);
    const seed = await this.ensureSeed(episode);
    const voiceFor = (sp: 'teacher' | 'learner') => (sp === 'teacher' ? teacherVoice : learnerVoice);

    const { chunks, backchannels } = planChunks(body.turns, voiceFor, {
      seed, languageCode: language, outputFormat: OUTPUT_FORMAT, stability: STABILITY,
    });

    const total = chunks.length + backchannels.length;
    let done = 0;
    const bump = async () => { done++; await opts.onProgress?.(done, total); };
    await opts.onProgress?.(0, total);

    // Per-turn clip files, keyed by turnId.
    const clipPath = new Map<string, string>();
    const clipDurMs = new Map<string, number>();

    // Turns that end on a scripted cut-off dash get an extra tail shave at recut.
    const cutOffIds = new Set(body.turns.filter((t) => /[—–]\s*["']?\s*$/.test(t.text)).map((t) => t.id));

    await runLimited(chunks, SYNTH_CONCURRENCY, async (chunk, ci) => {
      const { audioBuf, segments } = await this.synthChunk(episodeId, chunk, seed);
      await this.recutChunk(workDir, ci, chunk, audioBuf, segments, clipPath, clipDurMs, cutOffIds);
      await bump();
    });

    await runLimited(backchannels, SYNTH_CONCURRENCY, async (bc, bi) => {
      // Backchannels are optional flavor — a failed one must NEVER fail the render.
      // It's simply omitted from the timeline (the conversation stands without it).
      try {
        const { audioBuf, segments } = await this.synthBackchannel(episodeId, bc, seed);
        await this.recutBackchannel(workDir, bi, bc, audioBuf, segments, clipPath, clipDurMs);
      } catch (err) {
        logger.warn({ err, turnId: bc.turnId }, 'backchannel synthesis failed — skipping this reaction');
      }
      await bump();
    });

    return { clipPath, clipDurMs };
  }

  // ── Synthesis + cache ─────────────────────────────────────────────────────

  private async synthChunk(episodeId: string, chunk: Chunk, seed: number): Promise<{ audioBuf: Buffer; segments: VoiceSegment[] }> {
    const cached = await db.query.podcast_chunk_audio.findFirst({
      where: and(eq(podcast_chunk_audio.episode_id, episodeId), eq(podcast_chunk_audio.chunk_hash, chunk.hash)),
    });
    if (cached?.storage_key && cached.segments_json) {
      const audioBuf = await this.storage.readObject(cached.storage_key);
      return { audioBuf, segments: cached.segments_json as VoiceSegment[] };
    }

    // Synthesize, retrying (seed+1) if segments don't COVER every real input OR are
    // MISALIGNED — v3 occasionally returns the right number of segments but positions
    // them wrong (one line's audio bleeds into another's slice), which shipped as the
    // "12s clip for an 8-word line → lanes overlap" corruption. Char-range alignment
    // catches that; a still-bad result is not cached so a rebuild self-heals.
    let result = await this.el.synthesize({ inputs: chunk.inputs, seed, outputFormat: OUTPUT_FORMAT, stability: STABILITY });
    let complete = this.segmentsCoverReal(result.voiceSegments, chunk) && this.segmentsAligned(result.voiceSegments, chunk);
    if (!complete) {
      logger.warn({ hash: chunk.hash }, 'chunk voice_segments incomplete or misaligned — retrying with seed+1');
      result = await this.el.synthesize({ inputs: chunk.inputs, seed: seed + 1, outputFormat: OUTPUT_FORMAT, stability: STABILITY });
      complete = this.segmentsCoverReal(result.voiceSegments, chunk) && this.segmentsAligned(result.voiceSegments, chunk);
    }

    // Only CACHE a complete result — otherwise a re-render must be free to retry, and
    // caching the poisoned audio would make the dropped line permanent. Use the audio
    // for this render regardless (missing lines are logged + skipped downstream).
    if (complete) {
      const ext = result.format === 'pcm' ? 'pcm' : 'mp3';
      const key = `podcasts/${episodeId}/chunks/${chunk.hash}.${ext}`;
      await this.storage.uploadFile(key, result.audio, result.format === 'pcm' ? 'application/octet-stream' : 'audio/mpeg', 'public, max-age=31536000, immutable');
      await db.insert(podcast_chunk_audio).values({
        episode_id: episodeId, chunk_hash: chunk.hash, storage_key: key,
        segments_json: result.voiceSegments, kind: 'chunk',
      }).onConflictDoNothing();
    } else {
      const present = new Set(result.voiceSegments.map((s) => s.dialogue_input_index));
      const dropped = chunk.turnIds.filter((_, k) => !present.has(chunk.contextCount + k));
      logger.warn({ hash: chunk.hash, dropped }, 'chunk still incomplete after retry — not caching; these lines will be missing from the audio');
    }
    return { audioBuf: result.audio, segments: result.voiceSegments };
  }

  private async synthBackchannel(episodeId: string, bc: BackchannelJob, seed: number): Promise<{ audioBuf: Buffer; segments: VoiceSegment[] }> {
    const cached = await db.query.podcast_chunk_audio.findFirst({
      where: and(eq(podcast_chunk_audio.episode_id, episodeId), eq(podcast_chunk_audio.chunk_hash, bc.hash)),
    });
    if (cached?.storage_key) {
      return { audioBuf: await this.storage.readObject(cached.storage_key), segments: (cached.segments_json as VoiceSegment[]) ?? [] };
    }

    // Backchannels carry a context input for prosody; the bc's own segment must be
    // present so we can cut the context away. Retry once with seed+1 if it's missing.
    let result = await this.el.synthesize({ inputs: bc.inputs, seed, outputFormat: OUTPUT_FORMAT, stability: STABILITY });
    const hasBcSegment = () => bc.contextCount === 0 || result.voiceSegments.some((s) => s.dialogue_input_index === bc.contextCount);
    if (!hasBcSegment()) {
      logger.warn({ hash: bc.hash }, 'backchannel segment missing — retrying with seed+1');
      result = await this.el.synthesize({ inputs: bc.inputs, seed: seed + 1, outputFormat: OUTPUT_FORMAT, stability: STABILITY });
    }
    if (!hasBcSegment()) {
      // Last resort: synthesize without context so the whole clip IS the backchannel.
      logger.warn({ hash: bc.hash }, 'backchannel still incomplete — synthesizing without context');
      result = await this.el.synthesize({ inputs: bc.inputs.slice(bc.contextCount), seed, outputFormat: OUTPUT_FORMAT, stability: STABILITY });
      const ext = result.format === 'pcm' ? 'pcm' : 'mp3';
      const key = `podcasts/${episodeId}/chunks/${bc.hash}.${ext}`;
      await this.storage.uploadFile(key, result.audio, result.format === 'pcm' ? 'application/octet-stream' : 'audio/mpeg', 'public, max-age=31536000, immutable');
      await db.insert(podcast_chunk_audio).values({
        episode_id: episodeId, chunk_hash: bc.hash, storage_key: key, segments_json: [], kind: 'backchannel',
      }).onConflictDoNothing();
      return { audioBuf: result.audio, segments: [] };
    }

    const ext = result.format === 'pcm' ? 'pcm' : 'mp3';
    const key = `podcasts/${episodeId}/chunks/${bc.hash}.${ext}`;
    await this.storage.uploadFile(key, result.audio, result.format === 'pcm' ? 'application/octet-stream' : 'audio/mpeg', 'public, max-age=31536000, immutable');
    await db.insert(podcast_chunk_audio).values({
      episode_id: episodeId, chunk_hash: bc.hash, storage_key: key,
      segments_json: result.voiceSegments, kind: 'backchannel',
    }).onConflictDoNothing();
    return { audioBuf: result.audio, segments: result.voiceSegments };
  }

  private segmentsCoverReal(segments: VoiceSegment[], chunk: Chunk): boolean {
    const byIndex = new Set(segments.map((s) => s.dialogue_input_index));
    for (let k = 0; k < chunk.turnIds.length; k++) {
      if (!byIndex.has(chunk.contextCount + k)) return false;
    }
    return true;
  }

  private segmentsAligned(segments: VoiceSegment[], chunk: Chunk): boolean {
    return segmentsAligned(segments, chunk.inputs.map((i) => i.text.length), chunk.contextCount, chunk.turnIds.length);
  }

  // ── Recut ──────────────────────────────────────────────────────────────────

  private async recutChunk(
    workDir: string, ci: number, chunk: Chunk, audioBuf: Buffer, segments: VoiceSegment[],
    clipPath: Map<string, string>, clipDurMs: Map<string, number>, cutOffIds: Set<string> = new Set(),
  ): Promise<void> {
    const isPcm = OUTPUT_FORMAT.startsWith('pcm_');
    const rawPath = join(workDir, `chunk${ci}.${isPcm ? 'pcm' : 'mp3'}`);
    await writeFile(rawPath, audioBuf);
    const chunkWav = join(workDir, `chunk${ci}.wav`);
    await decodeToWav(rawPath, chunkWav, isPcm ? { pcm: true, pcmRate: Number(OUTPUT_FORMAT.split('_')[1] ?? 44100) } : undefined);
    const chunkDur = (await probeDurationMs(chunkWav)) / 1000;
    const gain = gainToTarget(await measureLufs(chunkWav));

    // Sort real segments by input index for guard-band clamping against neighbors.
    const real = segments
      .filter((s) => s.dialogue_input_index >= chunk.contextCount)
      .sort((a, b) => a.dialogue_input_index - b.dialogue_input_index);

    // Exclusive, tail-generous boundary allocation (see clipBounds.ts for the
    // diagnosed "tail cut + replays at the next block's head" failure this kills).
    let prevChosenEnd = 0;
    for (let k = 0; k < chunk.turnIds.length; k++) {
      const seg = real.find((s) => s.dialogue_input_index === chunk.contextCount + k);
      if (!seg) continue;
      const prevSegEnd = real.find((s) => s.dialogue_input_index === chunk.contextCount + k - 1)?.end_time_seconds ?? 0;
      const nextSegStart = real.find((s) => s.dialogue_input_index === chunk.contextCount + k + 1)?.start_time_seconds ?? chunkDur;
      const turnId = chunk.turnIds[k];
      const { start, end } = computeClipBounds({
        segStart: seg.start_time_seconds, segEnd: seg.end_time_seconds,
        prevSegEnd, nextSegStart, prevChosenEnd, chunkDur,
        isCutOff: cutOffIds.has(turnId),
      });
      prevChosenEnd = end;
      // Index-based filename (never the turn id) so no id value can influence the path.
      const out = join(workDir, `clip_c${ci}_${k}.wav`);
      await extractClip(chunkWav, out, start, end, gain);
      clipPath.set(turnId, out);
      clipDurMs.set(turnId, await probeDurationMs(out));
    }
  }

  private async recutBackchannel(
    workDir: string, bi: number, bc: BackchannelJob, audioBuf: Buffer, segments: VoiceSegment[],
    clipPath: Map<string, string>, clipDurMs: Map<string, number>,
  ): Promise<void> {
    const isPcm = OUTPUT_FORMAT.startsWith('pcm_');
    const rawPath = join(workDir, `bc${bi}.${isPcm ? 'pcm' : 'mp3'}`);
    await writeFile(rawPath, audioBuf);
    const wav = join(workDir, `bc${bi}.wav`);
    await decodeToWav(rawPath, wav, isPcm ? { pcm: true, pcmRate: Number(OUTPUT_FORMAT.split('_')[1] ?? 44100) } : undefined);
    const dur = (await probeDurationMs(wav)) / 1000;
    const gain = gainToTarget(await measureLufs(wav));
    // If the clip was synthesized with a prosody-context input, keep only the
    // backchannel's own segment. CRITICAL: clamp the guard band at the midpoint
    // between the context segment's end and the backchannel's start — otherwise a
    // sliver of the context voice leaks into the clip and plays as a glitch when
    // the murmur is overlaid on the timeline.
    const seg = bc.contextCount > 0 ? segments.find((s) => s.dialogue_input_index === bc.contextCount) : undefined;
    const ctxEnd = seg
      ? segments
          .filter((s) => s.dialogue_input_index < bc.contextCount)
          .reduce((m, s) => Math.max(m, s.end_time_seconds), 0)
      : 0;
    const start = seg ? Math.max((ctxEnd + seg.start_time_seconds) / 2, seg.start_time_seconds - HEAD_GUARD_SEC, 0) : 0;
    const end = seg ? Math.min(dur, seg.end_time_seconds + TAIL_GUARD_SEC) : dur;
    const out = join(workDir, `clip_bc${bi}.wav`);
    await extractClip(wav, out, start, end, gain);
    clipPath.set(bc.turnId, out);
    clipDurMs.set(bc.turnId, await probeDurationMs(out));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async resolveVoices(show: PodcastShow): Promise<{ teacherVoice: string; learnerVoice: string }> {
    let teacher = show.teacher_voice_id;
    let learner = show.learner_voice_id;
    if (!teacher || !learner) {
      const resolved = await this.voices.resolveDefaultVoices(show.teacher_name, show.learner_name);
      teacher = teacher ?? resolved.teacher_voice_id;
      learner = learner ?? resolved.learner_voice_id;
      if (teacher && learner) {
        await db.update(podcast_shows).set({ teacher_voice_id: teacher, learner_voice_id: learner, updated_at: new Date() }).where(eq(podcast_shows.id, show.id));
      }
    }
    if (!teacher || !learner) {
      throw new Error('No ElevenLabs voices resolved for this show — set them in show settings or configure an ElevenLabs key.');
    }
    return { teacherVoice: teacher, learnerVoice: learner };
  }

  /** One stable seed per episode (cache determinism), minted on first render. */
  private async ensureSeed(episode: PodcastEpisode): Promise<number> {
    if (episode.tts_seed != null) return episode.tts_seed;
    const seed = Math.floor(1 + Math.random() * 4_000_000_000);
    await db.update(podcast_episodes).set({ tts_seed: seed, updated_at: new Date() }).where(eq(podcast_episodes.id, episode.id));
    return seed;
  }

  private async setProgress(renderId: string, stage: RenderStage, chunksDone: number, chunksTotal: number): Promise<void> {
    const status = stage === 'ready' ? 'ready' : stage;
    await db.update(podcast_renders)
      .set({ status, progress: { stage, chunksDone, chunksTotal }, claimed_at: new Date(), updated_at: new Date() })
      .where(eq(podcast_renders.id, renderId));
  }
}
