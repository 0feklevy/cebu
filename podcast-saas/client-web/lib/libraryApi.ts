/**
 * Server-side data access for the public library mini-site — the `courseApi.ts` twin.
 *
 * Runs only in Server Components (never shipped to the client), so nothing crosses an origin from
 * the browser and CORS is not involved at all. The ISR tags are what makes revocation prompt: the
 * backend's `dispatchLibraryInvalidation` purges `library-share:{slug}`, so a revoked link stops
 * resolving within seconds instead of within its 60-second window.
 *
 * A body that fails to parse is `not_found`, loudly logged — the exact policy `courseApi.getPage`
 * documents, and for the same reason: a 404 is a better answer than half a page.
 */
import 'server-only';
import { LibraryViewSchema } from 'shared/src/types/library-view';
import type { LibraryMaterialType, LibraryView } from 'shared/src/types/library-view';

const BACKEND =
  process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

/** Matches the page's own `export const revalidate`. Both are the ISR contract, so both are 60. */
export const LIBRARY_REVALIDATE_SECONDS = 60;

export type PageResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found' };

export async function getLibraryPage(
  slug: string,
  type?: LibraryMaterialType,
): Promise<PageResult<LibraryView>> {
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  try {
    const res = await fetch(`${BACKEND}/api/v1/public/library/${encodeURIComponent(slug)}${query}`, {
      next: {
        revalidate: LIBRARY_REVALIDATE_SECONDS,
        // Two tags: one to purge every library at once, one to purge exactly this share.
        tags: ['library-share', `library-share:${slug}`],
      },
    });
    if (res.status !== 200) return { status: 'not_found' };

    const parsed = LibraryViewSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) return { status: 'ok', data: parsed.data };

    // Loud, because this is drift between two halves of one contract — and silently 404ing a
    // library that IS shared would otherwise be invisible.
    console.error(`[libraryApi] /public/library/${slug} did not match its schema:`, parsed.error.issues.slice(0, 5));
    return { status: 'not_found' };
  } catch (err) {
    console.error(`[libraryApi] /public/library/${slug} fetch failed:`, err);
    return { status: 'not_found' };
  }
}
