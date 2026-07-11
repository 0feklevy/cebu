import type { PgBoss as PgBossType, QueueOptions } from 'pg-boss';
import type { JobName } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * pg-boss lifecycle (Phase B). Lazily constructed so the durable driver — and the `pg-boss`
 * module itself — is never loaded on the default `inline` path or in tests (pglite). Only
 * touched when QUEUE_DRIVER=pgboss and something actually enqueues/works a durable job.
 *
 * Connection: prefers QUEUE_DATABASE_URL (point this at a DIRECT/session-mode Postgres
 * endpoint), falling back to DATABASE_URL. LISTEN/NOTIFY is opt-in (QUEUE_PGBOSS_LISTEN=1)
 * and requires a session-pinned connection; polling is always the correctness floor and works
 * through transaction poolers, so it is the default.
 */

/** Job names routed through pg-boss in this phase. Phase B: crop; Phase C: video_generate. */
export const PGBOSS_JOB_NAMES = ['crop', 'video_generate'] as const satisfies readonly JobName[];

const DLQ_SUFFIX = '-dead';

// Per-queue retry/backoff + expiry. Inherited by each job; expireInSeconds must exceed the
// worst-case job runtime (crop's stale-claim window is 20 min, so 30 min is a safe ceiling;
// video_generate polls up to 20 min then downloads + HLS-transcodes, so 45 min).
const QUEUE_OPTIONS: Record<(typeof PGBOSS_JOB_NAMES)[number], QueueOptions> = {
  crop: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 30 * 60 },
  video_generate: { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 45 * 60 },
};

function connectionString(): string {
  return (
    process.env.QUEUE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/podcast_saas'
  );
}

function needsSsl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.com') || host.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

let bossPromise: Promise<PgBossType> | null = null;

/** Get the started pg-boss singleton, creating + starting it (and its queues) on first use. */
export function getBoss(): Promise<PgBossType> {
  if (bossPromise) return bossPromise;
  bossPromise = (async () => {
    const url = connectionString();
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({
      connectionString: url,
      schema: process.env.QUEUE_PGBOSS_SCHEMA ?? 'pgboss',
      max: Number(process.env.QUEUE_PGBOSS_MAX ?? '4'),
      ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
      useListenNotify: process.env.QUEUE_PGBOSS_LISTEN === '1',
    });
    boss.on('error', (err) => logger.error({ err }, '[pg-boss] runtime error'));
    await boss.start();
    await ensureQueues(boss);
    logger.info({ schema: process.env.QUEUE_PGBOSS_SCHEMA ?? 'pgboss' }, '[pg-boss] started');
    return boss;
  })().catch((err) => {
    bossPromise = null; // allow a later call to retry a fresh start
    throw err;
  });
  return bossPromise;
}

/** Idempotently create each durable queue and its dead-letter queue. */
async function ensureQueues(boss: PgBossType): Promise<void> {
  for (const name of PGBOSS_JOB_NAMES) {
    const dead = `${name}${DLQ_SUFFIX}`;
    try {
      await boss.createQueue(dead);
      await boss.createQueue(name, { ...QUEUE_OPTIONS[name], deadLetter: dead });
    } catch (err) {
      // createQueue is safe to call repeatedly; log and continue if the queue already exists.
      logger.debug({ err, queue: name }, '[pg-boss] createQueue (already exists?)');
    }
  }
}

/** Gracefully stop pg-boss (drains in-flight work). Safe to call when never started. */
export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const pending = bossPromise;
  bossPromise = null;
  try {
    const boss = await pending;
    await boss.stop({ graceful: true, timeout: 30_000 });
    logger.info('[pg-boss] stopped');
  } catch (err) {
    logger.warn({ err }, '[pg-boss] stop failed');
  }
}
