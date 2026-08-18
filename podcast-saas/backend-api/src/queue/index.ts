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
 * behaviour for every job — the single-process form for local dev and tests.
 * `QUEUE_DRIVER=pgboss` routes PGBOSS_JOB_NAMES through pg-boss; since job-queue-005 that is
 * EVERY job kind, because every one of them either spends money on a third-party API or runs for
 * minutes, and an inline job dies with the process that accepted it. pg-boss send failures still
 * fall back to inline, so a job is never lost — except `project_export`, see NEVER_INLINE.
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
 * not exist. And no fallback — see NEVER_INLINE.
 *
 * The export id is the singleton key, and the queue's `short` policy is what makes that mean
 * something (job-queue-006 — under pg-boss's default `standard` policy the key was inert). What it
 * buys is precise: a second delivery arriving while the first is still WAITING is collapsed. It is
 * not the guard against a second render — that is `ProjectExportService.claim()`, which refuses a
 * live encode, and which holds whether or not this key exists.
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
      // Under the `short` policy pg-boss answers null when this key already has a job WAITING to
      // start — the duplicate-delivery case, and it is success: the work is already queued once.
      logger.info({ exportId }, 'export: already queued (singleton) — not enqueued twice');
    }
  } catch (err) {
    throw new ExportQueueUnavailable(err instanceof Error ? err.message : String(err));
  }
}

export type { JobName, JobPayloads, Queue } from './types.js';
