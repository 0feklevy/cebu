/**
 * Which request URLs a hermetic browser suite may make — one predicate, so it can be unit-tested
 * and mutated rather than living as an inline boolean inside a spec.
 *
 * The rule that matters is the narrow one: the ONLY extra origin approved beyond the app, the API
 * and explicitly stubbed third parties is the *specific* loopback Firebase Auth Emulator that the
 * run is configured to use. "Any loopback host" is deliberately NOT the rule — that would approve
 * every other local service on the machine and turn a hermeticity check into a formality.
 *
 * Background: the app signs guests in anonymously on mount. In production that is a live call to
 * identitytoolkit.googleapis.com; in development it is redirected to a local emulator. Without an
 * allowance the hermeticity check fails for replacing a REAL external dependency with a local
 * one — punishing exactly the change it should reward. With a blanket loopback allowance it stops
 * checking anything. Hence: one configured origin, validated as loopback, and nothing else.
 */

export interface HermeticPolicy {
  /** The app origin under test (e.g. http://localhost:3010). */
  base: string;
  /** The API origin the app is allowed to call (e.g. http://localhost:8080). */
  apiOrigin: string;
  /** Third-party origins the suite stubs; they never reach the network. */
  stubbedHosts: readonly string[];
  /**
   * The one approved auth-emulator origin, already validated as loopback by
   * `authEmulatorOrigin` in shared/src/csp — or null when no emulator is configured.
   */
  authEmulator: string | null;
}

/** Schemes that cannot reach a network peer. */
const LOCAL_SCHEMES = ['data:', 'blob:', 'about:', 'filesystem:'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Is this a loopback ORIGIN (parsed, not string-matched)? Used to vet the configured emulator. */
export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.username || u.password) return false;
    return LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * True when `url` IS `origin` or continues past it at a real boundary (`/`, `?`, `#`). A bare
 * `startsWith(origin)` also matches `http://localhost:30100/...` against `http://localhost:3010`
 * and `http://localhost:8080.evil.test/...` against `http://localhost:8080` — the same prefix
 * collision the emulator allowance always defended against, applied to every origin here.
 */
function atOriginBoundary(url: string, origin: string): boolean {
  const o = origin.replace(/\/+$/, '');
  return url === o || url.startsWith(`${o}/`) || url.startsWith(`${o}?`) || url.startsWith(`${o}#`);
}

export function isApprovedRequestUrl(url: string, policy: HermeticPolicy): boolean {
  if (LOCAL_SCHEMES.some((s) => url.startsWith(s))) return true;
  if (atOriginBoundary(url, policy.base) || atOriginBoundary(url, policy.apiOrigin)) return true;
  // Stubbed hosts are deliberate PREFIXES (every entry ends with '/'), not bare origins.
  if (policy.stubbedHosts.some((h) => url.startsWith(h))) return true;

  // THE ONLY EXTRA ALLOWANCE, and it is exact: the configured emulator origin, which must itself
  // be loopback. A non-loopback value configured by mistake approves nothing.
  if (policy.authEmulator && isLoopbackOrigin(policy.authEmulator)) {
    if (atOriginBoundary(url, policy.authEmulator)) return true;
  }
  return false;
}
