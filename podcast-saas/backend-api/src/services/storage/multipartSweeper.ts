/**
 * Abandoned multipart uploads (owner ruling 2026-09-03; census G9).
 *
 * A browser that starts a multipart upload and closes the tab leaves its parts in the bucket:
 * billed, invisible to any object LIST, and unreachable by the abort route because the uploadId
 * left with the tab. The bucket census found four such uploads with 81 parts. This sweep lists
 * them through the adapter, and aborts the ones older than the grace — a week by default: no
 * legitimate upload of ours runs that long, and the owner's ruling was an age-based sweep rather
 * than a one-off clean.
 *
 * Dry-run by default (`apply: false` reports and touches nothing). `MULTIPART_ABORT_SWEEP=0`
 * disables the periodic pass entirely.
 */
import { getStorageAdapter } from './getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import type { MultipartUploadInfo } from './StorageService.js';

export const MULTIPART_ABORT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const MULTIPART_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MultipartSweepResult {
  listed: number;
  abandoned: MultipartUploadInfo[];
  aborted: number;
  failed: number;
  apply: boolean;
}

/** The uploads older than the grace as of `now`. Pure, so the rule is testable without a bucket. */
export function abandonedUploads(uploads: readonly MultipartUploadInfo[], graceMs: number, now = Date.now()): MultipartUploadInfo[] {
  return uploads.filter((u) => u.initiated !== null && now - Date.parse(u.initiated) >= graceMs);
}

export async function sweepAbandonedMultipartUploads(opts: {
  apply: boolean;
  graceMs?: number;
  now?: number;
  storage?: Pick<ReturnType<typeof getStorageAdapter>, 'listMultipartUploads' | 'abortMultipartUpload'>;
}): Promise<MultipartSweepResult> {
  const storage = opts.storage ?? getStorageAdapter();
  const graceMs = opts.graceMs ?? MULTIPART_ABORT_GRACE_MS;
  const uploads = await storage.listMultipartUploads();
  const abandoned = abandonedUploads(uploads, graceMs, opts.now);
  let aborted = 0;
  let failed = 0;
  if (opts.apply) {
    for (const u of abandoned) {
      try {
        await storage.abortMultipartUpload(u.key, u.uploadId);
        aborted += 1;
      } catch (err) {
        failed += 1;
        logger.warn({ err: (err as Error)?.message?.slice(0, 200), key: u.key }, '[MultipartSweep] abort failed');
      }
    }
  }
  const result = { listed: uploads.length, abandoned, aborted, failed, apply: opts.apply };
  if (uploads.length > 0) {
    logger.info({ evt: 'multipart_sweep', listed: uploads.length, abandoned: abandoned.length, aborted, failed, apply: opts.apply }, '[MultipartSweep] pass complete');
  }
  return result;
}

/** Daily; aborts for real. Off with MULTIPART_ABORT_SWEEP=0. Never prevents a boot. */
export function startMultipartAbortSweep(intervalMs = MULTIPART_SWEEP_INTERVAL_MS): () => void {
  if (process.env.MULTIPART_ABORT_SWEEP === '0') return () => {};
  const run = () => {
    void sweepAbandonedMultipartUploads({ apply: true }).catch((e) => {
      logger.warn({ err: (e as Error)?.message?.slice(0, 200) }, '[MultipartSweep] pass failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
