import { getBoss, PGBOSS_JOB_NAMES } from './pgBoss.js';
import { resolveWorkerQueues, registerWorkers } from './pgBossDriver.js';
import { handlers } from './registry.js';
import { logger } from '../lib/logger.js';

/**
 * Start pg-boss workers in the current process. Shared by the dedicated worker entrypoint
 * (`src/worker.ts`) and the opt-in in-process worker the web server runs when
 * QUEUE_DRIVER=pgboss and WORKER_INLINE=1 (the single-process form for the managed host /
 * local dev). Kept out of `worker.ts` so importing it does not execute that entrypoint.
 */
export async function startWorker(): Promise<void> {
  const boss = await getBoss();
  // WORKER_QUEUES decides what THIS process consumes. Unset means every queue, which is right for
  // a single-process dev box and wrong for production: the API must never pick up `project_export`,
  // because running it there means a capture container launched from the request-serving process,
  // with the Docker socket that requires.
  const queues = resolveWorkerQueues(PGBOSS_JOB_NAMES);
  logger.info({ queues }, '[pg-boss] worker queues resolved');
  await registerWorkers(boss, queues, handlers);
  logger.info({ queues: PGBOSS_JOB_NAMES }, '[worker] ready');
}
