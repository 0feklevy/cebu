/**
 * Phase 2 validation fixtures — ISOLATED, clearly-marked test data in a dedicated
 * test organization. NOT the legacy backfill. Every created id is recorded to
 * FIXTURES_FILE so `cleanup` can guarantee removal.
 *
 *   pnpm --filter backend-api exec tsx --env-file=../.env src/scripts/phase2-fixtures.ts create
 *   pnpm --filter backend-api exec tsx --env-file=../.env src/scripts/phase2-fixtures.ts cleanup
 *
 * All names/slugs are prefixed `p2val` + a run nonce so they cannot collide with
 * real data. Referenced (not created) real projects are recorded separately and
 * NEVER deleted by cleanup.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { db } from '../db/index.js';
import { orgs, projects, courses, course_lessons, project_redirect_targets, video_files } from '../db/schema.js';
import { eq, and, isNotNull, inArray } from 'drizzle-orm';
import { jsonbStringArray } from '../db/jsonb.js';

const FIXTURES_FILE = '/tmp/phase2-fixtures.json';
const SITE = (process.env.PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

interface Manifest {
  nonce: string;
  orgId: string;
  createdProjectIds: string[];
  referencedProjectIds: string[];   // real projects referenced read-only — never deleted
  courseIds: string[];
  fixtures: Record<string, unknown>;
}

async function newProject(orgId: string, opts: { title?: string; topic?: string; shareToken?: string } = {}): Promise<string> {
  const [row] = await db.insert(projects).values({
    org_id: orgId, title: opts.title ?? 'p2val project', topic: opts.topic ?? null,
    share_token: opts.shareToken ?? null,
    share_enabled_at: opts.shareToken ? new Date() : null,
  }).returning({ id: projects.id });
  return row.id;
}

async function newCourse(orgId: string, v: Record<string, unknown>): Promise<string> {
  const [row] = await db.insert(courses).values({ org_id: orgId, ...v } as never).returning({ id: courses.id });
  return row.id;
}

async function addLesson(courseId: string, projectId: string, position: number, slug: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db.insert(course_lessons).values({ course_id: courseId, project_id: projectId, position, slug, ...extra } as never).returning({ id: course_lessons.id });
  return row.id;
}

async function create(): Promise<void> {
  const nonce = randomBytes(3).toString('hex');
  const p = (s: string) => `p2val-${s}-${nonce}`;
  const [org] = await db.insert(orgs).values({ name: `[P2VAL ${nonce}] test org` }).returning({ id: orgs.id });
  const orgId = org.id;

  const m: Manifest = { nonce, orgId, createdProjectIds: [], referencedProjectIds: [], courseIds: [], fixtures: {} };
  const track = (pid: string) => { m.createdProjectIds.push(pid); return pid; };
  const trackCourse = (cid: string) => { m.courseIds.push(cid); return cid; };

  // 1. single-lesson published
  {
    const proj = track(await newProject(orgId, { title: 'P2VAL Single Vectors', topic: 'Vectors lesson topic.' }));
    const slug = p('single');
    const cid = trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Single Course', description: 'A single-lesson published course for validation.', publish_state: 'published', published_at: new Date(), kind: 'single', learning_outcomes: jsonbStringArray(['Understand vectors', 'Add vectors']) }));
    await addLesson(cid, proj, 0, 'vectors', { summary: 'Intro to vectors.' });
    m.fixtures.single = { slug, lessonSlug: 'vectors' };
  }

  // 2. multi-lesson published
  {
    const slug = p('multi');
    const cid = trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Multi Course', description: 'A multi-lesson published course.', publish_state: 'published', published_at: new Date(), kind: 'playlist' }));
    const lessonSlugs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const proj = track(await newProject(orgId, { title: `P2VAL Multi L${i + 1}` }));
      const ls = `lesson-${i + 1}`;
      await addLesson(cid, proj, i, ls, { summary: `Summary of lesson ${i + 1}.` });
      lessonSlugs.push(ls);
    }
    m.fixtures.multi = { slug, lessonSlugs };
  }

  // 3. project reused in two courses
  {
    const shared = track(await newProject(orgId, { title: 'P2VAL Shared Project' }));
    const slugA = p('reuse-a'); const slugB = p('reuse-b');
    const a = trackCourse(await newCourse(orgId, { slug: slugA, title: 'P2VAL Reuse A', publish_state: 'published', published_at: new Date() }));
    const b = trackCourse(await newCourse(orgId, { slug: slugB, title: 'P2VAL Reuse B', publish_state: 'published', published_at: new Date() }));
    await addLesson(a, shared, 0, 'shared-lesson');
    await addLesson(b, shared, 0, 'shared-lesson');
    m.fixtures.reuse = { slugA, slugB, lessonSlug: 'shared-lesson', sharedProjectId: shared };
  }

  // 4. unlisted course
  {
    const proj = track(await newProject(orgId, { title: 'P2VAL Unlisted L' }));
    const slug = p('unlisted');
    const cid = trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Unlisted Course', description: 'Should be noindex and excluded from sitemaps.', publish_state: 'unlisted' }));
    await addLesson(cid, proj, 0, 'hidden-lesson');
    m.fixtures.unlisted = { slug, lessonSlug: 'hidden-lesson' };
  }

  // 5. permanently archived
  {
    const slug = p('archived-perm');
    trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Archived Permanent', publish_state: 'archived', archive_disposition: 'permanent', archived_at: new Date() }));
    m.fixtures.archivedPermanent = { slug };
  }

  // 6. archived redirect (→ the single course, a valid published platform destination)
  {
    const dest = `${SITE}/c/${m.fixtures.single ? (m.fixtures.single as { slug: string }).slug : p('single')}`;
    const slug = p('archived-redirect');
    trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Archived Redirect', publish_state: 'archived', archive_disposition: 'redirect', archived_at: new Date(), archived_replacement_url: dest }));
    m.fixtures.archivedRedirect = { slug, dest };
  }

  // 7. Hebrew course with explicit author slug
  {
    const proj = track(await newProject(orgId, { title: 'שיעור עברית' }));
    const slug = p('hebrew');   // explicit ASCII author slug despite Hebrew title
    const cid = trackCourse(await newCourse(orgId, { slug, title: 'מבוא לפיזיקה קוונטית', description: 'קורס בעברית לאימות.', publish_state: 'published', published_at: new Date(), language: 'he' }));
    await addLesson(cid, proj, 0, 'shiur-1', { title: 'שיעור ראשון' });
    m.fixtures.hebrew = { slug, lessonSlug: 'shiur-1' };
  }

  // 8. legacy project redirect target (valid)
  {
    const token = `p2val-tok-${nonce}`;
    const proj = track(await newProject(orgId, { title: 'P2VAL Legacy Target', shareToken: token }));
    const slug = p('legacy');
    const cid = trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Legacy Course', publish_state: 'published', published_at: new Date() }));
    const lessonId = await addLesson(cid, proj, 0, 'legacy-lesson');
    await db.insert(project_redirect_targets).values({ project_id: proj, course_lesson_id: lessonId });
    m.fixtures.legacyValid = { token, slug, lessonSlug: 'legacy-lesson', projectId: proj };
  }

  // 9. legacy route WITHOUT a valid redirect target (token exists, no target row)
  {
    const token = `p2val-notok-${nonce}`;
    const proj = track(await newProject(orgId, { title: 'P2VAL Legacy NoTarget', shareToken: token }));
    m.fixtures.legacyNoTarget = { token, projectId: proj };
  }

  // 10. (optional) real-media unlisted course — reference an already-public real project
  //     read-only so we can validate the interactive renderer on a /c lesson page
  //     without changing any real content's public exposure.
  {
    const real = await db.query.video_files.findFirst({
      where: and(isNotNull(video_files.hls_master_key), eq(video_files.hls_status, 'ready')),
      columns: { project_id: true },
    });
    if (real?.project_id) {
      const realProj = await db.query.projects.findFirst({ where: eq(projects.id, real.project_id), columns: { id: true, share_token: true } });
      if (realProj?.share_token) {
        m.referencedProjectIds.push(realProj.id);
        const slug = p('media');
        const cid = trackCourse(await newCourse(orgId, { slug, title: 'P2VAL Media Course', publish_state: 'unlisted' }));
        await addLesson(cid, realProj.id, 0, 'media-lesson');
        m.fixtures.media = { slug, lessonSlug: 'media-lesson', referencedProjectId: realProj.id };
      }
    }
  }

  writeFileSync(FIXTURES_FILE, JSON.stringify(m, null, 2));
  console.log(JSON.stringify(m, null, 2));
  console.log(`\nWrote manifest → ${FIXTURES_FILE}`);
}

async function cleanup(): Promise<void> {
  if (!existsSync(FIXTURES_FILE)) { console.log('No manifest; nothing to clean.'); return; }
  const m: Manifest = JSON.parse(readFileSync(FIXTURES_FILE, 'utf-8'));
  // Deleting courses cascades course_lessons and (via FK) project_redirect_targets.
  if (m.courseIds.length) await db.delete(courses).where(inArray(courses.id, m.courseIds));
  // Defensive: remove any redirect targets for created projects.
  if (m.createdProjectIds.length) await db.delete(project_redirect_targets).where(inArray(project_redirect_targets.project_id, m.createdProjectIds));
  if (m.createdProjectIds.length) await db.delete(projects).where(inArray(projects.id, m.createdProjectIds));
  await db.delete(orgs).where(eq(orgs.id, m.orgId));
  console.log(`Deleted: ${m.courseIds.length} courses, ${m.createdProjectIds.length} projects, 1 org. Referenced (untouched): ${m.referencedProjectIds.join(', ') || 'none'}`);
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === 'create') await create();
    else if (cmd === 'cleanup') await cleanup();
    else { console.error('usage: phase2-fixtures.ts create|cleanup'); process.exitCode = 1; }
  } catch (err) {
    console.error('FIXTURE ERROR:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
})();
