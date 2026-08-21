/**
 * Migration 069 (the impact-review queue, and a host that cannot be deleted out from under its
 * anchors — D-01b) against a real Postgres engine.
 *
 * The properties that matter, and why each is a TEST rather than a comment:
 *
 *   • DELETING AN ANCHORED HOST IS REFUSED. 063 used ON DELETE SET NULL, which silently orphaned
 *     every overlay placed over a deleted video and left it playing at a wall-clock second the
 *     now-shorter timeline had just made wrong. The ruling asks for an explicit choice instead, and
 *     a route that forgets to ask must fail loudly rather than quietly detach an author's work.
 *   • DELETING THE PROJECT STILL WORKS. This is the whole reason the constraint is NO ACTION and
 *     not RESTRICT, and it is the assertion that would have caught the mistake: a project delete
 *     cascades to video_files and timeline_sections in ONE statement, and RESTRICT — checked
 *     immediately rather than at end of statement — survives that only while the two cascades
 *     happen to fire in the helpful order. Nothing pins that order.
 *   • THE QUEUE HOLDS ONE OPEN ITEM PER (SECTION, REASON). The detector runs from a job that is
 *     delivered at least once; without the partial unique index a re-drive hands the author the
 *     same finding twice. Resolved rows are exempt, so a second replace can raise a second review.
 *   • 069 CONVERTS NOTHING. Like 063: no row's placement columns may change, asserted as data
 *     rather than as "the file contains no UPDATE".
 *   • Idempotent, rolls back cleanly, and registered with BOTH the runner and db:check. An
 *     unregistered file silently never runs, which is the failure mode that leaves the application
 *     reading a table the database does not have.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATION_FILES } from '../migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const TARGET = '069_placement_impact_review.sql';
const ROLLBACK = '069_placement_impact_review.rollback.sql';
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

/** Undo everything after 069, newest first, so 069's rollback is measured on its own schema. */
const rollbackAfter = async (): Promise<void> => {
  for (const f of [...AFTER].reverse()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f.replace(/\.sql$/, '.rollback.sql')), 'utf-8'));
  }
};

async function snapshot(): Promise<unknown> {
  return {
    tables: await rows(`SELECT table_name FROM information_schema.tables
                         WHERE table_schema='public' ORDER BY table_name`),
    sectionCons: await rows(`SELECT conname, confdeltype FROM pg_constraint
                              WHERE conrelid='timeline_sections'::regclass ORDER BY conname`),
    sectionCols: await rows(`SELECT column_name, data_type, is_nullable, column_default
                               FROM information_schema.columns WHERE table_name='timeline_sections'
                              ORDER BY column_name`),
  };
}

async function seed(): Promise<{ projectId: string; mainId: string; brollId: string }> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-069', 'e@test') RETURNING id`);
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

/** A b-roll ANCHORED to `mainId` — the row the delete rules are about. */
async function anchoredBroll(projectId: string, sourceId: string, hostId: string): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                    global_offset_sec, placement_mode, anchor_video_file_id,
                                    anchor_offset_sec)
     VALUES ($1,$2,0,6,'broll','broll',10,'segment',$3,10) RETURNING id`,
    [projectId, sourceId, hostId]);
  return r.id;
}

async function openReview(projectId: string, sectionId: string, reason: string): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO placement_impact_reviews (project_id, section_id, reason, change_kind)
     VALUES ($1,$2,$3,'media_replace') RETURNING id`, [projectId, sectionId, reason]);
  return r.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

// ── The queue ─────────────────────────────────────────────────────────────────

