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
export function createInlineQueue(handlers: JobHandlers): Queue {
  return {
    enqueue<N extends JobName>(name: N, payload: JobPayloads[N]): void {
      setImmediate(() => {
        Promise.resolve(handlers[name](payload)).catch((err) => {
          logger.warn({ err, job: name }, '[queue] inline job failed');
        });
      });
    },
  };
}
