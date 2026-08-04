/**
 * Migration 050 (`sim_revisions` + the pointer columns on `simulations`) proven against a real
 * Postgres engine — PGlite, in-process WASM Postgres — with the REAL prior schema underneath it.
 *
 * Same reasoning as migration049.test.ts, and the same deployment-ordering hazard: schema.ts now
 * declares `active_revision_id`, `active_revision_entry_key` and `revision_counter` on
 * `simulations`, and Drizzle emits EVERY declared column in a full-row select. An image carrying
 * this schema against a database where 050 has not been applied raises PostgreSQL 42703 on every
 * `db.query.simulations` read — including the player's hottest path. So this suite replays the
 * actual migration files in order and drives the actual Drizzle query shapes over the result.
 *
 * Beyond the forward/idempotent/rollback trio, the constraints here are load-bearing in a way 049's
 * were not: `uniq_sim_revisions_active` is the ONLY thing standing between a lost CAS race and two
 * simultaneously-active revisions, which is the single guarantee the whole immutable-package design
 * rests on. It is therefore tested by racing it, not by reading its definition.
 *
 * Isolation: this file never imports `../index.js`. That module builds a postgres.js pool against
 * `DATABASE_URL` at import time, and that URL points at the database preview and production SHARE.
 * Importing schema.ts alone (pure table definitions, no client) and binding it to a private
 * in-process engine is what makes it impossible for this suite to reach that database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

import * as schema from '../schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TARGET = '050_sim_revisions.sql';
const ROLLBACK = '050_sim_revisions.rollback.sql';

function forwardMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[^.]+\.sql$/.test(f))
    .sort();
}

const ALL = forwardMigrations();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

/** The three columns 050 adds to `simulations`. Named once; asserted from both directions. */
const NEW_SIM_COLUMNS = ['active_revision_id', 'active_revision_entry_key', 'revision_counter'] as const;

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let projectId: string;
let simId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pg.query<T>(sql, params);
  return res.rows;
}

async function applyPrior(): Promise<void> {
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

const applyForward = (): Promise<unknown> => pg.exec(forwardSql);
const applyRollback = (): Promise<unknown> => pg.exec(rollbackSql);

/**
 * The catalog facts 050 is responsible for. Compared before/after a second application to prove
 * idempotency across columns, constraints AND indexes — a re-run that silently dropped the partial
 * unique index would leave a database where two revisions can be active at once, and nothing else
 * in the suite would notice.
 */
async function snapshot(): Promise<unknown> {
  const cols = await rows(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name IN ('sim_revisions','simulations')
      ORDER BY table_name, column_name`,
  );
  const cons = await rows(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid IN ('sim_revisions'::regclass, 'simulations'::regclass)
      ORDER BY conname`,
  );
  const idx = await rows(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename IN ('sim_revisions','simulations') ORDER BY indexname`,
  );
  return { cols, cons, idx };
}

/** A minimal project + simulation, using only columns that exist before 050. */
async function seed(): Promise<void> {
  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`);
  const [p] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1, 'Project') RETURNING id`,
    [org!.id],
  );
  projectId = p!.id;
  const [s] = await rows<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
     VALUES ($1, 'sim', $2, 'index.html') RETURNING id`,
    [projectId, `simulations/${projectId}/x`],
  );
  simId = s!.id;
}

