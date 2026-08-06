/**
 * Content-Security-Policy builder for the Next.js frontends (client-web + admin-web).
 *
 * Kept as a pure, testable function so both next.config files and the regression tests use
 * the EXACT same logic. Two framing concerns are deliberately separate:
 *   frame-ancestors 'none'  → nobody may embed OUR pages (never weakened here).
 *   frame-src               → which iframes OUR pages may load (the concern this governs).
 */

export interface FrontendCspOptions {
  /** Public API origin, e.g. https://api.flowvidco.com. Sims are served from /sim-public here. */
  apiUrl: string;
  /**
   * NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, e.g. `cebu-1a10f.firebaseapp.com` (a bare host).
   * Firebase Auth loads an iframe from `https://<authDomain>/__/auth/iframe` for popup/redirect
   * session handling, so its exact origin must appear in frame-src or auth breaks.
   */
  firebaseAuthDomain?: string;
  /** client-web loads the Stripe checkout iframe (js.stripe.com); admin-web does not. */
  includeStripe?: boolean;
  /** true in development → adds localhost sources. MUST be false for a production policy. */
  dev?: boolean;
  /**
   * `host:port` of a LOCAL Firebase Auth emulator, added to connect-src in development only.
   *
   * With `connectAuthEmulator` active the SDK posts to `http://<host>:<port>/identitytoolkit…`,
   * which `connect-src` refused — so anonymous sign-in failed silently inside the provider's catch
   * and the page ran unauthenticated. Ignored entirely unless `dev` is true AND the value is a
   * loopback host, so it can never widen a production policy.
   */
  authEmulatorHost?: string;
}

/** `http://host:port` for a loopback emulator, or '' for anything else. Never widens production. */
export function authEmulatorOrigin(hostPort: string | undefined, dev: boolean): string {
  if (!dev || !hostPort) return '';
  const trimmed = hostPort.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  const [host, port] = trimmed.split(':');
  if (!host || !port || !/^\d+$/.test(port)) return '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return '';
  return `http://${host}:${port}`;
}

const LOOPBACK = /(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i;

/**
 * Derive the exact https origin of the Firebase Auth iframe from the configured auth domain.
 * Returns '' when the domain is missing/invalid/localhost — it never widens the policy and
 * never emits a wildcard. Tolerates a value that already carries a scheme/port/path.
 */
export function firebaseAuthFrameOrigin(authDomain?: string): string {
  const raw = authDomain?.trim();
  if (!raw) return '';
  const host = raw
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
  // Must be a real, dotted hostname with no wildcards/whitespace and not a loopback host.
  if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/i.test(host) || LOOPBACK.test(host)) return '';
  return `https://${host}`;
}

/** Build the full Content-Security-Policy header value for an app-page response. */
export function buildFrontendCsp(opts: FrontendCspOptions): string {
  const { apiUrl, firebaseAuthDomain, includeStripe = false, dev = false } = opts;
  const authFrame = firebaseAuthFrameOrigin(firebaseAuthDomain);
  const devApi = dev ? ' http://localhost:8080' : '';
  const emu = authEmulatorOrigin(opts.authEmulatorHost, dev);
  const devEmu = emu ? ` ${emu}` : '';

  // frame-src — the exact origins whose iframes our pages may load:
  //   the API origin (sims via /sim-public), Stripe checkout (client-web), and the Firebase
  //   Auth iframe origin. No http:, no localhost (except dev), no wildcards.
  const frameSrc = [
    "'self'",
    apiUrl,
    includeStripe ? 'https://js.stripe.com' : '',
    authFrame,
    dev ? 'http://localhost:8080' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `frame-src ${frameSrc}`,
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:" + (dev ? ' http:' : ''),
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    `img-src 'self' data: blob: https:${devApi}`,
    `media-src 'self' blob: https:${devApi}`,
    `connect-src 'self' https: wss:${dev ? ' http://localhost:8080 ws://localhost:8080' : ''}${devEmu}`,
  ].join('; ');
}
