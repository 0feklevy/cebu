/**
 * What happens when the meter cannot answer, and what shadow mode does and does not excuse.
 *
 * These are the two decisions in the design that are pure policy rather than mechanism, so they
 * are the two that a future edit is most likely to get backwards:
 *
 *   • a BILLABLE call whose cost cannot be reserved must not be made. "The limiter is down" is
 *     precisely when spending is unbounded, so the safe direction is to refuse, not to wave
 *     through. That only applies once the meter is the authority (enforce); while it is still
 *     proving itself (shadow) an outage must degrade to the burst shield instead, or turning the
 *     meter on for the first time would be a self-inflicted outage.
 *   • shadow mode suspends the BUDGETS. It does not suspend the emergency stop. A kill switch that
 *     only works once you have finished evaluating your limiter is not a kill switch.
 *
 * The database is reached through the real dynamic-import path, backed by a real Postgres engine,
 * so this also proves the wiring rather than a mock of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const handle = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../../db/index.js', () => ({ get db() { return handle.db; } }));

import { reserveAvatarSpend, resetAvatarSpendRuntime } from '../avatarBudgetRuntime.js';
import { resetBurstShield, hashSubject } from '../avatarBudget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'db', 'migrations');
const TARGET = '064_avatar_cost_meter.sql';
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();

let pg: PGlite | null = null;

async function realDb(): Promise<void> {
  pg = new PGlite();
  for (const f of ALL.slice(0, ALL.indexOf(TARGET) + 1)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  handle.db = drizzle(pg);
}

const subjects = { ip: hashSubject('ip', '203.0.113.7'), project: hashSubject('project', 'video-1') };
const spend = () => reserveAvatarSpend({ op: 'image', subjects });

beforeEach(() => {
  resetBurstShield();
  resetAvatarSpendRuntime();
  handle.db = null;
  delete process.env.AVATAR_KILL_SWITCH;
  process.env.AVATAR_BURST_IP = '1000000';
  process.env.AVATAR_BURST_PROJECT = '1000000';
  process.env.AVATAR_BURST_GLOBAL = '1000000';
});

afterEach(async () => {
  if (pg) { await pg.close(); pg = null; }
  for (const k of ['AVATAR_BUDGET_MODE', 'AVATAR_BURST_IP', 'AVATAR_BURST_PROJECT', 'AVATAR_BURST_GLOBAL',
                   'AVATAR_HOURLY_IP', 'AVATAR_HOURLY_PROJECT', 'AVATAR_HOURLY_GLOBAL']) delete process.env[k];
});

describe('when the meter cannot be consulted', () => {
  it('ENFORCE fails closed: no reservation, no billable call', async () => {
    process.env.AVATAR_BUDGET_MODE = 'enforce';
    handle.db = { query: {} }; // a handle with no transaction() — a driver that never connected
    const verdict = await spend();
    expect(verdict.allowed).toBe(false);
    expect(verdict.status).toBe(503);
    expect(verdict.deniedBy).toBe('meter_unavailable');
    expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('ENFORCE fails closed when the transaction itself throws, not only when it is missing', async () => {
    process.env.AVATAR_BUDGET_MODE = 'enforce';
    handle.db = { transaction: async () => { throw new Error('connection terminated'); } };
    const verdict = await spend();
    expect(verdict.allowed).toBe(false);
    expect(verdict.deniedBy).toBe('meter_unavailable');
  });

  it('SHADOW degrades to the burst shield instead, and says the meter was not consulted', async () => {
    process.env.AVATAR_BUDGET_MODE = 'shadow';
    handle.db = { transaction: async () => { throw new Error('connection terminated'); } };
    const verdict = await spend();
    expect(verdict.allowed).toBe(true);
    expect(verdict.metered).toBe(false);
    expect(verdict.shadowDeniedBy).toBe('meter_unavailable');
  });

  it('OFF never reaches for a database at all', async () => {
    process.env.AVATAR_BUDGET_MODE = 'off';
    handle.db = { transaction: vi.fn(async () => { throw new Error('must not be called'); }) };
    const verdict = await spend();
    expect(verdict.allowed).toBe(true);
    expect(verdict.metered).toBe(false);
    expect((handle.db as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
  });
});

describe('shadow mode suspends the budgets, not the emergency stop', () => {
  beforeEach(async () => { await realDb(); process.env.AVATAR_BUDGET_MODE = 'shadow'; });

  it('records the spend and reports what it WOULD have refused, without refusing', async () => {
    process.env.AVATAR_HOURLY_IP = '1'; // an image is worth far more than one unit
    const verdict = await spend();
    expect(verdict.allowed).toBe(true);
    expect(verdict.metered).toBe(true);
    expect(verdict.shadowDeniedBy).toBe('ip');
  });

  it('the SAME budget in enforce mode refuses, with Retry-After', async () => {
    process.env.AVATAR_BUDGET_MODE = 'enforce';
    process.env.AVATAR_HOURLY_IP = '1';
    const verdict = await spend();
    expect(verdict.allowed).toBe(false);
    expect(verdict.status).toBe(429);
    expect(verdict.deniedBy).toBe('ip');
    expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('the database kill switch still stops the call dead — in shadow mode', async () => {
    await pg!.exec(`UPDATE avatar_budget_state SET killed = true WHERE id = 1`);
    const verdict = await spend();
    expect(verdict.allowed).toBe(false);
    expect(verdict.status).toBe(503);
    expect(verdict.deniedBy).toBe('kill_switch');
  });
});

describe('the env kill switch is checked before anything else', () => {
  it('refuses without resolving a database handle at all', async () => {
    process.env.AVATAR_KILL_SWITCH = 'on';
    process.env.AVATAR_BUDGET_MODE = 'enforce';
    handle.db = { transaction: vi.fn(async () => { throw new Error('must not be called'); }) };
    const verdict = await spend();
    expect(verdict.allowed).toBe(false);
    expect(verdict.status).toBe(503);
    expect(verdict.deniedBy).toBe('kill_switch');
    expect((handle.db as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
  });
});
