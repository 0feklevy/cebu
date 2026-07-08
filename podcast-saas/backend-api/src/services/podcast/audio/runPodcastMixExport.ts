/**
 * podcast_mix_export job — render a master from the USER-EDITED mix timeline.
 *
 * Unlike the one-click renderer (which recomputes the timeline from the script),
 * this consumes a frozen mix snapshot + the persisted per-turn clips and lays them
 * out with the SAME `layoutMix` the browser player used — so the export is exactly
 * what the user auditioned. Clips are already tempo-baked + leveled, so there is no
 * global atempo here; only trims/gaps/gain from the edit, then loudnorm + encode.
 *
 * CAS-claimed on podcast_renders.claimed_at (shares the render table + its recovery).
 */

import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { and, eq, isNull, lt, notInArray, or } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_renders, podcast_episodes, podcast_mix_snapshots, podcast_clips } from '../../../db/schema.js';
import { getStorageAdapter } from '../../storage/getStorageAdapter.js';
import { mixClips, loudnormTwoPass, encodeMp4, encodeMp3, encodeWav, probeDurationMs, type TimelineClip } from './ffmpegAudio.js';
import { layoutMix, MixTimelineSchema, type MixTimeline } from 'shared';
import { logger } from '../../../lib/logger.js';

const STALE_MS = 30 * 60 * 1000;

const FORMATS: Record<string, { ext: string; mime: string; encode: (i: string, o: string) => Promise<void> }> = {
  mp4: { ext: 'mp4', mime: 'video/mp4', encode: encodeMp4 },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', encode: encodeMp3 },
  wav: { ext: 'wav', mime: 'audio/wav', encode: encodeWav },
};

export async function runPodcastMixExportJob(payload: { renderId: string }): Promise<void> {
  const { renderId } = payload;
  const staleThreshold = new Date(Date.now() - STALE_MS);

  const claimed = await db
    .update(podcast_renders)
    .set({ status: 'stitching', claimed_at: new Date() })
    .where(and(
      eq(podcast_renders.id, renderId),
      notInArray(podcast_renders.status, ['ready', 'failed']),
      or(isNull(podcast_renders.claimed_at), lt(podcast_renders.claimed_at, staleThreshold)),
    )!)
    .returning({ id: podcast_renders.id, episode_id: podcast_renders.episode_id, snapshot_id: podcast_renders.mix_snapshot_id, format: podcast_renders.format });
  if (claimed.length === 0) {
    logger.info({ renderId }, 'podcast_mix_export: already claimed — skipping');
    return;
  }
  const { episode_id: episodeId, snapshot_id, format } = claimed[0];

  try {
    await exportMix(renderId, episodeId, snapshot_id, format ?? 'mp4');
    await db.update(podcast_episodes).set({ status: 'ready', updated_at: new Date() }).where(eq(podcast_episodes.id, episodeId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, renderId }, 'podcast_mix_export: failed');
    await db.update(podcast_renders)
      .set({ status: 'failed', error: message.slice(0, 1000), claimed_at: null, updated_at: new Date() })
      .where(eq(podcast_renders.id, renderId));
  }
}

async function exportMix(renderId: string, episodeId: string, snapshotId: string | null, formatKey: string): Promise<void> {
  const fmt = FORMATS[formatKey] ?? FORMATS.mp4;
  if (!snapshotId) throw new Error('Export has no mix snapshot');
  const snapshot = await db.query.podcast_mix_snapshots.findFirst({ where: eq(podcast_mix_snapshots.id, snapshotId) });
  if (!snapshot) throw new Error('Mix snapshot not found');
  const timeline: MixTimeline = MixTimelineSchema.parse(snapshot.timeline_json);

  // Resolve every referenced clip to its persisted duration + storage key.
  const clipRows = await db.query.podcast_clips.findMany({ where: eq(podcast_clips.episode_id, episodeId) });
  const byId = new Map(clipRows.map((c) => [c.id, c]));
  const durOf = (clipId: string) => byId.get(clipId)?.duration_ms ?? 0;
  const { placements, totalMs } = layoutMix(timeline, durOf);
  if (totalMs <= 0) throw new Error('The mix is empty');

  const storage = getStorageAdapter();
  const workDir = await mkdtemp(join(tmpdir(), 'podcast-export-'));
  try {
    await db.update(podcast_renders).set({ status: 'stitching', progress: { stage: 'stitching' }, claimed_at: new Date(), updated_at: new Date() }).where(eq(podcast_renders.id, renderId));

    // Download each referenced clip once (a take may appear in several split parts).
    const localPath = new Map<string, string>();
    for (const p of placements) {
      if (p.muted || localPath.has(p.clipId)) continue;
      const row = byId.get(p.clipId);
      if (!row) continue;
      const buf = await storage.readObject(row.storage_key);
      const path = join(workDir, `clip_${localPath.size}.wav`);
      await writeFile(path, buf);
      localPath.set(p.clipId, path);
    }

    const clips: TimelineClip[] = placements
      .filter((p) => !p.muted && localPath.has(p.clipId))
      .map((p) => ({ path: localPath.get(p.clipId)!, delayMs: p.startMs, gainDb: p.gainDb, inMs: p.inMs, outMs: p.outMs }));
    if (clips.length === 0) throw new Error('No audible clips in the mix');

    const mixWav = join(workDir, 'mix.wav');
    await mixClips(clips, totalMs, mixWav, workDir, true);
    const finalWav = join(workDir, 'final.wav');
    await loudnormTwoPass(mixWav, finalWav);

    await db.update(podcast_renders).set({ status: 'encoding', progress: { stage: 'encoding' }, claimed_at: new Date(), updated_at: new Date() }).where(eq(podcast_renders.id, renderId));
    const outPath = join(workDir, `master.${fmt.ext}`);
    await fmt.encode(finalWav, outPath);
    const durationMs = await probeDurationMs(outPath);

    const key = `podcasts/${episodeId}/renders/${renderId}/master.${fmt.ext}`;
    await storage.uploadFile(key, await readFile(outPath), fmt.mime, 'public, max-age=31536000, immutable');

    // Map the chosen format onto the render's typed key columns for the UI.
    const keyPatch = fmt.ext === 'mp4' ? { master_mp4_key: key }
      : fmt.ext === 'mp3' ? { master_mp3_key: key }
      : { master_wav_key: key };
    await db.update(podcast_renders).set({
      status: 'ready',
      ...keyPatch,
      duration_ms: durationMs,
      progress: { stage: 'ready' },
      claimed_at: null,
      updated_at: new Date(),
    }).where(eq(podcast_renders.id, renderId));
    logger.info({ renderId, format: fmt.ext, durationMs }, 'podcast_mix_export: complete');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
