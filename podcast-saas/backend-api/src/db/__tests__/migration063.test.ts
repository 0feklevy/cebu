/**
 * Migration 063 (segment-relative placement, D-01) against a real Postgres engine.
 *
 * The properties that matter, and the reason each is a TEST rather than a comment:
 *
 *   • THE ROLLOUT IS EXPAND, NOT REWRITE. Every row that existed before the migration must come out
 *     the other side reading exactly as it did — `placement_mode = 'legacy_absolute'`, both anchor
 *     columns NULL, `global_offset_sec` untouched. This is the single property a rollback of the
 *     application code depends on, and the one a hurried backfill would destroy.
 *   • NOTHING IS CONVERTED. The ruling forbids mapping today's absolute second onto today's
 *     segments, because a row that has already drifted would have its drift recorded as intent,
 *     permanently. Asserted as "no row's placement columns changed", not as "the file contains no
 *     UPDATE" — the former stays true whatever the file becomes.
 *   • DELETING A HOST VIDEO MUST NOT DELETE THE OVERLAY. `ON DELETE SET NULL` on the anchor, so an
 *     author who removes a main video loses the anchor and keeps the b-roll. CASCADE here would
 *     quietly delete content.
 *   • `placement_mode` IS CONSTRAINED. Unlike `track` and `type` on this same table, which are bare
 *     TEXT whose legal values live in a comment — which is how the malformed shapes the section
 *     census counts got written in the first place.
 *   • Idempotent, rolls back cleanly, and registered with BOTH the runner and db:check. An
 *     unregistered file silently never runs, which is the failure mode that leaves the application
 *     reading a column the database does not have.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATION_FILES } from '../migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const TARGET = '063_segment_relative_placement.sql';
const ROLLBACK = '063_segment_relative_placement.rollback.sql';
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const AFTER = ALL.slice(ALL.indexOf(TARGET) + 1);
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

const applyForwardToHead = async (): Promise<void> => {
  await applyForward();
  for (const f of AFTER) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
};

/** Undo everything after 063, newest first, so 063's rollback is measured on its own schema. */
const rollbackAfter = async (): Promise<void> => {
  for (const f of [...AFTER].reverse()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f.replace(/\.sql$/, '.rollback.sql')), 'utf-8'));
  }
};

async function snapshot(): Promise<unknown> {
  return {
    sectionCols: await rows(`SELECT column_name, data_type, is_nullable, column_default
                               FROM information_schema.columns WHERE table_name='timeline_sections'
                              ORDER BY column_name`),
    jobCols: await rows(`SELECT column_name, data_type, is_nullable, column_default
                           FROM information_schema.columns WHERE table_name='video_generation_jobs'
                          ORDER BY column_name`),
    sectionIdx: await rows(`SELECT indexname, indexdef FROM pg_indexes
                             WHERE tablename='timeline_sections' ORDER BY indexname`),
    sectionCons: await rows(`SELECT conname FROM pg_constraint
                              WHERE conrelid='timeline_sections'::regclass ORDER BY conname`),
  };
}

async function seed(): Promise<{ projectId: string; mainId: string; brollId: string }> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-063', 'e@test') RETURNING id`);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`, [org.id, user.id]);
  const main = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec)
     VALUES ($1,'main.mp4',10,$2,'ready',30) RETURNING id`, [project.id, `videos/${project.id}/main.mp4`]);
  const src = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, is_broll)
     VALUES ($1,'gen.mp4',10,$2,'ready',true) RETURNING id`, [project.id, `videos/${project.id}/gen.mp4`]);
  return { projectId: project.id, mainId: main.id, brollId: src.id };
}

