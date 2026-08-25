/**
 * "Bring the simulation too" — the join that decides whether the offer appears.
 *
 * `listForUser` resolves each preset against its source simulation in one LEFT JOIN. Three things
 * about that can only be wrong against a real database, and each one breaks the feature in a way
 * that looks like nothing is wrong:
 *
 *   • an INNER join instead of a left one silently HIDES every preset whose source was deleted —
 *     the user's own presets disappear from their own list;
 *   • a join on the wrong column returns names from the wrong simulation, so the picker offers to
 *     import a package that has nothing to do with the preset;
 *   • `source_importable` computed from the id alone stays true after the source is deleted,
 *     because the FK is SET NULL and a stale id is indistinguishable from a live one — except
 *     that it is not, and the import would 404.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desc, eq } from 'drizzle-orm';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

const PREREQ = `
  CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), firebase_uid TEXT UNIQUE NOT NULL, email TEXT);
  CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT);
  CREATE TABLE simulations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, bridge_hash TEXT
  );
`;

const pg = new PGlite();
const database = drizzle(pg);
vi.mock('../../../db/index.js', () => ({ get db() { return database; } }));

const { saved_bridges, simulations } = await import('../../../db/schema.js');

let USER = '';
let SIM = '';

/** The production query, verbatim — the point is to run THIS, not a paraphrase of it. */
async function listForUser(userId: string) {
  const rows = await database
    .select({ preset: saved_bridges, simName: simulations.name })
    .from(saved_bridges)
    .leftJoin(simulations, eq(simulations.id, saved_bridges.source_simulation_id))
    .where(eq(saved_bridges.created_by, userId))
    .orderBy(desc(saved_bridges.created_at));
  return rows.map(({ preset, simName }) => ({
    label: preset.label,
    source_simulation_name: simName ?? null,
    source_importable: !!preset.source_simulation_id && !!simName,
  }));
}

beforeAll(async () => {
  await pg.exec(PREREQ);
  await pg.exec(readFileSync(join(MIGRATIONS, '079_saved_bridges.sql'), 'utf-8'));
  const u = await pg.query<{ id: string }>(`INSERT INTO users (firebase_uid) VALUES ('u') RETURNING id`);
  USER = u.rows[0].id;
  const p = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('p') RETURNING id`);
  const sm = await pg.query<{ id: string }>(
    `INSERT INTO simulations (project_id, name) VALUES ($1,'Boids') RETURNING id`, [p.rows[0].id]);
  SIM = sm.rows[0].id;
});

afterAll(async () => { await pg.close(); });

const savePreset = (label: string, simId: string | null) =>
  database.insert(saved_bridges).values({
    created_by: USER, label, simple_ui: false, auto_script: true,
    source_simulation_id: simId, updated_at: new Date(),
  });

describe('what the picker is told about each preset', () => {
  it('names the source package, so a chooser sees what the preset applies TO', async () => {
    await savePreset('plucking a boid with one button', SIM);
    const [row] = await listForUser(USER);
    expect(row.source_simulation_name).toBe('Boids');
    expect(row.source_importable).toBe(true);
  });

  it('still LISTS a preset whose source is gone — a left join, not an inner one', async () => {
    // The failure that looks like data loss: an inner join drops these rows entirely and the
    // user's own presets vanish from their own list.
    await savePreset('orphaned', SIM);
    await pg.query(`DELETE FROM simulations WHERE id = $1`, [SIM]);

    const rows = await listForUser(USER);
    expect(rows.map((r) => r.label)).toContain('orphaned');
    expect(rows.map((r) => r.label)).toContain('plucking a boid with one button');
  });

  it('marks an orphaned preset NOT importable, so no offer is made that would 404', async () => {
    // `source_simulation_id` is SET NULL on delete, but the flag must not depend on noticing that:
    // it is computed from the JOIN finding a row, which is the fact that actually matters.
    const rows = await listForUser(USER);
    for (const r of rows) {
      expect(r.source_importable, `${r.label} still offers an import`).toBe(false);
      expect(r.source_simulation_name).toBeNull();
    }
  });

  it('a preset that never had a source is listed, and offers nothing', async () => {
    await savePreset('no source at all', null);
    const rows = await listForUser(USER);
    const row = rows.find((r) => r.label === 'no source at all');
    expect(row).toBeTruthy();
    expect(row!.source_importable).toBe(false);
  });

  it('does not leak ANOTHER user\'s presets into the list', async () => {
    const other = await pg.query<{ id: string }>(`INSERT INTO users (firebase_uid) VALUES ('other') RETURNING id`);
    await database.insert(saved_bridges).values({
      created_by: other.rows[0].id, label: 'not yours', simple_ui: false, auto_script: true, updated_at: new Date(),
    });
    const rows = await listForUser(USER);
    expect(rows.map((r) => r.label)).not.toContain('not yours');
  });
});
