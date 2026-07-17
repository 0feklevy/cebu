import { expect, test, type ConsoleMessage, type Page, type Request, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Production browser AUDIT — the false-green killer. An HTTP-200 health check is
 * necessary but not sufficient: this suite drives a real browser over the deployed
 * site, collects every failure signal, ASSERTS the critical invariants, and emits a
 * machine-readable flowvid.browser-audit/v1 JSON consumed by the release pipeline
 * (ops/release: `release-cli browser-audit`).
 *
 * Env:
 *   SMOKE_BASE_URL          deployed origin (default https://flowvidco.com)
 *   SMOKE_PUBLIC_PATH       a public/shared project page with media (optional)
 *   SMOKE_PLAYLIST_PATH     a playlist lobby page (optional)
 *   SMOKE_ADMIN_URL         admin origin, e.g. https://admin.flowvidco.com (optional)
 *   SMOKE_ADMIN_EMAIL/_PASSWORD  least-privileged smoke account (optional, secrets)
 *   SMOKE_ADMIN_PREVIEW_PATH     an admin preview path to open after login (optional)
 *   PLAYWRIGHT_AUDIT_OUT    output path for the audit JSON (default e2e-results/browser-audit.json)
 */

const BASE = process.env.SMOKE_BASE_URL ?? 'https://flowvidco.com';

// ── Non-public host detection (mirrors ops/release/src/hosts.ts) ────────────────────
const DOCKER_HOSTS = new Set(['backend', 'worker', 'nginx', 'client-web', 'admin-web']);

function hostKind(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'loopback';
  if (host === '0.0.0.0' || host === '::') return 'unspecified';
  if (DOCKER_HOSTS.has(host)) return 'docker-service';
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'link-local';
  }
  return null; // public
}

// ── PageAudit collection (schema flowvid.browser-audit/v1) ─────────────────────────
interface PageAudit {
  url: string;
  status: number | null;
  /** Whether this page was audited anonymously or after signing in. */
  authContext: 'anonymous' | 'authenticated';
  consoleErrors: string[];
  consoleSecurityWarnings: string[];
  pageErrors: string[];
  cspViolations: string[];
  mixedContent: string[];
  requestsFailed: Array<{ url: string; error: string }>;
  responses5xx: Array<{ url: string; status: number }>;
  unexpected4xx: Array<{ url: string; status: number; type: string }>;
  /** Protected-route 401/403 observed while ANONYMOUS — expected, diagnostic only. */
  expectedAuthRejections: Array<{ url: string; status: number }>;
  /** Exactly-matched known-benign browser messages (Firebase COOP popup poll). */
  knownBenignWarnings: string[];
  nonPublicRequests: Array<{ url: string; kind: string }>;
  brokenImages: string[];
  iframes: string[];
  serviceWorkers: number;
}

const collectedPages: PageAudit[] = [];

const SECURITY_CONSOLE = /content security policy|violates|refused to (frame|connect|load|execute)|mixed content|blocked by/i;
/** Same-origin + first-party API/storage resources whose 401/403/404 means a broken page. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const API_ORIGIN = 'https://api.flowvidco.com';
const REQUIRED_RESOURCE = new RegExp(
  `^(?:${escapeRe(BASE)}|${escapeRe(API_ORIGIN)}|https://[a-z0-9-]+\\.supabase\\.co)`,
  'i',
);
const REQUIRED_TYPES = new Set(['image', 'media', 'stylesheet', 'script', 'font', 'fetch', 'xhr']);

/**
 * First-party API routes that REQUIRE authentication BY DESIGN (path-only match,
 * query stripped). A 401/403 from these while the audit is ANONYMOUS is an
 * expected rejection recorded as diagnostic evidence — not a broken asset.
 * Deliberately explicit (mirrors ops/release/src/config.ts api.protectedRoutes;
 * the ops test suite checks the two lists stay in sync). Never a blanket
 * /api/v1 rule, and never applied to static resources or authenticated audits.
 */
const PROTECTED_API_ROUTES: RegExp[] = [
  /^\/api\/v1\/projects\/?$/i,
  /^\/api\/v1\/playlists\/?$/i,
];
/** Public API routes that must work for everyone — 4xx here is always a failure. */
const REQUIRED_PUBLIC_API_ROUTES: RegExp[] = [/^\/health\/?$/i];

/**
 * The exact known-benign Chrome message emitted while Firebase signInWithPopup
 * polls popup.closed (Google's popup serves COOP same-origin-allow-popups; our
 * pages send no COOP header — verified 2026-07-16 — and the popup/iframe flow is
 * functional). Recorded as diagnostic evidence, never as a security warning.
 * Mirrors ops/release/src/asset-audit.ts COOP_WINDOW_CLOSED_RE.
 */
const COOP_WINDOW_CLOSED = /Cross-Origin-Opener-Policy policy would block the window\.closed call/i;
const CONSOLE_AUTH_LOAD_FAILURE = /Failed to load resource:.*\b(401|403)\b/i;

function isProtectedApiRoute(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.origin !== API_ORIGIN) return false;
    if (REQUIRED_PUBLIC_API_ROUTES.some((re) => re.test(u.pathname))) return false;
    return PROTECTED_API_ROUTES.some((re) => re.test(u.pathname));
  } catch {
    return false;
  }
}

