/**
 * The blob sweeper, against a REAL Postgres — because it DELETES BYTES.
 *
 * Every other guard in this design is about refusing to destroy something. This is the one piece
 * whose job is to destroy things, so the burden is reversed: the tests below are mostly attempts
 * to make it delete something it must not.
 *
 * The three ways it could be catastrophically wrong:
 *   • deleting a blob that is still referenced — somebody's video disappears;
 *   • deleting a freshly-claimed blob during the window between "claimed" and "mapping written",
 *     which is why the grace period exists and is not merely caution;
 *   • missing a referencing table, so blobs referenced only through THAT table look orphaned —
 *     the failure that would take out every imported simulation at once.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const pg = new PGlite();
const database = drizzle(pg);

const deleted: string[] = [];
vi.mock('../getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ deleteFile: async (k: string) => { deleted.push(k); } }),
}));
vi.mock('../../../db/index.js', () => ({ get db() { return database; } }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const PREREQ = `
  CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT);
  CREATE TABLE simulations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL);
  CREATE TABLE video_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID, filename TEXT NOT NULL);
  CREATE TABLE image_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID, filename TEXT NOT NULL, storage_key TEXT NOT NULL, original_url TEXT NOT NULL);
  CREATE TABLE audio_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID, filename TEXT NOT NULL, storage_key TEXT NOT NULL, url TEXT NOT NULL);
`;

const { media_blobs, sim_files } = await import('../../../db/schema.js');
const { sweepOrphanBlobs, ORPHAN_GRACE_MS } = await import('../blobSweeper.js');

const SHA = (c: string) => c.repeat(64);
let PROJECT = '';
let seq = 0;

const newBlob = async (c: string) => {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 1, $2) RETURNING id`,
    [SHA(c), `blobs/${c}${c}/${seq++}/${SHA(c)}`]);
  return r.rows[0].id;
};

beforeAll(async () => {
  await pg.exec(PREREQ);
  await pg.exec(readFileSync(join(MIGRATIONS, '078_media_blobs.sql'), 'utf-8'));
  await pg.exec(readFileSync(join(MIGRATIONS, '080_sim_files.sql'), 'utf-8'));
  const p = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('p') RETURNING id`);
  PROJECT = p.rows[0].id;
});

afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  deleted.length = 0;
  await pg.query(`DELETE FROM sim_files`);
  await pg.query(`DELETE FROM audio_files`);
  await pg.query(`DELETE FROM media_blobs`);
});

const LATER = Date.now() + ORPHAN_GRACE_MS + 60_000;

describe('what it must never delete', () => {
  it('leaves a blob a media row still references, however long it waits', async () => {
    const blob = await newBlob('a');
    await pg.query(
      `INSERT INTO audio_files (project_id, filename, storage_key, url, blob_id) VALUES ($1,'a.mp3','k','u',$2)`,
      [PROJECT, blob]);

    await sweepOrphanBlobs();          // mark pass
    await sweepOrphanBlobs(LATER);     // long past the grace period
    expect(deleted, 'a referenced blob was deleted').toEqual([]);
  });

  it('leaves a blob referenced ONLY through sim_files', async () => {
    // The failure that would take out every imported simulation at once: a sweeper that knows
    // about the three media tables and forgets the fourth.
    const blob = await newBlob('b');
    const sim = await pg.query<{ id: string }>(
      `INSERT INTO simulations (project_id, name) VALUES ($1,'Boids') RETURNING id`, [PROJECT]);
    await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'index.html',$2)`,
      [sim.rows[0].id, blob]);

    await sweepOrphanBlobs();
    await sweepOrphanBlobs(LATER);
    expect(deleted, 'a simulation lost its file').toEqual([]);
  });

  it('does NOT delete on the first sight of an orphan — the grace period is the guard', async () => {
    // The window this protects: an import claims a blob BEFORE writing its mapping rows, so a
    // freshly-claimed blob is momentarily unreferenced. A single-pass sweeper deletes it.
    await newBlob('c');
    const first = await sweepOrphanBlobs();
    expect(first.marked).toBe(1);
    expect(first.deleted, 'deleted an orphan on first sight').toBe(0);
    expect(deleted).toEqual([]);
  });

  it('UN-MARKS a blob that gained a reference while marked, instead of deleting it', async () => {
    // A mark is a suspicion, not a sentence. This is the import that arrived during the window.
    const blob = await newBlob('d');
    await sweepOrphanBlobs();                                   // marked
    await pg.query(
      `INSERT INTO audio_files (project_id, filename, storage_key, url, blob_id) VALUES ($1,'a.mp3','k','u',$2)`,
      [PROJECT, blob]);

    const second = await sweepOrphanBlobs(LATER);
    expect(second.unmarked).toBe(1);
    expect(second.deleted).toBe(0);
    expect(deleted).toEqual([]);

    const [row] = await database.select().from(media_blobs).where(eq(media_blobs.id, blob));
    expect(row.orphaned_at, 'the mark survived the reference coming back').toBeNull();
  });
});

describe('what it does collect', () => {
  it('deletes a blob that stayed unreferenced through the whole grace period', async () => {
    const blob = await newBlob('e');
    await sweepOrphanBlobs();               // mark
    const second = await sweepOrphanBlobs(LATER);

    expect(second.deleted).toBe(1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^blobs\//);
    const rows = await database.select().from(media_blobs).where(eq(media_blobs.id, blob));
    expect(rows).toHaveLength(0);
  });

  it('collects a blob released by a deleted SIMULATION', async () => {
    // The lifecycle 080 introduced, end to end.
    const blob = await newBlob('f');
    const sim = await pg.query<{ id: string }>(
      `INSERT INTO simulations (project_id, name) VALUES ($1,'gone') RETURNING id`, [PROJECT]);
    await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'a.js',$2)`,
      [sim.rows[0].id, blob]);

    await sweepOrphanBlobs();                                    // referenced: nothing happens
    await pg.query(`DELETE FROM simulations WHERE id = $1`, [sim.rows[0].id]);
    await sweepOrphanBlobs();                                    // now marked
    const third = await sweepOrphanBlobs(LATER);

    expect(third.deleted).toBe(1);
  });

  it('deletes the BYTES before the row, so a crash cannot hide the object', async () => {
    // The reverse of the write order, for the same reason read backwards: a row deleted first
    // leaves an unreferenced object the sweeper can never see again.
    const blob = await newBlob('0');
    const [before] = await database.select().from(media_blobs).where(eq(media_blobs.id, blob));
    await sweepOrphanBlobs();
    await sweepOrphanBlobs(LATER);
    expect(deleted, 'the object was not removed').toContain(before.storage_key);
  });

  it('a blob shared by TWO holders survives losing one of them', async () => {
    const blob = await newBlob('1');
    const a = await pg.query<{ id: string }>(`INSERT INTO simulations (project_id, name) VALUES ($1,'a') RETURNING id`, [PROJECT]);
    const b = await pg.query<{ id: string }>(`INSERT INTO simulations (project_id, name) VALUES ($1,'b') RETURNING id`, [PROJECT]);
    for (const s of [a.rows[0].id, b.rows[0].id]) {
      await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'x.js',$2)`, [s, blob]);
    }

    await pg.query(`DELETE FROM simulations WHERE id = $1`, [a.rows[0].id]);
    await sweepOrphanBlobs();
    await sweepOrphanBlobs(LATER);

    expect(deleted, 'the survivor lost its bytes').toEqual([]);
  });
});
