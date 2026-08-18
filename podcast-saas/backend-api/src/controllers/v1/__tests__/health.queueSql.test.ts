/**
 * observability-008 — the queue probe's SQL, against a real Postgres engine.
 *
 * `health.test.ts` proves the probe's JUDGEMENT with a stubbed executor and must stay instant.
 * This proves the thing no stub can: that the statement actually RUNS, and that its two aggregates
 * mean what the stall rule assumes they mean. A health check whose central query is a syntax error
 * is worse than no health check — it would report `queue_unreadable` forever, which reads exactly
 * like a real outage.
 *
 * PGlite (the in-process WASM Postgres the migration suites already use), never `db/index.js`, so
 * this cannot reach any deployment. The DDL is a hand-written minimal `pgboss.job` — only the four
 * columns the query touches — because this is a test of an expression, not of pg-boss's schema.
 * That is also the limit of what it proves: if pg-boss ever renames `state`, `created_on` or
 * `start_after`, this test keeps passing and production breaks. The column names are pinned to
 * pg-boss 12.x.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { probeQueue, QUEUE_STALL_DEFAULT_SECONDS, type RunSql } from '../health.controller.js';

const DDL = `
  CREATE SCHEMA pgboss;
  CREATE TABLE pgboss.job (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    state        text NOT NULL,
    created_on   timestamptz NOT NULL DEFAULT now(),
    start_after  timestamptz NOT NULL DEFAULT now()
  );
`;

let pg: PGlite;
let run: RunSql;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  const db = drizzle(pg);
  run = (async (query) => {
    const result = (await db.execute(query)) as unknown;
    return (Array.isArray(result) ? result : (result as { rows: Array<Record<string, unknown>> }).rows);
  }) as RunSql;
}, 60_000);

afterAll(async () => { await pg?.close(); });

async function reset(): Promise<void> {
  await pg.exec('TRUNCATE pgboss.job;');
}

/** Insert one job `agedSec` seconds old, optionally not runnable until `startsInSec` from now. */
async function job(state: string, agedSec: number, startsInSec = 0): Promise<void> {
  await pg.query(
    `INSERT INTO pgboss.job (name, state, created_on, start_after)
     VALUES ($1, $2, now() - ($3 || ' seconds')::interval, now() + ($4 || ' seconds')::interval)`,
    ['project_export', state, String(agedSec), String(startsInSec)],
  );
}

const ENV = { QUEUE_DRIVER: 'pgboss' };

describe('the queue-depth statement runs on a real engine', () => {
  it('counts nothing, and does not divide by zero, on an empty queue', async () => {
    await reset();
    const out = await probeQueue(ENV, run);
    expect(out).toMatchObject({ status: 'ok', waiting: 0, active: 0, oldestWaitingSec: 0 });
  });

  it('counts created and retry jobs as waiting, and reports the oldest one', async () => {
    await reset();
    await job('created', 30);
    await job('retry', 90);
    await job('active', 500);
    const out = await probeQueue(ENV, run);
    expect(out.waiting).toBe(2);
    expect(out.active).toBe(1);
    // The oldest READY job is the 90s one; the 500s job is active, not waiting.
    expect(out.oldestWaitingSec).toBeGreaterThanOrEqual(89);
    expect(out.oldestWaitingSec).toBeLessThan(120);
  });

  it('does not count a job that is not runnable yet — retry backoff is not a stall', async () => {
    await reset();
    await job('retry', 10_000, 600); // very old, but deliberately scheduled 10 minutes out
    const out = await probeQueue(ENV, run);
    expect(out.waiting, 'a backing-off job was counted as a stalled backlog').toBe(0);
    expect(out.oldestWaitingSec).toBe(0);
    expect(out.status).toBe('ok');
  });

  it('ignores terminal states', async () => {
    await reset();
    for (const state of ['completed', 'failed', 'cancelled']) await job(state, 9_999);
    const out = await probeQueue(ENV, run);
    expect(out).toMatchObject({ waiting: 0, active: 0, oldestWaitingSec: 0, status: 'ok' });
  });

  it('turns a genuinely stalled queue red', async () => {
    await reset();
    await job('created', QUEUE_STALL_DEFAULT_SECONDS + 60);
    const out = await probeQueue(ENV, run);
    expect(out.status).toBe('degraded');
    expect(out.reason).toBe('queue_stalled');
  });

  it('stays green while a worker is visibly chewing through an old backlog', async () => {
    await reset();
    await job('created', QUEUE_STALL_DEFAULT_SECONDS + 60);
    await job('active', 5);
    const out = await probeQueue(ENV, run);
    expect(out.status).toBe('ok');
  });

  it('reports queue_unreadable — not an empty queue — when the schema is absent', async () => {
    const bare = new PGlite();
    try {
      const db = drizzle(bare);
      const runBare = (async (query) => {
        const result = (await db.execute(query)) as unknown;
        return (Array.isArray(result) ? result : (result as { rows: Array<Record<string, unknown>> }).rows);
      }) as RunSql;
      const out = await probeQueue(ENV, runBare);
      expect(out.status).toBe('down');
      expect(out.reason).toBe('queue_unreadable');
    } finally {
      await bare.close();
    }
  }, 60_000);
});
