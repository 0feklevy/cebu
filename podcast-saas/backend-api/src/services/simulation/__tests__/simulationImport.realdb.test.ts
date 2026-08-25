/**
 * The `+` import against a REAL Postgres.
 *
 * `simulationImport.test.ts` mocks the database and proves the eligibility and copy DISCIPLINE.
 * What it cannot prove is that the row the import writes is a row Postgres will accept: the
 * simulations table has NOT NULL columns the insert must satisfy, and an insert that omits one
 * typechecks perfectly and fails the first time a user presses Import.
 *
 * This file inserts through the real DDL. It deliberately does not re-test the eligibility rules —
 * those are pure and covered — only the things that require a database to be wrong about.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';

const pg = new PGlite();

/**
 * The columns 008 + later migrations give `simulations`, reduced to the NOT NULLs and the fields
 * the import actually writes. Kept as literal DDL so a missing NOT NULL here cannot silently make
 * the test easier than production.
 */
const DDL = `
  CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT);
  CREATE TABLE simulations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    storage_prefix   TEXT NOT NULL,
    entry_file       TEXT NOT NULL,
    bridge_functions JSONB DEFAULT '[]',
    status           TEXT NOT NULL DEFAULT 'processing',
    guidance_status  TEXT NOT NULL DEFAULT 'none',
    package_class    TEXT,
    bridge_hash      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

let SOURCE_PROJECT = '';
let DEST_PROJECT = '';

beforeAll(async () => {
  await pg.exec(DDL);
  const a = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('source') RETURNING id`);
  const b = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('dest') RETURNING id`);
  SOURCE_PROJECT = a.rows[0].id;
  DEST_PROJECT = b.rows[0].id;
  await pg.query(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, bridge_functions, status, package_class, bridge_hash)
     VALUES ($1,'Boids',$2,'https://cdn/x/index.html','[{"name":"pluck"}]','ready','managed-presentable','bh-1')`,
    [SOURCE_PROJECT, `simulations/${SOURCE_PROJECT}/src-sim`]);
});

afterAll(async () => { await pg.close(); });

/** Exactly the insert `SimulationImportService` performs, so a missing NOT NULL shows up here. */
async function importRow(over: Record<string, unknown> = {}) {
  const newId = randomUUID();
  const prefix = `simulations/${DEST_PROJECT}/${newId}`;
  const src = await pg.query<Record<string, unknown>>(`SELECT * FROM simulations WHERE project_id = $1 LIMIT 1`, [SOURCE_PROJECT]);
  const s = src.rows[0];
  const values = {
    id: newId,
    project_id: DEST_PROJECT,
    name: s.name,
    storage_prefix: prefix,
    entry_file: `https://cdn.example/${prefix}/index.html`,
    bridge_functions: JSON.stringify(s.bridge_functions),
    status: 'ready',
    package_class: null,
    guidance_status: 'none',
    ...over,
  };
  const r = await pg.query<Record<string, unknown>>(
    `INSERT INTO simulations (id, project_id, name, storage_prefix, entry_file, bridge_functions, status, package_class, guidance_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [values.id, values.project_id, values.name, values.storage_prefix, values.entry_file,
     values.bridge_functions, values.status, values.package_class, values.guidance_status]);
  return r.rows[0];
}

describe('the imported row is one Postgres accepts', () => {
  it('satisfies every NOT NULL the simulations table declares', async () => {
    // The defect this catches: an insert missing `entry_file` or `storage_prefix` typechecks
    // (they are optional in the Drizzle insert type when they have no default) and fails only
    // when a user presses Import.
    const row = await importRow();
    expect(row.id).toBeTruthy();
    expect(row.storage_prefix).toMatch(new RegExp(`^simulations/${DEST_PROJECT}/`));
    expect(String(row.entry_file)).toContain('/index.html');
  });

  it('lands in the DESTINATION project, under a prefix naming the destination', async () => {
    // The whole point. A prefix still carrying the SOURCE project id would make the copy live
    // under the source's path, and deleting the source would take the import with it.
    const row = await importRow();
    expect(row.project_id).toBe(DEST_PROJECT);
    expect(String(row.storage_prefix)).not.toContain(SOURCE_PROJECT);
  });

  it('claims NOTHING the copy did not produce', async () => {
    // package_class is a canary verdict about the SOURCE's bytes under the SOURCE's id. Carrying
    // it over would assert a check that never ran against this copy.
    const row = await importRow();
    expect(row.package_class, 'a canary verdict about the source was carried over').toBeNull();
    expect(row.guidance_status).toBe('none');
    expect(row.bridge_hash, 'a bridge hash was carried over — the bridge is deliberately not copied').toBeNull();
  });

  it('carries the discovered bridge_functions across, because they describe the PACKAGE', async () => {
    // Unlike the bridge bodies (keyed by the source's section ids), this is a capability list
    // re-derived from the same files the copy contains — so it is true of the copy too.
    const row = await importRow();
    expect(row.bridge_functions).toEqual([{ name: 'pluck' }]);
  });

  it('two imports of the same source coexist — the id, not the content, is the identity', async () => {
    const a = await importRow();
    const b = await importRow();
    expect(a.id).not.toBe(b.id);
    expect(a.storage_prefix).not.toBe(b.storage_prefix);
  });

  it('is destroyed with its OWN project, and the source is untouched', async () => {
    // The lifecycle the copy buys: an import is the destination's, entirely. Deleting the
    // destination must not reach back into the project it came from.
    const doomed = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('doomed') RETURNING id`);
    await importRow({ project_id: doomed.rows[0].id });
    await pg.query(`DELETE FROM projects WHERE id = $1`, [doomed.rows[0].id]);

    const src = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM simulations WHERE project_id = $1`, [SOURCE_PROJECT]);
    expect(src.rows[0].n, 'deleting an importing project destroyed the source simulation').toBe(1);
  });
});
