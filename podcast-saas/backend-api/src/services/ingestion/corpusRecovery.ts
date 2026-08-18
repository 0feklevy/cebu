/**
 * Recovery for corpus ingestions nothing is running any more (observability-002).
 *
 * THE BUG THIS MODULE EXISTS FOR
 * `CorpusBuilder.ingest` flips the row to `processing` and is the ONLY writer that ever moves it
 * off again — to `ready` in its happy path, to `failed` in its catch. A catch block does not run
 * when the process dies, and ingestion is fire-and-forget off the upload request
 * (`corpus.controller.ts` calls `builder.ingest(...).catch(log)` without awaiting), so a deploy or
 * a crash mid-ingest leaves the row at `processing` with nothing anywhere in the codebase that
 * will ever look at it again. The upload UI polls that column, so the user watches "Ingesting…"
 * for the life of the database. Grepping `ingestion_status` across `src/` finds four writers, all
 * inside CorpusBuilder and the controller's INSERT: there was no sweep of any kind.
 *
 * WHY A DURATION BOUND AND NOT A HEARTBEAT
 * The honest lease wants a `claimed_at` / `heartbeat_at` column, and `corpora` has neither — it
 * carries `created_at` and nothing else time-shaped. Adding one is a migration, and this change
 * deliberately ships none. `created_at` is nevertheless a SOUND clock here, for a specific
 * structural reason: every path that ingests a corpus ingests it IMMEDIATELY after inserting the
 * row (both branches of POST /corpus), there is no re-ingest endpoint, and the duplication path
 * resets a copied `processing` row to `pending` rather than carrying it. So for any row that is
 * `processing`, "created N minutes ago" IS "has been ingesting for N minutes".
 *
 * The bound is therefore set well above the slowest legitimate ingest rather than tuned tight:
 * over-reaping kills real work, while under-reaping only delays an answer the user currently
 * never gets at all.
 *
 * POOLER SAFETY
 * No advisory locks, no LISTEN/NOTIFY, no session state — none of which Supabase's transaction
 * pooler supports. Two instances sweeping at once are serialised by the UPDATE itself: the
 * staleness predicate is repeated in the OUTER `WHERE`, so under READ COMMITTED the second
 * writer re-evaluates it against the committed row, sees `failed`, and matches nothing.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { corpora } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

/**
 * How long a corpus may be `processing` before it is presumed dead. An hour is far longer than
 * any real extraction — the durable form of this job caps itself at 300 s (`corpus.ingest`'s
 * `maxDuration`) — and the generosity is deliberate: see the note on duration bounds above.
 */
export const CORPUS_STALE_AFTER_MS = 60 * 60 * 1000;

/** How often the reaper runs while the process is alive. */
export const CORPUS_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const CORPUS_ABANDONED_MESSAGE =
  'Ingestion was interrupted before it finished — please re-add this source.';

export function corpusStaleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - CORPUS_STALE_AFTER_MS);
}

/**
 * Fail every `processing` corpus whose ingestion cannot still be running. Returns how many were
 * reaped. Bounded per pass so one sweep can never turn into an unbounded write.
 */
export async function sweepStuckCorpusIngestions(limit = 50, now: Date = new Date()): Promise<number> {
  const staleBefore = corpusStaleBefore(now);
  const abandoned = and(
    eq(corpora.ingestion_status, 'processing'),
    lt(corpora.created_at, staleBefore),
  );
  const reaped = await db
    .update(corpora)
    .set({ ingestion_status: 'failed', error: CORPUS_ABANDONED_MESSAGE })
    .where(and(
      sql`${corpora.id} IN (
        SELECT ${corpora.id} FROM ${corpora}
        WHERE ${abandoned} ORDER BY ${corpora.created_at} ASC LIMIT ${limit})`,
      // Repeated outside the subquery: this is the CAS that stops a second instance from
      // reaping the same row twice. See POOLER SAFETY above.
      abandoned,
    )!)
    .returning({ id: corpora.id });
  if (reaped.length > 0) {
    logger.warn({ count: reaped.length }, 'Recovered stuck corpus ingestions');
  }
  return reaped.length;
}

/**
 * Start the reaper. Returns a stop function. Unref'd timer plus one deferred kick — the kick is
 * what handles the rows the process that just died left behind, and the interval is what makes
 * "was not stale yet when we booted" stop being permanent.
 */
export function startCorpusIngestionSweep(intervalMs = CORPUS_SWEEP_INTERVAL_MS): () => void {
  const run = (): void => {
    void sweepStuckCorpusIngestions().catch((err: unknown) => {
      logger.error({ err }, 'corpus reaper failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
}
