/**
 * Migration 059 (project_exports.degradation_policy) against a real Postgres engine, in the
 * migration058 head-apply pattern.
 *
 * The column decides whether a failed simulation capture may be published as a still image. It is
 * frozen on the row at creation, so the migration has to get three things right:
 *
 *   • the DEFAULT is `forbid` — a row written by an older code path, or by any future caller that
 *     forgets the column, must inherit the strict contract rather than permission to degrade;
 *   • the CHECK admits exactly the two policies, so no third value can ever be read as "maybe";
 *   • the BACKFILL marks pre-existing rows `allow_poster`, because they were produced under the
 *     old always-degrade behaviour. Describing what actually happened to them is honest; leaving
 *     them `forbid` would retroactively claim a guarantee they never had.
 *
 * The registration test is the one that would have caught the real bug: the file existed and was
 * committed, but neither runner knew about it, so the column would never have appeared in
 * production and every export row would have been missing the field the worker reads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const TARGET = '060_export_plan_snapshot.sql';
const ROLLBACK = '060_export_plan_snapshot.rollback.sql';

const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

let pg: PGlite;
async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

/** Everything before 059, then 059 and anything after it — the loop keeps the suite honest. */
async function applyToHead(): Promise<void> {
  for (const f of ALL.slice(ALL.indexOf(TARGET))) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
}

async function seedProject(): Promise<string> {
  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const [user] = await rows<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-059', 'e059@test') RETURNING id`,
  );
  const [project] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`,
    [org.id, user.id],
  );
  return project.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

describe('migration 060 — the frozen plan snapshot', () => {
  it('is REGISTERED with the runner and with db:check', () => {
    const migrateTs = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(migrateTs).toContain(TARGET);
    expect(checkDb).toContain(TARGET);
  });

  it('adds the three snapshot columns, all nullable', async () => {
    await applyToHead();
    const cols = await rows<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_name='project_exports'
         AND column_name IN ('plan_fingerprint','effective_plan','failure')`);
    expect(cols.map((c) => c.column_name).sort()).toEqual(['effective_plan', 'failure', 'plan_fingerprint']);
    // Nullable on purpose: rows written before the snapshot existed never had one, and a
    // fingerprint invented for them would claim a guarantee retroactively — the verifier would
    // believe it, which is worse than an honest absence.
    for (const c of cols) expect(c.is_nullable).toBe('YES');
    expect(cols.find((c) => c.column_name === 'effective_plan')!.data_type).toBe('jsonb');
    expect(cols.find((c) => c.column_name === 'failure')!.data_type).toBe('jsonb');
  });

  it('the CHECK admits only a 64-hex fingerprint, or NULL', async () => {
    await applyToHead();
    const projectId = await seedProject();
    const good = 'a'.repeat(64);
    await expect(rows(
      `INSERT INTO project_exports (project_id, status, plan_fingerprint) VALUES ($1,'queued',$2)`,
      [projectId, good])).resolves.toBeDefined();
    await expect(rows(
      `INSERT INTO project_exports (project_id, status, plan_fingerprint) VALUES ($1,'ready',NULL)`,
      [projectId])).resolves.toBeDefined();
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'zz', '']) {
      await expect(rows(
        `INSERT INTO project_exports (project_id, status, plan_fingerprint) VALUES ($1,'ready',$2)`,
        [projectId, bad])).rejects.toThrow();
    }
  });

  it('leaves existing rows UNFINGERPRINTED rather than inventing one', async () => {
    const projectId = await seedProject();
    await rows(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);
    await applyToHead();
    const [row] = await rows<{ plan_fingerprint: string | null }>(
      `SELECT plan_fingerprint FROM project_exports`);
    expect(row.plan_fingerprint).toBeNull();
  });

  it('is IDEMPOTENT across repeated application', async () => {
    await applyToHead();
    await pg.exec(forwardSql);
    await pg.exec(forwardSql);
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='project_exports' AND column_name='plan_fingerprint'`);
    expect(cols).toHaveLength(1);
  });

  it('ROLLS BACK cleanly, leaving 059 and 058 intact', async () => {
    await applyToHead();
    const projectId = await seedProject();
    await rows(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);
    await pg.exec(rollbackSql);
    const names = (await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='project_exports'`))
      .map((c) => c.column_name);
    expect(names).not.toContain('plan_fingerprint');
    expect(names).not.toContain('effective_plan');
    expect(names).not.toContain('failure');
    expect(names).toEqual(expect.arrayContaining(['degradation_policy', 'quality_state', 'cancel_requested']));
    const [{ n }] = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM project_exports`);
    expect(n).toBe('1');
  });
});
