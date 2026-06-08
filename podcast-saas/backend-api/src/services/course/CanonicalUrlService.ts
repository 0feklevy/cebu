/**
 * CanonicalUrlService — the single place canonical/public URLs are built.
 *
 * Route components and other services must NOT assemble course/lesson URLs by
 * hand. Default host is the platform host (env). The service is ready for a
 * verified custom primary hostname later, but never trusts an unverified one.
 *
 * Rules enforced here:
 *   - course   → {base}/c/{slug}
 *   - lesson   → {base}/c/{courseSlug}/{lessonSlug}
 *   - query/hash are never part of a canonical URL
 *   - an explicit canonical override is validated (absolute http(s), no creds)
 *     before use; anything invalid falls back to the generated canonical
 *   - token/preview hosts never become canonical
 */

/** Platform base URL, normalised (no trailing slash). */
export function platformBaseUrl(): string {
  const raw = process.env.PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

export interface CanonicalHostContext {
  /** Verified custom primary host for this course, if any (Phase 3 wires verification). */
  verifiedCustomHost?: string | null;
}

function baseUrlFor(ctx?: CanonicalHostContext): string {
  const host = ctx?.verifiedCustomHost?.trim();
  if (host) {
    // Only accept a bare hostname (optionally with scheme). Reject paths/creds.
    const normalized = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (isValidHostname(normalized)) return `https://${normalized}`;
  }
  return platformBaseUrl();
}

function isValidHostname(h: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !h.includes('..');
}

export function courseUrl(slug: string, ctx?: CanonicalHostContext): string {
  return `${baseUrlFor(ctx)}/c/${encodeURIComponent(slug)}`;
}

export function lessonUrl(courseSlug: string, lessonSlug: string, ctx?: CanonicalHostContext): string {
  return `${baseUrlFor(ctx)}/c/${encodeURIComponent(courseSlug)}/${encodeURIComponent(lessonSlug)}`;
}

/**
 * Validate an explicit author canonical override. Returns the cleaned URL, or
 * null if it is unusable (then the caller uses the generated canonical).
 * Rejects: relative URLs, non-http(s), embedded credentials, query/hash.
 */
export function validateCanonicalOverride(value: string | null | undefined): string | null {
  if (!value) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  // Strip query + hash — they must never be canonical.
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '') || null;
}

/** True if a URL belongs to the platform's public host (used to reject token/preview as canonical). */
export function isPlatformUrl(value: string): boolean {
  try {
    return new URL(value).origin === new URL(platformBaseUrl()).origin;
  } catch {
    return false;
  }
}
