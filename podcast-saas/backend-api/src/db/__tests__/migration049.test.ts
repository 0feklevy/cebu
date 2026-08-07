/**
 * Migration 049 (`sim_posters` + the canary columns on `simulations`) proven against a real
 * Postgres engine — PGlite, in-process WASM Postgres — with the REAL prior schema underneath it.
 *
 * Why this file exists at all, given that PosterService already has DDL coverage:
 *
 *   schema.ts declares `bridge_hash`, `package_class`, `canary_report`, `canary_at` and the whole
 *   `sim_posters` table. Drizzle emits EVERY declared column in a full-row select, so the moment an
 *   image containing this schema serves traffic against a database where 049 has not been applied,
 *   every `db.query.simulations` read raises PostgreSQL 42703 (undefined_column) — roughly twenty
 *   call sites, including the player's hottest read path. That is a deployment-ORDERING hazard, and
 *   ordering hazards are invisible to a test that builds its fixture from schema.ts.
 *
 * So this suite is deliberately built the other way round: it replays the actual migration files in
 * order, and drives the actual Drizzle query shapes over the result. It proves the forward step,
 * its idempotency, that existing rows survive it, that the affected queries work after it — and,
 * as the regression test for the hazard itself, that those same queries fail with 42703 BEFORE it.
 *
 * Isolation: this file never imports `../index.js`. That module constructs a postgres.js pool
 * against `DATABASE_URL` at import time, and `DATABASE_URL` points at the database that preview and
 * production SHARE. Importing schema.ts alone (pure table definitions, no client) and binding it to
 * a private in-process engine is what makes it impossible for this suite to reach that database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, inArray } from 'drizzle-orm';

import * as schema from '../schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TARGET = '049_sim_posters.sql';
const ROLLBACK = '049_sim_posters.rollback.sql';

/**
 * Every numbered forward migration, in filename order.
 *
 * Discovered from disk rather than hard-coded so that a migration added between now and the next
 * reader does not silently drop out of "the prior schema" and quietly weaken every assertion below
 * — which is exactly the failure this file is about. `.rollback.` files and the unnumbered
 * `phase2-schema.sql` are not forward steps and are excluded by the pattern.
 */
function forwardMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[^.]+\.sql$/.test(f))
    .sort();
}

const ALL = forwardMigrations();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

/** The four columns 049 adds to `simulations`. Named once; asserted from both directions. */
const NEW_SIM_COLUMNS = ['bridge_hash', 'package_class', 'canary_report', 'canary_at'] as const;

/** The classes a canary may assign — the CHECK vocabulary, mirrored from shared/src/sim. */
const PACKAGE_CLASSES = [
  'managed-presentable',
  'managed-partial',
  'legacy-cooperative',
  'legacy-opaque',
  'failed',
] as const;

const VARIANTS = JSON.stringify([
  { size: 'standard', format: 'webp', path: 'p/standard.webp', checksum: 'c'.repeat(64), width: 1280, height: 720 },
]);

/** The pre-049 shape of a `simulations` row, so "existing rows survive" has something to compare to. */
const LEGACY_SIM = {
  name: 'pluck-boids',
  storage_prefix: 'simulations/p/s',
  entry_file: 'https://cdn.example/simulations/p/s/index.html',
  bridge_functions: JSON.stringify([{ name: 'setSpeed', args: ['number'] }]),
  status: 'ready',
  error: null as string | null,
  guidance: JSON.stringify([{ at: 1.5, text: 'watch the flock split' }]),
  guidance_status: 'ready',
  guidance_meta: JSON.stringify({ provider: 'claude', entryCount: 1 }),
  guidance_error: null as string | null,
};

type Snapshot = { columns: unknown[]; constraints: unknown[]; indexes: unknown[]; tables: unknown[] };

