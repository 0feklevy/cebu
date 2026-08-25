/**
 * Migration 080 against a REAL Postgres: a simulation's files, shared rather than copied.
 *
 * The two claims that carry the feature, and neither can be checked without a database:
 *
 *   1. Two simulations can name the SAME blob — that is the saving. A unique constraint in the
 *      wrong place would forbid exactly the case the feature exists for, and would only show up
 *      on somebody's second import.
 *   2. A blob that any simulation still references CANNOT be deleted, and a deleted simulation
 *      releases its references without touching bytes anybody else holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const pg = new PGlite();
const SHA = (c: string) => c.repeat(64);

const PREREQ = `
  CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT);
  CREATE TABLE simulations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL
  );
  CREATE TABLE video_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID, filename TEXT NOT NULL);
  CREATE TABLE image_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID, filename TEXT NOT NULL, storage_key TEXT NOT NULL, original_url TEXT NOT NULL);
  CREATE TABLE audio_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID, filename TEXT NOT NULL, storage_key TEXT NOT NULL, url TEXT NOT NULL);
`;

const newSim = async (projectId: string, name: string) => {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO simulations (project_id, name) VALUES ($1,$2) RETURNING id`, [projectId, name]);
  return r.rows[0].id;
};
const newBlob = async (c: string) => {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 99, $2) RETURNING id`,
    [SHA(c), `blobs/${c}${c}/${c}${c}/${SHA(c)}`]);
  return r.rows[0].id;
};

let P1 = '';
let P2 = '';

beforeAll(async () => {
  await pg.exec(PREREQ);
  await pg.exec(readFileSync(join(MIGRATIONS, '078_media_blobs.sql'), 'utf-8'));
  await pg.exec(readFileSync(join(MIGRATIONS, '080_sim_files.sql'), 'utf-8'));
  const a = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('p1') RETURNING id`);
  const b = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('p2') RETURNING id`);
  P1 = a.rows[0].id; P2 = b.rows[0].id;
});

afterAll(async () => { await pg.close(); });

describe('sharing is what the table is for', () => {
  it('lets TWO simulations in different projects name the same blob', async () => {
    // The saving itself. A unique constraint on blob_id would forbid exactly this and would only
    // surface on somebody's second import.
    const blob = await newBlob('a');
    const s1 = await newSim(P1, 'Boids');
    const s2 = await newSim(P2, 'Boids (imported)');
    for (const s of [s1, s2]) {
      await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'index.html',$2)`, [s, blob]);
    }
    const n = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM sim_files WHERE blob_id = $1`, [blob]);
    expect(n.rows[0].n).toBe(2);
  });

  it('refuses the same path TWICE within one simulation', async () => {
    // The primary key. Two rows for one path make resolution ambiguous, and whichever wins is a
    // coin flip that changes between deploys.
    const blob = await newBlob('b');
    const s = await newSim(P1, 'dup');
    await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'app.js',$2)`, [s, blob]);
    await expect(pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'app.js',$2)`, [s, blob]))
      .rejects.toThrow(/duplicate key|unique|primary/i);
  });

  it('rejects an absolute or empty path', async () => {
    // The resolver splits a request key and looks the remainder up verbatim. A stored '/index.html'
    // would never match 'index.html' and the file would silently 404.
    const blob = await newBlob('c');
    const s = await newSim(P1, 'shape');
    for (const bad of ['', '/index.html']) {
      await expect(
        pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,$2,$3)`, [s, bad, blob]),
        bad || '(empty)',
      ).rejects.toThrow(/check constraint|violates/i);
    }
  });
});

describe('the lifecycle', () => {
  it('REFUSES to delete a blob a simulation still references', async () => {
    const blob = await newBlob('d');
    const s = await newSim(P1, 'holds');
    await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'a.png',$2)`, [s, blob]);
    await expect(pg.query(`DELETE FROM media_blobs WHERE id = $1`, [blob]))
      .rejects.toThrow(/foreign key constraint/i);
  });

  it('deleting a SIMULATION releases its references and leaves the blob', async () => {
    const blob = await newBlob('e');
    const s = await newSim(P1, 'goes');
    await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'a.png',$2)`, [s, blob]);

    await pg.query(`DELETE FROM simulations WHERE id = $1`, [s]);

    const refs = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM sim_files WHERE blob_id = $1`, [blob]);
    expect(refs.rows[0].n, 'the mapping outlived its simulation').toBe(0);
    const blobs = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_blobs WHERE id = $1`, [blob]);
    expect(blobs.rows[0].n, 'the blob was destroyed with one of its holders').toBe(1);
  });

  it('a PROJECT cascade releases only ITS simulation — the other keeps the bytes', async () => {
    // The case the whole feature exists for, end to end: two projects sharing one package, one of
    // them deleted. The survivor must still serve.
    const blob = await newBlob('f');
    const keep = await newSim(P1, 'survivor');
    const doomedProject = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('doomed') RETURNING id`);
    const doomed = await newSim(doomedProject.rows[0].id, 'doomed sim');
    for (const s of [keep, doomed]) {
      await pg.query(`INSERT INTO sim_files (simulation_id, rel_path, blob_id) VALUES ($1,'index.html',$2)`, [s, blob]);
    }

    await pg.query(`DELETE FROM projects WHERE id = $1`, [doomedProject.rows[0].id]);

    const refs = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM sim_files WHERE blob_id = $1`, [blob]);
    expect(refs.rows[0].n, 'the survivor lost its file when another project was deleted').toBe(1);
    // And the database still refuses to drop the bytes the survivor serves.
    await expect(pg.query(`DELETE FROM media_blobs WHERE id = $1`, [blob]))
      .rejects.toThrow(/foreign key constraint/i);
  });
});
