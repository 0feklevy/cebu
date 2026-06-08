/**
 * Backfill 030 — populate courses + course_lessons (+ project_redirect_targets)
 * from legacy playlists/projects.
 *
 *   Dry run (default, READ-ONLY — never writes):
 *     pnpm --filter backend-api exec tsx --env-file=../.env src/db/backfill/030_courses.ts
 *   Execute (writes inside ONE transaction, each course isolated by a SAVEPOINT):
 *     … src/db/backfill/030_courses.ts --execute
 *   Machine-readable report:
 *     … src/db/backfill/030_courses.ts --json
 *
 * Transaction model: a single transaction wraps the whole run; each course is
 * wrapped in its own SAVEPOINT so a failure rolls back ONLY that course (and its
 * lessons), is reported, and later courses are still attempted. A course/lesson is
 * counted as created only after its SAVEPOINT is released. Idempotency comes from
 * (a) the plan skipping already-backfilled sources and (b) the
 * courses.legacy_*_id unique indexes; project_redirect_targets is upserted.
 *
 * Not wired into the migrate runner — operated manually so it is never executed
 * automatically against production data.
 */

import postgres from 'postgres';
import { logger } from '../../lib/logger.js';
import {
  computeBackfillPlan,
  type BackfillInput,
  type BackfillPlan,
  type PlaylistRow,
  type PlaylistItemRow,
  type ProjectRow,
  type ExistingCourseRow,
} from './computeBackfillPlan.js';

