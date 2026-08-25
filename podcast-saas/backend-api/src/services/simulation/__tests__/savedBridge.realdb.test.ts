/**
 * The saved-bridge service against a REAL Postgres — the gap every other test in this feature left.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * Every unit test for this feature mocks `db` wholesale. That proves the decisions are right and
 * proves NOTHING about the SQL: a column name that does not exist, an `onConflictDoUpdate` whose
 * target does not match a real unique index, a jsonb round-trip that comes back a string — all of
 * them typecheck, all of them pass a mocked suite, and all of them fail the first time a user
 * presses the button.
 *
 * PGlite is real Postgres compiled to WASM, so the DDL, the constraints and drizzle's generated
 * SQL are all genuine. The migrations applied below are the ones that actually ship.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

/** Only what 079 references, plus the section columns the save reads. */
const PREREQ = `
  CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid TEXT UNIQUE NOT NULL,
    email TEXT
  );
  CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT);
  CREATE TABLE simulations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bridge_hash TEXT
  );
`;

const pg = new PGlite();
const database = drizzle(pg);

vi.mock('../../../db/index.js', () => ({ get db() { return database; } }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { saved_bridges } = await import('../../../db/schema.js');

let USER = '';
let SIM = '';

beforeAll(async () => {
  await pg.exec(PREREQ);
  // The migration that actually ships, verbatim.
  await pg.exec(readFileSync(join(MIGRATIONS, '079_saved_bridges.sql'), 'utf-8'));

  const u = await pg.query<{ id: string }>(`INSERT INTO users (firebase_uid, email) VALUES ('u1','a@b.c') RETURNING id`);
  USER = u.rows[0].id;
  const p = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('p') RETURNING id`);
  const sm = await pg.query<{ id: string }>(
    `INSERT INTO simulations (project_id, name, bridge_hash) VALUES ($1,'Boids','bh-1') RETURNING id`, [p.rows[0].id]);
  SIM = sm.rows[0].id;
});

afterAll(async () => { await pg.close(); });

const row = (over: Record<string, unknown> = {}) => ({
  created_by: USER,
  label: 'plucking a boid with one button',
  sim_prompt: 'pluck one boid',
  simple_ui: true,
  auto_script: false,
  ui_controls: { controls: [], show: ['#speed'], hide: ['.debug'] },
  main_body: 'window.__murmuration.pluck();',
  contract: { ids: [], selectors: [], texts: [], classes: [], globals: ['__murmuration'], members: [] },
  source_simulation_id: SIM,
  source_bridge_hash: 'bh-1',
  source_hash: 'sh-1',
  conversation_history: [{ role: 'user', content: 'pluck' }],
  updated_at: new Date(),
  ...over,
});

describe('the schema drizzle writes matches the schema 079 creates', () => {
  it('inserts every column and reads each type back intact', async () => {
    // A jsonb column that round-trips as a STRING, or a boolean stored as text, is the class of
    // defect a mocked db can never surface.
    const [saved] = await database.insert(saved_bridges).values(row()).returning();

    expect(saved.label).toBe('plucking a boid with one button');
    expect(saved.simple_ui).toBe(true);
    expect(saved.auto_script).toBe(false);
    expect(saved.main_body).toContain('__murmuration');
    // jsonb, not a string:
    expect((saved.ui_controls as { hide: string[] }).hide).toEqual(['.debug']);
    expect((saved.contract as { globals: string[] }).globals).toEqual(['__murmuration']);
    expect(Array.isArray(saved.conversation_history)).toBe(true);
    expect(saved.created_at).toBeInstanceOf(Date);
  });

  it('RE-SAVING the same label UPDATES rather than breeding a sibling', async () => {
    // The behaviour a user refining a preset depends on — and it works only if drizzle's conflict
    // target matches the real unique index. A mocked db cannot tell you that it does.
    const values = row({ label: 'refined', main_body: 'v1' });
    await database.insert(saved_bridges).values(values)
      .onConflictDoUpdate({ target: [saved_bridges.created_by, saved_bridges.label], set: values });

    const second = row({ label: 'refined', main_body: 'v2' });
    await database.insert(saved_bridges).values(second)
      .onConflictDoUpdate({ target: [saved_bridges.created_by, saved_bridges.label], set: second });

    const rows = await database.select().from(saved_bridges)
      .where(and(eq(saved_bridges.created_by, USER), eq(saved_bridges.label, 'refined')));
    expect(rows).toHaveLength(1);
    expect(rows[0].main_body).toBe('v2');
  });

  it('lets two DIFFERENT users hold the same label', async () => {
    const other = await pg.query<{ id: string }>(`INSERT INTO users (firebase_uid) VALUES ('u2') RETURNING id`);
    await database.insert(saved_bridges).values(row({ created_by: other.rows[0].id, label: 'shared name' }));
    await database.insert(saved_bridges).values(row({ label: 'shared name' }));
    const rows = await database.select().from(saved_bridges).where(eq(saved_bridges.label, 'shared name'));
    expect(rows).toHaveLength(2);
  });

  it('enforces the label length CHECK the migration declares', async () => {
    await expect(database.insert(saved_bridges).values(row({ label: '' }))).rejects.toThrow();
    await expect(database.insert(saved_bridges).values(row({ label: 'x'.repeat(121) }))).rejects.toThrow();
  });

  it('accepts a RECIPE-ONLY preset — no script, no contract', async () => {
    // A minimal-UI setup that never generated a demo is a first-class preset, not a broken one.
    const [saved] = await database.insert(saved_bridges)
      .values(row({ label: 'recipe only', main_body: null, contract: null })).returning();
    expect(saved.main_body).toBeNull();
    expect(saved.contract).toBeNull();
  });

  it('SURVIVES its source simulation being deleted — outliving the source is the point', async () => {
    // ON DELETE SET NULL, not CASCADE. A preset that vanished with the video it was made from
    // would be useless precisely when it is most wanted.
    const [saved] = await database.insert(saved_bridges).values(row({ label: 'outlives' })).returning();
    expect(saved.source_simulation_id).toBe(SIM);

    await pg.query(`DELETE FROM simulations WHERE id = $1`, [SIM]);

    const [after] = await database.select().from(saved_bridges).where(eq(saved_bridges.id, saved.id));
    expect(after, 'the preset was deleted with its source simulation').toBeTruthy();
    expect(after.source_simulation_id).toBeNull();
    expect(after.main_body).toContain('__murmuration');
  });

  it('is removed when its OWNER is deleted — presets are the account\'s own content', async () => {
    const doomed = await pg.query<{ id: string }>(`INSERT INTO users (firebase_uid) VALUES ('u3') RETURNING id`);
    // No source_simulation_id: the test above deleted SIM, and this case is about the OWNER's
    // cascade, not the source's.
    await database.insert(saved_bridges)
      .values(row({ created_by: doomed.rows[0].id, label: 'goes with the user', source_simulation_id: null }));
    await pg.query(`DELETE FROM users WHERE id = $1`, [doomed.rows[0].id]);
    const rows = await database.select().from(saved_bridges).where(eq(saved_bridges.label, 'goes with the user'));
    expect(rows).toHaveLength(0);
  });
});
