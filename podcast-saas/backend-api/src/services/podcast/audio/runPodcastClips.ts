/**
 * podcast_clips job — the Audio Studio's clip builder.
 *
 * Synthesizes + recuts each turn (reusing the renderer's pipeline), bakes the
 * global tempo INTO each clip (so what plays in the editor == what exports),
 * persists every clip as an immutable content-addressed WAV with waveform peaks,
 * and derives the initial order-preserving mix timeline from `buildTimeline`
 * (scaled by 1/tempo so the first draft matches the tuned one-click master).
 *
 * CAS-claimed on podcast_mixes.claimed_at; idempotent; startup recovery below.
 */

import { createHash } from 'crypto';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { and, desc, eq, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_mixes, podcast_clips, podcast_episodes, podcast_shows, podcast_scripts } from '../../../db/schema.js';
import { getStorageAdapter } from '../../storage/getStorageAdapter.js';
import { PodcastRenderer } from './PodcastRenderer.js';
import { buildTimeline, type TimelineTurn } from './timeline.js';
import { applyTempo, extractPeaks, probeDurationMs, PODCAST_TEMPO } from './ffmpegAudio.js';
import type { PodcastScriptBody, MixClip, MixTimeline } from 'shared';
import { logger } from '../../../lib/logger.js';

const STALE_MS = 30 * 60 * 1000;

function textHash(speaker: string, text: string): string {
  return createHash('sha256').update(`${speaker}|${text}`).digest('hex');
}

export async function runPodcastClipsJob(payload: { mixId: string }): Promise<void> {
  const { mixId } = payload;
  const staleThreshold = new Date(Date.now() - STALE_MS);

  const claimed = await db
    .update(podcast_mixes)
    .set({ status: 'generating', claimed_at: new Date(), error: null, updated_at: new Date() })
    .where(and(
      eq(podcast_mixes.id, mixId),
      or(isNull(podcast_mixes.claimed_at), lt(podcast_mixes.claimed_at, staleThreshold)),
    )!)
    .returning({ id: podcast_mixes.id, episode_id: podcast_mixes.episode_id });
  if (claimed.length === 0) {
    logger.info({ mixId }, 'podcast_clips: already claimed — skipping');
    return;
  }
  const episodeId = claimed[0].episode_id;

  try {
    await buildClips(mixId, episodeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, mixId }, 'podcast_clips: failed');
    await db.update(podcast_mixes)
      .set({ status: 'failed', error: message.slice(0, 1000), claimed_at: null, updated_at: new Date() })
      .where(eq(podcast_mixes.id, mixId));
  }
}

