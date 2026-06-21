/**
 * SeoResolver — pure, deterministic effective-SEO resolution. No DB access.
 *
 * Precedence:
 *   course → explicit override → course content → safe branded fallback
 *   lesson → explicit override → lesson content → project content → course + fallback
 *
 * Never returns a placeholder (e.g. "Untitled Course", "New Project",
 * "Lorem ipsum"); such stored values are treated as empty and fall through.
 */
import type { EffectiveSeo, PublishState } from 'shared';

export function brandName(): string {
  return process.env.PUBLIC_BRAND_NAME ?? 'Interactive Video Studio';
}

const PLACEHOLDER_RE = /^\s*(untitled( course| lesson| project)?|new project|lorem ipsum.*|undefined|null)\s*$/i;

/** First value that is a real, non-placeholder, non-empty string. */
function firstReal(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0 && !PLACEHOLDER_RE.test(t)) return t;
    }
  }
  return null;
}

/** Title-case a slug as a deterministic last-resort label (never a placeholder word). */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/^[cl]-/, '').split('-').filter(Boolean);
  if (words.length === 0) return brandName();
  return words.map((w) => (/^[a-z0-9]/i.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** A real display title from (explicit title, fallback content, slug) — never a placeholder. */
export function humanizeTitleFor(
  title: string | null | undefined,
  fallbackContent: string | null | undefined,
  slug: string,
): string {
  return firstReal(title, fallbackContent) ?? humanizeSlug(slug);
}

/** Clamp a meta description to a sane length without cutting mid-word. */
function clampDescription(s: string, max = 320): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

function robotsFor(indexable: boolean): string {
  return indexable ? 'index, follow' : 'noindex, nofollow';
}

/**
 * Effective indexability: only a published course can be indexed, and only when
 * its (effective) indexable flag is true. Unlisted/draft/archived are never indexable.
 */
export function effectiveIndexable(publishState: PublishState, indexableFlag: boolean): boolean {
  return publishState === 'published' && indexableFlag === true;
}

export interface CourseSeoInput {
  slug: string;
  publishState: PublishState;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  language: string;
  indexable: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageOverride: string | null;
}

export function resolveCourseSeo(
  c: CourseSeoInput,
  ctx: { canonicalUrl: string; ogImageUrl: string },
): EffectiveSeo {
  const title = firstReal(c.seoTitle, c.title) ?? humanizeSlug(c.slug);
  const description = clampDescription(
    firstReal(c.seoDescription, c.description, c.subtitle) ?? `${title} — an interactive course on ${brandName()}.`,
  );
  const indexable = effectiveIndexable(c.publishState, c.indexable);
  return {
    title,
    description,
    canonicalUrl: ctx.canonicalUrl,
    ogTitle: firstReal(c.ogTitle, c.seoTitle, c.title) ?? title,
    ogDescription: firstReal(c.ogDescription, c.seoDescription, c.description) ?? description,
    ogImageUrl: firstReal(c.ogImageOverride) ?? ctx.ogImageUrl,
    language: c.language,
    indexable,
    robots: robotsFor(indexable),
  };
}

export interface LessonSeoInput {
  publishState: PublishState;   // the COURSE publish state
  courseIndexable: boolean;
  courseTitle: string;
  courseLanguage: string;
  position: number;
  // lesson overrides + content
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageOverride: string | null;
  lessonTitle: string | null;
  lessonSummary: string | null;
  lessonLanguage: string | null;
  lessonIndexable: boolean | null;
  // underlying project content
  projectTitle: string | null;
  projectTopic: string | null;
  // transcript-derived SEO (generated from the video's captions)
  projectSeoDescription?: string | null;
  projectKeywords?: string | null;
}

export function resolveLessonSeo(
  l: LessonSeoInput,
  ctx: { canonicalUrl: string; ogImageUrl: string },
): EffectiveSeo {
  const title =
    firstReal(l.seoTitle, l.lessonTitle, l.projectTitle) ?? `${l.courseTitle} — Lesson ${l.position + 1}`;
  const description = clampDescription(
    // Author override → lesson summary → transcript-derived description → topic → fallback.
    firstReal(l.seoDescription, l.lessonSummary, l.projectSeoDescription, l.projectTopic) ??
      `A lesson from ${l.courseTitle} on ${brandName()}.`,
  );
  // Lesson inherits course indexability unless it explicitly overrides to false.
  const lessonIndexableFlag = l.lessonIndexable === null ? l.courseIndexable : l.lessonIndexable;
  const indexable = effectiveIndexable(l.publishState, l.courseIndexable && lessonIndexableFlag);
  return {
    title,
    description,
    canonicalUrl: ctx.canonicalUrl,
    ogTitle: firstReal(l.ogTitle, l.seoTitle, l.lessonTitle, l.projectTitle) ?? title,
    ogDescription: firstReal(l.ogDescription, l.seoDescription, l.lessonSummary) ?? description,
    ogImageUrl: firstReal(l.ogImageOverride) ?? ctx.ogImageUrl,
    language: firstReal(l.lessonLanguage) ?? l.courseLanguage,
    indexable,
    robots: robotsFor(indexable),
    keywords: firstReal(l.projectKeywords),
  };
}