function attach(page: Page): PageAudit {
  const audit: PageAudit = {
    url: '',
    status: null,
    authContext: 'anonymous',
    consoleErrors: [],
    consoleSecurityWarnings: [],
    pageErrors: [],
    cspViolations: [],
    mixedContent: [],
    requestsFailed: [],
    responses5xx: [],
    unexpected4xx: [],
    expectedAuthRejections: [],
    knownBenignWarnings: [],
    nonPublicRequests: [],
    brokenImages: [],
    iframes: [],
    serviceWorkers: 0,
  };

  page.on('request', (req: Request) => {
    const url = req.url();
    const kind = hostKind(url);
    if (kind) audit.nonPublicRequests.push({ url, kind });
    if (url.startsWith('http://') && BASE.startsWith('https://') && !kind) {
      audit.mixedContent.push(url); // plain-http request to a public host from an https page
    }
  });
  page.on('requestfailed', (req: Request) => {
    audit.requestsFailed.push({ url: req.url(), error: req.failure()?.errorText ?? 'failed' });
  });
  page.on('response', (res: Response) => {
    const status = res.status();
    const url = res.url();
    if (status >= 500) audit.responses5xx.push({ url, status });
    else if ([401, 403, 404].includes(status)) {
      const type = res.request().resourceType();
      if (!REQUIRED_TYPES.has(type) || !REQUIRED_RESOURCE.test(url)) return;
      // Context-aware: a 401/403 from an explicitly-protected API route while the
      // audit is ANONYMOUS is an expected rejection (diagnostic), not a broken asset.
      // 404s, static resources, and authenticated audits are never downgraded.
      const isAuthRejection =
        (status === 401 || status === 403) &&
        (type === 'fetch' || type === 'xhr') &&
        audit.authContext === 'anonymous' &&
        isProtectedApiRoute(url);
      if (isAuthRejection) audit.expectedAuthRejections.push({ url, status });
      else audit.unexpected4xx.push({ url, status, type });
    }
  });
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    if (COOP_WINDOW_CLOSED.test(text)) {
      audit.knownBenignWarnings.push(text); // exact known-benign message, never a security warning
      return;
    }
    if (SECURITY_CONSOLE.test(text)) {
      if (/mixed content/i.test(text)) audit.mixedContent.push(text);
      else audit.cspViolations.push(text);
      if (msg.type() === 'warning') audit.consoleSecurityWarnings.push(text);
    } else if (msg.type() === 'error') {
      // Correlate the browser's own "Failed to load resource … 401/403" line with
      // an expected anonymous auth rejection (same resource URL, from location()):
      // that event is already represented once in expectedAuthRejections — don't
      // duplicate it as console noise. Unrelated console errors are untouched.
      const locUrl = msg.location()?.url ?? '';
      if (CONSOLE_AUTH_LOAD_FAILURE.test(text) && audit.authContext === 'anonymous' && isProtectedApiRoute(locUrl)) {
        return;
      }
      audit.consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => audit.pageErrors.push(String(err?.message ?? err)));

  return audit;
}

