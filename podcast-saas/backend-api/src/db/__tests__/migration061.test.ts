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
const TARGET = '061_export_progress.sql';
const ROLLBACK = '061_export_progress.rollback.sql';

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

describe('migration 061 — authoritative progress', () => {
  it('is REGISTERED with the runner and with db:check', () => {
    const migrateTs = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(migrateTs).toContain(TARGET);
    expect(checkDb).toContain(TARGET);
  });

  it('adds every progress column, with counters defaulting to zero', async () => {
    await applyToHead();
    const cols = await rows<{ column_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_name='project_exports' AND column_name IN
         ('current_phase','phase_done','phase_total','current_section_id','current_section_label',
          'capture_stage','frames_done','frames_total','degraded_windows')`);
    expect(cols).toHaveLength(9);
    // Counters are NOT NULL with a zero default: a null counter reads as "unknown", and the UI
    // would have to guess whether that means nothing yet or something went wrong.
    for (const name of ['phase_done', 'phase_total', 'frames_done', 'frames_total', 'degraded_windows']) {
      const c = cols.find((x) => x.column_name === name)!;
      expect(c.is_nullable).toBe('NO');
      expect(c.column_default).toContain('0');
    }
    // Descriptive fields are nullable, because "not capturing anything right now" is a real state.
    for (const name of ['current_phase', 'current_section_id', 'current_section_label', 'capture_stage']) {
      expect(cols.find((x) => x.column_name === name)!.is_nullable).toBe('YES');
    }
  });

  it('refuses negative counters — progress that ran backwards is a bug, not a value', async () => {
    await applyToHead();
    const projectId = await seedProject();
    const [{ id }] = await rows<{ id: string }>(
      `INSERT INTO project_exports (project_id, status) VALUES ($1,'queued') RETURNING id`, [projectId]);
    for (const col of ['phase_done', 'frames_done', 'degraded_windows']) {
      await expect(rows(`UPDATE project_exports SET ${col} = -1 WHERE id = $1`, [id])).rejects.toThrow();
    }
    await expect(rows(`UPDATE project_exports SET phase_done = 3 WHERE id = $1`, [id])).resolves.toBeDefined();
  });

  it('is IDEMPOTENT and ROLLS BACK cleanly', async () => {
    await applyToHead();
    await pg.exec(forwardSql);
    const projectId = await seedProject();
    await rows(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);
    await pg.exec(rollbackSql);
    const names = (await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='project_exports'`))
      .map((c) => c.column_name);
    for (const gone of ['current_phase', 'phase_done', 'frames_total', 'degraded_windows']) {
      expect(names).not.toContain(gone);
    }
    expect(names).toEqual(expect.arrayContaining(['plan_fingerprint', 'degradation_policy']));
    const [{ n }] = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM project_exports`);
    expect(n).toBe('1');
  });
});
