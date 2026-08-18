/**
 * Migration 064 (avatar cost meter) against a real Postgres engine, in the migration062 pattern.
 *
 * The properties that matter:
 *   • the ledger's PRIMARY KEY is (dimension, subject, window_start) — that composite is what makes
 *     a reservation atomic, because ON CONFLICT needs a unique constraint to arbitrate on and takes
 *     the row lock that serialises two concurrent reservations. Without it the whole design is a
 *     read-then-write race;
 *   • the lease table is keyed by jti, so one popup open holds one lease however often it retries;
 *   • the kill-switch singleton EXISTS after the migration — an operator cannot flip a missing row;
 *   • no foreign keys to projects or users: the subject columns hold hashes, and deleting a project
 *     must not erase the record of what its viewers already spent;
 *   • idempotent, rolls back cleanly, registered with the runner, and holds its locks briefly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATION_FILES } from '../migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const TARGET = '064_avatar_cost_meter.sql';
const ROLLBACK = '064_avatar_cost_meter.rollback.sql';
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

let pg: PGlite;
const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;

const applyForwardToHead = async (): Promise<void> => {
  await pg.exec(forwardSql);
  for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
};

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

describe('migration 064 — the shape the reservation statement depends on', () => {
  beforeEach(applyForwardToHead);

  it('keys the ledger on (dimension, subject, window_start) — the constraint ON CONFLICT arbitrates on', async () => {
    const cols = await rows<{ attname: string }>(`
      SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'avatar_cost_ledger'::regclass AND i.indisprimary
       ORDER BY a.attname`);
    expect(cols.map((c) => c.attname)).toEqual(['dimension', 'subject', 'window_start']);
  });

  it('refuses a negative balance, so a bug cannot mint budget by reserving a negative weight', async () => {
    await expect(pg.query(
      `INSERT INTO avatar_cost_ledger (dimension, subject, window_start, units)
       VALUES ('ip', 's', now(), -5)`,
    )).rejects.toBeTruthy();
  });

  it('keys a lease by jti, so one popup open cannot hold two', async () => {
    await pg.exec(`INSERT INTO avatar_session_leases (jti, project_subject, expires_at)
                   VALUES ('open-1', 'p', now() + interval '1 hour')`);
    await expect(pg.query(
      `INSERT INTO avatar_session_leases (jti, project_subject, expires_at)
       VALUES ('open-1', 'p', now() + interval '1 hour')`,
    )).rejects.toBeTruthy();
  });

  it('ships the kill-switch singleton already present and off', async () => {
    expect(await rows('SELECT id, killed FROM avatar_budget_state')).toEqual([{ id: 1, killed: false }]);
    // …and it stays a singleton.
    await expect(pg.query(`INSERT INTO avatar_budget_state (id, killed) VALUES (2, true)`)).rejects.toBeTruthy();
  });

  it('has NO foreign keys — the subject columns hold hashes, not ids', async () => {
    const fks = await rows(`
      SELECT conname FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN ('avatar_cost_ledger'::regclass, 'avatar_session_leases'::regclass,
                          'avatar_budget_state'::regclass)`);
    expect(fks).toEqual([]);
  });

  it('indexes what the sweep and the concurrency count actually scan', async () => {
    const idx = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename IN ('avatar_cost_ledger', 'avatar_session_leases') ORDER BY indexname`);
    const names = idx.map((i) => i.indexname);
    expect(names).toContain('avatar_cost_ledger_window_idx');
    expect(names).toContain('avatar_session_leases_project_idx');
  });
});

describe('migration 064 — runner hygiene', () => {
  it('is idempotent: applying it twice changes nothing', async () => {
    await applyForwardToHead();
    const before = await rows(`SELECT table_name, column_name, data_type FROM information_schema.columns
                                WHERE table_name LIKE 'avatar_%' ORDER BY table_name, column_name`);
    await pg.exec(forwardSql);
    expect(await rows(`SELECT table_name, column_name, data_type FROM information_schema.columns
                        WHERE table_name LIKE 'avatar_%' ORDER BY table_name, column_name`)).toEqual(before);
    // The singleton is not duplicated by a second run.
    expect(await rows('SELECT count(*)::int AS n FROM avatar_budget_state')).toEqual([{ n: 1 }]);
  });

  it('rolls back to exactly the prior schema', async () => {
    const before = await rows(`SELECT table_name FROM information_schema.tables
                                WHERE table_schema='public' ORDER BY table_name`);
    await pg.exec(forwardSql);
    await pg.exec(rollbackSql);
    expect(await rows(`SELECT table_name FROM information_schema.tables
                        WHERE table_schema='public' ORDER BY table_name`)).toEqual(before);
  });

  it('sets a short lock_timeout, LOCAL so it dies with the migration', async () => {
    expect(forwardSql).toMatch(/SET\s+LOCAL\s+lock_timeout/i);
    expect(forwardSql).not.toMatch(/(?<!LOCAL\s)\bSET\s+lock_timeout/i);
  });

  it('is registered with the migration runner, in order', async () => {
    expect(MIGRATION_FILES).toContain(TARGET);
    expect([...MIGRATION_FILES]).toEqual([...MIGRATION_FILES].sort());
  });
});
