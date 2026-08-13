/**
 * Migration 058 (project_exports — the linear video export job row) against a real Postgres
 * engine, in the migration052 head-apply pattern.
 *
 * The properties that matter:
 *   • the status CHECK admits exactly the eight states (incl. the `cancelled` terminal) and
 *     nothing else;
 *   • the PARTIAL unique index refuses a second IN-FLIGHT export of one project but never
 *     refuses history (a project must be exportable twice, sequentially, forever);
 *   • `cancel_requested` and `quality_state` are NOT NULL with honest defaults, so a null can
 *     never read as "maybe cancelled" or "maybe degraded";
 *   • idempotent, rolls back cleanly, and is registered with the runner and db:check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TARGET = '058_project_exports.sql';
const ROLLBACK = '058_project_exports.rollback.sql';
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

/** 058 and then every migration after it — none today, but the loop keeps the suite honest. */
const applyForwardToHead = async (): Promise<void> => {
  await applyForward();
  for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
};

async function snapshot(): Promise<unknown> {
  return {
    cols: await rows(`SELECT column_name, data_type, is_nullable, column_default
                        FROM information_schema.columns WHERE table_name='project_exports'
                       ORDER BY column_name`),
    cons: await rows(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                       WHERE conrelid='project_exports'::regclass ORDER BY conname`),
    idx: await rows(`SELECT indexname, indexdef FROM pg_indexes
                      WHERE tablename='project_exports' ORDER BY indexname`),
  };
}

/** Seed the minimal parent rows an export row needs; returns a project id. */
async function seedProject(): Promise<string> {
  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const [user] = await rows<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-058', 'e@test') RETURNING id`);
  const [project] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`,
    [org.id, user.id]);
  return project.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  db = drizzle(pg, { schema });
});
afterEach(async () => { await pg.close(); });

describe('058 — shape', () => {
  beforeEach(applyForward);

  it('a fresh row defaults to queued, full quality, zero progress, cancel_requested false', async () => {
    const projectId = await seedProject();
    const [r] = await rows<{ status: string; quality_state: string; objects_total: number; objects_done: number; cancel_requested: boolean; output_key: string | null }>(
      `INSERT INTO project_exports (project_id) VALUES ($1)
       RETURNING status, quality_state, objects_total, objects_done, cancel_requested, output_key`,
      [projectId]);
    expect(r!.status).toBe('queued');
    expect(r!.quality_state).toBe('full');
    expect(Number(r!.objects_total)).toBe(0);
    expect(Number(r!.objects_done)).toBe(0);
    expect(r!.cancel_requested).toBe(false);
    expect(r!.output_key).toBeNull();
  });

  it('cancel_requested, status and quality_state are NOT NULL — no ambiguous third state', async () => {
    const cols = await rows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name='project_exports' AND column_name IN ('status','cancel_requested','quality_state','updated_at')`);
    expect(cols).toHaveLength(4);
    for (const c of cols) expect(c.is_nullable, c.column_name).toBe('NO');
  });

  it('the CHECK admits exactly the eight statuses — cancelled is a real terminal, not a failed flavour', async () => {
    const projectId = await seedProject();
    for (const s of ['queued', 'planning', 'capturing', 'assembling', 'uploading', 'ready', 'failed', 'cancelled']) {
      await expect(
        pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,$2)`, [projectId, s]),
        s,
      ).resolves.toBeDefined();
      // Keep the in-flight index out of the way: only one in-flight row may exist at a time.
      await pg.query(`UPDATE project_exports SET status='failed'`);
    }
    await expect(pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'encoding')`, [projectId]))
      .rejects.toMatchObject({ message: expect.stringContaining('project_exports_status_chk') });
  });

  it('quality_state admits exactly full|degraded', async () => {
    const projectId = await seedProject();
    await expect(pg.query(
      `INSERT INTO project_exports (project_id, status, quality_state) VALUES ($1,'ready','degraded')`, [projectId]))
      .resolves.toBeDefined();
    await expect(pg.query(
      `INSERT INTO project_exports (project_id, status, quality_state) VALUES ($1,'ready','partial')`, [projectId]))
      .rejects.toMatchObject({ message: expect.stringContaining('project_exports_quality_state_chk') });
  });

  it('a cancelled row does NOT hold the in-flight index — the project is immediately exportable again', async () => {
    const projectId = await seedProject();
    await pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'cancelled')`, [projectId]);
    await expect(pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'queued')`, [projectId]))
      .resolves.toBeDefined();
  });

  it('refuses a SECOND in-flight export of one project (every in-flight status)', async () => {
    const projectId = await seedProject();
    await pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'queued')`, [projectId]);
    for (const s of ['queued', 'planning', 'capturing', 'assembling', 'uploading']) {
      await expect(
        pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,$2)`, [projectId, s]),
        s,
      ).rejects.toMatchObject({ message: expect.stringContaining('uniq_project_exports_inflight') });
    }
  });

  it('never refuses HISTORY: terminal rows do not block the next export', async () => {
    const projectId = await seedProject();
    await pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);
    await pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'failed')`, [projectId]);
    // A third, in-flight one starts fine on top of two finished ones.
    await expect(pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'queued')`, [projectId]))
      .resolves.toBeDefined();
  });

  it('deleting the project cascades its export bookkeeping away', async () => {
    const projectId = await seedProject();
    await pg.query(`INSERT INTO project_exports (project_id, status) VALUES ($1,'ready')`, [projectId]);
    await pg.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    const [n] = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM project_exports`);
    expect(Number(n!.n)).toBe(0);
  });

  it('a Drizzle project_exports read works at head', async () => {
    await applyForwardToHead();
    await expect(db.query.project_exports.findFirst()).resolves.toBeUndefined();
  });
});

describe('058 — idempotency and rollback', () => {
  it('is idempotent', async () => {
    await applyForward();
    const once = await snapshot();
    await applyForward();
    expect(await snapshot()).toEqual(once);
  });

  it('a re-run does not disturb existing rows', async () => {
    await applyForward();
    const projectId = await seedProject();
    await pg.query(
      `INSERT INTO project_exports (project_id, status, cancel_requested, output_key)
       VALUES ($1,'ready',true,'exports/p/e/master.mp4')`, [projectId]);
    await applyForward();
    const [r] = await rows<{ status: string; cancel_requested: boolean; output_key: string }>(
      `SELECT status, cancel_requested, output_key FROM project_exports`);
    expect(r!.status).toBe('ready');
    expect(r!.cancel_requested).toBe(true);
    expect(r!.output_key).toBe('exports/p/e/master.mp4');
  });

  it('rolls back cleanly and leaves the neighbouring tables intact', async () => {
    await applyForward();
    await expect(pg.exec(rollbackSql)).resolves.toBeDefined();
    const [t] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name='project_exports'`);
    expect(Number(t!.n)).toBe(0);
    // 056's table is untouched — the two job tables are siblings, not a family.
    const [d] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name='project_duplications'`);
    expect(Number(d!.n)).toBe(1);
  });

  it('forward → rollback → forward reaches the same catalog state', async () => {
    await applyForward();
    const first = await snapshot();
    await pg.exec(rollbackSql);
    await applyForward();
    expect(await snapshot()).toEqual(first);
  });
});

describe('058 — registration', () => {
  it('is registered with the runner and db:check, and ships a rollback', () => {
    expect(readFileSync(join(MIGRATIONS_DIR, '..', 'migrate.ts'), 'utf-8')).toContain(TARGET);
    expect(readFileSync(join(MIGRATIONS_DIR, '..', '..', 'scripts', 'check-db.ts'), 'utf-8')).toContain(TARGET);
    expect(readdirSync(MIGRATIONS_DIR)).toContain(ROLLBACK);
  });
});