/** A LEGACY b-roll row: written by the code that exists today, before any anchor column did. */
async function legacyBroll(projectId: string, videoFileId: string, offset: number): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                    global_offset_sec)
     VALUES ($1,$2,0,6,'broll','broll',$3) RETURNING id`, [projectId, videoFileId, offset]);
  return r.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

// ── The expand half ───────────────────────────────────────────────────────────

describe('063 — shape', () => {
  beforeEach(applyForward);

  it('adds the anchor pair NULLABLE, and the mode NOT NULL defaulting to legacy', async () => {
    const cols = await rows<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='timeline_sections'
          AND column_name IN ('anchor_video_file_id','anchor_offset_sec','placement_mode')
        ORDER BY column_name`);
    expect(cols).toEqual([
      { column_name: 'anchor_offset_sec',    is_nullable: 'YES', column_default: null },
      { column_name: 'anchor_video_file_id', is_nullable: 'YES', column_default: null },
      { column_name: 'placement_mode',       is_nullable: 'NO',  column_default: "'legacy_absolute'::text" },
    ]);
  });

  it('gives the generation job the anchor it must capture AT ENQUEUE, nullable', async () => {
    // Nullable because a project with no main video has nothing to anchor to and the job still
    // runs. NOT NULL here would refuse the generation outright.
    const cols = await rows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name='video_generation_jobs'
          AND column_name IN ('target_anchor_video_file_id','target_anchor_offset_sec')
        ORDER BY column_name`);
    expect(cols).toEqual([
      { column_name: 'target_anchor_offset_sec',    is_nullable: 'YES' },
      { column_name: 'target_anchor_video_file_id', is_nullable: 'YES' },
    ]);
  });

  it('constrains placement_mode to the two legal values', async () => {
    // The one column on this table that cannot hold nonsense. `track` and `type` next to it can,
    // and that is exactly how the malformed rows the section census counts were written.
    const { projectId, brollId } = await seed();
    await expect(pg.query(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec, placement_mode)
       VALUES ($1,$2,0,6,'broll','broll',0,'whatever')`, [projectId, brollId],
    )).rejects.toThrow(/placement_mode/);
  });

  it('accepts both legal values', async () => {
    const { projectId, mainId, brollId } = await seed();
    for (const mode of ['segment', 'legacy_absolute']) {
      await pg.query(
        `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                        global_offset_sec, placement_mode, anchor_video_file_id,
                                        anchor_offset_sec)
         VALUES ($1,$2,0,6,'broll','broll',10,$3,$4,4)`, [projectId, brollId, mode, mainId]);
    }
    expect(await rows(`SELECT 1 FROM timeline_sections`)).toHaveLength(2);
  });
});

// ── The prohibition ───────────────────────────────────────────────────────────

describe('063 — the expand half converts nothing', () => {
  it('leaves every pre-existing row reading EXACTLY as it did', async () => {
    // The property an application rollback depends on, and the one a hurried backfill would
    // destroy. Asserted on the rows themselves rather than by reading the SQL, so it stays true of
    // whatever the migration becomes.
    const { projectId, brollId } = await seed();
    const a = await legacyBroll(projectId, brollId, 47);
    const b = await legacyBroll(projectId, brollId, 0);

    await applyForward();

    const after = await rows<{
      id: string; global_offset_sec: number; placement_mode: string;
      anchor_video_file_id: string | null; anchor_offset_sec: number | null;
    }>(`SELECT id, global_offset_sec, placement_mode, anchor_video_file_id, anchor_offset_sec
          FROM timeline_sections ORDER BY global_offset_sec`);

    expect(after).toEqual([
      { id: b, global_offset_sec: 0,  placement_mode: 'legacy_absolute', anchor_video_file_id: null, anchor_offset_sec: null },
      { id: a, global_offset_sec: 47, placement_mode: 'legacy_absolute', anchor_video_file_id: null, anchor_offset_sec: null },
    ]);
  });

  it('does not convert a row on a SECOND application either', async () => {
    const { projectId, brollId } = await seed();
    await legacyBroll(projectId, brollId, 47);
    await applyForward();
    await applyForward();
    const r = await one<{ placement_mode: string; global_offset_sec: number }>(
      `SELECT placement_mode, global_offset_sec FROM timeline_sections`);
    expect(r).toEqual({ placement_mode: 'legacy_absolute', global_offset_sec: 47 });
  });
});

