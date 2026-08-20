/**
 * PublishingInvalidationService — the SINGLE place that decides what to revalidate
 * when course/lesson data changes. Controllers/repositories must call this with a
 * typed event rather than scattering revalidatePath calls.
 *
 * `computeInvalidationTargets` is pure and unit-tested. `dispatch` best-effort
 * POSTs the targets to the Next on-demand revalidation endpoint (client-web's
 * /api/revalidate); it no-ops when REVALIDATE_URL is unset (e.g. tests/local).
 */
import { logger } from '../../lib/logger.js';

export interface CourseChangeEvent {
  type: 'course_changed';
  courseSlug: string;
  /** Slugs of lessons whose pages are affected (ordering/content/SEO changes). */
  affectedLessonSlugs: string[];
  /** A previous slug, when the course slug changed (its old paths must be purged too). */
  previousCourseSlug?: string | null;
}

export interface InvalidationTargets {
  paths: string[];
  tags: string[];
}

/** Pure: map a domain event to every path/tag that must be revalidated. */
export function computeInvalidationTargets(event: CourseChangeEvent): InvalidationTargets {
  const slugs = [event.courseSlug, ...(event.previousCourseSlug ? [event.previousCourseSlug] : [])];
  const paths = new Set<string>();

  for (const slug of slugs) {
    paths.add(`/c/${slug}`);                 // course page
    paths.add(`/c/${slug}/og`);              // course OG image
    for (const lessonSlug of event.affectedLessonSlugs) {
      paths.add(`/c/${slug}/${lessonSlug}`);     // lesson page
      paths.add(`/c/${slug}/${lessonSlug}/og`);  // lesson OG image
    }
  }
  // Site-wide surfaces that list/aggregate courses.
  paths.add('/sitemap.xml');
  paths.add('/sitemap-courses.xml');
  paths.add('/sitemap-videos.xml');
  paths.add('/');                            // public discovery/listing

  return {
    paths: [...paths],
    tags: ['courses', `course:${event.courseSlug}`],
  };
}

/** Best-effort dispatch to the Next revalidation webhook. Never throws. */
export async function dispatchInvalidation(event: CourseChangeEvent): Promise<void> {
  const url = process.env.REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!url) return; // not configured (tests/local) → no-op
  const targets = computeInvalidationTargets(event);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-revalidate-secret': secret } : {}) },
      body: JSON.stringify(targets),
    });
  } catch (err) {
    logger.warn({ err, courseSlug: event.courseSlug }, 'publishing invalidation dispatch failed');
  }
}

// ── Library share (migration 065) ─────────────────────────────────────────────

export interface LibraryShareChangeEvent {
  /** The share's own slug — the coded form, always present. */
  slug: string;
  /** The `/{permalink}/library` alias, when the project is public with a permalink. */
  cleanSlug?: string | null;
}

/**
 * Pure: every ISR path the library mini-site occupies, for BOTH URL forms.
 *
 * This function is the whole reason a revoked link stops being served. `dispatchInvalidation` is
 * the only thing in the repository that feeds `POST /api/revalidate`, so a cached route missing
 * from this list is a route that is never purged — it simply expires on its own 60-second timer.
 * The sub-routes are separate ISR entries, not tabs, so each one has to be named.
 *
 * `/og` is listed although Phase 1 does not serve it: purging a path that does not exist is a
 * no-op, and the alternative is a Phase-2 route that ships already stale.
 */
export function computeLibraryInvalidationTargets(event: LibraryShareChangeEvent): InvalidationTargets {
  const slugs = [event.slug, ...(event.cleanSlug ? [event.cleanSlug] : [])];
  const paths = new Set<string>();
  const tags = new Set<string>(['library-share']);

  for (const slug of slugs) {
    paths.add(`/${slug}/library`);
    for (const seg of ['simulation', 'images', 'videos', 'sounds', 'og']) {
      paths.add(`/${slug}/library/${seg}`);
    }
    tags.add(`library-share:${slug}`);
  }

  return { paths: [...paths], tags: [...tags] };
}

/** Best-effort dispatch of a library-share purge. Never throws; no-ops without REVALIDATE_URL. */
export async function dispatchLibraryInvalidation(event: LibraryShareChangeEvent): Promise<void> {
  const url = process.env.REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!url) return; // not configured (tests/local) → no-op
  const targets = computeLibraryInvalidationTargets(event);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-revalidate-secret': secret } : {}) },
      body: JSON.stringify(targets),
    });
  } catch (err) {
    logger.warn({ err, slug: event.slug }, 'library share invalidation dispatch failed');
  }
}
