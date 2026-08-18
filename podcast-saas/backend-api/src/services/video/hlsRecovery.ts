/**
 * Recovery for HLS transcodes nothing is running any more (job-queue-003).
 *
 * THE BUG THIS MODULE EXISTS FOR
 * The only thing that ever cleared `hls_status='processing'` was a pass in `server.ts` that ran
 * ONCE, at boot, and only for rows whose `hls_started_at` was already 30 minutes old. Those two
 * rules do not intersect where the failure actually happens: a transcode orphaned five minutes
 * before a deploy is four minutes and change too YOUNG for the boot sweep, and the boot sweep is
 * the last thing that will ever look at it. The row sits at `processing` forever, the player
 * never gets an HLS ladder, and no log line is ever written about it.
 *
 * TWO CHANGES, AND THE SECOND IS WHAT MAKES THE FIRST SAFE
 *
 *  1. The sweep runs on a TIMER, not only at boot, so a row that is not yet stale at boot is
 *     collected by a later pass instead of never.
 *
 *  2. A live transcode BEATS A HEARTBEAT onto `hls_started_at` (`beatHlsHeartbeat`), so the
 *     predicate is a liveness test rather than a duration guess. Without it, turning a boot-only
 *     30-minute rule into a repeating one would REAP LIVE WORK: any honest transcode longer than
 *     the window — a long 4K source is not exotic — would be failed out from under itself by the
 *     next tick. With it, "untouched for HLS_STALE_AFTER_MS" means the writer is gone, and the
 *     window can drop from a 30-minute guess to five minutes of silence.
 *
 * WHY `hls_started_at` AND NOT A NEW COLUMN
 * A dedicated `hls_heartbeat_at` would say what it means, and it needs a migration. This module
 * deliberately adds none, so the column already there carries the lease: it is read by exactly
 * one thing (this sweep) and copied by one more (duplication, which nulls it for a reset row),
 * so widening it from "when it started" to "last sign of life" changes no other reader. The
 * heartbeat write is fenced on `hls_status='processing'`, so it can never touch a finished row.
 *
 * POOLER SAFETY
 * Supabase's transaction pooler (6543) has no session advisory locks, no LISTEN/NOTIFY and no
 * session state, so none of those may appear here — and none do. Two app instances sweeping at
 * the same moment are made safe by the UPDATE itself: the staleness predicate is repeated in the
 * OUTER `WHERE`, so under READ COMMITTED the second writer re-evaluates it against the row the
 * first one already committed, finds `hls_status='failed'`, and matches zero rows. One recovery,
 * one log line, no lock of any kind.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { video_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

/** How often a running transcode proves it is still alive. */
export const HLS_HEARTBEAT_MS = 15_000;

/**
 * Silence that means the writer is gone. Twenty missed beats — generous enough that a stalled
 * event loop or a slow DB write does not read as death, short enough that a user watching a
 * "Processing…" spinner gets a truthful answer in minutes instead of never.
 */
export const HLS_STALE_AFTER_MS = 20 * HLS_HEARTBEAT_MS;

/** How often the reaper runs while the process is alive. */
export const HLS_SWEEP_INTERVAL_MS = 60_000;

/** Rows older than this have not been heard from since. */
export function hlsStaleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - HLS_STALE_AFTER_MS);
}

export const HLS_ABANDONED_MESSAGE = 'Interrupted by process restart';

/**
 * Fail every `processing` transcode that has gone quiet. Returns how many were reaped.
 *
 * `hls_started_at IS NULL` is deliberately NOT matched: `lt()` is NULL-false, and a row that
 * claims to be processing without ever recording a start is a shape this pipeline does not
 * produce (`runVideoTranscode` writes both in one statement). Reaping on a NULL would mean
 * inventing a death from missing evidence.
 */
export async function sweepStuckTranscodes(limit = 50, now: Date = new Date()): Promise<number> {
  const staleBefore = hlsStaleBefore(now);
  const abandoned = and(
    eq(video_files.hls_status, 'processing'),
    lt(video_files.hls_started_at, staleBefore),
  );
  const reaped = await db
    .update(video_files)
    .set({ hls_status: 'failed', hls_error: HLS_ABANDONED_MESSAGE, hls_finished_at: now })
    .where(and(
      sql`${video_files.id} IN (
        SELECT ${video_files.id} FROM ${video_files}
        WHERE ${abandoned} ORDER BY ${video_files.hls_started_at} ASC LIMIT ${limit})`,
      // Repeated OUTSIDE the subquery on purpose — this is the CAS that stops a second instance
      // from reaping the same row twice. See POOLER SAFETY above.
      abandoned,
    )!)
    .returning({ id: video_files.id });
  if (reaped.length > 0) {
    logger.warn({ count: reaped.length }, 'Recovered stuck HLS transcodes');
  }
  return reaped.length;
}

/**
 * Prove a transcode is still alive. Returns the stop function; call it in a `finally`.
 *
 * Unref'd so it can never hold the process open, and fenced on `hls_status='processing'` so a
 * beat that races the final status write cannot drag a finished row's timestamp forward.
 */
export function beatHlsHeartbeat(videoFileId: string, intervalMs = HLS_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    void db
      .update(video_files)
      .set({ hls_started_at: new Date() })
      .where(and(eq(video_files.id, videoFileId), eq(video_files.hls_status, 'processing'))!)
      .catch((err: unknown) => logger.warn({ err, videoFileId }, 'hls heartbeat failed'));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => { clearInterval(timer); };
}

/**
 * Start the reaper. Returns a stop function. `startExportSweep`'s shape: unref'd timer plus one
 * deferred kick, because a process recycled faster than the interval is exactly the one that
 * strands rows — the kick is what replaces the old boot-only pass.
 */
export function startHlsRecoverySweep(intervalMs = HLS_SWEEP_INTERVAL_MS): () => void {
  const run = (): void => {
    void sweepStuckTranscodes().catch((err: unknown) => {
      logger.error({ err }, 'hls reaper failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
}
