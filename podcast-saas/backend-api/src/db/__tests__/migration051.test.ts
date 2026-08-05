/**
 * Migration 051 (`sim_rum_events` + the RUM kill switch) against a real Postgres engine.
 *
 * Same isolation contract as the 049/050 suites: this file never imports `db/index.js`, so it
 * cannot reach the database preview and production share.
 *
 * The claims that matter are about failure DIRECTION. `rum_sample_rate` must default to collecting
 * NOTHING, retention must be bounded so it can neither be disabled nor made permanent by a careless
 * UPDATE, and the text columns must be capped in the DDL — not only in the validator — because the
 * endpoint feeding them is unauthenticated and a code change must not be able to remove the last
 * line of defence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TARGET = '051_sim_rum.sql';
const ROLLBACK = '051_sim_rum.rollback.sql';

const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
const applyForward = (): Promise<unknown> => pg.exec(forwardSql);

/**
 * Apply 051 AND everything after it.
 *
 * Needed by the Drizzle-shape assertions only. schema.ts always describes migration HEAD and
 * Drizzle emits every declared column in a full-row select, so a test stopping at 051 and then
 * driving a full-row read asserts against a database the current schema.ts no longer describes —
 * the very hazard this file documents, reaching its own harness. The catalog assertions
 * deliberately do NOT use this: they must keep testing 051 in isolation.
 */
const applyForwardToHead = async (): Promise<void> => {
  await applyForward();
  for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
};
const applyRollback = (): Promise<unknown> => pg.exec(rollbackSql);

async function snapshot(): Promise<unknown> {
  const cols = await rows(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name IN ('sim_rum_events','admin_settings')
         OR (table_name = 'simulations' AND column_name = 'prepare_budget_ms')
      ORDER BY table_name, column_name`);
  const cons = await rows(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('sim_rum_events'::regclass, 'admin_settings'::regclass, 'simulations'::regclass)
        AND conname LIKE '%prepare_budget%' OR conrelid IN ('sim_rum_events'::regclass, 'admin_settings'::regclass)
      ORDER BY conname`);
  const idx = await rows(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename IN ('sim_rum_events','admin_settings') ORDER BY indexname`);
  return { cols, cons, idx };
}

const EVENT = (over: Record<string, unknown> = {}) => ({
  session_id: 'session-abcdef', package_revision: 'abc123', kind: 'transition', t_ms: 10, ...over,
});

async function insertEvent(over: Record<string, unknown> = {}): Promise<void> {
  const e = EVENT(over);
  const keys = Object.keys(e);
  await pg.query(
    `INSERT INTO sim_rum_events (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    keys.map((k) => (e as Record<string, unknown>)[k]),
  );
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  db = drizzle(pg, { schema });
});
afterEach(async () => { await pg.close(); });

// ── The ordering hazard ──────────────────────────────────────────────────────────────────────────

describe('051 — the ordering hazard', () => {
  it('an admin_settings read fails with 42703 before 051 and succeeds after', async () => {
    await expect(db.query.admin_settings.findFirst()).rejects.toMatchObject({ code: '42703' });
    await applyForwardToHead();
    await expect(db.query.admin_settings.findFirst()).resolves.toBeDefined();
  });

  it('a sim_rum_events read fails with 42P01 before and succeeds after', async () => {
    await expect(db.query.sim_rum_events.findMany()).rejects.toMatchObject({ code: '42P01' });
    await applyForwardToHead();
    await expect(db.query.sim_rum_events.findMany()).resolves.toEqual([]);
  });
});

// ── The kill switch ──────────────────────────────────────────────────────────────────────────────

describe('051 — the kill switch defaults to collecting nothing', () => {
  beforeEach(applyForward);

  it('rum_sample_rate defaults to 0 and is NOT NULL', async () => {
    const [c] = await rows<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'admin_settings' AND column_name = 'rum_sample_rate'`);
    // A viewer must send nothing until an operator deliberately turns it on.
    // `toContain('0')` would pass for DEFAULT 0.5 — the text of the default contains a '0'. The
    // claim is that collection is OFF, so the VALUE is what must be asserted.
    expect(c!.is_nullable).toBe('NO');
    const [row] = await rows<{ rum_sample_rate: number }>(
      `SELECT rum_sample_rate FROM admin_settings LIMIT 1`);
    expect(Number(row!.rum_sample_rate), 'collection is not off by default').toBe(0);
  });

  it('refuses a sample rate outside [0,1]', async () => {
    await pg.query(`INSERT INTO admin_settings DEFAULT VALUES`).catch(() => undefined);
    for (const bad of [-0.1, 1.1, 2]) {
      await expect(pg.query(`UPDATE admin_settings SET rum_sample_rate = $1`, [bad]))
        .rejects.toMatchObject({ code: '23514' });
    }
    await expect(pg.query(`UPDATE admin_settings SET rum_sample_rate = 0.05`)).resolves.toBeDefined();
  });

  it('bounds retention in BOTH directions', async () => {
    await pg.query(`INSERT INTO admin_settings DEFAULT VALUES`).catch(() => undefined);
    // 0 would silently disable retention and let the table grow forever.
    await expect(pg.query(`UPDATE admin_settings SET rum_retention_days = 0`))
      .rejects.toMatchObject({ code: '23514' });
    // An unbounded upper value would let one careless UPDATE make a 30-day dataset permanent.
    await expect(pg.query(`UPDATE admin_settings SET rum_retention_days = 100000`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pg.query(`UPDATE admin_settings SET rum_retention_days = 90`)).resolves.toBeDefined();
  });

  it('defaults retention to 30 days', async () => {
    const [c] = await rows<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'admin_settings' AND column_name = 'rum_retention_days'`);
    // Same reasoning as the sample rate: assert the VALUE, not the text of the default.
    const [row] = await rows<{ rum_retention_days: number }>(
      `SELECT rum_retention_days FROM admin_settings LIMIT 1`);
    expect(Number(row!.rum_retention_days)).toBe(30);
    void c;
  });
});

