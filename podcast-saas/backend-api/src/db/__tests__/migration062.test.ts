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

/** Every migration after 062 — 063 today, and whatever follows it. */
const AFTER = ALL.slice(ALL.indexOf(TARGET) + 1);

/** 062 and then every migration after it, so "idempotent" is tested against the real head. */
const applyForwardToHead = async (): Promise<void> => {
  await applyForward();
  for (const f of AFTER) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
};

/**
 * Undo everything applied AFTER 062, newest first, so 062's own rollback is measured against the
 * schema 062 alone produced.
 *
 * This used to be a no-op because 062 was the head. It stopped being one the moment 063 landed, and
 * the failure it produced was the honest one: 062's rollback drops 062's columns and nothing else,
 * so the snapshot still carried 063's. Rolling the later files back first is what the test always
 * meant — a missing `.rollback.sql` is a real gap and fails loudly rather than being skipped.
 */
const rollbackAfter = async (): Promise<void> => {
  for (const f of [...AFTER].reverse()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f.replace(/\.sql$/, '.rollback.sql')), 'utf-8'));
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

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

describe('062 — shape', () => {
  beforeEach(applyForward);

  it('does NOT add a provenance column to timeline_sections — the invariant lives on the job row', async () => {
    // An earlier draft of 062 added timeline_sections.generation_job_id with a partial unique
    // index. It is deliberately absent, and this test pins that: the product lets a user manually
    // re-insert a previously generated asset, so "this asset appears once in the timeline" is not
    // true; every section predating the change carries no provenance and so could never have
    // collided; and it cost a write lock on a hot table. Finalisation serialises on the job row
    // instead. If someone re-adds the column, this fails and they must revisit that reasoning.
    const found = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='timeline_sections' AND column_name='generation_job_id'`,
    );
    expect(found).toEqual([]);
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

describe('062 — the lock it is allowed to take', () => {
  beforeEach(applyForward);

  it('sets a short lock_timeout, so a deploy fails fast instead of holding the table', async () => {
    // The runner wraps each file in ONE transaction, so every lock this file takes is held until
    // COMMIT. A deploy that cannot get its locks promptly must abort and leave the previous
    // version serving, rather than queueing behind a long transaction on a hot table.
    const sql = forwardSql;
    // SET LOCAL, not SET. The runner reuses one connection for every migration in the run, so a
    // bare SET survives COMMIT and silently imposes this timeout on every later file. SET LOCAL
    // is scoped to the transaction the runner already wraps each file in.
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout/i);
    expect(sql).not.toMatch(/(?<!LOCAL\s)\bSET\s+lock_timeout/i);
  });

  it('touches no table but video_generation_jobs', async () => {
    // The blast radius IS the point of the rework: timeline_sections is hot and must not be
    // locked by this migration at all.
    // COMMENTS STRIPPED FIRST. This file argues its case in prose, and the prose says the words
    // `ALTER TABLE` — most recently in "how long does ALTER TABLE take", which the bare regex read
    // as a migration altering a table called `take`. Scanning the executable statements is what the
    // assertion always meant; scanning the whole file made it fail on an edit to a sentence.
    const sql = forwardSql.replace(/--[^\n]*/g, '');
    const altered = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    const indexed = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX[^(]*ON\s+(\w+)/gi)].map((m) => m[1]);
    expect([...new Set([...altered, ...indexed])]).toEqual(['video_generation_jobs']);
  });

  it('adds no index — the in-flight scan filters on status alone and has no ORDER BY', async () => {
    // A performance index, not a correctness condition. Adding one would put a second lock in this
    // file for no measured benefit. Add it only after EXPLAIN on representative volume.
    const sql = forwardSql;
    expect(sql).not.toMatch(/CREATE\s+INDEX/i);
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

  it('rolls back the lease columns cleanly', async () => {
    const before = await snapshot();
    await applyForwardToHead();
    await rollbackAfter();
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
