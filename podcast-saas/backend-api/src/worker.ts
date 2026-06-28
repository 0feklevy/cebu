/**
 * Dedicated worker entrypoint (`npm run worker` / `npm run dev:worker`).
 *
 * Runs pg-boss workers in their own process so heavy ffmpeg work executes off the web tier.
 * Requires QUEUE_DRIVER=pgboss semantics (it always starts pg-boss) and a DIRECT/session-mode
 * Postgres connection via QUEUE_DATABASE_URL (falls back to DATABASE_URL).
 *
 * On the single-app managed host that cannot run a second process, use the web server's
 * in-process worker instead (WORKER_INLINE=1); this file is for hosts that support a separate
 * worker service (Railway/Render) and for mirroring that shape locally.
 */
import { startWorker } from './queue/startWorker.js';
import { stopBoss } from './queue/pgBoss.js';
import { logger } from './lib/logger.js';

startWorker().catch((err) => {
  logger.error({ err }, '[worker] failed to start');
  process.exit(1);
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, '[worker] shutdown signal received — draining');
  await stopBoss();
  process.exit(0);
};
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