describe('069 — the review queue', () => {
  beforeEach(applyForward);

  it('holds ONE open item per (section, reason), and refreshes rather than duplicates', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    await openReview(projectId, sec, 'anchor_out_of_range');

    await expect(openReview(projectId, sec, 'anchor_out_of_range')).rejects.toMatchObject({ code: '23505' });

    // A DIFFERENT fault on the same row is a different decision and is allowed to coexist: an
    // author who is told only "this clip is broken" cannot tell which half to fix.
    await expect(openReview(projectId, sec, 'source_window_out_of_range')).resolves.toBeTruthy();
  });

  it('lets a NEW review open once the previous one is resolved', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    const first = await openReview(projectId, sec, 'anchor_out_of_range');
    await pg.query(
      `UPDATE placement_impact_reviews SET resolved_at=now(), resolution='accepted' WHERE id=$1`,
      [first]);
    // A second replace breaks the same row again. Its history is kept; the queue is not.
    await expect(openReview(projectId, sec, 'anchor_out_of_range')).resolves.toBeTruthy();
    const open = await rows(`SELECT id FROM placement_impact_reviews WHERE resolved_at IS NULL`);
    expect(open).toHaveLength(1);
  });

  it('constrains the three vocabularies, and has no word for "the system fixed it"', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    await expect(openReview(projectId, sec, 'something_else')).rejects.toMatchObject({ code: '23514' });
    await expect(pg.query(
      `INSERT INTO placement_impact_reviews (project_id, section_id, reason, change_kind)
       VALUES ($1,$2,'anchor_out_of_range','fixed_it')`, [projectId, sec],
    )).rejects.toMatchObject({ code: '23514' });

    const id = await openReview(projectId, sec, 'anchor_out_of_range');
    await expect(pg.query(
      `UPDATE placement_impact_reviews SET resolved_at=now(), resolution='auto_fixed' WHERE id=$1`, [id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot be half-resolved — the two columns move together or the queue lies about its length', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    const id = await openReview(projectId, sec, 'anchor_out_of_range');
    await expect(pg.query(
      `UPDATE placement_impact_reviews SET resolved_at=now() WHERE id=$1`, [id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pg.query(
      `UPDATE placement_impact_reviews SET resolution='dismissed' WHERE id=$1`, [id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('goes away with its section — a review of a row that no longer exists is noise', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    await openReview(projectId, sec, 'anchor_out_of_range');
    await pg.query(`DELETE FROM timeline_sections WHERE id=$1`, [sec]);
    expect(await rows(`SELECT id FROM placement_impact_reviews`)).toEqual([]);
  });

  it('SURVIVES the deletion of the host it names, with the id nulled', async () => {
    // `host_deleted_detached` is written in the same transaction that deletes the host, so a
    // CASCADE here would delete the review as fast as it was created — which is the one case the
    // queue exists for.
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    await pg.query(
      `INSERT INTO placement_impact_reviews (project_id, section_id, host_video_file_id, reason, change_kind, detail)
       VALUES ($1,$2,$3,'host_deleted_detached','host_delete','the video it was anchored to ("main.mp4") was deleted')`,
      [projectId, sec, mainId]);

    // The author chose to detach, so the anchor goes first — then the host may be deleted.
    await pg.query(`UPDATE timeline_sections SET anchor_video_file_id=NULL WHERE id=$1`, [sec]);
    await pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId]);

    const review = await one<{ host_video_file_id: string | null; detail: string }>(
      `SELECT host_video_file_id, detail FROM placement_impact_reviews WHERE section_id=$1`, [sec]);
    expect(review.host_video_file_id).toBeNull();
    expect(review.detail).toContain('main.mp4');   // the name survives where the id cannot
  });
});

// ── Referential behaviour ─────────────────────────────────────────────────────

describe('069 — deleting a host video', () => {
  beforeEach(applyForward);

  it('REFUSES to delete a video an overlay is anchored to', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);

    await expect(pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId]))
      .rejects.toMatchObject({ code: '23503' });

    // And the overlay is untouched: the refusal is not a partial delete.
    const after = await one<{ anchor_video_file_id: string | null; placement_mode: string }>(
      `SELECT anchor_video_file_id, placement_mode FROM timeline_sections WHERE id=$1`, [sec]);
    expect(after).toEqual({ anchor_video_file_id: mainId, placement_mode: 'segment' });
  });

  it('allows the delete once the author has explicitly detached', async () => {
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    await pg.query(`UPDATE timeline_sections SET anchor_video_file_id=NULL WHERE id=$1`, [sec]);
    await expect(pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId])).resolves.toBeDefined();

    // The overlay survives, keeps the second it plays at, and still SAYS it was anchored —
    // `placement_mode='segment'` with a null anchor is what "lost its host" looks like.
    const after = await one<{ placement_mode: string; global_offset_sec: number }>(
      `SELECT placement_mode, global_offset_sec FROM timeline_sections WHERE id=$1`, [sec]);
    expect(after).toEqual({ placement_mode: 'segment', global_offset_sec: 10 });
  });

  it('still lets the whole PROJECT be deleted — the reason this is NO ACTION, not RESTRICT', async () => {
    // A project delete cascades to video_files and timeline_sections in one statement. NO ACTION is
    // checked at the END of that statement, when the sections are already gone, so it passes by
    // design rather than by the order the cascades happened to fire in.
    const { projectId, mainId, brollId } = await seed();
    await anchoredBroll(projectId, brollId, mainId);

    await expect(pg.query(`DELETE FROM projects WHERE id=$1`, [projectId])).resolves.toBeDefined();
    expect(await rows(`SELECT id FROM video_files`)).toEqual([]);
    expect(await rows(`SELECT id FROM timeline_sections`)).toEqual([]);
  });

  it('leaves a GENERATION job free to lose its captured anchor, without blocking the delete', async () => {
    // Deliberately still SET NULL: a queued generation must not hold a video hostage for the
    // twenty-five minutes it may take to finish. The section it publishes falls back to its
    // absolute second, which is the pre-063 behaviour.
    const { projectId, mainId } = await seed();
    const job = await one<{ id: string }>(
      `INSERT INTO video_generation_jobs (project_id, model, original_prompt, target_duration_sec,
                                          target_global_offset_sec, target_anchor_video_file_id,
                                          target_anchor_offset_sec)
       VALUES ($1,'kling','a cat',5,12,$2,12) RETURNING id`, [projectId, mainId]);
    await expect(pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId])).resolves.toBeDefined();
    const after = await one<{ target_anchor_video_file_id: string | null }>(
      `SELECT target_anchor_video_file_id FROM video_generation_jobs WHERE id=$1`, [job.id]);
    expect(after.target_anchor_video_file_id).toBeNull();
  });

  it('a row that is BOTH anchored to and sourced from the host still deletes cleanly', async () => {
    // The interaction the NO ACTION choice depends on, and the one a RESTRICT would have broken.
    // The `video_file_id` CASCADE removes this row DURING the delete statement; the anchor check
    // runs at the END of that statement and finds nothing left to complain about. If this ever
    // fails, the delete route's preflight cannot save it — the row is unreachable from `detach`
    // by design (`anchoredSectionIdsFor` excludes it), so the constraint has to tolerate it.
    const { projectId, mainId } = await seed();
    await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec, placement_mode, anchor_video_file_id,
                                      anchor_offset_sec)
       VALUES ($1,$2,0,6,'broll','broll',10,'segment',$2,10) RETURNING id`, [projectId, mainId]);

    await expect(pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId])).resolves.toBeDefined();
    expect(await rows(`SELECT id FROM timeline_sections`)).toEqual([]);
  });

  it('a SOURCED section still goes with its media — what "detach" cannot save', async () => {
    // `timeline_sections.video_file_id` has cascaded since long before D-01, and it is why the
    // delete route names those rows separately in its 409: an author who chooses "keep my clips"
    // must be told which ones cannot be kept, because their media is the video being deleted.
    const { projectId, brollId } = await seed();
    const sec = await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec)
       VALUES ($1,$2,0,6,'broll','broll',10) RETURNING id`, [projectId, brollId]);
    await pg.query(`DELETE FROM video_files WHERE id=$1`, [brollId]);
    expect(await rows(`SELECT id FROM timeline_sections WHERE id=$1`, [sec.id])).toEqual([]);
  });
});