describe('migration 049 — sim_posters + canary columns', () => {
  let pg: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: string;
  let simId: string;

  /** Apply the real 049 file exactly as the migration runner would (one multi-statement exec). */
  const applyForward = () => pg.exec(forwardSql);

  /**
   * Apply 049 AND every migration after it.
   *
   * Needed by the Drizzle-shape assertions only. `schema.ts` always describes the HEAD of the
   * migration list, and Drizzle emits every declared column in a full-row select — so a test that
   * stops at 049 and then drives a full-row read is asserting against a database the current
   * schema.ts no longer describes, and fails with 42703 on whatever 050+ added.
   *
   * That is not incidental to this file, it is the very hazard it documents: a schema ahead of the
   * applied migrations breaks every full-row read. The catalog-level assertions above deliberately
   * do NOT use this — they must keep testing 049 in isolation, or they would stop being about 049.
   */
  const applyForwardToHead = async (): Promise<void> => {
    await applyForward();
    for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
    }
  };
  const applyRollback = () => pg.exec(rollbackSql);

  async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await pg.query<T>(sql, params)).rows;
  }

  /**
   * The parts of the catalog 049 is allowed to move, for the two structural comparisons below
   * (double-apply and rollback round-trip). Constraint definitions are captured as text so a
   * re-created CHECK with a different predicate reads as a difference, not as a match on name.
   */
  async function snapshot(): Promise<Snapshot> {
    return {
      tables: await rows(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY table_name`,
      ),
      columns: await rows(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ('simulations', 'sim_posters')
          ORDER BY table_name, column_name`,
      ),
      constraints: await rows(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname IN ('simulations', 'sim_posters') ORDER BY c.conname`,
      ),
      indexes: await rows(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename IN ('simulations', 'sim_posters') ORDER BY indexname`,
      ),
    };
  }

  async function insertPoster(over: Record<string, unknown> = {}): Promise<void> {
    const cols: Record<string, unknown> = {
      simulation_id: simId,
      package_revision: 'rev00000000000a',
      variant_key: 'section-a',
      config_hash: 'cfg000000000000a',
      aspect_profile: 'wide',
      quality_profile: 'high',
      identity: 'rev00000000000a__section-a__cfg000000000000a__wide__high',
      variants: VARIANTS,
      transparent: false,
      ...over,
    };
    const keys = Object.keys(cols);
    const placeholders = keys.map((k, i) => (k === 'variants' ? `$${i + 1}::jsonb` : `$${i + 1}`));
    await pg.query(
      `INSERT INTO sim_posters (${keys.join(', ')}) VALUES (${placeholders.join(', ')})`,
      keys.map((k) => cols[k]),
    );
  }

  /** Run a thunk that must be rejected by the database; returns the error's SQLSTATE + message. */
  async function rejected(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
      await fn();
    } catch (err) {
      const e = err as { code?: string; message?: string; cause?: { code?: string } };
      return { code: e.code ?? e.cause?.code ?? '', message: e.message ?? String(err) };
    }
    throw new Error('expected the database to reject this, but it succeeded');
  }

  beforeEach(async () => {
    pg = new PGlite();
    // Approach: replay the REAL migration files 001–048 rather than hand-building ancestor tables.
    // It costs ~1.5s and it is the only version of "the prior schema" that cannot drift from what a
    // production database actually contains — a hand-written `projects`/`simulations` pair would be
    // written from schema.ts, i.e. from the post-049 world, which is precisely the assumption under
    // test. It also makes the FKs resolve against the genuine parents instead of stand-ins.
    for (const file of PRIOR) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'));
    }
    db = drizzle(pg, { schema });

    const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`);
    const [project] = await rows<{ id: string }>(
      `INSERT INTO projects (org_id, title) VALUES ($1, 'Project') RETURNING id`,
      [org.id],
    );
    projectId = project.id;

    const keys = Object.keys(LEGACY_SIM);
    const [sim] = await rows<{ id: string }>(
      `INSERT INTO simulations (project_id, ${keys.join(', ')})
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [projectId, ...keys.map((k) => LEGACY_SIM[k as keyof typeof LEGACY_SIM])],
    );
    simId = sim.id;
  });

  afterEach(async () => {
    await pg.close();
  });

  // ── The prior schema is genuinely prior ─────────────────────────────────────

  it('replays a prior schema that really does predate 049', () => {
    // If the discovery pattern ever stops matching, PRIOR silently becomes [] and every test below
    // starts passing against an empty database. Pin the ends of the range.
    expect(PRIOR).toContain('001_initial.sql');
    expect(PRIOR).toContain('048_sim_pool_mode.sql');
    expect(PRIOR).not.toContain(TARGET);
    expect(PRIOR).toHaveLength(48);
  });

  it('is registered in the migration runner, so applying it is not a manual step', () => {
    const runner = readFileSync(join(MIGRATIONS_DIR, '..', 'migrate.ts'), 'utf-8');
    for (const file of [...PRIOR, TARGET]) {
      expect(runner).toContain(`'${file}'`);
    }
  });

  // ── 1. Forward application ──────────────────────────────────────────────────

  describe('forward', () => {
    it('applies cleanly on top of the real 001–048 schema', async () => {
      await applyForward();

      const cols = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'simulations' AND column_name = ANY($1)`,
        [[...NEW_SIM_COLUMNS]],
      );
      expect(cols.map((c) => c.column_name).sort()).toEqual([...NEW_SIM_COLUMNS].sort());

      const [table] = await rows<{ t: string | null }>(`SELECT to_regclass('sim_posters')::text AS t`);
      expect(table.t).toBe('sim_posters');

      const [idx] = await rows<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_sim_posters_revision'`,
      );
      // The revision sweep's predicate is (simulation_id, package_revision) and runs on every
      // republish; an index on the wrong leading column would not serve it.
      expect(idx.indexdef).toMatch(/\(simulation_id, package_revision\)/);
    });

    it('is idempotent — a second application changes nothing and does not error', async () => {
      await applyForward();
      const once = await snapshot();

      await applyForward();
      const twice = await snapshot();

      expect(twice).toEqual(once);
    });

    it('a re-run does not disturb data written between the two applications', async () => {
      await applyForward();
      await pg.query('UPDATE simulations SET package_class = $1, bridge_hash = $2 WHERE id = $3', [
        'managed-presentable',
        'abc123',
        simId,
      ]);
      await insertPoster();

      await applyForward();

      const [sim] = await rows<{ package_class: string; bridge_hash: string }>(
        'SELECT package_class, bridge_hash FROM simulations WHERE id = $1',
        [simId],
      );
      expect(sim).toEqual({ package_class: 'managed-presentable', bridge_hash: 'abc123' });
      const [{ n }] = await rows<{ n: number }>('SELECT count(*)::int AS n FROM sim_posters');
      expect(n).toBe(1);
    });
  });

  // ── 2. Existing rows survive ────────────────────────────────────────────────

  describe('existing rows', () => {
    it('keeps every pre-migration value and defaults the four new columns to NULL', async () => {
      const before = (await rows(`SELECT * FROM simulations WHERE id = $1`, [simId]))[0];

      await applyForward();

      const after = (await rows(`SELECT * FROM simulations WHERE id = $1`, [simId]))[0] as Record<string, unknown>;

      for (const [key, value] of Object.entries(before as Record<string, unknown>)) {
        expect(after[key]).toEqual(value);
      }
      for (const col of NEW_SIM_COLUMNS) {
        expect(after[col]).toBeNull();
      }
      // NULL is load-bearing, not incidental: an unclassified package must keep its pre-v3
      // behaviour, and nothing may infer "legacy" from the absence of a class. A DEFAULT here
      // would classify every existing package by fiat.
      expect(await rows(`SELECT count(*)::int AS n FROM simulations WHERE package_class IS NOT NULL`)).toEqual([
        { n: 0 },
      ]);
    });

    it('does not rewrite the row (created_at and the JSONB payloads are byte-identical)', async () => {
      const [before] = await rows<{ created_at: Date; guidance: unknown; bridge_functions: unknown }>(
        `SELECT created_at, guidance, bridge_functions FROM simulations WHERE id = $1`,
        [simId],
      );
      await applyForward();
      const [after] = await rows<{ created_at: Date; guidance: unknown; bridge_functions: unknown }>(
        `SELECT created_at, guidance, bridge_functions FROM simulations WHERE id = $1`,
        [simId],
      );
      expect(after.created_at).toEqual(before.created_at);
      expect(after.guidance).toEqual(JSON.parse(LEGACY_SIM.guidance));
      expect(after.bridge_functions).toEqual(JSON.parse(LEGACY_SIM.bridge_functions));
    });
  });

  // ── 3. The regression test for the ordering hazard ──────────────────────────

  describe('before the migration is applied', () => {
    it('the full-row simulations read raises 42703, naming a column 049 adds', async () => {
      const { code, message } = await rejected(() =>
        db.query.simulations.findMany({ where: eq(schema.simulations.project_id, projectId) }),
      );

      expect(code).toBe('42703'); // undefined_column
      expect(message).toMatch(new RegExp(`(${NEW_SIM_COLUMNS.join('|')})`));
    });

    it('the narrowed buildPlayerConfig read raises 42703 too — narrowing is not a workaround', async () => {
      const { code } = await rejected(() =>
        db.query.simulations.findMany({
          where: eq(schema.simulations.project_id, projectId),
          columns: { id: true, package_class: true, bridge_hash: true },
        }),
      );
      expect(code).toBe('42703');
    });

    it('the poster read raises 42P01 — a missing table, not a missing column', async () => {
      const { code } = await rejected(() =>
        db.query.sim_posters.findMany({ where: inArray(schema.sim_posters.simulation_id, [simId]) }),
      );
      expect(code).toBe('42P01'); // undefined_table
    });

    it('a pre-049 column list still reads fine — only the new columns are missing', async () => {
      // Pins the diagnosis: the failure above is 049's four columns, not a broken engine or fixture.
      const [row] = await rows<{ name: string }>('SELECT id, name, status, guidance FROM simulations WHERE id = $1', [
        simId,
      ]);
      expect(row.name).toBe(LEGACY_SIM.name);
    });
  });

  // ── 4. The affected queries after the migration ─────────────────────────────

  describe('after the migration', () => {
    beforeEach(async () => {
      await applyForwardToHead();
    });

    it('the full-row simulations read succeeds and reports the package as unclassified', async () => {
      const found = await db.query.simulations.findMany({ where: eq(schema.simulations.project_id, projectId) });

      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(simId);
      expect(found[0].name).toBe(LEGACY_SIM.name);
      expect(found[0].guidance_status).toBe('ready');
      expect(found[0].bridge_hash).toBeNull();
      expect(found[0].package_class).toBeNull();
      expect(found[0].canary_report).toBeNull();
      expect(found[0].canary_at).toBeNull();
    });

    it('the narrowed buildPlayerConfig read returns exactly its three columns', async () => {
      const found = await db.query.simulations.findMany({
        where: eq(schema.simulations.project_id, projectId),
        columns: { id: true, package_class: true, bridge_hash: true },
      });

      expect(found).toHaveLength(1);
      // The narrowing is not cosmetic — it keeps `guidance`, `guidance_meta`, `bridge_functions`
      // and `canary_report` off the player's hottest read path. A regression that widened it back
      // to a full row would show up here as extra keys.
      expect(Object.keys(found[0]).sort()).toEqual(['bridge_hash', 'id', 'package_class']);
      expect(found[0]).toEqual({ id: simId, package_class: null, bridge_hash: null });
    });

    it('the narrowed read carries a written verdict through', async () => {
      await pg.query('UPDATE simulations SET package_class = $1, bridge_hash = $2, canary_at = now() WHERE id = $3', [
        'managed-presentable',
        'deadbeefcafe',
        simId,
      ]);

      const [found] = await db.query.simulations.findMany({
        where: eq(schema.simulations.project_id, projectId),
        columns: { id: true, package_class: true, bridge_hash: true },
      });
      expect(found).toEqual({ id: simId, package_class: 'managed-presentable', bridge_hash: 'deadbeefcafe' });
    });

    it('the poster read succeeds — empty for an uncaptured simulation, then returns the row', async () => {
      const empty = await db.query.sim_posters.findMany({
        where: inArray(schema.sim_posters.simulation_id, [simId]),
      });
      expect(empty).toEqual([]);

      await insertPoster();

      const [poster] = await db.query.sim_posters.findMany({
        where: inArray(schema.sim_posters.simulation_id, [simId]),
      });
      expect(poster.simulation_id).toBe(simId);
      expect(poster.identity).toBe('rev00000000000a__section-a__cfg000000000000a__wide__high');
      expect(poster.transparent).toBe(false);
      expect(poster.captured_at).toBeInstanceOf(Date);
      // Drizzle must hand back the parsed array, not the raw text — buildPlayerConfig indexes it.
      expect(poster.variants).toEqual(JSON.parse(VARIANTS));
    });

    it('a canary verdict round-trips through Drizzle, JSONB and timestamptz', async () => {
      const report = { classification: 'managed-partial', checks: [{ id: 'handshake', ok: true }] };
      const at = new Date('2026-07-01T12:00:00.000Z');

      await db
        .update(schema.simulations)
        .set({ package_class: 'managed-partial', canary_report: report, canary_at: at, bridge_hash: 'h'.repeat(16) })
        .where(eq(schema.simulations.id, simId));

      const found = await db.query.simulations.findFirst({ where: eq(schema.simulations.id, simId) });
      expect(found!.canary_report).toEqual(report);
      expect(found!.canary_at).toEqual(at);
      expect(found!.package_class).toBe('managed-partial');
    });
  });

  // ── 5. Constraints ──────────────────────────────────────────────────────────

  describe('constraints', () => {
    beforeEach(async () => {
      await applyForward();
    });

    it('accepts every SimPackageClass, and NULL, and nothing else', async () => {
      for (const cls of PACKAGE_CLASSES) {
        await pg.query('UPDATE simulations SET package_class = $1 WHERE id = $2', [cls, simId]);
        const [row] = await rows<{ package_class: string }>('SELECT package_class FROM simulations WHERE id = $1', [
          simId,
        ]);
        expect(row.package_class).toBe(cls);
      }
      await pg.query('UPDATE simulations SET package_class = NULL WHERE id = $1', [simId]);

      for (const bad of ['managed', 'presentable', 'MANAGED-PRESENTABLE', '']) {
        const { message } = await rejected(() =>
          pg.query('UPDATE simulations SET package_class = $1 WHERE id = $2', [bad, simId]),
        );
        expect(message).toMatch(/simulations_package_class_chk/);
      }
    });

    it('holds one poster per (simulation_id, identity), and lets two simulations share an identity', async () => {
      await insertPoster();

      // Same identity, different everything-else: the constraint is on the identity, so the second
      // capture must collide (PosterService relies on this to upsert instead of accumulating).
      const dup = await rejected(() => insertPoster({ package_revision: 'rev-different', transparent: true }));
      expect(dup.code).toBe('23505'); // unique_violation
      expect(dup.message).toMatch(/uniq_sim_posters_sim_identity/);

      const [other] = await rows<{ id: string }>(
        `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
         VALUES ($1, 'other', 'simulations/p/s2', 'e') RETURNING id`,
        [projectId],
      );
      await insertPoster({ simulation_id: other.id });
      expect(await rows('SELECT count(*)::int AS n FROM sim_posters')).toEqual([{ n: 2 }]);
    });

    it('refuses a poster with no renditions, or a variants blob that is not an array', async () => {
      // "Has a poster" and "has something to show" must be the same statement; an empty array would
      // resolve to the first and fail the second at display time.
      for (const bad of ['[]', '{}', '{"size":"standard"}', '"[]"', 'null', '3']) {
        const { message } = await rejected(() => insertPoster({ variants: bad }));
        expect(message).toMatch(/sim_posters_variants_array_chk/);
      }
      expect(await rows('SELECT count(*)::int AS n FROM sim_posters')).toEqual([{ n: 0 }]);
    });

    it('refuses aspect and quality profiles outside the protocol vocabulary', async () => {
      for (const bad of ['square', 'tall', '16:9']) {
        expect((await rejected(() => insertPoster({ aspect_profile: bad }))).message).toMatch(/check/i);
      }
      for (const bad of ['ultra', 'medium', 'HIGH']) {
        expect((await rejected(() => insertPoster({ quality_profile: bad }))).message).toMatch(/check/i);
      }
      for (const good of ['wide', 'standard', 'portrait', 'native']) {
        await insertPoster({ aspect_profile: good, identity: `id-${good}` });
      }
      expect(await rows('SELECT count(*)::int AS n FROM sim_posters')).toEqual([{ n: 4 }]);
    });

    it('requires a real simulation and cascades from it, and from the project above it', async () => {
      const orphan = await rejected(() =>
        insertPoster({ simulation_id: '00000000-0000-0000-0000-000000000000' }),
      );
      expect(orphan.code).toBe('23503'); // foreign_key_violation

      await insertPoster();
      await pg.query('DELETE FROM simulations WHERE id = $1', [simId]);
      expect(await rows('SELECT count(*)::int AS n FROM sim_posters')).toEqual([{ n: 0 }]);

      // Two levels: posters live under the simulation's storage prefix, which lives under the
      // project's. Deleting a project must not leave poster rows pointing at bytes that are gone.
      const [sim2] = await rows<{ id: string }>(
        `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
         VALUES ($1, 'again', 'simulations/p/s3', 'e') RETURNING id`,
        [projectId],
      );
      await insertPoster({ simulation_id: sim2.id });
      await pg.query('DELETE FROM projects WHERE id = $1', [projectId]);
      expect(await rows('SELECT count(*)::int AS n FROM sim_posters')).toEqual([{ n: 0 }]);
    });
  });

  // ── 6. Rollback ─────────────────────────────────────────────────────────────

  describe('rollback', () => {
    it('restores the exact pre-migration catalog, and forward works again afterwards', async () => {
      const before = await snapshot();

      await applyForward();
      await insertPoster();
      await pg.query('UPDATE simulations SET package_class = $1 WHERE id = $2', ['failed', simId]);

      await applyRollback();
      expect(await snapshot()).toEqual(before);

      // The simulation itself is untouched by the rollback — only the additive columns go.
      const [sim] = await rows<{ name: string; guidance_status: string }>(
        'SELECT name, guidance_status FROM simulations WHERE id = $1',
        [simId],
      );
      expect(sim).toEqual({ name: LEGACY_SIM.name, guidance_status: 'ready' });

      await applyForward();
      await insertPoster();
      expect(await rows('SELECT count(*)::int AS n FROM sim_posters')).toEqual([{ n: 1 }]);
      const [row] = await rows<{ package_class: string | null }>('SELECT package_class FROM simulations WHERE id = $1', [
        simId,
      ]);
      expect(row.package_class).toBeNull(); // the dropped column comes back empty, not resurrected
    });

    it('is itself re-runnable and puts the queries back into the 42703 failure mode', async () => {
      await applyForward();
      await applyRollback();
      await applyRollback();

      const { code } = await rejected(() =>
        db.query.simulations.findMany({ where: eq(schema.simulations.project_id, projectId) }),
      );
      expect(code).toBe('42703');
    });
  });
});
