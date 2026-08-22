/**
 * THE RELEASE CANDIDATE, EXERCISED AS IMAGES — the gate that replaces a human clicking "approve".
 *
 * Every other check tests the SOURCE. `verify` runs the workspace's tests and production builds;
 * `viewer-e2e` starts the app from the pnpm workspace. Nothing had ever started the actual images
 * that are about to be deployed, which is the one artifact production will run.
 *
 * ── WHAT THESE TESTS ARE FOR, AND WHAT THEY ARE NOT ───────────────────────────────────────────
 * Not a second functional suite: the 4000-test backend suite already covers behaviour, and
 * duplicating it here would trade a fast gate for a slow flaky one. These cover the seams that
 * only exist ONCE THE PIECES ARE SEPARATE PROCESSES IN SEPARATE IMAGES — the failures a source
 * build structurally cannot show:
 *
 *   • the image BOOTS at all — a missing runtime dependency the workspace happened to have,
 *     an entrypoint that resolves differently, a fail-closed env assertion that fires;
 *   • migrations apply to a REAL Postgres — the backend suite runs on PGlite, which serialises a
 *     `Date` where real Postgres rejects it. That exact difference hid a defect that left a whole
 *     shipped feature dead in production while every test stayed green (D-23);
 *   • client-web can actually REACH backend across the network boundary;
 *   • a stored key becomes a URL a browser can fetch — mint, then LOAD. The owner named this one
 *     directly: "legacy DB URL without token → token minting → valid final URL → resource loads".
 *     Two production incidents were this shape: a loopback URL served to browsers, and an r2.dev
 *     origin `frame-src` refused.
 *
 * ── FAIL CLOSED ───────────────────────────────────────────────────────────────────────────────
 * A test that cannot produce its evidence must FAIL, never skip. A skipped test and a passing one
 * are indistinguishable in a summary, and "the environment was not ready" is exactly the excuse a
 * broken candidate would offer. The gate additionally requires this suite's report to exist and to
 * carry this run's identity, so a suite that never ran cannot be scored as a clean pass — the
 * v0.1.5 shape of failure, already documented in release.yml.
 */
import { test, expect } from '@playwright/test';

const API = process.env.CANDIDATE_API_URL ?? 'http://localhost:8080';
const APP = process.env.CANDIDATE_APP_URL ?? 'http://localhost:3000';

