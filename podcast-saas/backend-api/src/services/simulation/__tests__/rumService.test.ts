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
  startRumRetentionSweep, invalidateRumSampleRateCache,
  RUM_RETENTION_DEFAULT_DAYS,
} from '../RumService.js';
import { SIM_RUM_VERSION, bucketDevice, type RumEvent } from 'shared/sim/rumEvents';

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

/**
 * Ingestion is gated on the kill switch, so every ingest test must turn collection on.
 *
 * The resolved rate is cached in-process — it is read on an unauthenticated write path, and a
 * database round trip per inbound request is a denial-of-service lever. Production invalidates on
 * the settings write; these tests write the column directly, so they invalidate here.
 */
async function setRate(rate: number): Promise<void> {
  await pg.query(`UPDATE admin_settings SET rum_sample_rate = $1`, [rate]);
  invalidateRumSampleRateCache();
}
async function enableCollection(): Promise<void> { await setRate(1); }

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  delete process.env.SIM_RUM_SAMPLE_RATE;
  // Each test gets a fresh database; the rate cache is module state and would otherwise carry a
  // previous test's value into it.
  invalidateRumSampleRateCache();
});
afterEach(async () => { await pg.close(); delete process.env.SIM_RUM_SAMPLE_RATE; vi.clearAllMocks(); });

// ── The kill switch ──────────────────────────────────────────────────────────────────────────────

describe('resolveRumSampleRate — every layer fails closed', () => {
  it('is 0 when nothing has been configured', async () => {
    expect(await resolveRumSampleRate()).toBe(0);
  });

  it('reads the admin_settings column when it is set', async () => {
    await setRate(0.25);
    expect(await resolveRumSampleRate()).toBe(0.25);
  });

  it('lets an env var override the database', async () => {
    await pg.query(`UPDATE admin_settings SET rum_sample_rate = 0.5`);
    process.env.SIM_RUM_SAMPLE_RATE = '0.1';
    expect(await resolveRumSampleRate()).toBe(0.1);
  });

  it('treats an UNPARSEABLE env var as off, not as "fall through to the database"', async () => {
    // Someone who set it meant to control this; the safe reading of a malformed intent is off.
    await setRate(1);
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
  beforeEach(enableCollection);
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
    // Clamped TO THE CEILING. `<=` passes for a clamp with swapped bounds or a hardcoded 0.
    expect(row!.t_ms).toBe(2 ** 31 - 1);
  });

  it('refuses an over-long code at the validator, before any truncation is needed', async () => {
    // Named for what it actually asserts. The validator rejects >64 first, so the service-level
    // truncation is never reached for this input — claiming otherwise described a code path the
    // test does not exercise.
    const r = await ingestBatch(batch({ events: [ev({ kind: 'failure', code: 'x'.repeat(200) })] }));
    expect(r.stored).toBe(0);
    expect(r.rejected).toBe('bad-event');
  });
});

// ── Retention ────────────────────────────────────────────────────────────────────────────────────

