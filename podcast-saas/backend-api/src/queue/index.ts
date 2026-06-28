import type { JobName, JobPayloads, Queue } from './types.js';
import { createInlineQueue } from './inlineDriver.js';
import { handlers } from './registry.js';
import { PGBOSS_JOB_NAMES } from './pgBoss.js';
import { pgBossSend } from './pgBossDriver.js';

/**
 * Background-job producer entrypoint.
 *
 * `QUEUE_DRIVER=inline` (default) preserves the historical `setImmediate(runX(...))`
 * behaviour for every job. `QUEUE_DRIVER=pgboss` routes the durable job names
 * (PGBOSS_JOB_NAMES — Phase B: `crop`) through pg-boss while every other job still runs
 * inline. pg-boss failures fall back to inline, so a job is never lost.
 *
 * The inline queue is built lazily so the registry → service → queue import cycle resolves at
 * runtime; the pg-boss module is only loaded once a durable job is actually enqueued.
 */
const QUEUE_DRIVER = (process.env.QUEUE_DRIVER ?? 'inline').toLowerCase();
const pgBossJobs = new Set<JobName>(PGBOSS_JOB_NAMES);

function pgBossEnabled(name: JobName): boolean {
  return QUEUE_DRIVER === 'pgboss' && pgBossJobs.has(name);
}

let inlineQueue: Queue | undefined;
function getInlineQueue(): Queue {
  if (!inlineQueue) inlineQueue = createInlineQueue(handlers);
  return inlineQueue;
}

/** Schedule a background job. Fire-and-forget — never blocks or throws to the caller. */
export function enqueueJob<N extends JobName>(name: N, payload: JobPayloads[N]): void {
  if (pgBossEnabled(name)) {
    pgBossSend(name, payload, () => getInlineQueue().enqueue(name, payload));
    return;
  }
  getInlineQueue().enqueue(name, payload);
}

export type { JobName, JobPayloads, Queue } from './types.js';
