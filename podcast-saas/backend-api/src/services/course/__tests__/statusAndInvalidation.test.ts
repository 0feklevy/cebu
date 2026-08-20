import { describe, it, expect } from 'vitest';
import { resolveCourseStatus } from '../PublicCourseQueryService.js';
import { computeInvalidationTargets, computeLibraryInvalidationTargets } from '../PublishingInvalidationService.js';
import { vttToPlainText } from '../transcript.js';
import type { Course } from '../../../db/schema.js';

function course(over: Partial<Course>): Course {
  return {
    publish_state: 'published', archive_disposition: null, archived_replacement_url: null,
    ...over,
  } as Course;
}

describe('resolveCourseStatus — publication-state → HTTP outcome', () => {
  it('published → ok', () => expect(resolveCourseStatus(course({ publish_state: 'published' })).status).toBe('ok'));
  it('unlisted → ok (page renders, noindex handled by SEO)', () => expect(resolveCourseStatus(course({ publish_state: 'unlisted' })).status).toBe('ok'));
  it('draft → not_found', () => expect(resolveCourseStatus(course({ publish_state: 'draft' })).status).toBe('not_found'));
  it('archived temporary → not_found (404)', () =>
    expect(resolveCourseStatus(course({ publish_state: 'archived', archive_disposition: 'temporary' })).status).toBe('not_found'));
  it('archived permanent → gone (410)', () =>
    expect(resolveCourseStatus(course({ publish_state: 'archived', archive_disposition: 'permanent' })).status).toBe('gone'));
  it('archived redirect with valid URL → redirect', () => {
    const r = resolveCourseStatus(course({ publish_state: 'archived', archive_disposition: 'redirect', archived_replacement_url: 'https://x.com/c/new' }));
    expect(r.status).toBe('redirect');
    expect(r.redirectUrl).toBe('https://x.com/c/new');
  });
  it('archived redirect with invalid URL → not_found (safe fallback)', () =>
    expect(resolveCourseStatus(course({ publish_state: 'archived', archive_disposition: 'redirect', archived_replacement_url: '/relative' })).status).toBe('not_found'));
});

describe('computeInvalidationTargets', () => {
  it('covers course, lessons, OG, sitemaps and listing', () => {
    const t = computeInvalidationTargets({ type: 'course_changed', courseSlug: 'a', affectedLessonSlugs: ['l1', 'l2'] });
    expect(t.paths).toEqual(expect.arrayContaining([
      '/c/a', '/c/a/og', '/c/a/l1', '/c/a/l1/og', '/c/a/l2', '/c/a/l2/og',
      '/sitemap.xml', '/sitemap-courses.xml', '/sitemap-videos.xml', '/',
    ]));
    expect(t.tags).toContain('course:a');
  });
  it('includes the previous slug paths on a slug change', () => {
    const t = computeInvalidationTargets({ type: 'course_changed', courseSlug: 'new', affectedLessonSlugs: [], previousCourseSlug: 'old' });
    expect(t.paths).toEqual(expect.arrayContaining(['/c/new', '/c/old']));
  });
});

describe('computeLibraryInvalidationTargets — the library mini-site (065)', () => {
  it('purges the page and all four sub-routes plus /og, for the coded form', () => {
    const t = computeLibraryInvalidationTargets({ slug: 'chaos-abc' });
    expect(t.paths).toEqual(expect.arrayContaining([
      '/chaos-abc/library',
      '/chaos-abc/library/simulation', '/chaos-abc/library/images',
      '/chaos-abc/library/videos', '/chaos-abc/library/sounds', '/chaos-abc/library/og',
    ]));
    expect(t.tags).toEqual(expect.arrayContaining(['library-share', 'library-share:chaos-abc']));
  });

  it('purges BOTH slug forms when the clean permalink alias applies', () => {
    const t = computeLibraryInvalidationTargets({ slug: 'chaos-abc', cleanSlug: 'my-video' });
    expect(t.paths).toEqual(expect.arrayContaining(['/chaos-abc/library', '/my-video/library/images']));
    expect(t.tags).toContain('library-share:my-video');
    // Twelve paths, not six: a purge that covers only one form leaves the other serving a revoked
    // link until its own 60-second window expires.
    expect(t.paths).toHaveLength(12);
  });

  it('emits no clean-form paths when the project has no permalink', () => {
    const t = computeLibraryInvalidationTargets({ slug: 'chaos-abc', cleanSlug: null });
    expect(t.paths).toHaveLength(6);
  });
});

describe('vttToPlainText', () => {
  it('extracts cue text, dropping timing/index/tags', () => {
    const vtt = `WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<v Alice>Hello world\n\n2\n00:00:02.000 --> 00:00:04.000\nHello world\nSecond line`;
    expect(vttToPlainText(vtt)).toBe('Hello world Second line');
  });
  it('safe on empty input', () => expect(vttToPlainText('')).toBe(''));
});
