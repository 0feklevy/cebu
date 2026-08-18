import { PGBOSS_JOB_NAMES, deadLetterName, getBoss } from './pgBoss.js';
import { logger } from '../lib/logger.js';

/**
 * Queue depth for operators — including the DEAD-LETTER queues, which nothing read (job-queue-009).
 *
 * `ensureQueues` gives every durable queue a `<name>-dead` partner, so a job that exhausts its
 * retries is copied there rather than disappearing. That was only half a system: no code path, no
 * endpoint and no log line ever queried those queues. A poison job — an export that fails the same
 * way on every attempt, a transcode with a corrupt source — left the live queue silently, the
 * user's row stayed "processing" forever, and the only way to discover it was to know the pgboss
 * schema and go looking by hand.
 *
 * The dead-letter number is reported NEXT TO the live one on purpose. "Four jobs dead" means one
 * thing when the queue is empty and another when a thousand are moving through it; a count with no
 * denominator is the kind of metric people learn to ignore.
 */

/** Depth of one queue and of its dead-letter partner. */
export interface QueueDepth {
  /** Jobs runnable now — `queuedCount` minus future-dated ones. This is the real backlog. */
  ready: number;
  /** Jobs a worker currently holds. */
  active: number;
  /** Recent failures still retained on the LIVE queue (a rolling count, not all-time). */
  failed: number;
  /** Jobs that exhausted every retry and were copied to `<name>-dead`. NOTHING RETRIES THESE. */
  dead_letter: number;
}

export interface QueueDepths {
  /** Per durable queue, keyed by job name. */
  queues: Record<string, QueueDepth>;
  /** Sum across every dead-letter queue — the single number worth alerting on. */
  dead_letter_total: number;
  /** Total runnable backlog across every durable queue. */
  ready_total: number;
  /** When the snapshot was taken, so a cached or stale read is visible as such. */
  observed_at: string;
}

/**
 * Read every durable queue's depth, or null when there is nothing to read.
 *
 * Null rather than throwing, and null rather than 0: an operator has to be able to tell "no jobs
 * are dead" from "I could not ask". Returns null on the inline driver (there are no queues) and on
 * any pg-boss failure — a stats endpoint must still answer for everything else, and starting
 * pg-boss just to render a dashboard would be its own bug.
 */
export async function readQueueDepths(): Promise<QueueDepths | null> {
  if ((process.env.QUEUE_DRIVER ?? 'inline').toLowerCase() !== 'pgboss') return null;
  try {
    const boss = await getBoss();
    const wanted = PGBOSS_JOB_NAMES.flatMap((n) => [n, deadLetterName(n)]);
    const rows = await boss.getQueues(wanted);
    const byName = new Map(rows.map((r) => [r.name, r]));

    const queues: Record<string, QueueDepth> = {};
    let deadTotal = 0;
    let readyTotal = 0;
    for (const name of PGBOSS_JOB_NAMES) {
      const live = byName.get(name);
      const dead = byName.get(deadLetterName(name));
      // A dead-letter job sits in `created` and is never fetched, so `ready` is its depth.
      const deadDepth = dead?.readyCount ?? 0;
      const readyDepth = live?.readyCount ?? 0;
      queues[name] = {
        ready: readyDepth,
        active: live?.activeCount ?? 0,
        failed: live?.failedCount ?? 0,
        dead_letter: deadDepth,
      };
      deadTotal += deadDepth;
      readyTotal += readyDepth;
    }
    return {
      queues,
      dead_letter_total: deadTotal,
      ready_total: readyTotal,
      observed_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err }, '[queue] could not read queue depths');
    return null;
  }
}
