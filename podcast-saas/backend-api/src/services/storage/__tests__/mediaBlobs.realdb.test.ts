/**
 * Migration 078's central claim, against a REAL Postgres.
 *
 * The whole dedup design rests on one sentence: *a plain foreign key with no cascade means
 * Postgres itself refuses to delete a blob while any row still points at it.* That is why there is
 * no `ref_count` column and no trigger — the invariant is ENFORCED rather than maintained, so it
 * cannot drift.
 *
 * Until this file, that sentence was an argument in a comment. It was verified once by hand on a
 * throwaway database during the v0.2.0 release; a claim the design depends on deserves to be
 * verified on every run, by everyone, forever.
 *
 * PGlite is real Postgres compiled to WASM, so the DDL and the constraint behaviour below are
 * genuine — not a model of them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

/** The three tables 078 adds `blob_id` to, reduced to what the FK needs. */
const PREREQ = `
  CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT);
  CREATE TABLE video_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, storage_key TEXT
  );
  CREATE TABLE image_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, storage_key TEXT NOT NULL, original_url TEXT NOT NULL
  );
  CREATE TABLE audio_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, storage_key TEXT NOT NULL, url TEXT NOT NULL
  );
`;

const pg = new PGlite();
// Only [0-9a-f] satisfies the migration's sha256 shape CHECK — using 'g'..'k' here made
// three tests fail, which is the constraint doing its job.
const SHA = (c: string) => c.repeat(64);

const newBlob = async (c: string) => {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 123, $2) RETURNING id`,
    [SHA(c), `blobs/${c}${c}/${c}${c}/${SHA(c)}`]);
  return r.rows[0].id;
};

let PROJECT = '';

beforeAll(async () => {
  await pg.exec(PREREQ);
  await pg.exec(readFileSync(join(MIGRATIONS, '078_media_blobs.sql'), 'utf-8'));
  const p = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('p') RETURNING id`);
  PROJECT = p.rows[0].id;
});

afterAll(async () => { await pg.close(); });

describe('the database enforces the invariant, so no counter can drift', () => {
  it('REFUSES to delete a blob that a media row still references', async () => {
    // The load-bearing claim of the entire design.
    const blob = await newBlob('a');
    await pg.query(
      `INSERT INTO audio_files (project_id, filename, storage_key, url, blob_id) VALUES ($1,'a.mp3','k','u',$2)`,
      [PROJECT, blob]);

    await expect(pg.query(`DELETE FROM media_blobs WHERE id = $1`, [blob]))
      .rejects.toThrow(/foreign key constraint/i);
  });

  it('allows the delete once the last reference is gone', async () => {
    const blob = await newBlob('b');
    await pg.query(
      `INSERT INTO image_files (project_id, filename, storage_key, original_url, blob_id) VALUES ($1,'i.png','k','u',$2)`,
      [PROJECT, blob]);
    await pg.query(`DELETE FROM image_files WHERE blob_id = $1`, [blob]);

    await pg.query(`DELETE FROM media_blobs WHERE id = $1`, [blob]);
    const left = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_blobs WHERE id = $1`, [blob]);
    expect(left.rows[0].n).toBe(0);
  });

  it('refuses while ANY of the three tables still references it, not just the first', async () => {
    // Three separate foreign keys. A design that protected only video_files would pass a test
    // written against video_files and lose audio the moment somebody deduped a soundtrack.
    for (const [c, sql] of [
      ['c', `INSERT INTO video_files (project_id, filename, blob_id) VALUES ($1,'v.mp4',$2)`],
      ['d', `INSERT INTO image_files (project_id, filename, storage_key, original_url, blob_id) VALUES ($1,'i.png','k','u',$2)`],
      ['e', `INSERT INTO audio_files (project_id, filename, storage_key, url, blob_id) VALUES ($1,'a.mp3','k','u',$2)`],
    ] as const) {
      const blob = await newBlob(c);
      await pg.query(sql, [PROJECT, blob]);
      await expect(pg.query(`DELETE FROM media_blobs WHERE id = $1`, [blob]), c)
        .rejects.toThrow(/foreign key constraint/i);
    }
  });

  it('a PROJECT cascade removes the media row and leaves the blob standing', async () => {
    // The reason there is no ref_count: deleting a project removes media rows without running a
    // line of application code. A maintained counter would drift on every project delete, and a
    // drifted counter deletes bytes that are still in use. A DERIVED reference cannot drift.
    const blob = await newBlob('f');
    const doomed = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('doomed') RETURNING id`);
    await pg.query(
      `INSERT INTO audio_files (project_id, filename, storage_key, url, blob_id) VALUES ($1,'a.mp3','k','u',$2)`,
      [doomed.rows[0].id, blob]);

    await pg.query(`DELETE FROM projects WHERE id = $1`, [doomed.rows[0].id]);

    const rows = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_blobs WHERE id = $1`, [blob]);
    expect(rows.rows[0].n, 'the cascade destroyed a shared blob').toBe(1);
    const orphaned = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM audio_files WHERE blob_id = $1`, [blob]);
    expect(orphaned.rows[0].n).toBe(0);
  });

  it('keeps the blob while ONE project releases it and ANOTHER still holds it', async () => {
    // The case the feature exists for: two projects, one copy of the bytes.
    const blob = await newBlob('0');
    const other = await pg.query<{ id: string }>(`INSERT INTO projects (title) VALUES ('other') RETURNING id`);
    for (const p of [PROJECT, other.rows[0].id]) {
      await pg.query(
        `INSERT INTO audio_files (project_id, filename, storage_key, url, blob_id) VALUES ($1,'a.mp3','k','u',$2)`,
        [p, blob]);
    }

    await pg.query(`DELETE FROM projects WHERE id = $1`, [other.rows[0].id]);

    // Still referenced by the survivor — and the database still refuses.
    await expect(pg.query(`DELETE FROM media_blobs WHERE id = $1`, [blob]))
      .rejects.toThrow(/foreign key constraint/i);
  });
});

describe('the identity constraints', () => {
  it('is the PAIR (sha256, byte_size), not the hash alone', async () => {
    // Two rows agreeing on hash but not on length are kept APART — the shape a crafted-collision
    // attempt would take in a multi-tenant store.
    await pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 10, 'blobs/1/1')`, [SHA('1')]);
    await pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 20, 'blobs/1/2')`, [SHA('1')]);
    await expect(pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 10, 'blobs/1/3')`, [SHA('1')]))
      .rejects.toThrow(/duplicate key|unique/i);
  });

  it('refuses two rows naming the SAME object', async () => {
    // Deleting either would destroy the other's bytes.
    await pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 1, 'blobs/same/key')`, [SHA('2')]);
    await expect(pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 2, 'blobs/same/key')`, [SHA('3')]))
      .rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects a malformed digest at the database, not merely in code', async () => {
    for (const bad of ['', 'ABC', SHA('a').toUpperCase(), SHA('a').slice(1)]) {
      await expect(
        pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, 1, $2)`, [bad, `blobs/x/${bad || 'e'}`]),
        bad || '(empty)',
      ).rejects.toThrow(/check constraint|violates/i);
    }
  });

  it('rejects a negative size', async () => {
    await expect(pg.query(`INSERT INTO media_blobs (sha256, byte_size, storage_key) VALUES ($1, -1, 'blobs/neg/1')`, [SHA('4')]))
      .rejects.toThrow(/check constraint|violates/i);
  });
});