// ── The expand half ───────────────────────────────────────────────────────────

describe('069 — what it does NOT do', () => {
  it('converts no placement row, and moves no anchor', async () => {
    const { projectId, mainId, brollId } = await seed();
    // One legacy row and one anchored row, written by the code that exists before 069.
    await pg.query(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec)
       VALUES ($1,$2,0,6,'broll','broll',47)`, [projectId, brollId]);
    await anchoredBroll(projectId, brollId, mainId);

    const before = await rows(`SELECT id, global_offset_sec, placement_mode, anchor_video_file_id,
                                      anchor_offset_sec, start_sec, end_sec
                                 FROM timeline_sections ORDER BY id`);
    await applyForward();
    expect(await rows(`SELECT id, global_offset_sec, placement_mode, anchor_video_file_id,
                              anchor_offset_sec, start_sec, end_sec
                         FROM timeline_sections ORDER BY id`)).toEqual(before);
  });

  it('opens no review of its own — the queue starts empty', async () => {
    const { projectId, mainId, brollId } = await seed();
    await anchoredBroll(projectId, brollId, mainId);
    await applyForward();
    expect(await rows(`SELECT id FROM placement_impact_reviews`)).toEqual([]);
  });
});

// ── Runner hygiene ────────────────────────────────────────────────────────────

describe('069 — runner hygiene', () => {
  it('is idempotent (applying twice changes nothing)', async () => {
    await applyForwardToHead();
    const before = await snapshot();
    await applyForwardToHead();
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back cleanly, FK behaviour included', async () => {
    const before = await snapshot();
    await applyForwardToHead();
    await rollbackAfter();
    await pg.exec(rollbackSql);
    expect(await snapshot()).toEqual(before);
  });

  it('restores ON DELETE SET NULL on rollback, not merely the constraint name', async () => {
    // `snapshot()` compares `confdeltype`, but only a behavioural check proves the reverted
    // constraint does what 063 promised: a code rollback that still deletes videos must not start
    // failing on every anchored host.
    await applyForward();
    await pg.exec(rollbackSql);
    const { projectId, mainId, brollId } = await seed();
    const sec = await anchoredBroll(projectId, brollId, mainId);
    await expect(pg.query(`DELETE FROM video_files WHERE id=$1`, [mainId])).resolves.toBeDefined();
    const after = await one<{ anchor_video_file_id: string | null }>(
      `SELECT anchor_video_file_id FROM timeline_sections WHERE id=$1`, [sec]);
    expect(after.anchor_video_file_id).toBeNull();
  });

  it('sets lock_timeout LOCALLY — a bare SET leaks to every migration that follows', async () => {
    // The lesson of 062: the runner reuses ONE connection for the whole run, so a session-level SET
    // outlives its own file and silently governs the ones after it.
    expect(forwardSql).toMatch(/SET\s+LOCAL\s+lock_timeout/);
    expect(forwardSql).not.toMatch(/^\s*SET\s+lock_timeout/m);
  });

  it('is registered with the migration runner AND db:check', async () => {
    // An unregistered file never runs, and the application then reads a table the database does
    // not have — the failure this assertion exists to make impossible.
    expect(MIGRATION_FILES).toContain(TARGET);
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(checkDb).toContain(TARGET);
  });
});
