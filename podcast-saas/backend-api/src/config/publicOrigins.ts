/**
 * Single source of truth for every BROWSER-VISIBLE origin/URL the backend emits.
 *
 * The production incident this guards against: asset/sim/caption URLs were built as
 * `process.env.X ?? 'http://localhost:8080'`, so when the container env was missing the
 * public origin the backend served `http://localhost:8080/...` to real browsers (which
 * resolve localhost to the END USER's machine). Never emit a localhost/internal-docker
 * host in a browser-visible URL in production — fail closed instead.
 *
 * Policy:
 *   - BACKEND_API_URL      → the public API origin (https://api.<domain>)         REQUIRED in prod
 *   - NEXT_PUBLIC_APP_URL  → the public app origin  (https://<domain>)            REQUIRED in prod
 *   - PUBLIC_SITE_URL      → canonical site URL (defaults to the app origin)
 *   - ADMIN_ORIGIN         → the public admin origin (https://admin.<domain>)     optional
 * In development these default to localhost; in production a missing/localhost/http value throws.
 */

// localhost, loopback, 0.0.0.0, IPv6 loopback
const LOCALHOST_RE = /(?:^|\/\/|@)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:$|[/?#])/i;
// internal Docker service names used by this stack (never browser-reachable)
const INTERNAL_HOST_RE = /(?:^|\/\/)(?:backend|worker|client-web|admin-web|postgres|nginx)(?::\d+)?(?:$|[/?#])/i;

export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** True if the URL points at localhost/loopback or an internal Docker hostname. */
export function isNonPublicUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return LOCALHOST_RE.test(url) || INTERNAL_HOST_RE.test(url);
}

function stripTrailingSlash(v: string): string {
  return v.replace(/\/+$/, '');
}

/**
 * Read a required browser-visible origin from env. In production a missing value
 * throws (fail closed); in dev it returns the provided localhost default.
 */
function requireOrigin(name: string, devDefault: string): string {
  const v = process.env[name]?.trim();
  if (v) return stripTrailingSlash(v);
  if (isProd()) {
    throw new Error(
      `[config] ${name} is required in production — refusing to emit a localhost URL to browsers.`,
    );
  }
  return devDefault;
}

/** Public API origin, e.g. https://api.flowvidco.com. Used for /sim-public, /local-storage, captions. */
export function publicApiOrigin(): string {
  return requireOrigin('BACKEND_API_URL', 'http://localhost:8080');
}

/** Public app origin, e.g. https://flowvidco.com. */
export function appOrigin(): string {
  return requireOrigin('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
}

/** Canonical public site URL (defaults to the app origin). */
export function siteUrl(): string {
  const v = process.env.PUBLIC_SITE_URL?.trim();
  return v ? stripTrailingSlash(v) : appOrigin();
}

/** Public admin origin (https://admin.<domain>) if configured; localhost in dev. */
export function adminOrigin(): string | undefined {
  const v = process.env.ADMIN_ORIGIN?.trim();
  if (v) return stripTrailingSlash(v);
  return isProd() ? undefined : 'http://localhost:3001';
}

/**
 * Every origin a browser is allowed to call the API from / embed our sims from.
 * Localhost dev origins are included ONLY outside production.
 */
export function browserOrigins(): string[] {
  const set = new Set<string>();
  set.add(appOrigin());
  const admin = adminOrigin();
  if (admin) set.add(admin);
  if (!isProd()) {
    set.add('http://localhost:3000');
    set.add('http://localhost:3001');
  }
  return [...set];
}

/**
 * Boot-time assertion — call once at server/worker startup so a misconfigured
 * container fails fast with a clear message instead of silently poisoning the DB
 * and serving localhost URLs to every user.
 */
export function assertPublicOriginsForProd(): void {
  if (!isProd()) return;
  const required: Array<[string, string | undefined]> = [
    ['BACKEND_API_URL', process.env.BACKEND_API_URL],
    ['NEXT_PUBLIC_APP_URL', process.env.NEXT_PUBLIC_APP_URL],
  ];
  const problems: string[] = [];
  for (const [name, val] of required) {
    const v = val?.trim();
    if (!v) problems.push(`${name} is unset`);
    else if (isNonPublicUrl(v)) problems.push(`${name}=${v} points at localhost/an internal host`);
    else if (!/^https:\/\//i.test(v)) problems.push(`${name}=${v} is not https`);
  }
  // ADMIN_ORIGIN is optional, but if present it must be a real public origin.
  const admin = process.env.ADMIN_ORIGIN?.trim();
  if (admin && isNonPublicUrl(admin)) problems.push(`ADMIN_ORIGIN=${admin} points at localhost/an internal host`);

  if (problems.length) {
    throw new Error(
      `[config] Refusing to start in production with browser-visible URLs misconfigured:\n  - ${problems.join(
        '\n  - ',
      )}\nSet BACKEND_API_URL / NEXT_PUBLIC_APP_URL (and ADMIN_ORIGIN) to the public https origins.`,
    );
  }
}
