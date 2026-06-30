/**
 * Background smart-crop orchestration.
 *
 * Runs the crop engine for a video file, stores the resulting metadata JSON in
 * object storage, and tracks status on the video_files row — mirroring how
 * runVideoTranscode works. Everything here is fire-and-forget: the editor and
 * the share/preview requests never await it.
 *
 * Idempotency: a content hash of the source (storage_key + size + duration) is
 * stored on the row. Re-running when the hash already matches a `ready` result
 * is a no-op, so triggering on every preview is cheap; when the underlying video
 * changes the hash differs and the crop is recomputed automatically.
 */

import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq, and, or, ne, lt, isNull } from 'drizzle-orm';
import { db, video_files } from '../../db/index.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { processVideoCrop } from './cropProcessor.js';
import { enqueueJob } from '../../queue/index.js';

function sourceHash(storageKey: string, fileSize: number | null, durationSec: number | null): string {
  return createHash('sha256')
    .update(`${storageKey}|${fileSize ?? ''}|${durationSec ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

// In-process guard so concurrent triggers (preview + share at once) don't run the
// same heavy job twice. The authoritative cross-instance guard is the DB claim below.
const inFlight = new Set<string>();
// A 'processing' claim older than this is treated as stale (a crashed worker) and may be
// re-claimed by another instance.
const STALE_CLAIM_MS = 20 * 60 * 1000;

/**
 * Fire-and-forget entry point. Safe to call on every preview / share request.
 * Skips silently if the crop is already up to date or already running.
 */
export function enqueueCropAnalysis(videoFileId: string): void {
  enqueueJob('crop', { videoFileId });
}

/** Enqueue crop for every main (non-broll) video in a project. */
export async function enqueueCropForProject(projectId: string): Promise<void> {
  const vids = await db.query.video_files.findMany({ where: eq(video_files.project_id, projectId) });
  for (const v of vids) {
    if (v.is_broll || !v.storage_key) continue;
    enqueueCropAnalysis(v.id);
  }
}

export async function runCropAnalysis(videoFileId: string): Promise<void> {
  // Process-local fast-path so two in-process triggers don't both hit the DB claim; the
  // authoritative cross-instance guard is the CAS claim inside runCropAnalysisInner. Lives
  // in the handler (not the producer) so the queue producer stays a thin enqueue.
  if (inFlight.has(videoFileId)) return;
  inFlight.add(videoFileId);
  try {
    await runCropAnalysisInner(videoFileId);
  } finally {
    inFlight.delete(videoFileId);
  }
}

async function runCropAnalysisInner(videoFileId: string): Promise<void> {
  const storage = getStorageAdapter();

  const video = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
  if (!video || !video.storage_key || video.is_broll) return;

  const hash = sourceHash(video.storage_key, video.file_size, video.duration_sec);
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  if (video.crop_status === 'ready' && video.crop_source_hash === hash) return;       // up to date
  // A FRESH 'processing' run already covers it; a stale one (crashed worker) is reclaimable.
  if (video.crop_status === 'processing' && video.crop_source_hash === hash
      && (video.crop_updated_at?.getTime() ?? 0) >= staleBefore.getTime()) return;

  // Cluster-safe claim (review arch-008): only one instance wins the flip to 'processing'.
  // An empty RETURNING means another worker already holds a fresh claim — bow out.
  const claimed = await db.update(video_files)
    .set({ crop_status: 'processing', crop_source_hash: hash, crop_error: null, crop_updated_at: new Date() })
    .where(and(
      eq(video_files.id, videoFileId),
      or(
        isNull(video_files.crop_status),
        ne(video_files.crop_status, 'processing'),
        lt(video_files.crop_updated_at, staleBefore),
      ),
    ))
    .returning({ id: video_files.id });
  if (claimed.length === 0) {
    logger.debug({ videoFileId }, '[crop] already claimed by another worker — skipping');
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'crop-'));
  const ext = video.storage_key.split('.').pop() ?? 'mp4';
  const inputPath = join(workDir, `source.${ext}`);

  try {
    const url = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(inputPath));

    const t0 = Date.now();
    const metadata = await processVideoCrop(videoFileId, inputPath);
    logger.info(
      { videoFileId, ms: Date.now() - t0, frames: metadata.stats?.frames, heads: metadata.stats?.heads },
      'crop analysis complete',
    );

    const json = JSON.stringify(metadata);
    const key = `crop/${videoFileId}.json`;
    await storage.uploadFile(key, Buffer.from(json), 'application/json');

    await db.update(video_files)
      .set({ crop_status: 'ready', crop_key: key, crop_source_hash: hash, crop_error: null, crop_updated_at: new Date() })
      .where(eq(video_files.id, videoFileId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(video_files)
      .set({ crop_status: 'failed', crop_error: message })
      .where(eq(video_files.id, videoFileId));
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
