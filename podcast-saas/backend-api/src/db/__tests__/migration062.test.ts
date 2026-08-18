/**
 * Migration 062 (b-roll generation idempotency) against a real Postgres engine, in the
 * migration058 head-apply pattern.
 *
 * The properties that matter:
 *   • `timeline_sections.generation_job_id` exists, is nullable, and points at the generation
 *     that produced the row — SET NULL, so deleting the bookkeeping never deletes the b-roll;
 *   • the PARTIAL unique index refuses a SECOND section for one generation, forever, while
 *     leaving every hand-made section (NULL provenance) alone — a total unique index would
 *     allow exactly one of those per database, which is the trap 056/058 document;
 *   • `video_generation_jobs` gains the lease columns (`updated_at`, `claimed_by`, `attempts`)
 *     with defaults honest enough that a legacy row reads as "never claimed, never attempted";
 *   • idempotent, rolls back cleanly, and is registered with the runner and db:check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATION_FILES } from '../migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const TARGET = '062_broll_idempotency.sql';
const ROLLBACK = '062_broll_idempotency.rollback.sql';
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

let pg: PGlite;
async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}
const applyForward = (): Promise<unknown> => pg.exec(forwardSql);

/** 062 and then every migration after it — none today, but the loop keeps the suite honest. */
const applyForwardToHead = async (): Promise<void> => {
  await applyForward();
  for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
};

async function snapshot(): Promise<unknown> {
  return {
    sectionCols: await rows(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
                              WHERE table_name='timeline_sections' ORDER BY column_name`),
    jobCols: await rows(`SELECT column_name, data_type, is_nullable, column_default
                           FROM information_schema.columns WHERE table_name='video_generation_jobs'
                          ORDER BY column_name`),
    sectionIdx: await rows(`SELECT indexname, indexdef FROM pg_indexes
                             WHERE tablename='timeline_sections' ORDER BY indexname`),
    jobIdx: await rows(`SELECT indexname, indexdef FROM pg_indexes
                         WHERE tablename='video_generation_jobs' ORDER BY indexname`),
  };
}

/** Seed the minimal parent rows; returns { projectId, videoFileId }. */
async function seed(): Promise<{ projectId: string; videoFileId: string }> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-062', 'e@test') RETURNING id`);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`, [org.id, user.id]);
  const video = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status)
     VALUES ($1,'b.mp4',10,$2,'ready') RETURNING id`, [project.id, `videos/${project.id}/b.mp4`]);
  return { projectId: project.id, videoFileId: video.id };
}

async function newJob(projectId: string, offset = 0): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO video_generation_jobs (project_id, model, original_prompt, target_duration_sec,
                                        target_global_offset_sec)
     VALUES ($1,'kling','a cat',5,$2) RETURNING id`, [projectId, offset]);
  return r.id;
}

async function insertSection(
  projectId: string, videoFileId: string, generationJobId: string | null,
): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                    global_offset_sec, generation_job_id)
     VALUES ($1,$2,0,5,'broll','broll',0,$3) RETURNING id`,
    [projectId, videoFileId, generationJobId]);
  return r.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

