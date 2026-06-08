/**
 * Integration tests for the DB-bound publishing services, run against a real
 * Postgres engine (PGlite) with the app's `db` mocked to a PGlite-backed Drizzle
 * instance. Covers publication-state → view/result, no-private-field exposure,
 * sitemap inclusion/exclusion and legacy redirect runtime verification — without
 * writing to any shared database.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { createTestDb, type TestDb } from '../../../db/__tests__/pgliteHelper.js';
import * as schema from '../../../db/schema.js';

// Mock the app db with a proxy that delegates to the per-test PGlite Drizzle instance.
const holder = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof drizzle> }));
vi.mock('../../../db/index.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => (holder.current as Record<string | symbol, unknown>)[prop] }),
}));

import { PublicCourseQueryService } from '../PublicCourseQueryService.js';
import { LegacyRedirectResolver } from '../LegacyRedirectResolver.js';
import { SitemapService } from '../SitemapService.js';

beforeAll(() => { process.env.PUBLIC_SITE_URL = 'https://learn.example.com'; });

let dbt: TestDb;
let orgId: string;

async function addLesson(courseId: string, projectId: string, position: number, slug: string) {
  await dbt.pg.query(`INSERT INTO course_lessons (course_id, project_id, position, slug) VALUES ($1,$2,$3,$4)`, [courseId, projectId, position, slug]);
}

beforeEach(async () => {
  dbt = await createTestDb();
  holder.current = drizzle(dbt.pg, { schema });
  orgId = await dbt.seedOrg();
});
afterEach(async () => { await dbt.close(); });

describe('PublicCourseQueryService.getCourse — publication state', () => {
  it('published → ok with indexable SEO, JSON-LD and lessons', async () => {
    const courseId = await dbt.insertCourse(orgId, { slug: 'algebra', title: 'Algebra', publish_state: 'published', published_at: '2025-01-01T00:00:00Z', description: 'Real desc' });
    const p1 = await dbt.seedProject(orgId, { title: 'Vectors' });
    await addLesson(courseId, p1, 0, 'vectors');

    const res = await PublicCourseQueryService.getCourse('algebra');
    expect(res.status).toBe('ok');
    const c = res.course!;
    expect(c.title).toBe('Algebra');
    expect(c.seo.robots).toBe('index, follow');
    expect(c.canonicalUrl).toBe('https://learn.example.com/c/algebra');
    expect(c.lessons.map((l) => l.href)).toEqual(['/c/algebra/vectors']);
    expect(c.jsonLd.some((ld) => ld['@type'] === 'Course')).toBe(true);
    expect(c.jsonLd.some((ld) => ld['@type'] === 'BreadcrumbList')).toBe(true);
    // No private fields leaked.
    const json = JSON.stringify(c);
    expect(json).not.toMatch(/org_id|share_token|storage_key|legacy_/);
  });

  it('unlisted → ok but noindex', async () => {
    await dbt.insertCourse(orgId, { slug: 'secret', title: 'Secret', publish_state: 'unlisted' });
    const res = await PublicCourseQueryService.getCourse('secret');
    expect(res.status).toBe('ok');
    expect(res.course!.seo.robots).toBe('noindex, nofollow');
  });

  it('draft → not_found', async () => {
    await dbt.insertCourse(orgId, { slug: 'wip', publish_state: 'draft' });
    expect((await PublicCourseQueryService.getCourse('wip')).status).toBe('not_found');
  });

  it('archived permanent → gone; temporary → not_found; redirect → redirect', async () => {
    await dbt.insertCourse(orgId, { slug: 'gone', publish_state: 'archived', archive_disposition: 'permanent', archived_at: '2025-01-01T00:00:00Z' });
    await dbt.insertCourse(orgId, { slug: 'temp', publish_state: 'archived', archive_disposition: 'temporary', archived_at: '2025-01-01T00:00:00Z' });
    await dbt.insertCourse(orgId, { slug: 'moved', publish_state: 'archived', archive_disposition: 'redirect', archived_at: '2025-01-01T00:00:00Z', archived_replacement_url: 'https://learn.example.com/c/new' });
    expect((await PublicCourseQueryService.getCourse('gone')).status).toBe('gone');
    expect((await PublicCourseQueryService.getCourse('temp')).status).toBe('not_found');
    const r = await PublicCourseQueryService.getCourse('moved');
    expect(r.status).toBe('redirect');
    expect(r.redirectUrl).toBe('https://learn.example.com/c/new');
  });
});

describe('SitemapService.courseEntries — inclusion/exclusion', () => {
  it('includes only published + indexable courses', async () => {
    await dbt.insertCourse(orgId, { slug: 'pub', publish_state: 'published', published_at: '2025-01-01T00:00:00Z', indexable: true });
    await dbt.insertCourse(orgId, { slug: 'pub-noindex', publish_state: 'published', published_at: '2025-01-01T00:00:00Z', indexable: false });
    await dbt.insertCourse(orgId, { slug: 'unlisted', publish_state: 'unlisted' });
    await dbt.insertCourse(orgId, { slug: 'draft', publish_state: 'draft' });
    const entries = await SitemapService.courseEntries();
    expect(entries.map((e) => e.loc)).toEqual(['https://learn.example.com/c/pub']);
  });
});

describe('LegacyRedirectResolver — runtime verification', () => {
  async function setRedirectTarget(projectId: string, lessonId: string, ambiguous = false) {
    await dbt.pg.query(`INSERT INTO project_redirect_targets (project_id, course_lesson_id, is_ambiguous) VALUES ($1,$2,$3)`, [projectId, lessonId, ambiguous]);
  }

  it('redirects to the canonical lesson when target is published + indexable', async () => {
    const courseId = await dbt.insertCourse(orgId, { slug: 'pub', publish_state: 'published', published_at: '2025-01-01T00:00:00Z' });
    const proj = await dbt.seedProject(orgId, { title: 'P', shareToken: 'tok' });
    await addLesson(courseId, proj, 0, 'lesson-1');
    const lesson = (await dbt.pg.query<{ id: string }>(`SELECT id FROM course_lessons WHERE course_id=$1`, [courseId])).rows[0];
    await setRedirectTarget(proj, lesson.id);
    expect(await LegacyRedirectResolver.resolveProject('tok')).toBe('https://learn.example.com/c/pub/lesson-1');
  });

  it('does not redirect when the target course is a draft', async () => {
    const courseId = await dbt.insertCourse(orgId, { slug: 'draft', publish_state: 'draft' });
    const proj = await dbt.seedProject(orgId, { title: 'P', shareToken: 'tok2' });
    await addLesson(courseId, proj, 0, 'l');
    const lesson = (await dbt.pg.query<{ id: string }>(`SELECT id FROM course_lessons WHERE course_id=$1`, [courseId])).rows[0];
    await setRedirectTarget(proj, lesson.id);
    expect(await LegacyRedirectResolver.resolveProject('tok2')).toBeNull();
  });

  it('does not redirect when there is no redirect target', async () => {
    await dbt.seedProject(orgId, { title: 'P', shareToken: 'tok3' });
    expect(await LegacyRedirectResolver.resolveProject('tok3')).toBeNull();
  });

  it('does not redirect an unknown token', async () => {
    expect(await LegacyRedirectResolver.resolveProject('nope')).toBeNull();
  });

  it('playlist redirect only when its course is published + indexable', async () => {
    const playlistId = (await dbt.pg.query<{ id: string }>(`INSERT INTO playlists (org_id, title, share_token) VALUES ($1,'PL','pltok') RETURNING id`, [orgId])).rows[0].id;
    await dbt.insertCourse(orgId, { slug: 'pl-course', publish_state: 'published', published_at: '2025-01-01T00:00:00Z', legacy_playlist_id: playlistId });
    expect(await LegacyRedirectResolver.resolvePlaylist('pltok')).toBe('https://learn.example.com/c/pl-course');
  });

  it('does not redirect a playlist whose course is unpublished', async () => {
    const playlistId = (await dbt.pg.query<{ id: string }>(`INSERT INTO playlists (org_id, title, share_token) VALUES ($1,'PL2','pltok2') RETURNING id`, [orgId])).rows[0].id;
    await dbt.insertCourse(orgId, { slug: 'pl-draft', publish_state: 'draft', legacy_playlist_id: playlistId });
    expect(await LegacyRedirectResolver.resolvePlaylist('pltok2')).toBeNull();
  });
});
