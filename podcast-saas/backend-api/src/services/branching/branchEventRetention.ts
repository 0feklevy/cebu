/**
 * Retention for `branch_path_events` — the fastest-growing table in the product, and the only
 * per-playback one with no reaper (night run 2026-09-03 §7).
 *
 * Every viewer interaction with a branching video inserts a row; nothing ever removed one. The
 * analytics that read it aggregate the recent past, so ninety days is kept — long enough for a
 * creator to compare a month against the previous one, short enough that the table stops being
 * a function of total lifetime traffic. Same shape as `reapRumEvents`: bounded per statement AND
 * bounded in passes, an ISO string with an explicit cast (never a Date inside a raw fragment —
 * postgres.js refuses it and PGlite does not, which is how the RUM sweep once failed silently on
 * every production tick), and a missing table is not an error.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { branch_path_events } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

export const BRANCH_EVENT_RETENTION_DAYS = 90;
export const BRANCH_EVENT_REAP_BATCH = 5000;
export const BRANCH_EVENT_REAP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PASSES = 1000;

export function retentionCutoff(now: Date, days = BRANCH_EVENT_RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

export interface ReapDeps {
  /** Delete one bounded batch older than `cutoff`; returns how many rows went. */
  deleteBatch: (cutoff: Date, limit: number) => Promise<number>;
}

const defaultDeps: ReapDeps = {
  async deleteBatch(cutoff, limit) {
    const deleted = await db
      .delete(branch_path_events)
      .where(sql`ctid IN (
        SELECT ctid FROM branch_path_events
         WHERE created_at < ${cutoff.toISOString()}::timestamptz
         LIMIT ${limit}
      )`)
      .returning({ id: branch_path_events.id });
    return deleted.length;
  },
};

/** Delete everything older than the retention window, in bounded batches. Returns the count. */
export async function reapBranchPathEvents(now: Date = new Date(), deps: ReapDeps = defaultDeps): Promise<number> {
  const cutoff = retentionCutoff(now);
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const n = await deps.deleteBatch(cutoff, BRANCH_EVENT_REAP_BATCH);
    total += n;
    if (n < BRANCH_EVENT_REAP_BATCH) break;
  }
  if (total > 0) logger.info({ deleted: total, cutoff: cutoff.toISOString() }, 'branch analytics retention: reaped old path events');
  return total;
}

/** Every six hours, and once shortly after boot — a process recycled hourly would otherwise never reap. */
export function startBranchEventRetentionSweep(intervalMs = BRANCH_EVENT_REAP_INTERVAL_MS): () => void {
  const run = (): void => {
    void reapBranchPathEvents().catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === '42P01') { logger.debug('branch analytics retention: table not migrated yet'); return; }
      logger.error({ err }, 'branch analytics retention sweep failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const first = setTimeout(run, 30_000);
  if (typeof first.unref === 'function') first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}
