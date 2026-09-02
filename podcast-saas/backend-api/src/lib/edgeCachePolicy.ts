/**
 * The cache-header discipline a CDN in front of the API requires (night run 2026-09-03 §7).
 *
 * Most API routes set no Cache-Control at all. A browser treats that as "cache heuristically",
 * and a CDN placed in front of `api.` (the plan's Phase 2) would happily store an authenticated
 * JSON reply for the next visitor. So every `/api/` response that has not said otherwise now
 * says `no-store`; the routes that MEAN to be cached (the public library and audio views, the
 * sim assets, the posters) already set their own header and are left alone.
 *
 * Also the second half of the same discipline: which public READ paths get a per-IP ceiling.
 * The viewer surface had none — `player-config`, `share`, `permalink`, the caption tracks — so
 * every limiter that existed protected the paid vendors and nothing protected the pool.
 */

/** The value to add when a `/api/` response has no Cache-Control of its own, else null. */
export function defaultCacheControl(url: string, existing: string | number | string[] | undefined): string | null {
  if (existing !== undefined && existing !== '') return null;
  const path = url.split('?')[0];
  if (!path.startsWith('/api/')) return null;
  return 'no-store';
}

const PUBLIC_READ_PATTERNS: readonly RegExp[] = [
  /^\/api\/v1\/public\//,
  /^\/api\/v1\/share\//,
  /^\/api\/v1\/projects\/[^/]+\/player-config$/,
  /^\/api\/v1\/projects\/[^/]+\/captions$/,
  /^\/api\/v1\/videos\/[^/]+\/captions\.vtt$/,
];

/** True for the anonymous viewer reads that deserve a per-IP ceiling. */
export function isPublicReadPath(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0];
  return PUBLIC_READ_PATTERNS.some((re) => re.test(path));
}

/** Generous: a real viewer never notices; a scraper does. Per process, like every limiter here. */
export const PUBLIC_READ_LIMIT_PER_MINUTE = 120;