// ── Storage bounds ───────────────────────────────────────────────────────────────────────────────

describe('051 — the DDL bounds what an unauthenticated endpoint can store', () => {
  beforeEach(applyForward);

  it('accepts a well-formed event', async () => {
    await expect(insertEvent()).resolves.toBeUndefined();
  });

  it('refuses an unknown kind', async () => {
    await expect(insertEvent({ kind: 'exfiltrate' })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a negative timestamp or duration', async () => {
    await expect(insertEvent({ t_ms: -1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ total_ms: -5 })).rejects.toMatchObject({ code: '23514' });
  });

  it('caps session_id, package_revision, failure_code and furthest_stage in the DDL', async () => {
    // The validator caps these too. This is the backstop a code change cannot remove.
    await expect(insertEvent({ session_id: 'short' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ session_id: 'x'.repeat(129) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ package_revision: '' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ package_revision: 'x'.repeat(65) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ failure_code: 'x'.repeat(65) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ furthest_stage: 'x'.repeat(33) })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an unknown pool tier', async () => {
    await expect(insertEvent({ pool_tier: 'turbo' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvent({ pool_tier: 'window' })).resolves.toBeUndefined();
  });

  it('allows NULL durations — a missing stage is not a fast stage', async () => {
    await insertEvent({ total_ms: null, prepare_ms: null, apply_ms: null });
    const [r] = await rows<{ total_ms: number | null }>(`SELECT total_ms FROM sim_rum_events`);
    expect(r!.total_ms).toBeNull();
  });

  it('indexes the retention predicate, so the reaper is cheap', async () => {
    const [i] = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_sim_rum_created'`);
    expect(i!.indexdef).toContain('created_at');
  });

  it('indexes the analysis predicate', async () => {
    const [i] = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_sim_rum_package'`);
    expect(i!.indexdef).toMatch(/package_revision/);
  });

  it('stores ONLY the columns this design allows', async () => {
    // An allowlist, not a denylist. Checking a list of names the author chose not to use passes
    // against a schema storing `client_addr` or `fingerprint`; this fails the moment ANY new column
    // appears, which is when someone should have to justify it.
    const cols = (await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_rum_events'`))
      .map((c) => c.column_name).sort();
    expect(cols).toEqual([
      'apply_ms', 'coarse_pointer', 'created_at', 'device_cores', 'device_memory_gb', 'dpr',
      'failure_code', 'furthest_stage', 'id', 'kind', 'package_revision', 'pool_tier',
      'prepare_ms', 'present_ms', 'save_data', 'session_id', 't_ms', 'total_ms',
    ].sort());
  });
});

// ── Idempotency and rollback ─────────────────────────────────────────────────────────────────────

describe('051 — idempotency and rollback', () => {
  it('is idempotent across columns, constraints and indexes', async () => {
    await applyForward();
    const once = await snapshot();
    await applyForward();
    expect(await snapshot()).toEqual(once);
  });

  it('a re-run does not disturb stored events', async () => {
    await applyForward();
    await insertEvent();
    await applyForward();
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
    expect(n).toBe(1);
  });

  it('rolls back cleanly and leaves admin_settings usable', async () => {
    await applyForward();
    await insertEvent();
    await expect(applyRollback()).resolves.toBeDefined();
    const [{ n }] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'sim_rum_events'`);
    expect(n).toBe(0);
    const cols = (await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'admin_settings'`))
      .map((c) => c.column_name);
    expect(cols).not.toContain('rum_sample_rate');
    expect(cols).toContain('sim_pool_mode');
    // 051 also touches `simulations`; a rollback that left that half behind used to pass.
    const simCols = (await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'simulations'`))
      .map((c) => c.column_name);
    expect(simCols, 'the simulations half of 051 was left behind').not.toContain('prepare_budget_ms');
  });

  it('forward → rollback → forward reaches the same catalog state', async () => {
    await applyForward();
    const first = await snapshot();
    await applyRollback();
    await applyForward();
    expect(await snapshot()).toEqual(first);
  });

  it('rollback is idempotent', async () => {
    await applyForward();
    await applyRollback();
    await expect(applyRollback()).resolves.toBeDefined();
  });
});

// ── Registration ─────────────────────────────────────────────────────────────────────────────────

describe('051 — registration', () => {
  it('is registered with the runner and with db:check', () => {
    expect(readFileSync(join(MIGRATIONS_DIR, '..', 'migrate.ts'), 'utf-8')).toContain(TARGET);
    expect(readFileSync(join(MIGRATIONS_DIR, '..', '..', 'scripts', 'check-db.ts'), 'utf-8'))
      .toContain(TARGET);
  });

  it('ships a rollback file', () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain(ROLLBACK);
  });
});