describe('062 — shape', () => {
  beforeEach(applyForward);

  it('timeline_sections carries a nullable generation provenance column', async () => {
    const [col] = await rows<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name='timeline_sections' AND column_name='generation_job_id'`);
    expect(col).toBeDefined();
    expect(col.is_nullable).toBe('YES');
    expect(col.data_type).toBe('uuid');
  });

  it('video_generation_jobs gains the lease columns with honest defaults', async () => {
    const { projectId } = await seed();
    const jobId = await newJob(projectId);
    const row = await one<{ claimed_by: string | null; attempts: number; updated_at: string }>(
      `SELECT claimed_by, attempts, updated_at FROM video_generation_jobs WHERE id=$1`, [jobId]);
    // A row nobody has claimed reads as exactly that — never as "maybe claimed".
    expect(row.claimed_by).toBeNull();
    expect(Number(row.attempts)).toBe(0);
    expect(row.updated_at).not.toBeNull();
  });
});

describe('062 — the uniqueness that makes a duplicate section impossible', () => {
  beforeEach(applyForward);

  it('refuses a SECOND section for the same generation', async () => {
    const { projectId, videoFileId } = await seed();
    const jobId = await newJob(projectId);
    await insertSection(projectId, videoFileId, jobId);
    await expect(insertSection(projectId, videoFileId, jobId)).rejects.toMatchObject({ code: '23505' });
  });

  it('never refuses a hand-made section — NULL provenance is not a key', async () => {
    const { projectId, videoFileId } = await seed();
    // Three sections nobody generated. A TOTAL unique index would allow exactly one of these
    // per database; the partial one is why the editor still works.
    await insertSection(projectId, videoFileId, null);
    await insertSection(projectId, videoFileId, null);
    await insertSection(projectId, videoFileId, null);
    const [{ n }] = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM timeline_sections WHERE generation_job_id IS NULL`);
    expect(Number(n)).toBe(3);
  });

  it('two DIFFERENT generations may each have their own section', async () => {
    const { projectId, videoFileId } = await seed();
    const a = await newJob(projectId, 0);
    const b = await newJob(projectId, 10);
    await insertSection(projectId, videoFileId, a);
    await insertSection(projectId, videoFileId, b);
    const [{ n }] = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM timeline_sections WHERE generation_job_id IS NOT NULL`);
    expect(Number(n)).toBe(2);
  });

  it('ON CONFLICT DO NOTHING is inferable from the partial index — the runner depends on it', async () => {
    // The job body inserts with `ON CONFLICT (generation_job_id) WHERE generation_job_id IS NOT NULL
    // DO NOTHING`. Postgres can only infer a PARTIAL index when the predicate is spelled out; if the
    // index or the predicate ever drift apart this fails with 42P10 rather than silently
    // degrading into an unguarded insert.
    const { projectId, videoFileId } = await seed();
    const jobId = await newJob(projectId);
    await insertSection(projectId, videoFileId, jobId);
    const inserted = await rows<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec, generation_job_id)
       VALUES ($1,$2,0,5,'broll','broll',0,$3)
       ON CONFLICT (generation_job_id) WHERE generation_job_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [projectId, videoFileId, jobId]);
    expect(inserted).toEqual([]); // conflict swallowed, nothing inserted
    const [{ n }] = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM timeline_sections WHERE generation_job_id=$1`, [jobId]);
    expect(Number(n)).toBe(1);
  });

  it('deleting the job keeps the b-roll and frees the key', async () => {
    // SET NULL, not CASCADE: the section outlives the bookkeeping row that made it.
    const { projectId, videoFileId } = await seed();
    const jobId = await newJob(projectId);
    const sectionId = await insertSection(projectId, videoFileId, jobId);
    await pg.query(`DELETE FROM video_generation_jobs WHERE id=$1`, [jobId]);
    const row = await one<{ generation_job_id: string | null }>(
      `SELECT generation_job_id FROM timeline_sections WHERE id=$1`, [sectionId]);
    expect(row.generation_job_id).toBeNull();
  });
});

describe('062 — the backfill that protects the deploy window', () => {
  it('marks rows that were ALREADY in flight as attempted, and leaves queued rows alone', async () => {
    // Written before 062 exists, so every row starts with no `attempts` column at all.
    const { projectId } = await seed();
    const byStatus: Record<string, string> = {};
    for (const status of ['queued', 'enhancing', 'submitting', 'generating', 'downloading',
                          'transcoding', 'ready', 'failed']) {
      const id = await newJob(projectId, 0);
      await pg.query(`UPDATE video_generation_jobs SET status=$2 WHERE id=$1`, [id, status]);
      byStatus[status] = id;
    }

    await applyForward();

    const attemptsOf = async (status: string): Promise<number> => {
      const r = await one<{ attempts: number }>(
        `SELECT attempts FROM video_generation_jobs WHERE id=$1`, [byStatus[status]]);
      return Number(r.attempts);
    };
    // In flight means somebody already ran it. Without this, the first re-drive after the deploy
    // would read attempts=1 (its own claim), conclude nobody had been here, and re-submit the
    // generation the poison check exists to protect.
    for (const status of ['enhancing', 'submitting', 'generating', 'downloading', 'transcoding']) {
      expect(await attemptsOf(status)).toBe(1);
    }
    // Created, not attempted — starting it for the first time must not look like a resume.
    expect(await attemptsOf('queued')).toBe(0);
    // Terminal rows never reach the claim, so their value is irrelevant and left at the default.
    expect(await attemptsOf('ready')).toBe(0);
    expect(await attemptsOf('failed')).toBe(0);
  });

  it('the backfill does not re-arm on a second application', async () => {
    const { projectId } = await seed();
    const id = await newJob(projectId, 0);
    await pg.query(`UPDATE video_generation_jobs SET status='generating' WHERE id=$1`, [id]);
    await applyForward();
    await pg.query(`UPDATE video_generation_jobs SET attempts=4 WHERE id=$1`, [id]);
    await applyForward();
    const r = await one<{ attempts: number }>(
      `SELECT attempts FROM video_generation_jobs WHERE id=$1`, [id]);
    expect(Number(r.attempts)).toBe(4); // a live counter is never clobbered by a re-run
  });
});

describe('062 — runner hygiene', () => {
  it('is idempotent (applying twice changes nothing)', async () => {
    await applyForwardToHead();
    const before = await snapshot();
    await applyForwardToHead();
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back cleanly to the pre-062 shape', async () => {
    const before = await snapshot();
    await applyForwardToHead();
    await pg.exec(rollbackSql);
    expect(await snapshot()).toEqual(before);
  });

  it('is registered with the migration runner and db:check', async () => {
    expect(MIGRATION_FILES).toContain(TARGET);
    expect([...MIGRATION_FILES]).toEqual([...MIGRATION_FILES].sort());
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(checkDb).toContain(TARGET);
  });
});
