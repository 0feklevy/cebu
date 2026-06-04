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
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq } from 'drizzle-orm';
import { db, video_files } from '../../db/index.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { processVideoCrop } from './cropProcessor.js';

function sourceHash(storageKey: string, fileSize: number | null, durationSec: number | null): string {
  return createHash('sha256')
    .update(`${storageKey}|${fileSize ?? ''}|${durationSec ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

// In-process guard so concurrent triggers (preview + share at once) don't run the
// same heavy job twice.
const inFlight = new Set<string>();

/**
 * Fire-and-forget entry point. Safe to call on every preview / share request.
 * Skips silently if the crop is already up to date or already running.
 */
export function enqueueCropAnalysis(videoFileId: string): void {
  if (inFlight.has(videoFileId)) return;
  inFlight.add(videoFileId);
  setImmediate(() => {
    runCropAnalysis(videoFileId)
      .catch((err) => logger.warn({ err, videoFileId }, 'crop analysis failed'))
      .finally(() => inFlight.delete(videoFileId));
  });
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
  const storage = getStorageAdapter();

  const video = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
  if (!video || !video.storage_key || video.is_broll) return;

  const hash = sourceHash(video.storage_key, video.file_size, video.duration_sec);
  if (video.crop_status === 'ready' && video.crop_source_hash === hash) return;       // up to date
  if (video.crop_status === 'processing' && video.crop_source_hash === hash) return;   // a run already covered it

  await db.update(video_files)
    .set({ crop_status: 'processing', crop_source_hash: hash, crop_error: null })
    .where(eq(video_files.id, videoFileId));

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
    const localJson = join(workDir, 'crop.json');
    await writeFile(localJson, json);
    const key = `crop/${videoFileId}.json`;
    await storage.uploadFile(key, Buffer.from(json), 'application/json');

    await db.update(video_files)
      .set({ crop_status: 'ready', crop_key: key, crop_source_hash: hash, crop_error: null })
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