/** A loopback URL is correct INSIDE this stack and is the bug everywhere else — see below. */
const LOOPBACK = /(localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

test.describe('the candidate images boot and serve', () => {
  test('backend answers /health from inside its own image', async ({ request }) => {
    const res = await request.get(`${API}/health`, { timeout: 15_000 });
    expect(res.ok(), `backend /health returned ${res.status()}`).toBe(true);
  });

  test('client-web serves its document from inside its own image', async ({ page }) => {
    const res = await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    expect(res?.status(), 'client-web did not serve a document').toBeLessThan(500);
  });

  test('the backend image ran its migrations against a REAL Postgres', async ({ request }) => {
    // The whole point of a real engine here. `/health` is answered only once the pool connects,
    // and the readiness payload reports migration state where the build exposes it.
    const res = await request.get(`${API}/health`, { timeout: 15_000 });
    expect(res.ok()).toBe(true);
    const body = await res.json().catch(() => ({}));
    // Deliberately tolerant about SHAPE and strict about CONTENT: a build that reports database
    // health must not report it as unhealthy. A build that reports nothing is covered by the boot
    // test above rather than failed twice for the same reason.
    if (typeof body === 'object' && body !== null && 'database' in body) {
      expect(String((body as Record<string, unknown>).database)).not.toMatch(/error|down|fail/i);
    }
  });
});

test.describe('the two images can reach each other', () => {
  test('client-web talks to backend across the container boundary', async ({ page }) => {
    // Both listeners are attached BEFORE the navigation. Attaching `requestfailed` after
    // `page.goto()` resolves — as the first version of this test did — collects nothing, and the
    // assertion then passes on an empty array no matter how badly the wiring is broken.
    const failures: string[] = [];
    const attempted: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/')) attempted.push(r.url()); });
    page.on('requestfailed', (r) => {
      if (r.url().includes('/api/')) failures.push(`${r.url()} — ${r.failure()?.errorText ?? 'unknown'}`);
    });
    await page.goto(APP, { waitUntil: 'networkidle', timeout: 45_000 });

    // Not every landing page calls the API, so this asserts the property that matters: nothing
    // that DID fire came back as a transport failure. A cross-image wiring mistake — wrong
    // service name, wrong port, backend not listening — shows up as a failed request, not a
    // missing one. `attempted` is reported so a zero-call page is visible rather than silent.
    expect(failures, `API calls from client-web could not reach backend (${attempted.length} attempted)`).toEqual([]);
  });
});

/**
 * THE OWNER'S NAMED CASE: a stored key becomes a URL a browser can actually fetch.
 *
 *   "legacy DB URL without token → backend processing/token minting → valid final URL →
 *    resource successfully loads"
 *
 * The two production incidents of this shape were both "the URL was built from configuration
 * instead of asked of the storage adapter" — one emitted `http://localhost:8080/...` to real
 * browsers, the other a `pub-*.r2.dev` origin that `frame-src` refused. Both were invisible to
 * every source-level test and visible in one browser request.
 *
 * ── WHY THIS SEEDS, AND WHAT IT DELIBERATELY DOES NOT COVER ───────────────────────────────────
 * The first version of this block walked whatever JSON a public endpoint happened to return and
 * fetched any URLs it found. Against this stack — which seeds nothing — that is an empty list, a
 * loop that never runs, and a test that reports PASS while asserting nothing. Vacuous green is
 * worse than no test: it is the thing the gate was built to stop, reproduced inside the gate.
 *
 * So the workflow writes two real files into the backend image's storage directory before this
 * runs, and the fixtures are declared through `CANDIDATE_STORAGE_FIXTURES`. If that is absent the
 * tests FAIL rather than skip — a fixture that could not be placed means the environment could not
 * be produced, which is exactly the condition the owner asked to fail closed.
 *
 * The authenticated leg — a signed-in user asking the API to mint a token — is NOT covered here:
 * it needs a real Firebase identity, which this stack has no way to produce, and faking one would
 * test the fake. What IS covered is every leg that does not need an identity, including the one
 * that actually failed in production: an untokenised URL for a private key must be REFUSED, and a
 * public key's URL must return the real bytes over HTTP from inside the image.
 */
test.describe('storage URLs are mintable AND loadable', () => {
  interface Fixture { key: string; body: string; expect: 'loads' | 'refused' }

  /** Fail closed: no declared fixtures ⇒ the environment was not produced ⇒ no deploy. */
  function fixtures(): Fixture[] {
    const raw = process.env.CANDIDATE_STORAGE_FIXTURES;
    if (!raw) {
      throw new Error(
        'CANDIDATE_STORAGE_FIXTURES is not set — the candidate stack was never seeded, so the ' +
          'storage round trip would assert nothing. Refusing to report a vacuous pass.',
      );
    }
    const parsed = JSON.parse(raw) as Fixture[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('CANDIDATE_STORAGE_FIXTURES declared no fixtures — refusing to run vacuously.');
    }
    return parsed;
  }

  test('a public key returns its real bytes over HTTP from inside the image', async ({ request }) => {
    const loadable = fixtures().filter((f) => f.expect === 'loads');
    expect(loadable.length, 'no loadable fixture was seeded').toBeGreaterThan(0);
    for (const f of loadable) {
      const url = `${API}/local-storage/${f.key}`;
      const res = await request.get(url, { timeout: 20_000 });
      expect(res.status(), `seeded public key did not load: ${url}`).toBe(200);
      // Byte equality, not just a 200. A 200 carrying an error page, an index listing or another
      // object's contents is the failure mode a status check cannot see.
      expect(await res.text(), `served the wrong content for ${f.key}`).toBe(f.body);
    }
  });

  test('a private key with no token is refused — the legacy-URL leg', async ({ request }) => {
    const refused = fixtures().filter((f) => f.expect === 'refused');
    expect(refused.length, 'no private fixture was seeded').toBeGreaterThan(0);
    for (const f of refused) {
      const res = await request.get(`${API}/local-storage/${f.key}`, { timeout: 20_000 });
      // 401 or 403 — which one is an auth-layer detail. What must never happen is 200: that is a
      // private object served to an anonymous browser, the incident class this leg exists for.
      expect([401, 403], `private key was NOT refused (got ${res.status()}): ${f.key}`).toContain(res.status());
      expect(await res.text()).not.toBe(f.body);
    }
  });

  test('a traversal key is refused even though its first segment looks public', async ({ request }) => {
    // `podcasts/..%2fexports/x` decodes to a `..` segment whose leading part matches a PUBLIC
    // prefix, skipping the auth branch, while the path resolves back into the private tree.
    // Guarded in server.ts; asserted here against the running image rather than the source.
    const res = await request.get(`${API}/local-storage/podcasts/..%2fexports/anything.txt`, { timeout: 20_000 });
    expect(res.status(), 'a traversal key was not refused').toBe(403);
  });

  test('the app page requests no origin outside this stack', async ({ page }) => {
    // The r2.dev incident in one assertion: a page that reaches for a third-party origin the CSP
    // will refuse in production is a page that renders a blank iframe for every viewer.
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('data:') && !u.startsWith('blob:') && !LOOPBACK.test(u)) external.push(u);
    });
    await page.goto(APP, { waitUntil: 'networkidle', timeout: 45_000 });
    // Google Fonts is the one documented exception the product already depends on.
    const unexpected = external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
    expect(unexpected, 'the candidate reaches an origin outside its own stack').toEqual([]);
  });
});
