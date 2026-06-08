/**
 * Database constraint tests for migration 030 — run against a real Postgres
 * engine (PGlite) so we validate the actual DDL: unique indexes, check
 * constraints, foreign keys and deletion behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, expectReject, type TestDb } from './pgliteHelper.js';

describe('migration 030 — courses constraints', () => {
  let dbt: TestDb;
  let orgId: string;

  beforeEach(async () => {
    dbt = await createTestDb();
    orgId = await dbt.seedOrg();
  });
  afterEach(async () => { await dbt.close(); });

  it('accepts a minimal valid course', async () => {
    const id = await dbt.insertCourse(orgId, { slug: 'intro-to-x' });
    expect(id).toBeTruthy();
  });

  it('enforces unique slug under the default canonical host', async () => {
    await dbt.insertCourse(orgId, { slug: 'dup' });
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'dup' }));
    expect(msg).toMatch(/uniq_courses_host_slug|duplicate/i);
  });

  it('allows the same slug on a different canonical host', async () => {
    await dbt.insertCourse(orgId, { slug: 'dup', canonical_host: null });
    const id = await dbt.insertCourse(orgId, { slug: 'dup', canonical_host: 'custom.example.com' });
    expect(id).toBeTruthy();
  });

  it('rejects a malformed slug', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'Not A Slug' }));
    expect(msg).toMatch(/courses_slug_format_chk|check/i);
  });

  it('rejects a malformed language tag', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'lang', language: 'english!' }));
    expect(msg).toMatch(/courses_language_format_chk|check/i);
  });

  it('rejects learning_outcomes that are not a JSON array', async () => {
    const msg = await expectReject(() =>
      dbt.insertCourse(orgId, { slug: 'outc', learning_outcomes: JSON.stringify({ a: 1 }) }),
    );
    expect(msg).toMatch(/courses_outcomes_array_chk|check/i);
  });

  it('accepts learning_outcomes as a JSON array', async () => {
    const id = await dbt.insertCourse(orgId, { slug: 'outc2', learning_outcomes: JSON.stringify(['a', 'b']) });
    expect(id).toBeTruthy();
  });

  // ── Archive state machine — every valid & invalid combination ───────────────
  const archivedAt = '2025-06-01T00:00:00Z';

  it('accepts archived + temporary (404) with a timestamp', async () => {
    expect(await dbt.insertCourse(orgId, { slug: 'temp', publish_state: 'archived', archive_disposition: 'temporary', archived_at: archivedAt })).toBeTruthy();
  });
  it('accepts archived + permanent (410) with a timestamp', async () => {
    expect(await dbt.insertCourse(orgId, { slug: 'gone', publish_state: 'archived', archive_disposition: 'permanent', archived_at: archivedAt })).toBeTruthy();
  });
  it('accepts archived + redirect (301) with a non-empty replacement URL and timestamp', async () => {
    expect(await dbt.insertCourse(orgId, { slug: 'red', publish_state: 'archived', archive_disposition: 'redirect', archived_replacement_url: 'https://example.com/c/new', archived_at: archivedAt })).toBeTruthy();
  });

  it('rejects archived without a disposition', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a1', publish_state: 'archived', archived_at: archivedAt }));
    expect(msg).toMatch(/courses_archived_requires_disposition_chk|check/i);
  });
  it('rejects archived without an archived_at timestamp', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a2', publish_state: 'archived', archive_disposition: 'permanent' }));
    expect(msg).toMatch(/courses_archived_requires_timestamp_chk|check/i);
  });
  it('rejects redirect disposition with a NULL replacement URL', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a3', publish_state: 'archived', archive_disposition: 'redirect', archived_at: archivedAt, archived_replacement_url: null }));
    expect(msg).toMatch(/courses_redirect_requires_url_chk|check/i);
  });
  it('rejects redirect disposition with a blank replacement URL', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a4', publish_state: 'archived', archive_disposition: 'redirect', archived_at: archivedAt, archived_replacement_url: '   ' }));
    expect(msg).toMatch(/courses_redirect_requires_url_chk|check/i);
  });
  it('rejects a replacement URL when disposition is not redirect', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a5', publish_state: 'archived', archive_disposition: 'permanent', archived_at: archivedAt, archived_replacement_url: 'https://example.com/x' }));
    expect(msg).toMatch(/courses_replacement_url_only_redirect_chk|check/i);
  });
  it('rejects a non-archived course that retains a disposition', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a6', publish_state: 'draft', archive_disposition: 'permanent' }));
    expect(msg).toMatch(/courses_non_archived_clean_chk|courses_archived_requires|check/i);
  });
  it('rejects a non-archived course that retains an archived_at timestamp', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a7', publish_state: 'published', archived_at: archivedAt }));
    expect(msg).toMatch(/courses_non_archived_clean_chk|check/i);
  });
  it('rejects a non-archived course that retains a replacement URL', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'a8', publish_state: 'draft', archived_replacement_url: 'https://example.com/x' }));
    expect(msg).toMatch(/courses_replacement_url_only_redirect_chk|courses_non_archived_clean_chk|check/i);
  });
  it('accepts a normal non-archived course with all archive fields NULL', async () => {
    expect(await dbt.insertCourse(orgId, { slug: 'clean', publish_state: 'published', published_at: '2025-01-01T00:00:00Z' })).toBeTruthy();
  });

  it('rejects an invalid publish_state enum value', async () => {
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'enum', publish_state: 'live' }));
    expect(msg).toMatch(/invalid input value for enum|publish_state/i);
  });

  it('enforces one course per legacy_playlist_id but allows many NULLs', async () => {
    const plId = (await dbt.pg.query<{ id: string }>(
      `INSERT INTO playlists (org_id, title) VALUES ($1,$2) RETURNING id`, [orgId, 'PL'],
    )).rows[0].id;
    await dbt.insertCourse(orgId, { slug: 'p1', legacy_playlist_id: plId });
    const msg = await expectReject(() => dbt.insertCourse(orgId, { slug: 'p2', legacy_playlist_id: plId }));
    expect(msg).toMatch(/uniq_courses_legacy_playlist|duplicate/i);
    // Two courses with NULL provenance are fine.
    await dbt.insertCourse(orgId, { slug: 'n1' });
    await dbt.insertCourse(orgId, { slug: 'n2' });
  });
});

describe('migration 030 — course_lessons constraints', () => {
  let dbt: TestDb;
  let orgId: string;
  let courseId: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    dbt = await createTestDb();
    orgId = await dbt.seedOrg();
    courseId = await dbt.insertCourse(orgId, { slug: 'course' });
    projectA = await dbt.seedProject(orgId, { title: 'A' });
    projectB = await dbt.seedProject(orgId, { title: 'B' });
  });
  afterEach(async () => { await dbt.close(); });

  const addLesson = (over: Record<string, unknown>) => {
    const cols = { course_id: courseId, project_id: projectA, position: 0, slug: 'l', ...over };
    const keys = Object.keys(cols);
    return dbt.pg.query(
      `INSERT INTO course_lessons (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      keys.map((k) => (cols as Record<string, unknown>)[k]),
    );
  };

  it('accepts a valid lesson', async () => {
    await expect(addLesson({ slug: 'lesson-1', position: 0 })).resolves.toBeTruthy();
  });

  it('enforces unique slug within a course', async () => {
    await addLesson({ slug: 'dup', position: 0, project_id: projectA });
    const msg = await expectReject(() => addLesson({ slug: 'dup', position: 1, project_id: projectB }));
    expect(msg).toMatch(/uniq_lesson_course_slug|duplicate/i);
  });

  it('forbids the same project twice in a course', async () => {
    await addLesson({ slug: 'a1', position: 0, project_id: projectA });
    const msg = await expectReject(() => addLesson({ slug: 'a2', position: 1, project_id: projectA }));
    expect(msg).toMatch(/uniq_lesson_course_project|duplicate/i);
  });

  it('forbids two lessons sharing a position in a course', async () => {
    await addLesson({ slug: 'a1', position: 5, project_id: projectA });
    const msg = await expectReject(() => addLesson({ slug: 'a2', position: 5, project_id: projectB }));
    expect(msg).toMatch(/uniq_lesson_course_position|duplicate/i);
  });

  it('rejects a negative position', async () => {
    const msg = await expectReject(() => addLesson({ slug: 'neg', position: -1 }));
    expect(msg).toMatch(/course_lessons_position_chk|check/i);
  });

  it('allows the same project to be reused across different courses', async () => {
    const other = await dbt.insertCourse(orgId, { slug: 'course-2' });
    await addLesson({ slug: 'a1', position: 0, project_id: projectA });
    await expect(
      dbt.pg.query(
        `INSERT INTO course_lessons (course_id, project_id, position, slug) VALUES ($1,$2,$3,$4)`,
        [other, projectA, 0, 'a1'],
      ),
    ).resolves.toBeTruthy();
  });

  it('RESTRICTs deleting a project that backs a lesson (projects protected)', async () => {
    await addLesson({ slug: 'a1', position: 0, project_id: projectA });
    const msg = await expectReject(() => dbt.pg.query(`DELETE FROM projects WHERE id = $1`, [projectA]));
    expect(msg).toMatch(/foreign key|violates/i);
  });

  it('CASCADE-deletes lessons when the course is deleted, but never the projects', async () => {
    await addLesson({ slug: 'a1', position: 0, project_id: projectA });
    await dbt.pg.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    const lessons = await dbt.pg.query(`SELECT 1 FROM course_lessons WHERE course_id = $1`, [courseId]);
    const project = await dbt.pg.query(`SELECT 1 FROM projects WHERE id = $1`, [projectA]);
    expect(lessons.rows.length).toBe(0);
    expect(project.rows.length).toBe(1);
  });

  it('allows reordering positions within one transaction (deferrable unique)', async () => {
    await addLesson({ slug: 'a1', position: 0, project_id: projectA });
    await addLesson({ slug: 'a2', position: 1, project_id: projectB });
    await dbt.pg.exec(`
      BEGIN;
      SET CONSTRAINTS uniq_lesson_course_position DEFERRED;
      UPDATE course_lessons SET position = 1 WHERE project_id = '${projectA}';
      UPDATE course_lessons SET position = 0 WHERE project_id = '${projectB}';
      COMMIT;
    `);
    const rows = await dbt.pg.query<{ project_id: string; position: number }>(
      `SELECT project_id, position FROM course_lessons WHERE course_id = $1 ORDER BY position`, [courseId],
    );
    expect(rows.rows.map((r) => r.project_id)).toEqual([projectB, projectA]);
  });
});

describe('migration 030 — course_custom_domains constraints', () => {
  let dbt: TestDb;
  let orgId: string;
  let courseId: string;

  beforeEach(async () => {
    dbt = await createTestDb();
    orgId = await dbt.seedOrg();
    courseId = await dbt.insertCourse(orgId, { slug: 'course' });
  });
  afterEach(async () => { await dbt.close(); });

  const addDomain = (host: string, primary = false) =>
    dbt.pg.query(`INSERT INTO course_custom_domains (course_id, hostname, is_primary) VALUES ($1,$2,$3)`, [courseId, host, primary]);

  it('enforces globally unique hostnames', async () => {
    await addDomain('learn.example.com');
    const msg = await expectReject(() => addDomain('learn.example.com'));
    expect(msg).toMatch(/uniq_custom_domain_hostname|duplicate/i);
  });

  it('rejects an uppercase hostname', async () => {
    const msg = await expectReject(() => addDomain('Learn.Example.com'));
    expect(msg).toMatch(/custom_domain_hostname_lower_chk|check/i);
  });

  it('allows at most one primary hostname per course', async () => {
    await addDomain('a.example.com', true);
    const msg = await expectReject(() => addDomain('b.example.com', true));
    expect(msg).toMatch(/uniq_custom_domain_primary|duplicate/i);
    // A non-primary second domain is fine.
    await expect(addDomain('c.example.com', false)).resolves.toBeTruthy();
  });
});

describe('migration 030 — project_redirect_targets constraints', () => {
  let dbt: TestDb;
  let orgId: string;
  let courseId: string;
  let projectA: string;
  let projectB: string;
  let lessonA: string;

  beforeEach(async () => {
    dbt = await createTestDb();
    orgId = await dbt.seedOrg();
    courseId = await dbt.insertCourse(orgId, { slug: 'course' });
    projectA = await dbt.seedProject(orgId, { title: 'A' });
    projectB = await dbt.seedProject(orgId, { title: 'B' });
    lessonA = (await dbt.pg.query<{ id: string }>(
      `INSERT INTO course_lessons (course_id, project_id, position, slug) VALUES ($1,$2,0,'a') RETURNING id`, [courseId, projectA],
    )).rows[0].id;
  });
  afterEach(async () => { await dbt.close(); });

  it('accepts a redirect target whose lesson belongs to the project', async () => {
    await expect(
      dbt.pg.query(`INSERT INTO project_redirect_targets (project_id, course_lesson_id) VALUES ($1,$2)`, [projectA, lessonA]),
    ).resolves.toBeTruthy();
  });

  it('rejects a redirect target whose lesson belongs to a DIFFERENT project', async () => {
    // lessonA belongs to projectA; pointing projectB at it must fail the composite FK.
    const msg = await expectReject(() =>
      dbt.pg.query(`INSERT INTO project_redirect_targets (project_id, course_lesson_id) VALUES ($1,$2)`, [projectB, lessonA]),
    );
    expect(msg).toMatch(/fk_redirect_lesson_same_project|foreign key|violates/i);
  });

  it('enforces one canonical target per project (PK)', async () => {
    await dbt.pg.query(`INSERT INTO project_redirect_targets (project_id, course_lesson_id) VALUES ($1,$2)`, [projectA, lessonA]);
    const msg = await expectReject(() =>
      dbt.pg.query(`INSERT INTO project_redirect_targets (project_id, course_lesson_id) VALUES ($1,$2)`, [projectA, lessonA]),
    );
    expect(msg).toMatch(/project_redirect_targets_pkey|duplicate/i);
  });

  it('cascade-deletes the redirect target when its lesson is removed', async () => {
    await dbt.pg.query(`INSERT INTO project_redirect_targets (project_id, course_lesson_id) VALUES ($1,$2)`, [projectA, lessonA]);
    await dbt.pg.query(`DELETE FROM course_lessons WHERE id = $1`, [lessonA]);
    const rows = await dbt.pg.query(`SELECT 1 FROM project_redirect_targets WHERE project_id = $1`, [projectA]);
    expect(rows.rows.length).toBe(0);
  });
});
