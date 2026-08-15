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

/**
 * How many jobs of a given kind this worker runs at once.
 *
 * `project_export` is deliberately serial. A crop is I/O-bound and two of them interleave happily,
 * but an export with a simulation section runs a capture container that is allowed `--cpus 2` — on
 * the 2-vCPU worker host that is the whole machine. Two concurrent exports do not finish in the same
 * total time; they contend, each takes longer than the pair would have taken in sequence, and both
 * move closer to their wall-clock kill. Serialising is what makes the per-section time budget mean
 * anything.
 *
 * `QUEUE_EXPORT_CONCURRENCY` raises it for a host that genuinely has the cores.
 */
function concurrencyFor(name: JobName): number {
  if (name === 'project_export') {
    return Math.max(1, Number(process.env.QUEUE_EXPORT_CONCURRENCY ?? '1'));
  }
  return cropConcurrency();
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
/**
 * Which queues THIS process may consume, from `WORKER_QUEUES`.
 *
 * Without an allowlist every process that starts a worker consumes every queue, so the API — which
 * has no Docker socket and no business rendering video — would pick up an export and run a capture
 * container it cannot launch, or worse, could. Splitting the pool is not a deployment detail: it is
 * what keeps Docker access out of the request-serving process.
 *
 * A general worker gets `crop,video_generate`. A dedicated export orchestrator gets
 * `project_export` and nothing else. An unknown name is a startup error rather than a silent
 * omission, because a typo would otherwise mean a queue nobody consumes and jobs that sit forever.
 */
export function resolveWorkerQueues(
  available: readonly JobName[],
  env: NodeJS.ProcessEnv = process.env,
): JobName[] {
  const raw = env.WORKER_QUEUES?.trim();
  if (!raw) return [...available];
  const named = raw.split(',').map((n) => n.trim()).filter(Boolean);
  const unknown = named.filter((n) => !(available as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `WORKER_QUEUES names unknown queue(s): ${unknown.join(', ')}; known: ${available.join(', ')}`,
    );
  }
  return named as JobName[];
}

export async function registerWorkers(
  boss: PgBossType,
  names: readonly JobName[],
  handlers: JobHandlers,
): Promise<void> {
  for (const name of names) {
    const run = handlers[name] as (payload: unknown) => Promise<unknown>;
    await boss.work(name, { localConcurrency: concurrencyFor(name) }, async (jobs) => {
      for (const job of jobs) {
        await run(job.data); // throwing fails the job → pg-boss retries with backoff
      }
    });
    logger.info({ queue: name }, '[pg-boss] worker registered');
  }
}
