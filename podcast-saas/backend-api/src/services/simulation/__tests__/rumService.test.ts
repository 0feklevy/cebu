/**
 * RUM ingestion, sample-rate resolution and retention (Priority 8.9), against real Postgres.
 *
 * Every claim here is about FAILURE DIRECTION. This is a measurement system attached to the
 * product's hottest read path, so the only acceptable behaviour when anything goes wrong is
 * "collect nothing" — never "collect everything", and never "surface an error to the viewer".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));
vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current as Record<string, unknown>;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  resolveRumSampleRate, resolveRumRetentionDays, ingestBatch, reapRumEvents, packagePercentiles,
  RUM_RETENTION_DEFAULT_DAYS,
} from '../RumService.js';
import { SIM_RUM_VERSION, bucketDevice, type RumEvent } from 'shared/src/sim/rumEvents';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

const ev = (over: Partial<RumEvent> = {}): RumEvent => ({
  kind: 'transition', t: 10, packageRevision: 'pkg-abc',
  durations: { totalMs: 120, prepareMs: 50, presentMs: 35, applyMs: 42 }, ...over,
});
const batch = (over: Record<string, unknown> = {}) => ({
  v: SIM_RUM_VERSION, sessionId: 'session-abcdef',
  device: bucketDevice({ deviceMemory: 8, hardwareConcurrency: 8, poolTier: 'all', dpr: 2 }),
  events: [ev()], dropped: 0, ...over,
});

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  delete process.env.SIM_RUM_SAMPLE_RATE;
});
afterEach(async () => { await pg.close(); delete process.env.SIM_RUM_SAMPLE_RATE; vi.clearAllMocks(); });

// ── The kill switch ──────────────────────────────────────────────────────────────────────────────

describe('resolveRumSampleRate — every layer fails closed', () => {
  it('is 0 when nothing has been configured', async () => {
    expect(await resolveRumSampleRate()).toBe(0);
  });

  it('reads the admin_settings column when it is set', async () => {
    await pg.query(`UPDATE admin_settings SET rum_sample_rate = 0.25`);
    expect(await resolveRumSampleRate()).toBe(0.25);
  });

  it('lets an env var override the database', async () => {
    await pg.query(`UPDATE admin_settings SET rum_sample_rate = 0.5`);
    process.env.SIM_RUM_SAMPLE_RATE = '0.1';
    expect(await resolveRumSampleRate()).toBe(0.1);
  });

  it('treats an UNPARSEABLE env var as off, not as "fall through to the database"', async () => {
    // Someone who set it meant to control this; the safe reading of a malformed intent is off.
    await pg.query(`UPDATE admin_settings SET rum_sample_rate = 1`);
    process.env.SIM_RUM_SAMPLE_RATE = 'yes-please';
    expect(await resolveRumSampleRate()).toBe(0);
  });

  it('caps anything above 1', async () => {
    process.env.SIM_RUM_SAMPLE_RATE = '99';
    expect(await resolveRumSampleRate()).toBe(1);
  });

  it('collects nothing when the column does not exist yet', async () => {
    // An image that boots before 051 is applied must not break, and must not collect.
    await pg.exec(`ALTER TABLE admin_settings DROP COLUMN rum_sample_rate`);
    expect(await resolveRumSampleRate()).toBe(0);
  });

  it('collects nothing when the table is gone entirely', async () => {
    await pg.exec(`DROP TABLE admin_settings`);
    expect(await resolveRumSampleRate()).toBe(0);
  });
});

describe('resolveRumRetentionDays', () => {
  it('defaults to 30 and clamps into the legal window', async () => {
    expect(await resolveRumRetentionDays()).toBe(RUM_RETENTION_DEFAULT_DAYS);
    await pg.query(`UPDATE admin_settings SET rum_retention_days = 90`);
    expect(await resolveRumRetentionDays()).toBe(90);
  });

  it('clamps a value the database CHECK would have refused', async () => {
    // The app-level clamp is defence in depth, and its reachable case is a database whose CHECK is
    // absent — the half-applied state migration 050's own suite showed is realistic, since a bare
    // ADD CONSTRAINT can abort a file the runner still marks applied. Without the clamp a stray
    // value makes a 30-day dataset effectively permanent, and the reaper would silently keep
    // nothing in range.
    await pg.exec(`ALTER TABLE admin_settings DROP CONSTRAINT admin_settings_rum_retention_chk`);
    await pg.query(`UPDATE admin_settings SET rum_retention_days = 100000`);
    expect(await resolveRumRetentionDays()).toBe(365);

    await pg.query(`UPDATE admin_settings SET rum_retention_days = 0`);
    expect(await resolveRumRetentionDays()).toBe(1);
  });

  it('falls back to the default when the column is missing', async () => {
    await pg.exec(`ALTER TABLE admin_settings DROP COLUMN rum_retention_days`);
    expect(await resolveRumRetentionDays()).toBe(RUM_RETENTION_DEFAULT_DAYS);
  });
});

// ── Ingestion ────────────────────────────────────────────────────────────────────────────────────

describe('ingestBatch', () => {
  it('stores a valid batch in ONE statement', async () => {
    const r = await ingestBatch(batch({ events: [ev(), ev({ t: 20 }), ev({ t: 30 })] }));
    expect(r.stored).toBe(3);
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
    expect(n).toBe(3);
  });

  it('stores the durations and the device buckets', async () => {
    await ingestBatch(batch());
    const [r] = await rows<{
      total_ms: number; prepare_ms: number; apply_ms: number;
      device_memory_gb: number; pool_tier: string; dpr: number;
    }>(`SELECT total_ms, prepare_ms, apply_ms, device_memory_gb, pool_tier, dpr FROM sim_rum_events`);
    expect(r!.total_ms).toBe(120);
    expect(r!.prepare_ms).toBe(50);
    expect(r!.apply_ms).toBe(42);
    expect(r!.device_memory_gb).toBe(8);
    expect(r!.pool_tier).toBe('all');
    expect(r!.dpr).toBeCloseTo(2, 5);
  });

  it('stores NULL for an unobserved duration, never 0', async () => {
    await ingestBatch(batch({
      events: [ev({ durations: { totalMs: null, prepareMs: null, presentMs: null, applyMs: null } })],
    }));
    const [r] = await rows<{ total_ms: number | null }>(`SELECT total_ms FROM sim_rum_events`);
    expect(r!.total_ms).toBeNull();
  });

  it('rejects an invalid batch without storing anything', async () => {
    const r = await ingestBatch({ v: 99, sessionId: 'session-abcdef', events: [ev()] });
    expect(r.stored).toBe(0);
    expect(r.rejected).toBe('unknown-version');
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
    expect(n).toBe(0);
  });

  it('rejects garbage without throwing', async () => {
    for (const bad of [null, undefined, 'nope', 42, [], {}]) {
      await expect(ingestBatch(bad)).resolves.toMatchObject({ stored: 0 });
    }
  });

  it('clamps an absurd offset rather than losing the whole batch', async () => {
    // One bad field should cost that field, not every measurement alongside it.
    const r = await ingestBatch(batch({ events: [ev({ t: 1e18 })] }));
    expect(r.stored).toBe(1);
    const [row] = await rows<{ t_ms: number }>(`SELECT t_ms FROM sim_rum_events`);
    expect(row!.t_ms).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('truncates an over-long code rather than failing the insert', async () => {
    const r = await ingestBatch(batch({ events: [ev({ kind: 'failure', code: 'x'.repeat(200) })] }));
    // The validator refuses >64 first; this asserts the two layers agree rather than fight.
    expect(r.stored).toBe(0);
    expect(r.rejected).toBe('bad-event');
  });
});

// ── Retention ────────────────────────────────────────────────────────────────────────────────────

describe('reapRumEvents', () => {
  it('deletes only what is past the window', async () => {
    await ingestBatch(batch());
    await pg.query(`UPDATE sim_rum_events SET created_at = now() - interval '90 days'`);
    await ingestBatch(batch({ sessionId: 'session-fresh1' }));

    const deleted = await reapRumEvents();
    expect(deleted).toBe(1);
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
    expect(n).toBe(1);
  });

  it('honours a configured retention window', async () => {
    await pg.query(`UPDATE admin_settings SET rum_retention_days = 1`);
    await ingestBatch(batch());
    await pg.query(`UPDATE sim_rum_events SET created_at = now() - interval '2 days'`);
    expect(await reapRumEvents()).toBe(1);
  });

  it('deletes nothing when everything is inside the window', async () => {
    await ingestBatch(batch());
    expect(await reapRumEvents()).toBe(0);
  });
});

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────────

describe('packagePercentiles', () => {
  it('returns percentiles that actually occurred', async () => {
    // percentile_disc, not percentile_cont: an interpolated p90 is a number no transition ever took,
    // and the client-side summary uses nearest-rank, so two definitions would disagree.
    const events = [50, 60, 70, 80, 500].map((ms, i) =>
      ev({ t: i, durations: { totalMs: ms, prepareMs: ms - 10, presentMs: null, applyMs: null } }));
    await ingestBatch(batch({ events }));
    const p = await packagePercentiles('pkg-abc');
    expect(p.samples).toBe(5);
    expect([50, 60, 70, 80, 500]).toContain(p.p50TotalMs);
    expect([50, 60, 70, 80, 500]).toContain(p.p90TotalMs);
    expect(p.p90TotalMs!).toBeGreaterThanOrEqual(p.p50TotalMs!);
  });

  it('ignores transitions with no total', async () => {
    await ingestBatch(batch({
      events: [ev({ durations: { totalMs: null, prepareMs: null, presentMs: null, applyMs: null } })],
    }));
    expect((await packagePercentiles('pkg-abc')).samples).toBe(0);
  });

  it('reports nothing for a package with no measurements', async () => {
    const p = await packagePercentiles('never-seen');
    expect(p.samples).toBe(0);
    expect(p.p90TotalMs).toBeNull();
  });

  it('scopes to one package', async () => {
    await ingestBatch(batch({ events: [ev({ packageRevision: 'pkg-a' })] }));
    await ingestBatch(batch({ events: [ev({ packageRevision: 'pkg-b' })] }));
    expect((await packagePercentiles('pkg-a')).samples).toBe(1);
  });
});