/** Install a securitypolicyviolation listener before any page script runs. */
async function armCspListener(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      const ev = e as SecurityPolicyViolationEvent;
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
        `${ev.violatedDirective} blocked ${ev.blockedURI} on ${ev.documentURI}`,
      );
    });
  });
}

async function harvest(page: Page, audit: PageAudit, pageUrl: string, status: number | null): Promise<void> {
  audit.url = pageUrl;
  audit.status = status;

  const cspEvents: string[] = await page
    .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
    .catch(() => []);
  audit.cspViolations.push(...cspEvents);

  audit.serviceWorkers = await page
    .evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 0;
      return (await navigator.serviceWorker.getRegistrations()).length;
    })
    .catch(() => 0);

  audit.brokenImages = await page
    .$$eval('img', (imgs) =>
      imgs
        .filter((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src)
        .filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth === 0)
        .map((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src),
    )
    .catch(() => []);

  audit.iframes = await page.$$eval('iframe', (fs) => fs.map((f) => (f as HTMLIFrameElement).src).filter(Boolean)).catch(() => []);

  collectedPages.push(audit);
}

/** The hard invariants every audited page must satisfy (the incident classes). */
function assertCriticalInvariants(audit: PageAudit): void {
  expect(audit.status, `page ${audit.url} must respond < 500`).not.toBeNull();
  expect(audit.status!, `page ${audit.url} must respond < 500`).toBeLessThan(500);
  expect(
    audit.nonPublicRequests,
    `NO browser requests to localhost/private/docker hosts:\n${audit.nonPublicRequests.map((r) => `${r.url} (${r.kind})`).join('\n')}`,
  ).toHaveLength(0);
  expect(audit.mixedContent, `NO mixed content:\n${audit.mixedContent.join('\n')}`).toHaveLength(0);
  const coreCsp = audit.cspViolations.filter((v) => /firebaseapp\.com|stripe|frame-src|api\.flowvidco\.com/i.test(v));
  expect(coreCsp, `NO CSP violations on core flows:\n${coreCsp.join('\n')}`).toHaveLength(0);
  expect(audit.responses5xx, `NO 5xx responses:\n${audit.responses5xx.map((r) => `${r.status} ${r.url}`).join('\n')}`).toHaveLength(0);
  expect(audit.brokenImages, `NO broken images:\n${audit.brokenImages.join('\n')}`).toHaveLength(0);
  for (const src of audit.iframes) {
    expect(hostKind(src), `iframe src must be public: ${src}`).toBeNull();
  }
}

async function settle(page: Page, ms = 2500): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms); // deferred asset/XHR/iframe traffic
}

// ── Pages ───────────────────────────────────────────────────────────────────────────

test('audit: public homepage', async ({ page }) => {
  await armCspListener(page);
  const audit = attach(page);
  const resp = await page.goto('/', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await harvest(page, audit, new URL('/', BASE).toString(), resp?.status() ?? null);
  assertCriticalInvariants(audit);
});

test('audit: login entry point + Firebase auth iframe initiation', async ({ page }) => {
  await armCspListener(page);
  const audit = attach(page);
  const resp = await page.goto('/', { waitUntil: 'domcontentloaded' });
  await settle(page, 1500);

  const trigger = page
    .locator('button, a')
    .filter({ hasText: /sign\s?in|log\s?in|continue with google|get started/i })
    .first();
  if (await trigger.count()) {
    await trigger.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500); // let the Firebase auth iframe attempt to load
  }

  await harvest(page, audit, new URL('/#login', BASE).toString(), resp?.status() ?? null);
  assertCriticalInvariants(audit);

  // Firebase-specific: no frame violation against the auth origin (the v0.1.1 incident).
  const firebaseViolations = audit.cspViolations.filter((v) => /firebaseapp\.com/i.test(v));
  expect(firebaseViolations, `Firebase auth iframe must not be CSP-blocked:\n${firebaseViolations.join('\n')}`).toHaveLength(0);
});

