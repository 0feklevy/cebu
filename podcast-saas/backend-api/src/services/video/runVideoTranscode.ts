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
import { retireHlsRun } from './hlsRetention.js';
import { isSimilarMedia, parsePeaks } from './mediaSimilarity.js';
import { enqueueCropForProject } from '../crop/runCropAnalysis.js';
import { enqueueCaptionsForProject } from '../captions/CaptionService.js';
import { beatHlsHeartbeat } from './hlsRecovery.js';
import { fetchWithRetry } from '../../lib/fetchWithRetry.js';
import { logger } from '../../lib/logger.js';
import { recordHostMediaImpacts } from '../timeline/placementImpact.js';
import type { HostChangeKind } from 'shared';

export async function runVideoTranscode(
  video_file_id: string,
  /**
   * True when the write path SWAPPED this video's media rather than re-encoding what was already
   * there. It changes no behaviour of the transcode itself — it decides which of D-01b's two cases
   * a resulting placement review is filed under, and that distinction is not recoverable later.
   */
  { replaced = false }: { replaced?: boolean } = {},
): Promise<{ hls_master_key: string }> {
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

  // Prove this run is still alive for as long as it is (job-queue-003). The reaper in
  // `hlsRecovery.ts` runs on a timer now, not only at boot, and its death test is "nothing has
  // touched `hls_started_at` for HLS_STALE_AFTER_MS". Without this beat that test degrades into
  // "encoding has taken longer than the window", which would fail an honest long transcode out
  // from under itself — the beat is what makes the repeating sweep safe. Unref'd, fenced on
  // `hls_status='processing'`, and stopped in the `finally` below.
  const stopHeartbeat = beatHlsHeartbeat(video_file_id);

  const workDir = await mkdtemp(join(tmpdir(), 'hls-'));
  const ext = video.storage_key.split('.').pop() ?? 'mp4';
  const inputPath = join(workDir, `source.${ext}`);

  // What a FAILED run has to undo (media-006). Both stay null until the transcoder actually
  // begins work under this run's prefix, so a failure that never wrote anything — a download
  // error, an unreadable source — still retires nothing and clears nothing.
  //
  // `runPrefix`: the versioned tree this run may have put bytes under. A failure used to leave
  // every uploaded tier of it in object storage permanently: the caller's `hls_master_key`
  // never flips to a failed run, so `previousHlsTreeToGc` (which reads that pointer) can never
  // see it, and nothing else ever looks at it again.
  // `published360pKey`: the early-playback pointer this run wrote. It is the ONE thing a failed
  // run publishes, and every consumer (video.controller, buildPlayerConfig, SitemapService)
  // falls back to it when `hls_master_key` is null, without consulting `hls_status`.
  let runPrefix: string | null = null;
  let published360pKey: string | null = null;

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
        // From the first tier onward this run may own bytes under its prefix (a tier throwing
        // mid-upload leaves partial segments behind), so from here a failure must clean up.
        runPrefix = storageKeyPrefix;
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
          published360pKey = tierKey;
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

    // ── WHAT THIS DURATION DID TO THE ROWS PLACED AGAINST THIS VIDEO (D-01b) ────────────────
    //
    // This was a CLAMP: `SET end_sec = LEAST(end_sec, $new), start_sec = LEAST(start_sec, $new)`
    // over every main/broll row pointing at this video. It read as a repair and was a silent,
    // irreversible rewrite of authored placement data fired by a background job — no copy of the
    // previous value, nothing shown to the author, and it had already destroyed one class of row
    // outright (the `track IN ('main','broll')` predicate it carried was the scar left by a
    // 60-second music bed rewritten to the length of the 12-second video under it).
    //
    // The ruling separates the two events it was firing on, and gives them different answers:
    //
    //   • A PROBE CORRECTION rewrites NOTHING. An anchored row's absolute second ripples out of
    //     the new layout by itself — that is what the anchor added in 063 is for.
    //   • A REPLACE can genuinely leave a window or an anchor outside the new media, and the
    //     answer to that is a decision a person makes. Clamping picks one on their behalf,
    //     destroys the alternative, and tells nobody.
    //
    // So `timeline_sections` is not written here in either case. Findings go to
    // `placement_impact_reviews`, which the editor reads. The READ side is what keeps an
    // over-long window safe in the meantime: the export planner caps a window to the source it
    // can actually reach (D-01f) rather than asking ffmpeg for frames that do not exist.
    //
    // `video` holds the PRE-update row, so `video.duration_sec` here is still the old length.
    const similarMedia = isSimilarMedia(
      video.duration_sec, parsePeaks(video.waveform_peaks), result.durationSec, waveformPeaks,
    );
    if (video.project_id && result.durationSec > 0) {
      // WHICH EVENT THIS WAS. `replaced` is the truth from the write path — the replace route
      // knows what it did. The fallback is not belt-and-braces for its own sake: the transcode
      // queue is a singleton on `videoFileId`, so a replace enqueued while another delivery is
      // already queued can be collapsed into it and lose the flag. Media that is NOT similar to
      // what was there before is a replace whatever the payload says, and similar media is never
      // called a replace — so a genuine correction cannot be mislabelled in either direction.
      const kind: HostChangeKind =
        replaced || (!similarMedia && video.duration_sec != null)
          ? 'media_replace'
          : 'duration_correction';
      await recordHostMediaImpacts({
        projectId: video.project_id,
        hostVideoFileId: video_file_id,
        afterDurationSec: result.durationSec,
        beforeDurationSec: video.duration_sec,
        kind,
      });
    }

    // Pointer is flipped — RETIRE the previous *versioned* tree (different run), if any.
    // NOT deleted here: viewers mid-session still hold segment URLs into the old tree (their
    // player buffered the old master before the flip), so it goes into hls_retired_runs and
    // the hourly sweep deletes it only after the grace window (P0.3, sweepRetiredHlsRuns).
    const oldTree = previousHlsTreeToGc(video_file_id, oldMasterKey, runId);
    if (oldTree) {
      await retireHlsRun(video_file_id, oldTree).catch((err) => {
        // Best-effort, like the delete it replaces: a failed INSERT must not fail a finished
        // transcode — but it means the old tree leaks until manually purged, so say so.
        logger.warn({ err, video_file_id, oldTree }, 'failed to record retired HLS tree — it will not be swept');
      });
    }

    // Captions + smart-crop run on the WRITE path. Skip-if-similar: on a REPLACE where the
    // new media is essentially the same as the old (same duration + near-identical audio),
    // keep the existing captions/crop instead of re-running them ("save extra effort").
    // A first upload (no prior media) always processes. `similarMedia` is computed once above,
    // where the same comparison decides which D-01b case this transcode is.
    if (video.project_id) {
      if (similarMedia) {
        logger.info({ video_file_id, project_id: video.project_id }, 'Replaced media unchanged — skipping caption/crop re-processing');
      } else {
        enqueueCaptionsForProject(video.project_id).catch(() => {});
        enqueueCropForProject(video.project_id).catch(() => {});
      }
    }

    return { hls_master_key: result.masterKey };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[HLS] ✗ STATUS → failed  error="${message}"  (${video_file_id})`);
    logger.error({ video_file_id, err }, 'HLS transcode failed');

    // Un-publish before un-storing (media-006). This run's own 360p key is the only pointer a
    // failed run ever wrote, and it aims into a tree that is about to be queued for deletion —
    // so it goes first, and only this run's key is touched: a previous, still-complete tree's
    // pointer is none of a failed attempt's business.
    await db
      .update(video_files)
      .set({
        hls_status: 'failed',
        hls_error: message,
        hls_finished_at: new Date(),
        ...(published360pKey ? { hls_360p_key: null } : {}),
      })
      .where(eq(video_files.id, video_file_id));

    // Then hand the partial tree to the same grace-period sweep a superseded tree uses. NOT an
    // inline delete: a viewer who started on the early-playback 360p URL still holds segment
    // URLs into it. Best-effort — a bookkeeping failure must not replace the real error, but it
    // does mean the tree leaks, so it is logged as such.
    if (runPrefix) {
      await retireHlsRun(video_file_id, runPrefix).catch((e: unknown) => {
        logger.warn({ err: e, video_file_id, prefix: runPrefix },
          'failed to record the partial HLS tree of a failed run — it will not be swept');
      });
    }

    throw err;
  } finally {
    stopHeartbeat();
    await rm(workDir, { recursive: true, force: true });
    console.log(`[HLS] 🧹 Cleaned up workDir=${workDir}`);
  }
}
