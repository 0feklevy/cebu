/**
 * Re-voice ONE line for the Audio Studio. Like previewTurn (3-input dialogue for
 * v3 context → recut the middle line), but it PERSISTS the result as a first-class
 * clip take: tempo-baked (WYSIWYG with export), leveled, with waveform peaks and a
 * content-addressed take_hash. Returns the new podcast_clips row; the studio swaps
 * every MixClip for this turn onto the new clipId.
 */

import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_clips } from '../../../db/schema.js';
import type { PodcastShow, PodcastEpisode, PodcastClip } from '../../../db/schema.js';
import { getStorageAdapter } from '../../storage/getStorageAdapter.js';
import { PodcastVoiceService } from '../PodcastVoiceService.js';
import { ElevenLabsDialogue } from './ElevenLabsDialogue.js';
import { recordTtsSpend } from '../../usage/recordTtsSpend.js';
import { evaluateSpendCeiling } from '../../usage/spendCeiling.js';
import { charactersIn } from '../../usage/ttsCost.js';
import { decodeToWav, extractClip, measureLufs, gainToTarget, applyTempo, extractPeaks, probeDurationMs } from './ffmpegAudio.js';
import { computeClipBounds } from './clipBounds.js';
import type { PodcastTurn } from 'shared';

const OUTPUT_FORMAT = process.env.PODCAST_TTS_FORMAT ?? 'mp3_44100_128';

export async function revoicePodcastTurn(params: {
  show: PodcastShow;
  episode: PodcastEpisode;
  turns: PodcastTurn[];
  index: number;
  scriptVersion: number | null;
}): Promise<PodcastClip> {
  const { show, episode, turns, index, scriptVersion } = params;
  // ── THE CEILING, BEFORE A SINGLE CHARACTER IS SYNTHESISED ──────────────────────────────────
  // This path is where the 22 August 2026 spend incident actually happened: not one deliberate
  // render, but a creator auditioning voices, click after click, each one a paid synthesis. The
  // full-episode renderer has consulted the ceiling since it was built; these per-click paths did
  // not — which is backwards, because a render is ONE action with a knowable cost and this is
  // unbounded by construction.
  //
  // SHADOW BY DEFAULT, exactly as in PodcastRenderer: `SPEND_CEILING_MODE=enforce` has to be set
  // for this to refuse anything. Until then it records what it would have done, which is how the
  // configured figure gets checked before it starts costing somebody a preview.
  const ceiling = await evaluateSpendCeiling({ provider: 'elevenlabs' });
  if (ceiling.refuse) {
    throw new Error(ceiling.reason ?? 'Monthly ElevenLabs spend ceiling reached.');
  }
  const storage = getStorageAdapter();
  const target = turns[index];

  let teacher = show.teacher_voice_id;
  let learner = show.learner_voice_id;
  if (!teacher || !learner) {
    const r = await new PodcastVoiceService().resolveDefaultVoices(show.teacher_name, show.learner_name);
    teacher = teacher ?? r.teacher_voice_id;
    learner = learner ?? r.learner_voice_id;
  }
  if (!teacher || !learner) throw new Error('No ElevenLabs voices set for this show');
  const voiceFor = (sp: 'teacher' | 'learner') => (sp === 'teacher' ? teacher! : learner!);

  const prev = index > 0 ? turns[index - 1] : null;
  const next = index < turns.length - 1 ? turns[index + 1] : null;
  const inputs = [
    ...(prev ? [{ text: prev.text, voice_id: voiceFor(prev.speaker) }] : []),
    { text: target.text, voice_id: voiceFor(target.speaker) },
    ...(next ? [{ text: next.text, voice_id: voiceFor(next.speaker) }] : []),
  ];
  const targetInputIndex = prev ? 1 : 0;
  const seed = episode.tts_seed ?? 1234;

  const workDir = await mkdtemp(join(tmpdir(), 'podcast-revoice-'));
  try {
    const result = await new ElevenLabsDialogue().synthesize({ inputs, seed, outputFormat: OUTPUT_FORMAT, stability: 0.5 });

    // SPEND, RECORDED (#105's contract). Reached only on a cache MISS — the hash above covers the
    // inputs, the seed and the format, so re-previewing unchanged text costs nothing and is not
    // counted. What does cost is a creator editing a line and listening again, which is the
    // ordinary way this screen is used and was invisible until now.
    //
    // `attempts` multiplies it: the client's retry loop is internal, and every attempt that
    // reached the vendor was billed.
    void recordTtsSpend({
      userId: show.created_by ?? null,
      task: 'podcast_revoice',
      characters: charactersIn(inputs) * Math.max(1, result.attempts ?? 1),
    });
    const isPcm = result.format === 'pcm';
    const raw = join(workDir, `r.${isPcm ? 'pcm' : 'mp3'}`);
    await writeFile(raw, result.audio);
    const wav = join(workDir, 'r.wav');
    await decodeToWav(raw, wav, isPcm ? { pcm: true, pcmRate: result.sampleRate } : undefined);
    const totalDur = (await probeDurationMs(wav)) / 1000;

    // Recut the middle line — exclusive tail-generous bounds (see clipBounds.ts):
    // the context lines' audio must never leak into the take, and the take's own
    // decaying tail must stay inside it.
    const seg = result.voiceSegments.find((s) => s.dialogue_input_index === targetInputIndex);
    const prevSegEnd = result.voiceSegments.find((s) => s.dialogue_input_index === targetInputIndex - 1)?.end_time_seconds ?? 0;
    const nextSegStart = result.voiceSegments.find((s) => s.dialogue_input_index === targetInputIndex + 1)?.start_time_seconds ?? totalDur;
    const { start, end } = seg
      ? computeClipBounds({
          segStart: seg.start_time_seconds, segEnd: seg.end_time_seconds,
          prevSegEnd, nextSegStart, prevChosenEnd: 0, chunkDur: totalDur,
          isCutOff: /[—–]\s*["']?\s*$/.test(target.text),
        })
      : { start: 0, end: totalDur };
    const gain = gainToTarget(await measureLufs(wav));
    const clipWav = join(workDir, 'clip.wav');
    await extractClip(wav, clipWav, start, end, gain);

    // Bake tempo so the studio clip == the export clip.
    const baked = join(workDir, 'baked.wav');
    await applyTempo(clipWav, baked);
    const bytes = await readFile(baked);
    const takeHash = createHash('sha256').update(bytes).digest('hex');
    const key = `podcasts/${episode.id}/clips/${takeHash}.wav`;

    const existing = await db.query.podcast_clips.findFirst({
      where: and(eq(podcast_clips.episode_id, episode.id), eq(podcast_clips.turn_id, target.id), eq(podcast_clips.take_hash, takeHash)),
    });
    if (existing) return existing;

    const durationMs = await probeDurationMs(baked);
    const peaks = await extractPeaks(baked, Math.max(24, Math.min(600, Math.round(durationMs / 25))));
    await storage.uploadFile(key, bytes, 'audio/wav', 'public, max-age=31536000, immutable');
    const [row] = await db.insert(podcast_clips).values({
      episode_id: episode.id,
      turn_id: target.id,
      take_hash: takeHash,
      text_hash: createHash('sha256').update(`${target.speaker}|${target.text}`).digest('hex'),
      script_version: scriptVersion,
      storage_key: key,
      duration_ms: durationMs,
      peaks_json: peaks,
      source: 'regen',
    }).returning();
    return row;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
