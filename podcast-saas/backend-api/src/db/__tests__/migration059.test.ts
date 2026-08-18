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
const TARGET = '059_export_degradation_policy.sql';
const ROLLBACK = '059_export_degradation_policy.rollback.sql';

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

describe('migration 059 — degradation_policy', () => {
  it('is REGISTERED with the runner and with db:check', () => {
    // The bug this exists to prevent: the file was written, reviewed and committed, but neither
    // runner listed it — so it would never have run anywhere, and the column the worker reads on
    // every export would simply not exist in production.
    const migrateTs = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(migrateTs).toContain(TARGET);
    expect(checkDb).toContain(TARGET);
  });

  it('EVERY migration file on disk is registered — no future file can go unshipped', () => {
    // Generalised from the same bug: a per-migration assertion only protects the migration whose
    // author remembered to write one. This one fails for any file anybody adds and forgets.
    const migrateTs = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    const missingFromRunner = ALL.filter((f) => !migrateTs.includes(f));
    const missingFromCheck = ALL.filter((f) => !checkDb.includes(f));
    expect({ missingFromRunner, missingFromCheck }).toEqual({ missingFromRunner: [], missingFromCheck: [] });
  });

  it('every registered migration exists on disk — no phantom entries', () => {
    const migrateTs = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const listed = [...migrateTs.matchAll(/'(\d{3}_[^']+\.sql)'/g)].map((m) => m[1]!);
    expect(listed.filter((f) => !ALL.includes(f))).toEqual([]);
    // …and in the order the numbers imply, since the runner applies them in array order.
    expect(listed).toEqual([...listed].sort());
  });

  it('adds the column with the STRICT default', async () => {
    await applyToHead();
    const [col] = await rows<{ column_default: string; is_nullable: string; data_type: string }>(
      `SELECT column_default, is_nullable, data_type FROM information_schema.columns
       WHERE table_name='project_exports' AND column_name='degradation_policy'`,
    );
    expect(col).toBeDefined();
    expect(col.is_nullable).toBe('NO');
    expect(col.data_type).toBe('text');
    expect(col.column_default).toContain('forbid');
  });

  it('a row that names no policy inherits forbid — the safe direction', async () => {
    await applyToHead();
    const projectId = await seedProject();
    const [row] = await rows<{ degradation_policy: string }>(
      `INSERT INTO project_exports (project_id, status) VALUES ($1,'queued') RETURNING degradation_policy`,
      [projectId],
    );
    expect(row.degradation_policy).toBe('forbid');
  });

  it('the CHECK admits exactly the two policies', async () => {
    await applyToHead();
    const projectId = await seedProject();
    await expect(rows(
      `INSERT INTO project_exports (project_id, status, degradation_policy) VALUES ($1,'queued','allow_poster')`,
      [projectId],
    )).resolves.toBeDefined();
    for (const bad of ['maybe', 'ALLOW_POSTER', '', 'allow']) {
      await expect(rows(
        `INSERT INTO project_exports (project_id, status, degradation_policy) VALUES ($1,'ready',$2)`,
        [projectId, bad],
      )).rejects.toThrow();
    }
  });

  it('BACKFILLS pre-existing rows to allow_poster — they were made under the old behaviour', async () => {
    const projectId = await seedProject();
    // A row that existed BEFORE the migration ran.
    await rows(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);
    await applyToHead();

    const [old] = await rows<{ degradation_policy: string }>(
      `SELECT degradation_policy FROM project_exports`,
    );
    expect(old.degradation_policy).toBe('allow_poster');

    // …while a row created AFTER the migration still gets the strict default.
    const [fresh] = await rows<{ degradation_policy: string }>(
      `INSERT INTO project_exports (project_id, status) VALUES ($1,'queued') RETURNING degradation_policy`,
      [projectId],
    );
    expect(fresh.degradation_policy).toBe('forbid');
  });

  it('is IDEMPOTENT — applying it twice changes nothing and does not re-backfill', async () => {
    await applyToHead();
    const projectId = await seedProject();
    await rows(
      `INSERT INTO project_exports (project_id, status, degradation_policy) VALUES ($1,'queued','forbid')`,
      [projectId],
    );

    // Age the row so a `created_at < now()` style backfill would definitely match it. This is the
    // discriminator: a bare UPDATE is idempotent only by accident, and on a table that has since
    // collected real strict exports a re-run would relabel every one of them as permitted to
    // degrade. The backfill is scoped to the moment the column is created, so this is a no-op.
    await rows(`UPDATE project_exports SET created_at = now() - interval '1 day'`);
    await pg.exec(forwardSql); // second application
    await pg.exec(forwardSql); // and a third, for good measure

    const [row] = await rows<{ degradation_policy: string }>(
      `SELECT degradation_policy FROM project_exports`,
    );
    expect(row.degradation_policy).toBe('forbid');
  });

  it('ROLLS BACK cleanly, leaving the rest of the table intact', async () => {
    await applyToHead();
    const projectId = await seedProject();
    await rows(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);

    await pg.exec(rollbackSql);

    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='project_exports'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('degradation_policy');
    // The row and the columns 058 created survive.
    expect(names).toEqual(expect.arrayContaining(['id', 'project_id', 'status', 'quality_state', 'cancel_requested']));
    const [{ n }] = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM project_exports`);
    expect(n).toBe('1');
  });

  it('rollback is idempotent too', async () => {
    await applyToHead();
    await pg.exec(rollbackSql);
    await expect(pg.exec(rollbackSql)).resolves.toBeDefined();
  });
});
