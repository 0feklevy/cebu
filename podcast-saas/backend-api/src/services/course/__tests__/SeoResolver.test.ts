import { describe, it, expect } from 'vitest';
import {
  resolveCourseSeo, resolveLessonSeo, effectiveIndexable, humanizeSlug, humanizeTitleFor,
  type CourseSeoInput, type LessonSeoInput,
} from '../SeoResolver.js';

const ctx = { canonicalUrl: 'https://x.com/c/s', ogImageUrl: 'https://x.com/c/s/og' };

function courseInput(over: Partial<CourseSeoInput> = {}): CourseSeoInput {
  return {
    slug: 'intro-to-x', publishState: 'published', title: 'Intro to X', subtitle: null, description: 'A real course.',
    language: 'en', indexable: true, seoTitle: null, seoDescription: null, ogTitle: null, ogDescription: null,
    ogImageOverride: null, ...over,
  };
}

describe('SeoResolver — course precedence', () => {
  it('prefers explicit override, then content', () => {
    expect(resolveCourseSeo(courseInput({ seoTitle: 'Override' }), ctx).title).toBe('Override');
    expect(resolveCourseSeo(courseInput({ seoTitle: null }), ctx).title).toBe('Intro to X');
  });

  it('falls back to a humanized slug (never a placeholder) when no title', () => {
    const seo = resolveCourseSeo(courseInput({ title: null, seoTitle: null }), ctx);
    expect(seo.title).toBe('Intro To X');
    expect(seo.title).not.toMatch(/untitled/i);
  });

  it('treats stored placeholders as empty', () => {
    const seo = resolveCourseSeo(courseInput({ title: 'Untitled Course', seoTitle: '  ' }), ctx);
    expect(seo.title).toBe('Intro To X'); // humanized slug, not "Untitled Course"
  });

  it('always returns a non-empty description', () => {
    const seo = resolveCourseSeo(courseInput({ description: null, subtitle: null }), ctx);
    expect(seo.description.length).toBeGreaterThan(0);
  });

  it('published + indexable → index, follow', () => {
    expect(resolveCourseSeo(courseInput({ publishState: 'published', indexable: true }), ctx).robots).toBe('index, follow');
  });

  it('unlisted → noindex, nofollow', () => {
    expect(resolveCourseSeo(courseInput({ publishState: 'unlisted' }), ctx).robots).toBe('noindex, nofollow');
  });

  it('published but indexable=false → noindex', () => {
    expect(resolveCourseSeo(courseInput({ indexable: false }), ctx).indexable).toBe(false);
  });
});

describe('SeoResolver — lesson precedence', () => {
  function lessonInput(over: Partial<LessonSeoInput> = {}): LessonSeoInput {
    return {
      publishState: 'published', courseIndexable: true, courseTitle: 'Course', courseLanguage: 'en', position: 0,
      seoTitle: null, seoDescription: null, ogTitle: null, ogDescription: null, ogImageOverride: null,
      lessonTitle: null, lessonSummary: null, lessonLanguage: null, lessonIndexable: null,
      projectTitle: null, projectTopic: null, ...over,
    };
  }
  it('override → lesson → project → course fallback', () => {
    expect(resolveLessonSeo(lessonInput({ seoTitle: 'O' }), ctx).title).toBe('O');
    expect(resolveLessonSeo(lessonInput({ lessonTitle: 'L' }), ctx).title).toBe('L');
    expect(resolveLessonSeo(lessonInput({ projectTitle: 'P' }), ctx).title).toBe('P');
    expect(resolveLessonSeo(lessonInput({ position: 2 }), ctx).title).toBe('Course — Lesson 3');
  });
  it('lesson inherits course language unless overridden', () => {
    expect(resolveLessonSeo(lessonInput({ courseLanguage: 'he' }), ctx).language).toBe('he');
    expect(resolveLessonSeo(lessonInput({ lessonLanguage: 'fr' }), ctx).language).toBe('fr');
  });
  it('lesson noindex when course is not published', () => {
    expect(resolveLessonSeo(lessonInput({ publishState: 'unlisted' }), ctx).indexable).toBe(false);
  });
  it('lesson can opt out of indexing even when course is indexable', () => {
    expect(resolveLessonSeo(lessonInput({ lessonIndexable: false }), ctx).indexable).toBe(false);
  });
});

describe('SeoResolver — helpers', () => {
  it('effectiveIndexable only for published', () => {
    expect(effectiveIndexable('published', true)).toBe(true);
    expect(effectiveIndexable('unlisted', true)).toBe(false);
    expect(effectiveIndexable('draft', true)).toBe(false);
    expect(effectiveIndexable('archived', true)).toBe(false);
    expect(effectiveIndexable('published', false)).toBe(false);
  });
  it('humanizeSlug strips prefix + title-cases', () => {
    expect(humanizeSlug('c-abc123')).toBe('Abc123');
    expect(humanizeSlug('intro-to-x')).toBe('Intro To X');
  });
  it('humanizeTitleFor never returns a placeholder', () => {
    expect(humanizeTitleFor('New Project', 'Real', 's')).toBe('Real');
    expect(humanizeTitleFor(null, null, 'my-slug')).toBe('My Slug');
  });
});