describe('reapRumEvents', () => {
  beforeEach(enableCollection);
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
  beforeEach(enableCollection);
  it('returns percentiles that actually occurred', async () => {
    // percentile_disc, not percentile_cont: an interpolated p90 is a number no transition ever took,
    // and the client-side summary uses nearest-rank, so two definitions would disagree.
    // Ten values, so p50 and p90 are DIFFERENT members of the set. With five values both landed on
    // 70 and a p90 mutated to p50 survived — the assertion could not tell them apart.
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
    const events = vals.map((ms, i) =>
      ev({ t: i, durations: { totalMs: ms, prepareMs: ms - 5, presentMs: null, applyMs: null } }));
    await ingestBatch(batch({ events }));
    const p = await packagePercentiles('pkg-abc');
    expect(p.samples).toBe(10);
    // Every reported percentile is a value that actually occurred (percentile_disc, not _cont).
    expect(vals).toContain(p.p50TotalMs);
    expect(vals).toContain(p.p90TotalMs);
    expect(p.p50TotalMs).toBe(50);
    expect(p.p90TotalMs, 'p90 collapsed onto p50').toBe(90);
    expect(p.p90TotalMs).not.toBe(p.p50TotalMs);
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


// ── Review findings ──────────────────────────────────────────────────────────────────────────────

describe('the drop count survives the round trip', () => {
  beforeEach(enableCollection);

  it('stores what the client ring discarded', async () => {
    // The client validates, drains and transmits `dropped` precisely so a truncated sample cannot
    // masquerade as a complete one. Discarding it on arrival made that invariant false end to end
    // while every client-side test still passed.
    await ingestBatch(batch({ dropped: 17 }));
    const [row] = await rows<{ dropped: number }>(`SELECT dropped FROM sim_rum_events`);
    expect(row!.dropped).toBe(17);
  });

  it('defaults to 0 for a batch that dropped nothing', async () => {
    await ingestBatch(batch());
    const [row] = await rows<{ dropped: number }>(`SELECT dropped FROM sim_rum_events`);
    expect(row!.dropped).toBe(0);
  });
});

describe('the kill switch gates the WRITE path, not only the client', () => {
  it('stores nothing while collection is disabled', async () => {
    // The endpoint is unauthenticated, so "no honest client sends" is not "nothing is stored". Every
    // existing deployment sits at rate 0; without this gate any caller could poison the per-package
    // percentiles the rest of Priority 8 consumes.
    const r = await ingestBatch(batch());
    expect(r.stored).toBe(0);
    expect(r.rejected).toBe('collection-disabled');
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
    expect(n).toBe(0);
  });

  it('stores once collection is enabled', async () => {
    await enableCollection();
    expect((await ingestBatch(batch())).stored).toBe(1);
  });

  it('stops storing again the moment the switch goes back to 0', async () => {
    await enableCollection();
    expect((await ingestBatch(batch())).stored).toBe(1);
    await setRate(0);
    expect((await ingestBatch(batch())).stored).toBe(0);
  });
});

describe('a single bad device field cannot destroy a whole batch', () => {
  beforeEach(enableCollection);

  it('drops an unrecognised pool tier and keeps every measurement beside it', async () => {
    // pool_tier reaches a CHECK constraint; one unknown value made the multi-row INSERT throw and
    // lost the entire batch, silently, because the endpoint always answers 204. Realistic trigger:
    // a new tier added client-side before the DDL.
    const r = await ingestBatch(batch({
      device: { ...bucketDevice({}), poolTier: 'turbo' },
      events: [ev(), ev({ t: 20 })],
    }));
    expect(r.stored).toBe(2);
    const [row] = await rows<{ pool_tier: string | null }>(`SELECT pool_tier FROM sim_rum_events`);
    expect(row!.pool_tier).toBeNull();
  });
});

describe('the retention sweep has a caller', () => {
  it('starts, runs and can be stopped', async () => {
    await enableCollection();
    await ingestBatch(batch());
    await pg.query(`UPDATE sim_rum_events SET created_at = now() - interval '90 days'`);

    const stop = startRumRetentionSweep(20);
    try {
      // Poll for the effect rather than sleeping a guessed amount: a fixed sleep either flakes or
      // is needlessly slow, and this suite closes its PGlite in afterEach — an interval still
      // in flight when that happens would fire against a dead database.
      for (let i = 0; i < 100; i += 1) {
        const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
        if (n === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      stop();
      // Let any sweep already dispatched settle before the database goes away.
      await new Promise((r) => setTimeout(r, 30));
    }

    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_rum_events`);
    expect(n, 'the sweep never ran — retention is stated as enforced, not intended').toBe(0);
  });
});

describe('numOrNull', () => {
  it('preserves a genuine zero', async () => {
    // `Number(v) || null` turned a real 0 into null whenever the driver returned text.
    await enableCollection();
    await ingestBatch(batch({
      events: [ev({ durations: { totalMs: 0, prepareMs: 0, presentMs: 0, applyMs: 0 } })],
    }));
    const p = await packagePercentiles('pkg-abc');
    expect(p.samples).toBe(1);
    expect(p.p50TotalMs).toBe(0);
  });
});

describe('the retention sweep is quiet before its migration is applied', () => {
  it('does not log an error when the table does not exist yet', async () => {
    // An image booting before 051 has nothing to reap. Shouting hourly about that trains operators
    // to ignore the line, so the one case where it matters gets missed.
    await pg.exec(`DROP TABLE sim_rum_events`);
    const { logger } = await import('../../../lib/logger.js');
    const stop = startRumRetentionSweep(10);
    await new Promise((r) => setTimeout(r, 60));
    stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(logger.error).not.toHaveBeenCalled();
    // POSITIVE CONTROL: without this, a sweep that never ran at all would also pass.
    expect(logger.debug, 'the sweep never ran — the quiet-branch claim is untested').toHaveBeenCalled();
  });

  it('STILL shouts about any other failure', async () => {
    // The quiet path must be narrow. A sweep that swallowed every error silently would be worse
    // than one that shouted about everything: retention could stop working and nothing would say so.
    const { logger } = await import('../../../lib/logger.js');
    const boom = new Error('permission denied') as Error & { code?: string };
    boom.code = '42501';
    // `db` is a Proxy forwarding to this ref, so a spy cannot attach to it — the underlying method
    // is what has to be replaced.
    const target = h.dbRef.current as Record<string, unknown>;
    const original = target.delete;
    target.delete = () => { throw boom; };
    try {
      const stop = startRumRetentionSweep(10);
      await new Promise((r) => setTimeout(r, 60));
      stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(logger.error).toHaveBeenCalled();
    } finally {
      target.delete = original;
    }
  });
});
