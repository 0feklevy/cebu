import type { JobHandlers, JobName, JobPayloads, Queue } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * Inline queue driver — reproduces the historical fire-and-forget behaviour exactly:
 * each job is scheduled on the current process via `setImmediate` and its rejection is
 * swallowed (logged), so producers never block the request and never see a throw.
 *
 * No durability, no retries: this is the default driver and keeps local development a
 * single process. Durable drivers (pg-boss) plug in behind the same Queue interface in a
 * later phase; the job handlers are already idempotent (DB CAS claims / source-hash skips),
 * so moving to at-least-once delivery is safe.
 */
// Tracks inline jobs that have been scheduled but not yet settled, so a graceful shutdown
// can wait for them instead of letting SIGTERM hard-kill an in-flight transcode/crop
// (backend-004). Module-level so the single inline queue shares one registry.
const inFlight = new Set<Promise<unknown>>();

export function createInlineQueue(handlers: JobHandlers): Queue {
  return {
    enqueue<N extends JobName>(name: N, payload: JobPayloads[N]): void {
      setImmediate(() => {
        const p = Promise.resolve(handlers[name](payload))
          .catch((err) => {
            logger.warn({ err, job: name }, '[queue] inline job failed');
          })
          .finally(() => { inFlight.delete(p); });
        inFlight.add(p);
      });
    },
  };
}

/**
 * Wait (up to `timeoutMs`) for in-flight inline jobs to finish. Called from the graceful
 * shutdown path so a managed-host redeploy doesn't kill a running job mid-write. A genuinely
 * long job (e.g. a big transcode) may still exceed the bound and be cut off — that is no worse
 * than today and short jobs (crop/captions/metadata) now drain cleanly.
 */
export async function drainInlineJobs(timeoutMs = 25_000): Promise<void> {
  if (inFlight.size === 0) return;
  logger.info({ count: inFlight.size }, '[queue] draining in-flight inline jobs before shutdown');
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
