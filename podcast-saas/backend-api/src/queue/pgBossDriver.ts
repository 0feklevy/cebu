import type { PgBoss as PgBossType } from 'pg-boss';
import type { JobHandlers, JobName, JobPayloads } from './types.js';
import { getBoss } from './pgBoss.js';
import { logger } from '../lib/logger.js';

/**
 * Producer + consumer glue for the pg-boss driver.
 *
 * Producer (`pgBossSend`): persists the job to Postgres. Fire-and-forget — on any send
 * failure it runs the supplied inline fallback so a job is never silently lost when pg-boss
 * is misconfigured or down (no worse than the historical in-process behaviour).
 *
 * Consumer (`registerWorkers`): registers a batched worker per durable queue. Handlers are
 * already idempotent (DB CAS claims), so pg-boss's at-least-once delivery is safe.
 */

function cropConcurrency(): number {
  return Math.max(1, Number(process.env.QUEUE_CROP_CONCURRENCY ?? '2'));
}

/** Enqueue a durable job. Never throws; falls back to `inline()` if the send fails. */
export function pgBossSend<N extends JobName>(
  name: N,
  payload: JobPayloads[N],
  inline: () => void,
): void {
  getBoss()
    // singletonKey collapses duplicate *pending* jobs for the same target into one; the DB
    // CAS claim remains the authoritative guard against double *processing*.
    .then((boss) => boss.send(name, payload, { singletonKey: singletonKeyFor(name, payload) }))
    .then((id) => {
      if (!id) logger.debug({ job: name }, '[queue] pg-boss send deduped (existing pending job)');
    })
    .catch((err) => {
      logger.error({ err, job: name }, '[queue] pg-boss send failed — running inline as fallback');
      inline();
    });
}

/** A stable per-target key so repeated triggers for the same video don't pile up in the queue. */
function singletonKeyFor<N extends JobName>(name: N, payload: JobPayloads[N]): string | undefined {
  if (name === 'crop') return (payload as JobPayloads['crop']).videoFileId;
  return undefined;
}

/** Register a batched worker for each durable queue. ffmpeg stays globally bounded by ffmpegLimit. */
export async function registerWorkers(
  boss: PgBossType,
  names: readonly JobName[],
  handlers: JobHandlers,
): Promise<void> {
  for (const name of names) {
    const run = handlers[name] as (payload: unknown) => Promise<unknown>;
    await boss.work(name, { localConcurrency: cropConcurrency() }, async (jobs) => {
      for (const job of jobs) {
        await run(job.data); // throwing fails the job → pg-boss retries with backoff
      }
    });
    logger.info({ queue: name }, '[pg-boss] worker registered');
  }
}
