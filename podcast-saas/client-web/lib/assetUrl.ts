/**
 * Defense-in-depth for browser-visible asset URLs returned by the API.
 *
 * The backend should never emit a localhost/loopback URL in production (see the backend
 * publicOrigins config + DB backfill), but historical rows or a misconfigured instance
 * could still return `http://localhost:8080/...`. Rendering that into an <img>/<iframe>/
 * <video> src makes the browser hit the END USER's own machine (loopback), which fails
 * noisily and is a mixed-content violation. This helper rewrites any localhost/loopback
 * host to the configured public API origin so the request at least targets the real
 * server (where it 404s cleanly if the asset is genuinely missing) instead of the user's
 * machine. It leaves valid absolute (cloud/https) and relative URLs untouched.
 */

const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

export function resolveAssetUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  // Only absolute http(s) URLs can point at a loopback host; leave relative/data/blob as-is.
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!LOOPBACK_HOSTS.has(u.hostname)) return url; // already a real host — keep it
    if (!API_ORIGIN) return url; // no public origin configured (dev) — nothing safer to do
    // Re-point the loopback URL at the public API origin, preserving path + query.
    return `${API_ORIGIN}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