/** Minimal driver-agnostic query seam (satisfied by postgres.js and PGlite). */
export interface Querier {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface BackfillReport {
  mode: 'dry-run' | 'execute';
  counts: {
    coursesPlanned: number;
    lessonsPlanned: number;
    redirectTargetsPlanned: number;
    coursesCreated: number;
    lessonsCreated: number;
    redirectTargetsCreated: number;
    slugCollisions: number;
    ambiguousRedirects: number;
    skipped: number;
    conflicts: number;
    failed: number;
  };
  createdCourses: Array<{ slug: string; kind: string; publishState: string; legacyPlaylistId: string | null; legacyProjectId: string | null }>;
  ambiguousRedirects: Array<{ projectId: string; candidateCount: number }>;
  skipped: BackfillPlan['skipped'];
  conflicts: BackfillPlan['conflicts'];
  failed: Array<{ ref: string; error: string }>;
}

export function baseReport(plan: BackfillPlan, mode: 'dry-run' | 'execute'): BackfillReport {
  const slugCollisions =
    plan.coursesToCreate.filter((c) => c.slugCollided).length +
    plan.lessonsToCreate.filter((l) => l.slugCollided).length;
  return {
    mode,
    counts: {
      coursesPlanned: plan.coursesToCreate.length,
      lessonsPlanned: plan.lessonsToCreate.length,
      redirectTargetsPlanned: plan.redirectTargets.length,
      coursesCreated: 0,
      lessonsCreated: 0,
      redirectTargetsCreated: 0,
      slugCollisions,
      ambiguousRedirects: plan.redirectTargets.filter((r) => r.ambiguous).length,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.length,
      failed: 0,
    },
    createdCourses: [],
    ambiguousRedirects: plan.redirectTargets.filter((r) => r.ambiguous).map((r) => ({ projectId: r.projectId, candidateCount: r.candidateCount })),
    skipped: plan.skipped,
    conflicts: plan.conflicts,
    failed: [],
  };
}

/**
 * Execute a plan against a Querier inside one transaction with per-course
 * SAVEPOINT isolation. Mutates and returns `report`. Exported for tests.
 */
export async function executeBackfillPlan(q: Querier, plan: BackfillPlan, report: BackfillReport): Promise<BackfillReport> {
  const lessonsByCourse = new Map<string, BackfillPlan['lessonsToCreate']>();
  for (const l of plan.lessonsToCreate) {
    if (!lessonsByCourse.has(l.courseTempId)) lessonsByCourse.set(l.courseTempId, []);
    lessonsByCourse.get(l.courseTempId)!.push(l);
  }

  await q.query('BEGIN');
  try {
    const idByTemp = new Map<string, string>();

    for (let i = 0; i < plan.coursesToCreate.length; i++) {
      const c = plan.coursesToCreate[i];
      const sp = `bf_c_${i}`;
      await q.query(`SAVEPOINT ${sp}`);
      try {
        const rows = await q.query<{ id: string }>(
          `INSERT INTO courses (org_id, created_by, kind, title, description, cover_image_url,
                                publish_state, published_at, slug, legacy_playlist_id, legacy_project_id, view_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [c.orgId, c.createdBy, c.kind, c.title, c.description, c.coverImageUrl,
           c.publishState, c.publishedAt, c.slug, c.legacyPlaylistId, c.legacyProjectId, c.viewCount],
        );
        const courseId = rows[0].id;

        let lessonsInserted = 0;
        for (const l of lessonsByCourse.get(c.tempId) ?? []) {
          await q.query(
            `INSERT INTO course_lessons (course_id, project_id, position, slug) VALUES ($1,$2,$3,$4)`,
            [courseId, l.projectId, l.position, l.slug],
          );
          lessonsInserted++;
        }

        await q.query(`RELEASE SAVEPOINT ${sp}`);
        // Count only after the savepoint is released (insert succeeded).
        idByTemp.set(c.tempId, courseId);
        report.counts.coursesCreated++;
        report.counts.lessonsCreated += lessonsInserted;
        report.createdCourses.push({
          slug: c.slug, kind: c.kind, publishState: c.publishState,
          legacyPlaylistId: c.legacyPlaylistId, legacyProjectId: c.legacyProjectId,
        });
      } catch (err) {
        await q.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await q.query(`RELEASE SAVEPOINT ${sp}`);
        report.counts.failed++;
        report.failed.push({ ref: `course ${c.slug} (${c.tempId})`, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Canonical redirect targets — only for courses that were actually created.
    for (let i = 0; i < plan.redirectTargets.length; i++) {
      const rt = plan.redirectTargets[i];
      const courseId = idByTemp.get(rt.courseTempId);
      if (!courseId) continue; // its course failed or was not created this run
      const sp = `bf_r_${i}`;
      await q.query(`SAVEPOINT ${sp}`);
      try {
        const lessonRows = await q.query<{ id: string }>(
          `SELECT id FROM course_lessons WHERE course_id = $1 AND project_id = $2`,
          [courseId, rt.projectId],
        );
        if (lessonRows.length === 0) throw new Error('canonical lesson not found after insert');
        await q.query(
          `INSERT INTO project_redirect_targets (project_id, course_lesson_id, is_ambiguous, candidate_count)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (project_id) DO UPDATE SET
             course_lesson_id = EXCLUDED.course_lesson_id,
             is_ambiguous     = EXCLUDED.is_ambiguous,
             candidate_count  = EXCLUDED.candidate_count,
             updated_at       = now()`,
          [rt.projectId, lessonRows[0].id, rt.ambiguous, rt.candidateCount],
        );
        await q.query(`RELEASE SAVEPOINT ${sp}`);
        report.counts.redirectTargetsCreated++;
      } catch (err) {
        await q.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await q.query(`RELEASE SAVEPOINT ${sp}`);
        report.counts.failed++;
        report.failed.push({ ref: `redirect ${rt.projectId}`, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await q.query('COMMIT');
  } catch (err) {
    await q.query('ROLLBACK');
    throw err;
  }
  return report;
}

type Sql = ReturnType<typeof postgres>;

async function loadInput(sql: Sql): Promise<BackfillInput> {
  const playlists       = (await sql`SELECT id, org_id, created_by, title, description, banner_url, share_token, share_enabled_at, view_count, created_at FROM playlists`) as unknown as PlaylistRow[];
  const playlistItems   = (await sql`SELECT playlist_id, project_id, position FROM playlist_items`) as unknown as PlaylistItemRow[];
  const projects        = (await sql`SELECT id, org_id, created_by, title, topic, thumbnail_url, share_token, share_enabled_at, view_count, created_at FROM projects`) as unknown as ProjectRow[];
  const existingCourses = (await sql`SELECT slug, canonical_host, legacy_playlist_id, legacy_project_id FROM courses`) as unknown as ExistingCourseRow[];
  return { playlists, playlistItems, projects, existingCourses };
}

export async function runBackfill(sql: Sql, opts: { execute: boolean }): Promise<BackfillReport> {
  const plan = computeBackfillPlan(await loadInput(sql));
  const report = baseReport(plan, opts.execute ? 'execute' : 'dry-run');

  if (!opts.execute) {
    // Dry run: report what WOULD be created without writing.
    report.createdCourses = plan.coursesToCreate.map((c) => ({
      slug: c.slug, kind: c.kind, publishState: c.publishState,
      legacyPlaylistId: c.legacyPlaylistId, legacyProjectId: c.legacyProjectId,
    }));
    return report;
  }

  // Pin a single connection so BEGIN…COMMIT and SAVEPOINTs share one session.
  const reserved = await sql.reserve();
  try {
    const q: Querier = {
      query: (text, params = []) =>
        reserved.unsafe(text, params as (string | number | boolean | null)[]) as unknown as Promise<never[]>,
    };
    await executeBackfillPlan(q, plan, report);
  } finally {
    reserved.release();
  }
  return report;
}

function printReport(report: BackfillReport, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const c = report.counts;
  console.log('\n═══════════════════════════════════════════');
  console.log(` Course backfill — ${report.mode.toUpperCase()}`);
  console.log('═══════════════════════════════════════════');
  console.log(`  Courses planned:          ${c.coursesPlanned}`);
  console.log(`  Lessons planned:          ${c.lessonsPlanned}`);
  console.log(`  Redirect targets planned: ${c.redirectTargetsPlanned}`);
  console.log(`  Courses created:          ${c.coursesCreated}`);
  console.log(`  Lessons created:          ${c.lessonsCreated}`);
  console.log(`  Redirect targets created: ${c.redirectTargetsCreated}`);
  console.log(`  Slug collisions:          ${c.slugCollisions}`);
  console.log(`  Ambiguous redirects:      ${c.ambiguousRedirects}`);
  console.log(`  Skipped:                  ${c.skipped}`);
  console.log(`  Conflicts:                ${c.conflicts}`);
  console.log(`  Failed:                   ${c.failed}`);
  if (report.ambiguousRedirects.length) console.log('\n  — Ambiguous canonical targets —\n' + report.ambiguousRedirects.map((r) => `    project ${r.projectId} — ${r.candidateCount} candidates`).join('\n'));
  if (report.skipped.length)   console.log('\n  — Skipped —\n' + report.skipped.map((s) => `    [${s.type}] ${s.id} — ${s.reason}`).join('\n'));
  if (report.conflicts.length) console.log('\n  — Conflicts —\n' + report.conflicts.map((x) => `    [${x.type}] ${x.id} — ${x.detail}`).join('\n'));
  if (report.failed.length)    console.log('\n  — Failed —\n' + report.failed.map((f) => `    ${f.ref} — ${f.error}`).join('\n'));
  if (report.mode === 'dry-run') console.log('\n  Dry run — no rows written. Re-run with --execute to apply.');
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const asJson = args.includes('--json');

  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  const sql = postgres(connectionString, { max: 2 });

  try {
    const report = await runBackfill(sql, { execute });
    printReport(report, asJson);
    if (report.counts.failed > 0) process.exitCode = 1;
  } catch (err) {
    logger.error({ err }, 'Backfill failed');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('030_courses.ts') || process.argv[1]?.endsWith('030_courses.js');
if (invokedDirectly) void main();
