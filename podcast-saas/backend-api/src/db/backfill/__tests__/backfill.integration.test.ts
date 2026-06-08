/**
 * Backfill integration test — runs the real mapping + the real executor against a
 * real Postgres engine (PGlite). Proves:
 *   - the generated courses/lessons/redirect-targets satisfy every constraint,
 *   - a second run is idempotent (creates nothing, DB unchanged),
 *   - per-course SAVEPOINT isolation: a failing course rolls back entirely (no
 *     partial lessons) without aborting the transaction or later courses,
 *   - legacy playlists/projects/share-tokens are never modified.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../__tests__/pgliteHelper.js';
import {
  computeBackfillPlan,
  type BackfillInput,
  type BackfillPlan,
  type PlannedCourse,
  type PlaylistRow,
  type PlaylistItemRow,
  type ProjectRow,
  type ExistingCourseRow,
} from '../computeBackfillPlan.js';
import { executeBackfillPlan, baseReport } from '../030_courses.js';

async function loadInput(dbt: TestDb): Promise<BackfillInput> {
  const playlists = (await dbt.pg.query<PlaylistRow>(`SELECT id, org_id, created_by, title, description, banner_url, share_token, share_enabled_at, view_count, created_at FROM playlists`)).rows;
  const playlistItems = (await dbt.pg.query<PlaylistItemRow>(`SELECT playlist_id, project_id, position FROM playlist_items`)).rows;
  const projects = (await dbt.pg.query<ProjectRow>(`SELECT id, org_id, created_by, title, topic, thumbnail_url, share_token, share_enabled_at, view_count, created_at FROM projects`)).rows;
  const existingCourses = (await dbt.pg.query<ExistingCourseRow>(`SELECT slug, canonical_host, legacy_playlist_id, legacy_project_id FROM courses`)).rows;
  return { playlists, playlistItems, projects, existingCourses };
}

const run = (dbt: TestDb, plan: BackfillPlan) => executeBackfillPlan(dbt.querier(), plan, baseReport(plan, 'execute'));

describe('course backfill — integration (real executor + constraints)', () => {
  let dbt: TestDb;
  let orgId: string;

  beforeEach(async () => {
    dbt = await createTestDb();
    orgId = await dbt.seedOrg();
  });
  afterEach(async () => { await dbt.close(); });

  it('applies the plan, sets canonical redirect targets, and a rerun is idempotent', async () => {
    const pA = await dbt.seedProject(orgId, { title: 'Intro' });
    const pB = await dbt.seedProject(orgId, { title: 'Deep Dive' });
    const pSolo = await dbt.seedProject(orgId, { title: 'Solo', shareToken: 'solo-tok' });
    await dbt.seedProject(orgId, { title: 'Private', shareToken: null });

    const plId = (await dbt.pg.query<{ id: string }>(
      `INSERT INTO playlists (org_id, title, share_token) VALUES ($1,$2,$3) RETURNING id`, [orgId, 'My Course', 'pl-tok'],
    )).rows[0].id;
    await dbt.pg.query(`INSERT INTO playlist_items (playlist_id, project_id, position) VALUES ($1,$2,0),($1,$3,1)`, [plId, pA, pB]);

    const report1 = await run(dbt, computeBackfillPlan(await loadInput(dbt)));
    expect(report1.counts.coursesCreated).toBe(2);                 // playlist-course + solo
    expect(report1.counts.lessonsCreated).toBe(3);
    expect(report1.counts.redirectTargetsCreated).toBe(1);         // only the public solo project
    expect(report1.counts.failed).toBe(0);

    // Solo project's canonical target points at the solo course's lesson.
    const target = (await dbt.pg.query<{ project_id: string; course_lesson_id: string }>(
      `SELECT project_id, course_lesson_id FROM project_redirect_targets WHERE project_id = $1`, [pSolo],
    )).rows;
    expect(target).toHaveLength(1);

    // Playlist-course published, 2 lessons in order.
    const plCourse = (await dbt.pg.query<{ id: string; publish_state: string }>(
      `SELECT id, publish_state FROM courses WHERE legacy_playlist_id = $1`, [plId],
    )).rows[0];
    expect(plCourse.publish_state).toBe('published');
    const ordered = (await dbt.pg.query<{ project_id: string }>(
      `SELECT project_id FROM course_lessons WHERE course_id = $1 ORDER BY position`, [plCourse.id],
    )).rows.map((r) => r.project_id);
    expect(ordered).toEqual([pA, pB]);

    // Rerun — nothing new.
    const report2 = await run(dbt, computeBackfillPlan(await loadInput(dbt)));
    expect(report2.counts.coursesCreated).toBe(0);
    expect(report2.counts.lessonsCreated).toBe(0);
    expect(report2.counts.redirectTargetsCreated).toBe(0);
    expect((await dbt.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM courses`)).rows[0].n).toBe(2);
    expect((await dbt.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM course_lessons`)).rows[0].n).toBe(3);

    // Legacy untouched.
    expect((await dbt.pg.query<{ share_token: string }>(`SELECT share_token FROM playlists WHERE id = $1`, [plId])).rows[0].share_token).toBe('pl-tok');
  });

  it('isolates a failing course with a SAVEPOINT — no partial lessons, later courses still committed', async () => {
    // Hand-crafted plan: course #2 has two lessons with the SAME slug, so the 2nd
    // lesson insert violates uniq_lesson_course_slug and the whole course rolls back.
    const p1 = await dbt.seedProject(orgId, { title: 'P1' });
    const p2a = await dbt.seedProject(orgId, { title: 'P2a' });
    const p2b = await dbt.seedProject(orgId, { title: 'P2b' });
    const p3 = await dbt.seedProject(orgId, { title: 'P3' });

    const course = (tempId: string, slug: string): PlannedCourse => ({
      tempId, kind: 'playlist', orgId, createdBy: null, title: slug, description: null, coverImageUrl: null,
      publishState: 'draft', publishedAt: null, slug, slugCollided: false,
      legacyPlaylistId: null, legacyProjectId: null, viewCount: 0,
    });
    const plan: BackfillPlan = {
      coursesToCreate: [course('c:1', 'course-one'), course('c:2', 'course-two'), course('c:3', 'course-three')],
      lessonsToCreate: [
        { courseTempId: 'c:1', projectId: p1, position: 0, slug: 'l1', slugCollided: false },
        { courseTempId: 'c:2', projectId: p2a, position: 0, slug: 'dup', slugCollided: false },
        { courseTempId: 'c:2', projectId: p2b, position: 1, slug: 'dup', slugCollided: false }, // ← fails
        { courseTempId: 'c:3', projectId: p3, position: 0, slug: 'l3', slugCollided: false },
      ],
      redirectTargets: [],
      skipped: [], conflicts: [],
    };

    const report = await run(dbt, plan);

    expect(report.counts.coursesCreated).toBe(2);   // course-one + course-three
    expect(report.counts.lessonsCreated).toBe(2);
    expect(report.counts.failed).toBe(1);
    expect(report.failed[0].ref).toContain('course-two');

    // course-two fully rolled back — neither the course nor its first lesson exist.
    expect((await dbt.pg.query(`SELECT 1 FROM courses WHERE slug = 'course-two'`)).rows).toHaveLength(0);
    expect((await dbt.pg.query(`SELECT 1 FROM course_lessons WHERE project_id = $1`, [p2a])).rows).toHaveLength(0);

    // The good courses are committed (transaction was not aborted).
    expect((await dbt.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM courses`)).rows[0].n).toBe(2);
    expect((await dbt.pg.query(`SELECT 1 FROM courses WHERE slug = 'course-one'`)).rows).toHaveLength(1);
    expect((await dbt.pg.query(`SELECT 1 FROM courses WHERE slug = 'course-three'`)).rows).toHaveLength(1);
  });
});