/** Insert a revision. `status` defaults to draft; activated_at is required for retained statuses. */
async function insertRevision(over: Partial<{
  status: string; revision_number: number; activated_at: string | null; manifest_hash: string | null;
}> = {}): Promise<string> {
  const status = over.status ?? 'draft';
  const activatedAt = over.activated_at !== undefined
    ? over.activated_at
    : (['active', 'retired', 'rolled_back'].includes(status) ? new Date().toISOString() : null);
  const [r] = await rows<{ id: string }>(
    `INSERT INTO sim_revisions (simulation_id, revision_number, status, activated_at, manifest_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [simId, over.revision_number ?? 1, status, activatedAt, over.manifest_hash ?? null],
  );
  return r!.id;
}

beforeEach(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await applyPrior();
  await seed();
});

afterEach(async () => { await pg.close(); });

// ── 1. The deployment-ordering hazard ────────────────────────────────────────────────────────────

describe('050 — the ordering hazard it exists to prevent', () => {
  it('a Drizzle simulations read fails with 42703 BEFORE 050 is applied', async () => {
    // This is the regression test for the hazard itself: schema.ts declares the three new columns,
    // Drizzle selects all of them, so an un-migrated database breaks every simulations read.
    await expect(db.query.simulations.findFirst()).rejects.toMatchObject({ code: '42703' });
  });

  it('the same read succeeds after 050', async () => {
    await applyForward();
    const sim = await db.query.simulations.findFirst({ where: eq(schema.simulations.id, simId) });
    expect(sim).toBeTruthy();
    expect(sim!.active_revision_id).toBeNull();
    expect(sim!.active_revision_entry_key).toBeNull();
    expect(sim!.revision_counter).toBe(0);
  });

  it('a Drizzle sim_revisions read fails with 42P01 before and succeeds after', async () => {
    await expect(db.query.sim_revisions.findMany()).rejects.toMatchObject({ code: '42P01' });
    await applyForward();
    await expect(db.query.sim_revisions.findMany()).resolves.toEqual([]);
  });
});

// ── 2. Forward step and idempotency ──────────────────────────────────────────────────────────────

describe('050 — forward', () => {
  it('adds exactly the three pointer columns to simulations', async () => {
    await applyForward();
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'simulations'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const c of NEW_SIM_COLUMNS) expect(names).toContain(c);
  });

  it('defaults revision_counter to 0 and NOT NULL, so the allocator never starts from NULL', async () => {
    await applyForward();
    const [c] = await rows<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'simulations' AND column_name = 'revision_counter'`,
    );
    expect(c!.is_nullable).toBe('NO');
    expect(c!.column_default).toContain('0');
  });

  it('leaves every existing simulation on the legacy path — 050 is strictly additive', async () => {
    await applyForward();
    const [s] = await rows<{ active_revision_id: string | null; revision_counter: number }>(
      `SELECT active_revision_id, revision_counter FROM simulations WHERE id = $1`, [simId],
    );
    // packageRevisionFor() falls back to the pre-revision derivation for exactly this state, which
    // is what makes existing posters and canary verdicts survive the migration untouched.
    expect(s!.active_revision_id).toBeNull();
    expect(s!.revision_counter).toBe(0);
  });

  it('is idempotent — a second application changes no column, constraint or index', async () => {
    await applyForward();
    const once = await snapshot();
    await applyForward();
    const twice = await snapshot();
    expect(twice).toEqual(once);
  });

  it('a re-run does not disturb data written between the two applications', async () => {
    await applyForward();
    const revId = await insertRevision({ status: 'active' });
    await pg.query(
      `UPDATE simulations SET active_revision_id = $1, active_revision_entry_key = $2,
              revision_counter = 1 WHERE id = $3`,
      [revId, 'simulations/p/s/revisions/r/package/index.html', simId],
    );

    await applyForward();

    const [s] = await rows<{ active_revision_id: string; revision_counter: number }>(
      `SELECT active_revision_id, revision_counter FROM simulations WHERE id = $1`, [simId],
    );
    expect(s!.active_revision_id).toBe(revId);
    expect(s!.revision_counter).toBe(1);
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_revisions`);
    expect(n).toBe(1);
  });

  it('the ADD CONSTRAINT blocks survive a half-applied migration', async () => {
    // The runner wraps a whole file in one implicit transaction and still marks it applied on
    // failure. A bare ADD CONSTRAINT (no IF NOT EXISTS) after a manual partial apply would abort
    // the file, roll back the partial unique index too, and leave a database where two revisions
    // can be active — the one guarantee everything else rests on.
    await pg.exec(`ALTER TABLE simulations ADD COLUMN active_revision_id UUID;`);
    await pg.exec(`ALTER TABLE simulations ADD COLUMN active_revision_entry_key TEXT;`);
    await expect(applyForward()).resolves.toBeDefined();
    const [idx] = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_sim_revisions_active'`,
    );
    expect(idx!.indexdef).toContain('WHERE');
  });
});

// ── 3. At most one active revision — the load-bearing guarantee ──────────────────────────────────

