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
