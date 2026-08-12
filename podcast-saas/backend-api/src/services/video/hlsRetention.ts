/**
 * Grace-period retention for retired HLS run trees (P0.3, migration 053).
 *
 * A re-transcode flips `video_files.hls_master_key` to a fresh versioned tree. The OLD tree
 * must NOT be deleted at that instant: viewers mid-session still hold segment URLs into it
 * (their player buffered the old master minutes ago), and the immediate fire-and-forget
 * delete this module replaces started tearing their sessions down on the next microtask.
 *
 * So retirement is a bookkeeping INSERT, and deletion happens here, later, in a bounded
 * hourly sweep — the same cadence mechanism as the RUM retention sweep (RumService), wired
 * next to it in server.ts.
 */

import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { hls_retired_runs } from '../../db/schema.js';
import { deleteWithPrefixFallback } from '../storage/deleteWithFallback.js';
import { logger } from '../../lib/logger.js';

export const HLS_RETIRE_GRACE_HOURS_DEFAULT = 24;
/** No viewer session should outlive an hour of grace, but never delete sooner than that. */
export const HLS_RETIRE_GRACE_HOURS_MIN = 1;

/**
 * The grace window in hours: env HLS_RETIRE_GRACE_HOURS, default 24, clamped to ≥ 1.
 * An unparseable value falls back to the default — misconfiguration must not shorten the
 * window to "delete now", which is the failure the grace period exists to prevent.
 */
export function hlsRetireGraceHours(env: string | undefined = process.env.HLS_RETIRE_GRACE_HOURS): number {
  if (env === undefined || env.trim() === '') return HLS_RETIRE_GRACE_HOURS_DEFAULT;
  const n = Number(env);
  if (!Number.isFinite(n)) return HLS_RETIRE_GRACE_HOURS_DEFAULT;
  return Math.max(HLS_RETIRE_GRACE_HOURS_MIN, n);
}

/**
 * Record a retired run tree for deferred deletion. Idempotent on `prefix` (a crash-and-retry
 * of the same transcode run must not queue the same tree twice).
 */
export async function retireHlsRun(
  videoFileId: string,
  prefix: string,
  now: Date = new Date(),
): Promise<void> {
  const retireAfter = new Date(now.getTime() + hlsRetireGraceHours() * 3_600_000);
  await db
    .insert(hls_retired_runs)
    .values({ video_file_id: videoFileId, prefix, retired_at: now, retire_after: retireAfter })
    .onConflictDoNothing({ target: hls_retired_runs.prefix });
}

/** How many retired trees one sweep pass may process. Bounded: this runs inside the web process. */
export const HLS_RETIRE_SWEEP_LIMIT = 20;

/**
 * Delete retired trees whose grace window has passed. One bounded SELECT (LIMIT n), then per
 * row: delete the storage prefix (an already-missing prefix is tolerated — the helper logs
 * and continues) and mark `deleted_at`. A row whose storage delete throws is left unmarked
 * and retried on a later sweep; the others still proceed. Returns how many were deleted.
 */
export async function sweepRetiredHlsRuns(
  limit: number = HLS_RETIRE_SWEEP_LIMIT,
  now: Date = new Date(),
): Promise<number> {
  const due = await db
    .select({ id: hls_retired_runs.id, prefix: hls_retired_runs.prefix })
    .from(hls_retired_runs)
    .where(and(isNull(hls_retired_runs.deleted_at), lt(hls_retired_runs.retire_after, now)))
    .orderBy(hls_retired_runs.retire_after)
    .limit(limit);

  let deleted = 0;
  for (const row of due) {
    try {
      await deleteWithPrefixFallback(row.prefix);
      await db
        .update(hls_retired_runs)
        .set({ deleted_at: now })
        .where(eq(hls_retired_runs.id, row.id));
      deleted += 1;
    } catch (err) {
      logger.warn({ err, prefix: row.prefix }, 'HLS retired-run sweep: row failed — will retry next sweep');
    }
  }
  if (deleted > 0) {
    logger.info({ deleted }, 'HLS retired-run sweep');
  }
  return deleted;
}

/**
 * Drop retirement bookkeeping for a video whose ENTIRE `hls/{id}/` storage prefix is being
 * purged by an entity delete (video delete / project delete). Without this, the sweep would
 * later "delete" prefixes that are already gone and keep dead rows pending forever.
 *
 * Swallows errors (logged): bookkeeping cleanup must never fail the entity delete, and a
 * missed cleanup is benign — the sweep tolerates an already-missing prefix.
 */
export async function deleteHlsRetirementRowsForVideo(videoFileId: string): Promise<void> {
  try {
    await db.delete(hls_retired_runs).where(eq(hls_retired_runs.video_file_id, videoFileId));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      logger.debug('hls_retired_runs not migrated yet — nothing to clean up');
      return;
    }
    logger.warn({ err, videoFileId }, 'failed to drop HLS retirement rows for deleted video');
  }
}

/** How often the retention sweep runs while the process is alive (mirrors RUM_REAP_INTERVAL_MS). */
export const HLS_RETIRE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the retention sweep. Returns a stop function.
 *
 * Exactly the RumService.startRumRetentionSweep shape: `unref` so a pending timer never holds
 * the process open, one deferred kick at start so retention still executes on platforms that
 * recycle instances more often than the interval, and a missing table (an image that boots
 * before migration 053 lands) logged at debug, not error.
 */
export function startHlsRetentionSweep(intervalMs = HLS_RETIRE_SWEEP_INTERVAL_MS): () => void {
  const run = (): void => {
    void sweepRetiredHlsRuns().catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === '42P01') {
        logger.debug('HLS retired-run sweep: table not migrated yet, nothing to delete');
        return;
      }
      logger.error({ err }, 'HLS retired-run sweep failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
}