describe('050 — uniq_sim_revisions_active', () => {
  beforeEach(applyForward);

  it('is a PARTIAL unique index, not a total one', async () => {
    const [idx] = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_sim_revisions_active'`,
    );
    // A total unique index on simulation_id would forbid a simulation from ever having a second
    // revision at all — the exact opposite of the feature.
    expect(idx!.indexdef).toMatch(/UNIQUE/);
    expect(idx!.indexdef).toMatch(/WHERE \(?status = 'active'/);
  });

  it('refuses a second active revision for one simulation', async () => {
    await insertRevision({ status: 'active', revision_number: 1 });
    await expect(insertRevision({ status: 'active', revision_number: 2 }))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('permits many non-active revisions', async () => {
    await insertRevision({ status: 'retired', revision_number: 1 });
    await insertRevision({ status: 'retired', revision_number: 2 });
    await insertRevision({ status: 'draft', revision_number: 3 });
    await insertRevision({ status: 'failed', revision_number: 4 });
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_revisions`);
    expect(n).toBe(4);
  });

  it('permits one active revision per simulation across simulations', async () => {
    const [s2] = await rows<{ id: string }>(
      `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
       VALUES ($1, 'sim2', 'simulations/p/s2', 'index.html') RETURNING id`, [projectId],
    );
    await insertRevision({ status: 'active' });
    await pg.query(
      `INSERT INTO sim_revisions (simulation_id, revision_number, status, activated_at)
       VALUES ($1, 1, 'active', now())`, [s2!.id],
    );
    const [{ n }] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM sim_revisions WHERE status = 'active'`,
    );
    expect(n).toBe(2);
  });

  it('demote-then-promote in one transaction succeeds', async () => {
    // The index is an INDEX, not a DEFERRABLE constraint, so ordering inside the transaction is
    // load-bearing. This is the order the activation path must use.
    const r1 = await insertRevision({ status: 'active', revision_number: 1 });
    const r2 = await insertRevision({ status: 'canary_passed', revision_number: 2 });
    await pg.exec('BEGIN');
    await pg.query(`UPDATE sim_revisions SET status='retired', retired_at=now() WHERE id=$1`, [r1]);
    await pg.query(`UPDATE sim_revisions SET status='active', activated_at=now() WHERE id=$1`, [r2]);
    await pg.exec('COMMIT');
    const [{ id }] = await rows<{ id: string }>(
      `SELECT id FROM sim_revisions WHERE status = 'active'`,
    );
    expect(id).toBe(r2);
  });

  it('promote-then-demote in one transaction is REFUSED', async () => {
    // Recorded because it is the natural order to write and it aborts a legal operation.
    const r1 = await insertRevision({ status: 'active', revision_number: 1 });
    const r2 = await insertRevision({ status: 'canary_passed', revision_number: 2 });
    await pg.exec('BEGIN');
    await expect(
      pg.query(`UPDATE sim_revisions SET status='active', activated_at=now() WHERE id=$1`, [r2]),
    ).rejects.toMatchObject({ code: '23505' });
    await pg.exec('ROLLBACK');
    const [{ id }] = await rows<{ id: string }>(
      `SELECT id FROM sim_revisions WHERE status = 'active'`,
    );
    expect(id).toBe(r1);
  });
});

// ── 4. Constraints ───────────────────────────────────────────────────────────────────────────────

describe('050 — constraints', () => {
  beforeEach(applyForward);

  it('forbids a pointer without an entry key, and an entry key without a pointer', async () => {
    const revId = await insertRevision({ status: 'active' });
    await expect(
      pg.query(`UPDATE simulations SET active_revision_id = $1 WHERE id = $2`, [revId, simId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pg.query(`UPDATE simulations SET active_revision_entry_key = 'k' WHERE id = $1`, [simId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts both together', async () => {
    const revId = await insertRevision({ status: 'active' });
    await expect(pg.query(
      `UPDATE simulations SET active_revision_id=$1, active_revision_entry_key=$2 WHERE id=$3`,
      [revId, 'simulations/p/s/revisions/r/package/index.html', simId],
    )).resolves.toBeDefined();
  });

  it('requires activated_at for every status whose bytes must be retained', async () => {
    // rollbackTargetFor filters on activatedAt !== null. A retained revision with a NULL
    // activated_at would be silently unreachable by rollback — a failure that only surfaces during
    // an incident, which is why it is structural here rather than defensive there.
    for (const status of ['active', 'retired', 'rolled_back']) {
      await expect(insertRevision({ status, activated_at: null }))
        .rejects.toMatchObject({ code: '23514' });
    }
  });

  it('permits a NULL activated_at for statuses that were never served', async () => {
    for (const [i, status] of ['draft', 'uploading', 'validating', 'canary_passed', 'failed'].entries()) {
      await expect(insertRevision({ status, revision_number: i + 1, activated_at: null }))
        .resolves.toBeTruthy();
    }
  });

  it('rejects an unknown status', async () => {
    await expect(insertRevision({ status: 'published' })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a manifest_hash that is not lowercase 64-hex', async () => {
    await expect(insertRevision({ manifest_hash: 'nope' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRevision({ manifest_hash: 'A'.repeat(64) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRevision({ manifest_hash: 'a'.repeat(63) })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRevision({ manifest_hash: 'a'.repeat(64) })).resolves.toBeTruthy();
  });

  it('rejects a non-positive revision number', async () => {
    await expect(insertRevision({ revision_number: 0 })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a duplicate revision number within one simulation', async () => {
    await insertRevision({ revision_number: 7 });
    await expect(insertRevision({ revision_number: 7 })).rejects.toMatchObject({ code: '23505' });
  });
});

// ── 5. Referential behaviour ─────────────────────────────────────────────────────────────────────

describe('050 — referential behaviour', () => {
  beforeEach(applyForward);

  it('deleting a simulation cascades its revisions without deadlocking on the pointer FK', async () => {
    // The FK is ON DELETE SET NULL precisely so this statement does not fight its own cascade: both
    // rows are removed by one statement and FK checks fire at end of statement.
    const revId = await insertRevision({ status: 'active' });
    await pg.query(
      `UPDATE simulations SET active_revision_id=$1, active_revision_entry_key='k' WHERE id=$2`,
      [revId, simId],
    );
    await expect(pg.query(`DELETE FROM simulations WHERE id = $1`, [simId])).resolves.toBeDefined();
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_revisions`);
    expect(n).toBe(0);
  });

  it('deleting a revision NEVER deletes its simulation', async () => {
    // The FK is ON DELETE SET NULL. Under CASCADE this DELETE would remove the simulations row
    // itself — a GC pass reclaiming a revision would silently destroy the package, the timeline
    // sections referencing it, and every poster. Nothing about the statement would look wrong.
    const revId = await insertRevision({ status: 'retired' });
    await pg.query(`DELETE FROM sim_revisions WHERE id = $1`, [revId]);
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM simulations`);
    expect(n).toBe(1);
  });

  it('refuses to delete the revision the pointer is on — the DB enforces mustRetainBytes', async () => {
    // Emergent from SET NULL meeting simulations_active_revision_pair_chk: SET NULL clears
    // active_revision_id but leaves active_revision_entry_key, which the CHECK forbids. The result
    // is that the live revision's bytes cannot be reclaimed while it is being served, which is
    // exactly what mustRetainBytes('active') asserts in the application layer.
    const revId = await insertRevision({ status: 'active' });
    await pg.query(
      `UPDATE simulations SET active_revision_id=$1, active_revision_entry_key='k' WHERE id=$2`,
      [revId, simId],
    );
    await expect(pg.query(`DELETE FROM sim_revisions WHERE id = $1`, [revId]))
      .rejects.toMatchObject({ code: '23514' });
    const [s] = await rows<{ active_revision_id: string }>(
      `SELECT active_revision_id FROM simulations WHERE id = $1`, [simId],
    );
    expect(s!.active_revision_id).toBe(revId);
  });

  it('permits deleting a revision once the pointer has moved off it', async () => {
    const revId = await insertRevision({ status: 'retired' });
    await pg.query(
      `UPDATE simulations SET active_revision_id=NULL, active_revision_entry_key=NULL WHERE id=$1`,
      [simId],
    );
    await expect(pg.query(`DELETE FROM sim_revisions WHERE id = $1`, [revId])).resolves.toBeDefined();
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM simulations`);
    expect(n).toBe(1);
  });

  it('deleting a rollback target keeps the rollback audit record', async () => {
    const target = await insertRevision({ status: 'retired', revision_number: 1 });
    const [r2] = await rows<{ id: string }>(
      `INSERT INTO sim_revisions (simulation_id, revision_number, status, rollback_of_revision_id)
       VALUES ($1, 2, 'draft', $2) RETURNING id`, [simId, target],
    );
    await pg.query(`DELETE FROM sim_revisions WHERE id = $1`, [target]);
    const [row] = await rows<{ id: string; rollback_of_revision_id: string | null }>(
      `SELECT id, rollback_of_revision_id FROM sim_revisions WHERE id = $1`, [r2!.id],
    );
    // The record that a rollback happened outlives the thing it restored.
    expect(row!.id).toBe(r2!.id);
    expect(row!.rollback_of_revision_id).toBeNull();
  });
});

// ── 6. The revision_number allocator ─────────────────────────────────────────────────────────────

describe('050 — revision_counter', () => {
  beforeEach(applyForward);

  it('allocates monotonically under the row lock', async () => {
    const alloc = async (): Promise<number> => {
      const [r] = await rows<{ revision_counter: number }>(
        `UPDATE simulations SET revision_counter = revision_counter + 1
          WHERE id = $1 RETURNING revision_counter`, [simId],
      );
      return r!.revision_counter;
    };
    expect([await alloc(), await alloc(), await alloc()]).toEqual([1, 2, 3]);
  });

  it('a max()+1 allocator collides where the counter does not', async () => {
    // Recorded as the reason the counter exists: max()+1 reads a value two concurrent drafts can
    // both observe, and the collision surfaces only AFTER bytes have started being written.
    await insertRevision({ revision_number: 1 });
    const [m] = await rows<{ next: number }>(
      `SELECT COALESCE(max(revision_number), 0) + 1 AS next FROM sim_revisions WHERE simulation_id = $1`,
      [simId],
    );
    await insertRevision({ revision_number: m!.next });
    await expect(insertRevision({ revision_number: m!.next }))
      .rejects.toMatchObject({ code: '23505' });
  });
});

// ── 7. Rollback ──────────────────────────────────────────────────────────────────────────────────

describe('050 — rollback', () => {
  it('drops everything 050 added, in an order the FK permits', async () => {
    await applyForward();
    await insertRevision({ status: 'active' });
    await expect(applyRollback()).resolves.toBeDefined();

    const [{ n: tables }] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'sim_revisions'`,
    );
    expect(tables).toBe(0);
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'simulations'`,
    );
    for (const c of NEW_SIM_COLUMNS) expect(cols.map((x) => x.column_name)).not.toContain(c);
  });

  it('leaves the pre-050 simulations row intact', async () => {
    await applyForward();
    await applyRollback();
    const [s] = await rows<{ id: string; name: string }>(
      `SELECT id, name FROM simulations WHERE id = $1`, [simId],
    );
    // Rolling back must revert every simulation to its legacy mutable path, which requires the row
    // — and its storage_prefix — to still be there.
    expect(s!.id).toBe(simId);
    expect(s!.name).toBe('sim');
  });

  it('forward → rollback → forward reaches the same catalog state', async () => {
    await applyForward();
    const first = await snapshot();
    await applyRollback();
    await applyForward();
    expect(await snapshot()).toEqual(first);
  });

  it('is idempotent', async () => {
    await applyForward();
    await applyRollback();
    await expect(applyRollback()).resolves.toBeDefined();
  });
});

// ── 8. Registration ──────────────────────────────────────────────────────────────────────────────

describe('050 — registration', () => {
  it('is registered with the migration runner', async () => {
    const runner = readFileSync(join(MIGRATIONS_DIR, '..', 'migrate.ts'), 'utf-8');
    // A migration file on disk that the runner does not list is applied by nobody.
    expect(runner).toContain(TARGET);
  });

  it('is registered with db:check, along with the 046-049 gap it had drifted into', async () => {
    const check = readFileSync(
      join(MIGRATIONS_DIR, '..', '..', 'scripts', 'check-db.ts'), 'utf-8',
    );
    for (const f of ALL.slice(ALL.indexOf('046_token_usage_cost_precision.sql'))) {
      expect(check).toContain(f);
    }
  });

  it('ships a rollback file', () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain(ROLLBACK);
  });
});
