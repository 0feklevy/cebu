/**
 * types-003 — `CourseViewSchema` and `LessonViewSchema` were written to validate exactly this
 * boundary and were never called. `getPage()` did `(await res.json()) as T`, so the one place the
 * schemas were for was the one place they were absent: two full zod schemas sitting unused beside
 * an unchecked cast.
 *
 * This is not a hypothetical boundary. These are the PUBLIC `/c/` pages: the response is rendered
 * server-side, its `seo` block becomes the page metadata and its `jsonLd` becomes structured data
 * Google reads. A cast that lies here does not throw in a test — it emits a page with `undefined`
 * in a meta tag, or crashes the SSR render on `view.seo.title` and serves a 500 to a crawler.
 *
 * The decision this pins: a body that does not satisfy the schema is treated as NOT FOUND, not as
 * a course. Rendering half a page is worse than 404-ing, and the caller already has a not-found
 * branch. The schemas are non-strict, so a server that ADDS a field still parses — the tests below
 * pin that too, because a validator that breaks on additive change would just be reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `courseApi` is a server-only module; the marker package throws if imported anywhere else.
vi.mock('server-only', () => ({}));

import {
  getCoursePage, getLessonPage, getCourseSitemap, resolveLegacyProjectRedirect,
} from './courseApi';
import type { CourseView, LessonView } from 'shared/src/types/course-view';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const responds = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const SEO = {
  title: 'Pendulums', description: 'A course', canonicalUrl: 'https://x/c/pendulums',
  ogTitle: 'Pendulums', ogDescription: 'A course', ogImageUrl: 'https://x/og.png',
  language: 'en', indexable: true, robots: 'index, follow', keywords: null,
};

const COURSE: CourseView = {
  slug: 'pendulums', kind: 'single', title: 'Pendulums', subtitle: null,
  description: 'A course', coverImageUrl: null, language: 'en',
  instructor: { name: 'A', bio: null, avatarUrl: null },
  learningOutcomes: ['swing'],
  lessons: [{ slug: 'l1', title: 'One', summary: null, position: 1, durationSec: 60, thumbnailUrl: null, href: '/c/pendulums/l1' }],
  breadcrumbs: [{ name: 'Home', url: 'https://x' }],
  canonicalUrl: 'https://x/c/pendulums', ogImageUrl: 'https://x/og.png',
  seo: SEO, jsonLd: [{ '@type': 'Course' }], publishState: 'published',
};

const LESSON: LessonView = {
  courseSlug: 'pendulums', courseTitle: 'Pendulums', courseHref: '/c/pendulums',
  slug: 'l1', title: 'One', summary: null, language: 'en', position: 1,
  transcriptText: null, transcriptSource: null, topics: null, learningOutcomes: [],
  interactiveElements: [], chapters: [{ label: 'Intro', startSec: 0, endSec: 10 }],
  prev: null, next: { slug: 'l2', title: 'Two', href: '/c/pendulums/l2' },
  breadcrumbs: [{ name: 'Home', url: 'https://x' }],
  canonicalUrl: 'https://x/c/pendulums/l1', ogImageUrl: 'https://x/og.png',
  seo: SEO, jsonLd: [], player: { segments: [] },
};

describe('getCoursePage validates the body it renders', () => {
  it('returns a well-formed course', async () => {
    fetchMock.mockResolvedValue(responds(200, COURSE));
    await expect(getCoursePage('pendulums')).resolves.toEqual({ status: 'ok', data: COURSE });
  });

  it('survives a server that adds a field — additive change must not 404 a live course', async () => {
    fetchMock.mockResolvedValue(responds(200, { ...COURSE, newFieldFromANewerBackend: 42 }));
    const result = await getCoursePage('pendulums');
    expect(result.status).toBe('ok');
  });

  const REJECTED: Array<[string, unknown]> = [
    ['a body with no seo block (SSR reads seo.title)', (() => { const c = { ...COURSE }; delete (c as Partial<CourseView>).seo; return c; })()],
    ['a body whose lessons are not an array', { ...COURSE, lessons: null }],
    ['a body whose seo.indexable is a string', { ...COURSE, seo: { ...SEO, indexable: 'true' } }],
    ['a body with an unknown publishState', { ...COURSE, publishState: 'halfway' }],
    ['an error envelope served with 200', { message: 'Course not found' }],
    ['a bare string', 'not json'],
    ['null', null],
  ];

  for (const [name, body] of REJECTED) {
    it(`treats ${name} as not_found rather than a course`, async () => {
      fetchMock.mockResolvedValue(responds(200, body));
      await expect(getCoursePage('pendulums')).resolves.toEqual({ status: 'not_found' });
    });
  }

  it('still maps 410 to gone and 409 to a redirect', async () => {
    fetchMock.mockResolvedValueOnce(responds(410, {}));
    await expect(getCoursePage('old')).resolves.toEqual({ status: 'gone' });

    fetchMock.mockResolvedValueOnce(responds(409, { redirectUrl: '/c/new' }));
    await expect(getCoursePage('old')).resolves.toEqual({ status: 'redirect', redirectUrl: '/c/new' });

    fetchMock.mockResolvedValueOnce(responds(409, {}));
    await expect(getCoursePage('old')).resolves.toEqual({ status: 'not_found' });
  });
});

describe('getLessonPage validates the body it renders', () => {
  it('returns a well-formed lesson', async () => {
    fetchMock.mockResolvedValue(responds(200, LESSON));
    await expect(getLessonPage('pendulums', 'l1')).resolves.toEqual({ status: 'ok', data: LESSON });
  });

  it('treats a lesson missing its chapters array as not_found', async () => {
    const broken = { ...LESSON };
    delete (broken as Partial<LessonView>).chapters;
    fetchMock.mockResolvedValue(responds(200, broken));
    await expect(getLessonPage('pendulums', 'l1')).resolves.toEqual({ status: 'not_found' });
  });

  it('accepts a lesson whose player payload is any shape — the viewer owns it', async () => {
    fetchMock.mockResolvedValue(responds(200, { ...LESSON, player: null }));
    expect((await getLessonPage('pendulums', 'l1')).status).toBe('ok');
  });
});

describe('the endpoints with no schema of their own are unchanged', () => {
  it('a failed sitemap fetch is still an empty list, not a throw', async () => {
    fetchMock.mockResolvedValue(responds(500, {}));
    await expect(getCourseSitemap()).resolves.toEqual([]);
  });

  it('a legacy redirect still resolves to its url', async () => {
    fetchMock.mockResolvedValue(responds(200, { redirectUrl: '/c/new' }));
    await expect(resolveLegacyProjectRedirect('tok')).resolves.toBe('/c/new');
  });
});
