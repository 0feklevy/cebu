import { test, expect, type Page, type Request, type ConsoleMessage } from '@playwright/test';

/**
 * Production browser smoke test for the localhost-URL / CSP class of bug that HTTP-200
 * health checks miss. Runs against the DEPLOYED site (SMOKE_BASE_URL). It asserts that a
 * real browser session produces NO localhost/loopback requests, NO CSP violations, and
 * NO mixed-content, and that the CSP header is production-correct.
 *
 *   SMOKE_BASE_URL=https://flowvidco.com npx playwright test
 *   SMOKE_PUBLIC_PATH=/c/some-public-course  (optional page with banners/thumbnails/iframes)
 */

const LOOPBACK = /(?:^|\/\/|@)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?/i;

function collect(page: Page) {
  const localhostRequests: string[] = [];
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  const failedRequests: string[] = [];

  page.on('request', (req: Request) => {
    if (LOOPBACK.test(req.url())) localhostRequests.push(`${req.method()} ${req.url()}`);
  });
  page.on('requestfailed', (req: Request) => {
    const url = req.url();
    if (LOOPBACK.test(url)) failedRequests.push(`${url} (${req.failure()?.errorText ?? 'failed'})`);
  });
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    if (/content security policy|violates|refused to (frame|connect|load)/i.test(text)) cspViolations.push(text);
    if (/mixed content/i.test(text)) cspViolations.push(text);
    if (msg.type() === 'error' && LOOPBACK.test(text)) consoleErrors.push(text);
  });

  return { localhostRequests, consoleErrors, cspViolations, failedRequests };
}

test('home page makes no localhost requests and has no CSP/mixed-content violations', async ({ page }) => {
  const sink = collect(page);
  const resp = await page.goto('/', { waitUntil: 'networkidle' });
  expect(resp, 'navigation response').toBeTruthy();

  // CSP header present, contains the app origin, and no localhost in production.
  const csp = resp?.headers()['content-security-policy'];
  expect(csp, 'Content-Security-Policy header must be present').toBeTruthy();
  if (csp && (process.env.SMOKE_BASE_URL ?? '').startsWith('https://')) {
    expect(csp, 'prod CSP must not contain localhost').not.toMatch(LOOPBACK);
    expect(csp).toContain("frame-ancestors 'none'");
  }

  await page.waitForTimeout(1500); // let deferred asset/XHR requests fire

  expect(sink.localhostRequests, `no browser requests to localhost:\n${sink.localhostRequests.join('\n')}`).toHaveLength(0);
  expect(sink.failedRequests, `no failed localhost requests:\n${sink.failedRequests.join('\n')}`).toHaveLength(0);
  expect(sink.consoleErrors, `no localhost console errors:\n${sink.consoleErrors.join('\n')}`).toHaveLength(0);
  expect(sink.cspViolations, `no CSP / mixed-content violations:\n${sink.cspViolations.join('\n')}`).toHaveLength(0);
});

test('no stale service worker remains registered', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000); // allow the kill-switch cleanup to run
  const regs = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 0;
    const r = await navigator.serviceWorker.getRegistrations();
    return r.length;
  });
  expect(regs, 'no service worker should be registered (app ships none; stale ones self-unregister)').toBe(0);
});

test('Firebase auth iframe is allowed by CSP (sign-in works, frame-ancestors unchanged)', async ({ page }) => {
  // Capture real securitypolicyviolation events (more reliable than console text).
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${(e as SecurityPolicyViolationEvent).violatedDirective} blocked ${(e as SecurityPolicyViolationEvent).blockedURI}`,
      );
    });
  });

  const resp = await page.goto('/', { waitUntil: 'networkidle' });
  const csp = resp?.headers()['content-security-policy'] ?? '';
  const frameSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('frame-src ')) ?? '';

  // The Firebase Auth iframe origin (<project>.firebaseapp.com) MUST be allowed, or sign-in breaks.
  expect(frameSrc, `frame-src must allow the Firebase Auth iframe origin (got: "${frameSrc}")`)
    .toMatch(/https:\/\/[a-z0-9-]+\.firebaseapp\.com/i);
  // frame-ancestors must remain restrictive (separate concern, not weakened).
  expect(csp, 'frame-ancestors must stay restrictive').toContain("frame-ancestors 'none'");
  // No localhost / no wildcard in a production CSP.
  if ((process.env.SMOKE_BASE_URL ?? '').startsWith('https://')) {
    expect(frameSrc, 'prod frame-src must not contain localhost').not.toMatch(LOOPBACK);
    expect(frameSrc.split(/\s+/), 'prod frame-src must not use a bare * wildcard').not.toContain('*');
  }

  // Exercise the sign-in entry point if present; Firebase loads its authDomain iframe here.
  const trigger = page
    .locator('button, a')
    .filter({ hasText: /sign\s?in|log\s?in|continue with google|get started/i })
    .first();
  if (await trigger.count()) {
    await trigger.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500); // let the auth iframe attempt to load
  } else {
    await page.waitForTimeout(1500); // firebase may load its iframe on init anyway
  }

  // Fail on any CSP frame violation, especially against the Firebase auth origin.
  const violations: string[] = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []);
  const frameViolations = violations.filter((v) => /frame-src|firebaseapp\.com/i.test(v));
  expect(frameViolations, `no CSP frame violations (Firebase auth):\n${frameViolations.join('\n')}`).toHaveLength(0);
});

test('public content page loads banners/thumbnails/iframes without localhost', async ({ page }) => {
  const publicPath = process.env.SMOKE_PUBLIC_PATH;
  test.skip(!publicPath, 'set SMOKE_PUBLIC_PATH to a public page with media to run this check');

  const sink = collect(page);
  await page.goto(publicPath!, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Every rendered <img> must have resolved to a non-zero natural size (i.e. actually loaded).
  const brokenImages = await page.$$eval('img', (imgs) =>
    imgs
      .filter((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src)
      .filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth === 0)
      .map((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src),
  );

  // Any iframe (sim/embed) src must not be a loopback URL.
  const iframeSrcs = await page.$$eval('iframe', (frames) => frames.map((f) => (f as HTMLIFrameElement).src));

  expect(sink.localhostRequests, `no localhost requests on public page:\n${sink.localhostRequests.join('\n')}`).toHaveLength(0);
  expect(brokenImages, `no broken images:\n${brokenImages.join('\n')}`).toHaveLength(0);
  for (const src of iframeSrcs) expect(src, `iframe src must not be loopback: ${src}`).not.toMatch(LOOPBACK);
});
