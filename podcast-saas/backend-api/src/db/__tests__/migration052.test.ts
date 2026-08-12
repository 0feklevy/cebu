/**
 * Migration 052 (Priority 8 runtime kill switches) against a real Postgres engine.
 *
 * The property that matters: applying this migration changes NOTHING for any viewer. Every switch
 * defaults to today's behaviour, so the blast radius of the migration is zero and enabling a
 * feature is a deliberate, reversible act.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TARGET = '052_sim_scheduler.sql';
const ROLLBACK = '052_sim_scheduler.rollback.sql';
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
 * 052 and then EVERY migration after it.
 *
 * A Drizzle read selects every column `schema.ts` declares, and `schema.ts` always describes HEAD —
 * so a read taken at 052 fails the moment any later migration adds an admin_settings column (054
 * added `sim_transition_coordinator` and did exactly that: `42703 column … does not exist`). The
 * ORM check is about the migration and the schema AGREEING, so it has to be taken at head; the
 * catalog assertions below deliberately do not use this, because their whole point is to pin 052
 * in isolation. Same helper, same reasoning, as `migration051.test.ts`.
 */
const applyForwardToHead = async (): Promise<void> => {
  await applyForward();
  for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
};

async function snapshot(): Promise<unknown> {
  return {
    cols: await rows(`SELECT column_name, data_type, is_nullable, column_default
                        FROM information_schema.columns WHERE table_name='admin_settings'
                       ORDER BY column_name`),
    cons: await rows(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                       WHERE conrelid='admin_settings'::regclass ORDER BY conname`),
  };
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  db = drizzle(pg, { schema });
});
afterEach(async () => { await pg.close(); });

describe('052 — every switch defaults to today behaviour', () => {
  beforeEach(applyForward);

  it('the scheduler is off, adaptive quality is off, the sentinel is off', async () => {
    // Applying the migration must change nothing for any viewer.
    const [r] = await rows<{ sim_scheduler_mode: string; sim_adaptive_quality: boolean; sim_boundary_sentinel: boolean }>(
      `SELECT sim_scheduler_mode, sim_adaptive_quality, sim_boundary_sentinel FROM admin_settings LIMIT 1`);
    expect(r!.sim_scheduler_mode).toBe('off');
    expect(r!.sim_adaptive_quality).toBe(false);
    expect(r!.sim_boundary_sentinel).toBe(false);
  });

  it('every switch is NOT NULL, so a null can never read as an ambiguous state', async () => {
    const cols = await rows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name='admin_settings'
          AND column_name IN ('sim_scheduler_mode','sim_adaptive_quality','sim_boundary_sentinel')`);
    expect(cols).toHaveLength(3);
    for (const c of cols) expect(c.is_nullable, c.column_name).toBe('NO');
  });

  it('refuses an unknown scheduler mode', async () => {
    await expect(pg.query(`UPDATE admin_settings SET sim_scheduler_mode = 'turbo'`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pg.query(`UPDATE admin_settings SET sim_scheduler_mode = 'predictive'`))
      .resolves.toBeDefined();
  });

  it('a Drizzle admin_settings read works after it', async () => {
    // At HEAD, not at 052: see `applyForwardToHead`. Reading at 052 asserted that schema.ts had
    // not moved since, which is not a property of this migration and broke the first time a later
    // one added a column.
    await applyForwardToHead();
    await expect(db.query.admin_settings.findFirst()).resolves.toBeDefined();
  });
});

describe('052 — idempotency and rollback', () => {
  it('is idempotent', async () => {
    await applyForward();
    const once = await snapshot();
    await applyForward();
    expect(await snapshot()).toEqual(once);
  });

  it('a re-run does not disturb a flipped switch', async () => {
    await applyForward();
    await pg.query(`UPDATE admin_settings SET sim_scheduler_mode='predictive', sim_adaptive_quality=true`);
    await applyForward();
    const [r] = await rows<{ sim_scheduler_mode: string; sim_adaptive_quality: boolean }>(
      `SELECT sim_scheduler_mode, sim_adaptive_quality FROM admin_settings LIMIT 1`);
    expect(r!.sim_scheduler_mode).toBe('predictive');
    expect(r!.sim_adaptive_quality).toBe(true);
  });

  it('rolls back cleanly and leaves the pre-052 columns intact', async () => {
    await applyForward();
    await expect(pg.exec(rollbackSql)).resolves.toBeDefined();
    const cols = (await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='admin_settings'`))
      .map((c) => c.column_name);
    for (const c of ['sim_scheduler_mode', 'sim_adaptive_quality', 'sim_boundary_sentinel']) {
      expect(cols).not.toContain(c);
    }
    expect(cols).toContain('sim_pool_mode');
    expect(cols).toContain('rum_sample_rate');
  });

  it('forward → rollback → forward reaches the same catalog state', async () => {
    await applyForward();
    const first = await snapshot();
    await pg.exec(rollbackSql);
    await applyForward();
    expect(await snapshot()).toEqual(first);
  });
});

describe('052 — registration', () => {
  it('is registered with the runner and db:check, and ships a rollback', () => {
    expect(readFileSync(join(MIGRATIONS_DIR, '..', 'migrate.ts'), 'utf-8')).toContain(TARGET);
    expect(readFileSync(join(MIGRATIONS_DIR, '..', '..', 'scripts', 'check-db.ts'), 'utf-8')).toContain(TARGET);
    expect(readdirSync(MIGRATIONS_DIR)).toContain(ROLLBACK);
  });
});

describe('052 — the dropped column that could not go in an applied 051', () => {
  beforeEach(applyForward);

  it('adds sim_rum_events.dropped, defaulting to 0', async () => {
    // 051 was already applied when this column was needed. The runner records a migration by
    // filename and never re-runs it, so a column added to an applied file exists on fresh databases
    // and is silently absent on every existing one — surfacing only as a 42703 in production.
    const [c] = await rows<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_name='sim_rum_events' AND column_name='dropped'`);
    expect(c).toBeDefined();
    expect(c!.is_nullable).toBe('NO');
    await pg.query(`INSERT INTO sim_rum_events (session_id, package_revision, kind, t_ms)
                    VALUES ('session-abcdef', 'pkg', 'transition', 1)`);
    const [r] = await rows<{ dropped: number }>(`SELECT dropped FROM sim_rum_events LIMIT 1`);
    expect(Number(r!.dropped)).toBe(0);
  });

  it('refuses a negative drop count', async () => {
    await pg.query(`INSERT INTO sim_rum_events (session_id, package_revision, kind, t_ms)
                    VALUES ('session-abcdef', 'pkg', 'transition', 1)`);
    await expect(pg.query(`UPDATE sim_rum_events SET dropped = -1`))
      .rejects.toMatchObject({ code: '23514' });
  });
});
