import { getBoss, PGBOSS_JOB_NAMES } from './pgBoss.js';
import { registerWorkers } from './pgBossDriver.js';
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
  await registerWorkers(boss, PGBOSS_JOB_NAMES, handlers);
  logger.info({ queues: PGBOSS_JOB_NAMES }, '[worker] ready');
}
