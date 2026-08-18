/**
 * The durable avatar cost meter, against a REAL Postgres engine (PGlite) with migration 064 and
 * every migration before it applied — not against a mock of the database, because every property
 * worth asserting here is a property of Postgres rather than of the TypeScript around it.
 *
 * What a mocked suite would have missed, and this one caught while it was being written: the
 * reservation statement compares a weight against a limit, and two bare placeholders with no
 * column to infer from are resolved as TEXT. `5 <= 10` is then false, so the meter refused every
 * reservation it was ever asked for. A suite that only asserted "an over-limit call is refused"
 * passes that broken build perfectly. The first test below does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import {
  reserveAvatarSpend, readAvatarUsage, sweepAvatarMeter, windowStartMs, type BudgetDb,
} from '../AvatarBudgetService.js';
import { unitsFor, HOUR_MS } from '../avatarBudget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'db', 'migrations');
const TARGET = '064_avatar_cost_meter.sql';
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();

let pg: PGlite;
let db: BudgetDb;

const NOW = 1_700_000_000_000; // fixed, so window arithmetic is not a clock race

beforeEach(async () => {
  pg = new PGlite();
  for (const f of ALL.slice(0, ALL.indexOf(TARGET) + 1)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  db = drizzle(pg) as unknown as BudgetDb;
});
afterEach(async () => { await pg.close(); });

const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;

const reserve = (units: number, dims: Array<[string, string, number]>, extra: Record<string, unknown> = {}) =>
  reserveAvatarSpend(db, {
    op: 'visual', units, now: NOW,
    dimensions: dims.map(([dimension, subject, limit]) => ({ dimension: dimension as never, subject, limit })),
    ...extra,
  });

describe('reserving units', () => {
  it('ADMITS a reservation inside the limit and records exactly what it reserved', async () => {
    // The test the text-comparison bug fails. It says nothing about limits; it says the meter works.
    const first = await reserve(30, [['ip', 'subject-a', 100]]);
    expect(first.allowed).toBe(true);
    expect(await readAvatarUsage(db, 'ip', 'subject-a', NOW)).toBe(30);

    const second = await reserve(30, [['ip', 'subject-a', 100]]);
    expect(second.allowed).toBe(true);
    expect(await readAvatarUsage(db, 'ip', 'subject-a', NOW)).toBe(60);
  });

  it('refuses the reservation that would cross the limit, and leaves the total where it was', async () => {
    expect((await reserve(60, [['ip', 'subject-a', 100]])).allowed).toBe(true);
    const refused = await reserve(60, [['ip', 'subject-a', 100]]);
    expect(refused.allowed).toBe(false);
    expect(refused.deniedBy).toBe('ip');
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(await readAvatarUsage(db, 'ip', 'subject-a', NOW)).toBe(60);
  });

  it('refuses a single request heavier than the whole limit, against an EMPTY bucket', async () => {
    // The naive statement — plain ON CONFLICT DO UPDATE … WHERE — admits this one, because the
    // conditional UPDATE it would fail never runs when there is no conflicting row.
    const refused = await reserve(500, [['ip', 'fresh-subject', 100]]);
    expect(refused.allowed).toBe(false);
    expect(await readAvatarUsage(db, 'ip', 'fresh-subject', NOW)).toBe(0);
    expect(await rows('SELECT * FROM avatar_cost_ledger')).toEqual([]);
  });

  it('a refusal at a LATER layer rolls back every EARLIER layer — no partial spend', async () => {
    // Reserving each dimension in its own transaction would leave the ip bucket debited by a
    // request that was never served, and the caller would be charged for a 429.
    const refused = await reserve(50, [
      ['ip', 'subject-a', 1000],
      ['project', 'project-a', 1000],
      ['global', 'platform', 10],
    ]);
    expect(refused.allowed).toBe(false);
    expect(refused.deniedBy).toBe('global');
    expect(await readAvatarUsage(db, 'ip', 'subject-a', NOW)).toBe(0);
    expect(await readAvatarUsage(db, 'project', 'project-a', NOW)).toBe(0);
  });

  it('meters each layer separately — one address exhausting its budget does not exhaust the video', async () => {
    await reserve(90, [['ip', 'addr-1', 100], ['project', 'video-1', 1000]]);
    expect((await reserve(90, [['ip', 'addr-1', 100], ['project', 'video-1', 1000]])).allowed).toBe(false);
    expect((await reserve(90, [['ip', 'addr-2', 100], ['project', 'video-1', 1000]])).allowed).toBe(true);
    expect(await readAvatarUsage(db, 'project', 'video-1', NOW)).toBe(180);
  });

  it('rolls into a new hourly window without carrying the old total', async () => {
    await reserve(100, [['ip', 'addr-1', 100]]);
    expect((await reserve(100, [['ip', 'addr-1', 100]])).allowed).toBe(false);
    const nextHour = await reserveAvatarSpend(db, {
      op: 'visual', units: 100, now: NOW + HOUR_MS,
      dimensions: [{ dimension: 'ip', subject: 'addr-1', limit: 100 }],
    });
    expect(nextHour.allowed).toBe(true);
    expect(await readAvatarUsage(db, 'ip', 'addr-1', NOW)).toBe(100);
    expect(await readAvatarUsage(db, 'ip', 'addr-1', NOW + HOUR_MS)).toBe(100);
    expect(windowStartMs(NOW)).not.toBe(windowStartMs(NOW + HOUR_MS));
  });
});

describe('session leases — what /avatar/end is not allowed to undo', () => {
  const lease = (jti: string, over: Record<string, unknown> = {}) => ({
    lease: { jti, projectSubject: 'video-1', ttlMs: 60 * 60_000, perProject: 2, global: 10, ...over },
  });

  it('bounds concurrent sessions on one video', async () => {
    expect((await reserve(1, [['project', 'video-1', 10_000]], lease('a'))).allowed).toBe(true);
    expect((await reserve(1, [['project', 'video-1', 10_000]], lease('b'))).allowed).toBe(true);
    const third = await reserve(1, [['project', 'video-1', 10_000]], lease('c'));
    expect(third.allowed).toBe(false);
    expect(third.deniedBy).toBe('concurrency');
  });

  it('a retry of the SAME popup open renews its own lease instead of being refused by it', async () => {
    // The lease is keyed by the capability nonce for exactly this reason. Keyed by a random
    // per-request id, one viewer double-mounting their popup would consume the whole video's
    // concurrency budget.
    for (let i = 0; i < 5; i++) {
      expect((await reserve(1, [['project', 'video-1', 10_000]], lease('same-open'))).allowed).toBe(true);
    }
    expect(await rows('SELECT count(*)::int AS n FROM avatar_session_leases')).toEqual([{ n: 1 }]);
  });

  it('reserves the WORST-CASE session length up front, not the length the client admits to', async () => {
    await reserve(1, [['project', 'video-1', 10_000]], lease('a', { ttlMs: 60 * 60_000 }));
    const [row] = await rows<{ ms: number }>(
      `SELECT (EXTRACT(EPOCH FROM (expires_at - to_timestamp($1 / 1000.0))) * 1000)::bigint AS ms
         FROM avatar_session_leases WHERE jti = 'a'`, [NOW],
    );
    expect(Number(row.ms)).toBe(60 * 60_000);
  });

  it('the sweep removes long-dead leases and keeps live ones', async () => {
    await reserve(1, [['project', 'video-1', 10_000]], lease('live'));
    await pg.query(
      `INSERT INTO avatar_session_leases (jti, project_subject, expires_at)
       VALUES ('dead', 'video-1', to_timestamp($1 / 1000.0))`, [NOW - 3 * 24 * HOUR_MS],
    );
    await sweepAvatarMeter(db, NOW);
    expect(await rows('SELECT jti FROM avatar_session_leases ORDER BY jti')).toEqual([{ jti: 'live' }]);
  });

  it('a lease that has expired stops counting, so the video is not locked out forever', async () => {
    await reserve(1, [['project', 'video-1', 10_000]], lease('a', { ttlMs: 1000 }));
    await reserve(1, [['project', 'video-1', 10_000]], lease('b', { ttlMs: 1000 }));
    expect((await reserve(1, [['project', 'video-1', 10_000]], lease('c'))).allowed).toBe(false);
    const later = await reserveAvatarSpend(db, {
      op: 'start', units: 1, now: NOW + 5_000,
      dimensions: [{ dimension: 'project', subject: 'video-1', limit: 10_000 }],
      lease: { jti: 'c', projectSubject: 'video-1', ttlMs: 60_000, perProject: 2, global: 10 },
    });
    expect(later.allowed).toBe(true);
  });
});

describe('the database kill switch', () => {
  it('refuses everything while it is engaged, and says so distinctly', async () => {
    await pg.exec(`UPDATE avatar_budget_state SET killed = true WHERE id = 1`);
    const refused = await reserve(1, [['ip', 'addr-1', 10_000]]);
    expect(refused.allowed).toBe(false);
    expect(refused.deniedBy).toBe('kill_switch');
    expect(refused.killed).toBe(true);
    // Nothing was metered on the way to being refused.
    expect(await rows('SELECT * FROM avatar_cost_ledger')).toEqual([]);
  });

  it('releases cleanly when it is switched back off', async () => {
    await pg.exec(`UPDATE avatar_budget_state SET killed = true WHERE id = 1`);
    expect((await reserve(1, [['ip', 'addr-1', 10_000]])).allowed).toBe(false);
    await pg.exec(`UPDATE avatar_budget_state SET killed = false WHERE id = 1`);
    expect((await reserve(1, [['ip', 'addr-1', 10_000]])).allowed).toBe(true);
  });
});

describe('weights', () => {
  it('an image analysis costs materially more than a visual one, and a start reserves a session', async () => {
    // The audit's actual finding, in one assertion: the old limiter treated these as equal.
    expect(unitsFor('image')).toBeGreaterThan(unitsFor('visual') * 3);
    expect(unitsFor('start')).toBeGreaterThanOrEqual(unitsFor('image'));
    expect(unitsFor('visual')).toBeGreaterThan(1);
  });
});