test('audit: public/shared project page (thumbnails, sim iframe, captions, media)', async ({ page }) => {
  const path = process.env.SMOKE_PUBLIC_PATH;
  test.skip(!path, 'set SMOKE_PUBLIC_PATH to a public project/course page with media');

  await armCspListener(page);
  const audit = attach(page);
  const resp = await page.goto(path!, { waitUntil: 'domcontentloaded' });
  await settle(page, 3500);

  // Try to bootstrap playback so HLS/caption requests fire (best effort, no fragile text).
  const play = page.locator('video, [aria-label*="play" i], button:has-text("Play")').first();
  if (await play.count()) await play.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Caption tracks (if present) must be fetchable, valid WEBVTT, from a public host.
  const trackSrcs = await page.$$eval('track', (ts) => ts.map((t) => (t as HTMLTrackElement).src).filter(Boolean)).catch(() => []);
  for (const src of trackSrcs) {
    expect(hostKind(src), `caption track must be public: ${src}`).toBeNull();
    const res = await page.request.get(src);
    expect(res.status(), `caption VTT ${src}`).toBe(200);
    expect((await res.text()).trimStart().startsWith('WEBVTT'), `caption ${src} must be valid WEBVTT`).toBe(true);
  }

  await harvest(page, audit, new URL(path!, BASE).toString(), resp?.status() ?? null);
  assertCriticalInvariants(audit);
});

test('audit: playlist lobby (banner + thumbnails)', async ({ page }) => {
  const path = process.env.SMOKE_PLAYLIST_PATH;
  test.skip(!path, 'set SMOKE_PLAYLIST_PATH to a public playlist page');

  await armCspListener(page);
  const audit = attach(page);
  const resp = await page.goto(path!, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await harvest(page, audit, new URL(path!, BASE).toString(), resp?.status() ?? null);
  assertCriticalInvariants(audit);
});

test('audit: admin login + preview (least-privileged smoke account)', async ({ page }) => {
  const adminUrl = process.env.SMOKE_ADMIN_URL;
  const email = process.env.SMOKE_ADMIN_EMAIL;
  const password = process.env.SMOKE_ADMIN_PASSWORD;
  test.skip(!adminUrl, 'set SMOKE_ADMIN_URL to audit the admin app');

  await armCspListener(page);
  const audit = attach(page);
  const resp = await page.goto(adminUrl!, { waitUntil: 'domcontentloaded' });
  await settle(page, 2000);

  if (email && password) {
    const emailInput = page.locator('input[type="email"], input[name*="email" i]').first();
    const passInput = page.locator('input[type="password"]').first();
    if ((await emailInput.count()) && (await passInput.count())) {
      await emailInput.fill(email);
      await passInput.fill(password);
      await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click({ timeout: 5000 }).catch(() => {});
      // From here the audit is AUTHENTICATED: a 401/403 from a protected API route
      // is now a real failure (HIGH), never an expected rejection.
      audit.authContext = 'authenticated';
      await settle(page, 3000);
      const preview = process.env.SMOKE_ADMIN_PREVIEW_PATH;
      if (preview) {
        await page.goto(new URL(preview, adminUrl!).toString(), { waitUntil: 'domcontentloaded' }).catch(() => {});
        await settle(page, 2500);
      }
    }
  }

  await harvest(page, audit, adminUrl!, resp?.status() ?? null);
  assertCriticalInvariants(audit);
});

// ── Emit the machine-readable audit document ──────────────────────────────────────
test.afterAll(() => {
  const out = process.env.PLAYWRIGHT_AUDIT_OUT ?? join('e2e-results', 'browser-audit.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        schema: 'flowvid.browser-audit/v1',
        baseUrl: BASE,
        generatedAt: new Date().toISOString(),
        pages: collectedPages,
      },
      null,
      2,
    ) + '\n',
  );
});
