import { mkdtemp, rm } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { db, video_files } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { transcodeToHLS, extractWaveformPeaks } from './HLSTranscoder.js';
import { previousHlsTreeToGc } from './hlsVersioning.js';
import { enqueueVideoMetadata } from '../generateVideoMetadata.js';
import { fetchWithRetry } from '../../lib/fetchWithRetry.js';
import { deleteWithPrefixFallback } from '../storage/deleteWithFallback.js';
import { logger } from '../../lib/logger.js';

export async function runVideoTranscode(video_file_id: string): Promise<{ hls_master_key: string }> {
  const storage = getStorageAdapter();

  console.log(`[HLS] ▶ START transcode for video_file_id=${video_file_id}`);

  const video = await db.query.video_files.findFirst({
    where: eq(video_files.id, video_file_id),
  });
  if (!video || !video.storage_key) {
    console.error(`[HLS] ✗ video_file ${video_file_id} not found or missing storage_key`);
    throw new Error(`video_file ${video_file_id} not found or has no storage_key`);
  }

  await db
    .update(video_files)
    .set({ hls_status: 'processing', hls_started_at: new Date() })
    .where(eq(video_files.id, video_file_id));
  console.log(`[HLS] ● STATUS → processing  (${video_file_id})`);

  const workDir = await mkdtemp(join(tmpdir(), 'hls-'));
  const ext = video.storage_key.split('.').pop() ?? 'mp4';
  const inputPath = join(workDir, `source.${ext}`);

  try {
    console.log(`[HLS] ⬇ Downloading source from storage_key=${video.storage_key}`);
    const downloadUrl = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
    const response = await fetchWithRetry(downloadUrl);
    if (!response.ok) throw new Error(`Failed to download source video: ${response.status}`);
    if (!response.body) throw new Error('No response body');
    await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(inputPath));
    console.log(`[HLS] ✓ Source downloaded → ${inputPath}`);
    logger.info({ video_file_id, inputPath }, 'Source video downloaded');

    // Versioned HLS tree per transcode run: a re-transcode writes a fresh tree and the
    // DB update below flips the pointer atomically, instead of overwriting the live tree
    // in place (which caused torn reads for mid-stream viewers — review fiji-storage-008).
    const runId = Date.now().toString(36);
    const oldMasterKey = video.hls_master_key;
    const storageKeyPrefix = `hls/${video_file_id}/${runId}`;
    const result = await transcodeToHLS({
      inputPath,
      workDir,
      storageKeyPrefix,
      storage,
      onTierStart: async (tierName) => {
        console.log(`[HLS] ⚙ TIER START: ${tierName}  (${video_file_id})`);
        logger.info({ video_file_id, tierName }, 'HLS tier starting');
        await db
          .update(video_files)
          .set({ hls_current_tier: tierName })
          .where(eq(video_files.id, video_file_id));
      },
      onTierComplete: async (tierName, tierKey) => {
        console.log(`[HLS] ✓ TIER DONE: ${tierName}  key=${tierKey}  (${video_file_id})`);
        logger.info({ video_file_id, tierName, tierKey }, 'HLS tier complete');
        if (tierName === '360p') {
          await db
            .update(video_files)
            .set({ hls_360p_key: tierKey })
            .where(eq(video_files.id, video_file_id));
          console.log(`[HLS] ● 360p ready — early playback available  (${video_file_id})`);
        }
      },
    });

    // Extract waveform peaks for timeline display (non-blocking on error)
    console.log(`[HLS] ⚡ Extracting waveform peaks  (${video_file_id})`);
    const waveformPeaks = await extractWaveformPeaks(inputPath).catch((err) => {
      logger.warn({ err, video_file_id }, 'Waveform extraction failed, continuing without peaks');
      return [] as number[];
    });
    const waveformJson = waveformPeaks.length > 0 ? JSON.stringify(waveformPeaks) : null;
    if (waveformJson) console.log(`[HLS] ✓ Waveform peaks extracted  count=${waveformPeaks.length}  (${video_file_id})`);

    await db
      .update(video_files)
      .set({
        hls_status: 'ready',
        hls_master_key: result.masterKey,
        hls_finished_at: new Date(),
        duration_sec: result.durationSec > 0 ? result.durationSec : video.duration_sec,
        hls_error: null,
        waveform_peaks: waveformJson,
      })
      .where(eq(video_files.id, video_file_id));

    console.log(`[HLS] ✅ STATUS → ready  masterKey=${result.masterKey}  duration=${result.durationSec}s  (${video_file_id})`);
    logger.info({ video_file_id, masterKey: result.masterKey }, 'HLS transcode complete');

    // Pointer is flipped — GC the previous *versioned* tree (different run), if any.
    const oldTree = previousHlsTreeToGc(video_file_id, oldMasterKey, runId);
    if (oldTree) deleteWithPrefixFallback(oldTree).catch(() => {});

    // Generate thumbnail + AI title/description in the background.
    // Uses the already-downloaded source file in inputPath for the frame extraction.
    if (video.project_id) enqueueVideoMetadata(video.project_id, video_file_id);

    return { hls_master_key: result.masterKey };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[HLS] ✗ STATUS → failed  error="${message}"  (${video_file_id})`);
    logger.error({ video_file_id, err }, 'HLS transcode failed');

    await db
      .update(video_files)
      .set({ hls_status: 'failed', hls_error: message, hls_finished_at: new Date() })
      .where(eq(video_files.id, video_file_id));

    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
    console.log(`[HLS] 🧹 Cleaned up workDir=${workDir}`);
  }
}
