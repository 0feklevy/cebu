import type { JobName, JobPayloads, Queue } from './types.js';
import { createInlineQueue } from './inlineDriver.js';
import { logger } from '../lib/logger.js';
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

/**
 * Jobs that must NEVER run inside the process that accepted the request.
 *
 * An export runs a capture container for minutes per section and then an ffmpeg assembly. Running
 * that inline means it runs in the API process — competing with every request handler, holding the
 * event loop, and (worse) requiring the API container to have a Docker socket, which is a hole in
 * the isolation the whole capture design rests on. The inline fallback existed so "a job is never
 * lost", but for this job losing it is the better outcome: the user gets a truthful 503 and can try
 * again, instead of an API that stops answering while it renders someone's video.
 */
const NEVER_INLINE = new Set<JobName>(['project_export']);

/** Schedule a background job. Fire-and-forget — never blocks or throws to the caller. */
export function enqueueJob<N extends JobName>(name: N, payload: JobPayloads[N]): void {
  if (NEVER_INLINE.has(name)) {
    throw new Error(`${name} must be enqueued durably — use enqueueProjectExport, never enqueueJob`);
  }
  if (pgBossEnabled(name)) {
    pgBossSend(name, payload, () => getInlineQueue().enqueue(name, payload));
    return;
  }
  getInlineQueue().enqueue(name, payload);
}

export class ExportQueueUnavailable extends Error {
  readonly code = 'export_queue_unavailable' as const;
  constructor(detail: string) {
    super('Exporting videos is temporarily unavailable. Please try again in a few minutes.');
    this.name = 'ExportQueueUnavailable';
    this.detail = detail;
  }
  detail: string;
}

/**
 * Enqueue an export DURABLY, and tell the caller whether it worked.
 *
 * Awaitable, because the controller has to answer honestly: a fire-and-forget send that fails leaves
 * a `queued` row nothing will ever pick up, and the user watches a progress bar for a job that does
 * not exist. Singleton on the export id, so a duplicate delivery cannot start a second render of the
 * same row. And no fallback — see NEVER_INLINE.
 */
export async function enqueueProjectExport(exportId: string): Promise<void> {
  if (QUEUE_DRIVER !== 'pgboss') {
    throw new ExportQueueUnavailable(`QUEUE_DRIVER is ${QUEUE_DRIVER}; exports require the durable queue`);
  }
  const { getBoss } = await import('./pgBoss.js');
  try {
    const boss = await getBoss();
    const id = await boss.send('project_export', { exportId }, { singletonKey: exportId });
    if (!id) {
      // pg-boss returns null when the singleton key already has a job in flight — that is the
      // duplicate-delivery case, and it is success: the work is already queued exactly once.
      logger.info({ exportId }, 'export: already queued (singleton) — not enqueued twice');
    }
  } catch (err) {
    throw new ExportQueueUnavailable(err instanceof Error ? err.message : String(err));
  }
}

export type { JobName, JobPayloads, Queue } from './types.js';