async function buildClips(mixId: string, episodeId: string): Promise<void> {
  const episode = await db.query.podcast_episodes.findFirst({ where: eq(podcast_episodes.id, episodeId) });
  if (!episode) throw new Error('Episode not found');
  const show = await db.query.podcast_shows.findFirst({ where: eq(podcast_shows.id, episode.show_id) });
  if (!show) throw new Error('Show not found');

  // Newest script with a body (any status past drafting) — the studio edits/audio
  // are downstream of whatever the writers' room last produced.
  const script = await db.query.podcast_scripts.findFirst({
    where: and(eq(podcast_scripts.episode_id, episodeId), isNotNull(podcast_scripts.body_json)),
    orderBy: [desc(podcast_scripts.version)],
  });
  const body = script?.body_json as PodcastScriptBody | undefined;
  if (!body || !body.turns.length) throw new Error('No script to build clips from');
  const language = episode.language ?? show.language ?? 'en';

  const storage = getStorageAdapter();
  const renderer = new PodcastRenderer();
  const workDir = await mkdtemp(join(tmpdir(), 'podcast-clips-'));
  try {
    const { clipPath, clipDurMs } = await renderer.synthesizeAndRecut(episodeId, episode, show, body, language, workDir, {
      onProgress: (done, total) => db.update(podcast_mixes)
        .set({ progress: { stage: 'synthesizing', done, total }, claimed_at: new Date(), updated_at: new Date() })
        .where(eq(podcast_mixes.id, mixId)).then(() => undefined),
    });

    // Bake tempo + persist each clip; collect turnId → { clipId, bakedDurMs }.
    const clipInfo = new Map<string, { clipId: string; bakedDurMs: number }>();
    const turnsWithClips = body.turns.filter((t) => clipPath.has(t.id));
    let i = 0;
    for (const turn of turnsWithClips) {
      const src = clipPath.get(turn.id)!;
      const baked = join(workDir, `baked_${i++}.wav`);
      await applyTempo(src, baked); // WYSIWYG: editor clip == export clip
      const bytes = await readFile(baked);
      const takeHash = createHash('sha256').update(bytes).digest('hex');
      const key = `podcasts/${episodeId}/clips/${takeHash}.wav`;

      const existing = await db.query.podcast_clips.findFirst({
        where: and(eq(podcast_clips.episode_id, episodeId), eq(podcast_clips.turn_id, turn.id), eq(podcast_clips.take_hash, takeHash)),
      });
      if (existing) {
        clipInfo.set(turn.id, { clipId: existing.id, bakedDurMs: existing.duration_ms });
        continue;
      }

      const bakedDurMs = await probeDurationMs(baked);
      const peaks = await extractPeaks(baked, Math.max(24, Math.min(600, Math.round(bakedDurMs / 25))));
      await storage.uploadFile(key, bytes, 'audio/wav', 'public, max-age=31536000, immutable');
      const [row] = await db.insert(podcast_clips).values({
        episode_id: episodeId,
        turn_id: turn.id,
        take_hash: takeHash,
        text_hash: textHash(turn.speaker, turn.text),
        script_version: script?.version ?? null,
        storage_key: key,
        duration_ms: bakedDurMs,
        peaks_json: peaks,
        source: 'batch',
      }).returning({ id: podcast_clips.id });
      clipInfo.set(turn.id, { clipId: row.id, bakedDurMs });
    }

    const timeline = deriveInitialTimeline(body, clipPath, clipDurMs, clipInfo);
    await db.update(podcast_mixes).set({
      status: 'ready',
      timeline_json: timeline,
      script_version: script?.version ?? null,
      script_hash: script?.content_hash ?? null,
      progress: { stage: 'ready', done: turnsWithClips.length, total: turnsWithClips.length },
      claimed_at: null,
      updated_at: new Date(),
    }).where(eq(podcast_mixes.id, mixId));
    logger.info({ mixId, clips: clipInfo.size }, 'podcast_clips: built');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Convert `buildTimeline`'s absolute placements (computed on UN-baked clip durations,
 * i.e. today's tuned master) into the order-preserving mix document. Gaps are scaled
 * by 1/tempo so that, combined with the tempo-baked clip durations, `layoutMix`
 * reproduces the scaled placement exactly (see PR notes / layoutMix tests).
 */
function deriveInitialTimeline(
  body: PodcastScriptBody,
  clipPath: Map<string, string>,
  clipDurMs: Map<string, number>,
  clipInfo: Map<string, { clipId: string; bakedDurMs: number }>,
): MixTimeline {
  const tTurns: TimelineTurn[] = body.turns
    .filter((t) => clipPath.has(t.id) && clipInfo.has(t.id))
    .map((t) => ({
      turnId: t.id, speaker: t.speaker, overlap: t.overlap,
      durationMs: clipDurMs.get(t.id) ?? 0, pauseAfterMs: t.pause_after_ms ?? undefined,
      beat: t.beat, text: t.text,
    }));
  const { placements } = buildTimeline(tTurns);
  const startById = new Map(placements.map((p) => [p.turnId, p.delayMs]));

  const clips: MixClip[] = [];
  const prevRawEndByLane = new Map<string, number>();
  for (const t of tTurns) {
    const rawStart = startById.get(t.turnId) ?? 0;
    const lane = t.speaker;
    const prevRawEnd = prevRawEndByLane.get(lane) ?? 0;
    const rawGap = rawStart - prevRawEnd;
    const gapBeforeMs = Math.max(0, Math.round(rawGap / PODCAST_TEMPO));
    clips.push({
      clipId: clipInfo.get(t.turnId)!.clipId,
      turnId: t.turnId,
      partIndex: 0,
      role: 'speech',
      lane,
      gapBeforeMs,
      trimStartMs: 0,
      trimEndMs: 0,
      gainDb: 0,
      muted: false,
    });
    prevRawEndByLane.set(lane, Math.max(prevRawEnd, rawStart + (t.durationMs ?? 0)));
  }
  return { version: 1, layout: 'lanes', clips };
}

/** Startup recovery: fail mixes stuck generating past the stale window. */
export async function recoverStuckPodcastMixes(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_MS);
  const stuck = await db
    .update(podcast_mixes)
    .set({ status: 'failed', error: 'Clip generation was interrupted — please try again.', claimed_at: null, updated_at: new Date() })
    .where(and(
      eq(podcast_mixes.status, 'generating'),
      or(isNull(podcast_mixes.claimed_at), lt(podcast_mixes.claimed_at, staleThreshold)),
    )!)
    .returning({ id: podcast_mixes.id });
  if (stuck.length) logger.warn({ count: stuck.length }, 'Recovered stuck podcast mixes');
}
