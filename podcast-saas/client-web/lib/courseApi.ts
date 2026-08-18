/**
 * Server-side data access for the public /c/ pages, sitemaps and legacy redirects.
 * Runs only in Server Components / route handlers (never shipped to the client).
 * All SEO/canonical/JSON-LD resolution happens in the backend; this just fetches
 * the render-ready view models over HTTP with ISR caching.
 */
import 'server-only';
import type { z } from 'zod';
import {
  CourseViewSchema, LessonViewSchema,
} from 'shared/src/types/course-view';
import type {
  CourseView, LessonView, SitemapUrlEntry, VideoSitemapEntry,
} from 'shared/src/types/course-view';

const BACKEND =
  process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

const REVALIDATE_SECONDS = 300; // ISR; on-publish invalidation purges sooner

export type PageResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found' }
  | { status: 'gone' }
  | { status: 'redirect'; redirectUrl: string };

/**
 * `CourseViewSchema` / `LessonViewSchema` exist to validate exactly this boundary and were never
 * called — this function cast instead (types-003). These are the PUBLIC `/c/` pages: the body is
 * rendered server-side, `seo` becomes the page metadata and `jsonLd` becomes the structured data
 * a crawler reads, so a body that does not match produced `undefined` in a meta tag or a 500 from
 * the SSR render rather than anything a reader could act on.
 *
 * A body that fails to parse is NOT_FOUND, not a course: the caller already has that branch, and
 * a 404 is a better answer than half a page. The schemas are non-strict, so a backend that ADDS a
 * field still parses — a validator that broke on additive change would simply be reverted.
 */
async function getPage<T>(path: string, tags: string[], schema: z.ZodType<T>): Promise<PageResult<T>> {
  const res = await fetch(`${BACKEND}${path}`, {
    next: { revalidate: REVALIDATE_SECONDS, tags },
  });
  if (res.status === 200) {
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (parsed.success) return { status: 'ok', data: parsed.data };
    // Loud, because this is drift between two things that are supposed to be the same contract —
    // and silently serving a 404 for a course that IS published would otherwise be invisible.
    console.error(`[courseApi] ${path} did not match its schema:`, parsed.error.issues.slice(0, 5));
    return { status: 'not_found' };
  }
  if (res.status === 410) return { status: 'gone' };
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { redirectUrl?: string };
    return body.redirectUrl ? { status: 'redirect', redirectUrl: body.redirectUrl } : { status: 'not_found' };
  }
  return { status: 'not_found' };
}

export function getCoursePage(slug: string): Promise<PageResult<CourseView>> {
  return getPage(`/api/v1/public/courses/${encodeURIComponent(slug)}`, ['courses', `course:${slug}`], CourseViewSchema);
}

export function getLessonPage(slug: string, lessonSlug: string): Promise<PageResult<LessonView>> {
  return getPage(
    `/api/v1/public/courses/${encodeURIComponent(slug)}/lessons/${encodeURIComponent(lessonSlug)}`,
    ['courses', `course:${slug}`],
    LessonViewSchema,
  );
}

// Sitemaps are served by force-dynamic routes and must always reflect the live
// published set — never a cached/frozen result. So the upstream fetch is no-store.
export async function getCourseSitemap(): Promise<SitemapUrlEntry[]> {
  const res = await fetch(`${BACKEND}/api/v1/public/sitemap/courses`, { cache: 'no-store' });
  return res.ok ? ((await res.json()) as SitemapUrlEntry[]) : [];
}

export async function getVideoSitemap(): Promise<VideoSitemapEntry[]> {
  const res = await fetch(`${BACKEND}/api/v1/public/sitemap/videos`, { cache: 'no-store' });
  return res.ok ? ((await res.json()) as VideoSitemapEntry[]) : [];
}

async function resolveLegacy(kind: 'project' | 'playlist', token: string): Promise<string | null> {
  try {
    const res = await fetch(`${BACKEND}/api/v1/public/legacy-redirect/${kind}/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { redirectUrl: string | null };
    return body.redirectUrl ?? null;
  } catch {
    return null;
  }
}
export const resolveLegacyProjectRedirect = (token: string) => resolveLegacy('project', token);
export const resolveLegacyPlaylistRedirect = (token: string) => resolveLegacy('playlist', token);
