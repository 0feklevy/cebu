/**
 * Pure, testable helpers for the localhost-URL backfill (see backfill-localhost-urls.ts).
 * Kept separate so they can be unit-tested without running the migration's DB side effects.
 */

// A URL whose host is localhost/loopback or an internal Docker service name. Postgres
// regex string (used with `~*`) — valid cloud/public URLs never match, so they are safe.
export const NON_PUBLIC_SQL =
  '^https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|backend|worker|nginx|admin-web|client-web)([:/]|$)';

// JS mirror of NON_PUBLIC_SQL for in-code checks/tests.
export const nonPublicUrlRe =
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|backend|worker|nginx|admin-web|client-web)([:/]|$)/i;

export function isNonPublicUrl(url: string | null | undefined): boolean {
  return !!url && nonPublicUrlRe.test(url);
}

// Serve-route segments the backend uses; the storage key is everything after them.
const ROUTE_MARKERS = ['/sim-public/', '/local-storage/', '/hls-public/', '/video-raw/'];

/**
 * Extract the bare storage key from a backend serve URL, stripping the origin, the route
 * segment, and any leading media-token segment (`t/<token>/`). Returns null if the URL
 * doesn't contain a known serve route.
 */
export function keyFromUrl(url: string): string | null {
  for (const m of ROUTE_MARKERS) {
    const i = url.indexOf(m);
    if (i !== -1) {
      let key = url.slice(i + m.length);
      key = key.replace(/^t\/[^/]+\//, ''); // drop media-token segment if present
      try { key = decodeURIComponent(key); } catch { /* keep raw */ }
      return key.replace(/[?#].*$/, ''); // drop query/hash
    }
  }
  return null;
}