// ── Referential behaviour ─────────────────────────────────────────────────────

describe('063 — deleting a host video', () => {
  beforeEach(applyForward);

  it('CLEARS the anchor and KEEPS the overlay', async () => {
    // SET NULL, never CASCADE. An author who deletes a main video must not silently lose the b-roll
    // they placed over it. The row is then `placement_mode='segment'` with no anchor — which is
    // precisely why the mode is a stored column and not a computed `anchor IS NOT NULL`: the
    // resolver can tell "was anchored, lost its host" from "was never anchored" and report it.
    const { projectId, mainId, brollId } = await seed();
    const sec = await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec, placement_mode, anchor_video_file_id,
                                      anchor_offset_sec)
       VALUES ($1,$2,0,6,'broll','broll',10,'segment',$3,10) RETURNING id`,
      [projectId, brollId, mainId]);

    await pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId]);

    const after = await one<{
      placement_mode: string; anchor_video_file_id: string | null; global_offset_sec: number;
    }>(`SELECT placement_mode, anchor_video_file_id, global_offset_sec
          FROM timeline_sections WHERE id=$1`, [sec.id]);
    expect(after).toEqual({
      placement_mode: 'segment', anchor_video_file_id: null, global_offset_sec: 10,
    });
  });

  it('clears a generation job\'s captured anchor the same way, without losing the job', async () => {
    const { projectId, mainId } = await seed();
    const job = await one<{ id: string }>(
      `INSERT INTO video_generation_jobs (project_id, model, original_prompt, target_duration_sec,
                                          target_global_offset_sec, target_anchor_video_file_id,
                                          target_anchor_offset_sec)
       VALUES ($1,'kling','a cat',5,12,$2,12) RETURNING id`, [projectId, mainId]);
    await pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId]);
    const after = await one<{ target_anchor_video_file_id: string | null; target_global_offset_sec: number }>(
      `SELECT target_anchor_video_file_id, target_global_offset_sec
         FROM video_generation_jobs WHERE id=$1`, [job.id]);
    expect(after).toEqual({ target_anchor_video_file_id: null, target_global_offset_sec: 12 });
  });
});

// ── Runner hygiene ────────────────────────────────────────────────────────────

describe('063 — runner hygiene', () => {
  it('is idempotent (applying twice changes nothing)', async () => {
    await applyForwardToHead();
    const before = await snapshot();
    await applyForwardToHead();
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back cleanly, constraint included', async () => {
    const before = await snapshot();
    await applyForwardToHead();
    await rollbackAfter();
    await pg.exec(rollbackSql);
    expect(await snapshot()).toEqual(before);
  });

  it('adds NO index — none of the four columns is ever a query predicate', async () => {
    // Per 062's rule: an index goes in only after EXPLAIN on representative volume says it helps,
    // and never inside a transaction already holding a write lock on a hot table. The readers load
    // a project's sections by `project_id` and place them in memory.
    const before = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='timeline_sections' ORDER BY indexname`);
    await applyForward();
    const after = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='timeline_sections' ORDER BY indexname`);
    expect(after).toEqual(before);
  });

  it('sets lock_timeout LOCALLY — a bare SET leaks to every migration that follows', async () => {
    // The lesson of 062: the runner reuses ONE connection for the whole run, so a session-level SET
    // outlives its own file and silently governs the ones after it.
    expect(forwardSql).toMatch(/SET\s+LOCAL\s+lock_timeout/);
    expect(forwardSql).not.toMatch(/^\s*SET\s+lock_timeout/m);
  });

  it('is registered with the migration runner AND db:check', async () => {
    // An unregistered file never runs, and the application then reads a column the database does
    // not have — the failure this assertion exists to make impossible.
    expect(MIGRATION_FILES).toContain(TARGET);
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(checkDb).toContain(TARGET);
  });
});
