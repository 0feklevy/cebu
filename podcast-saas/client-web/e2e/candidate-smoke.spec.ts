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


test.describe('the candidate images boot and serve', () => {
  test('backend answers /health from inside its own image', async ({ request }) => {
    const res = await request.get(`${API}/health`, { timeout: 15_000 });
    expect(res.ok(), `backend /health returned ${res.status()}`).toBe(true);
  });

  test('client-web serves its document from inside its own image', async ({ page }) => {
    const res = await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    expect(res?.status(), 'client-web did not serve a document').toBeLessThan(500);
  });

  test('the schema this build migrated to is live, and the pool reports healthy', async ({ request }) => {
    // The migrations themselves are applied by the workflow step before this runs, with the
    // command production uses verbatim and no `|| true` — so a migration that cannot apply has
    // already failed the job by the time this executes. What this asserts is the CONSEQUENCE: the
    // backend, holding a pool against the freshly-migrated database, reports it healthy.
    //
    // Asserted STRICTLY. The first version of this test read `if ('database' in body)` and
    // tolerated the field being absent — which made it pass against a build that reports nothing
    // at all, i.e. against exactly the broken image it was written to catch.
    const res = await request.get(`${API}/health`, { timeout: 15_000 });
    expect(res.ok(), `/health returned ${res.status()}`).toBe(true);
    // `checks.database`, not `database`. The payload nests its probes one level down, and the
    // first version of this read the top level — where the value is always undefined, so the
    // assertion failed against a perfectly healthy image. The whole error message is included
    // below for exactly that reason: a shape mismatch here must read as a shape mismatch.
    const body = (await res.json()) as { checks?: { database?: { status?: string } } };
    expect(
      body.checks?.database?.status,
      `/health did not report the database as ok — payload was: ${JSON.stringify(body)}`,
    ).toBe('ok');
  });
});

/**
 * WHAT A CANDIDATE STACK CAN HONESTLY SAY ABOUT THE CLIENT-WEB IMAGE.
 *
 * Not "does it talk to the candidate backend" — it structurally cannot. Next.js bakes every
 * `NEXT_PUBLIC_*` value into the browser bundle at BUILD time, and this image was built with
 * `NEXT_PUBLIC_API_URL=https://api.flowvidco.com`. Setting that variable at runtime in the
 * compose file changes what server-side code reads and nothing the browser does.
 *
 * That matters more than it looks. The first version of this block asserted "the page requests
 * no origin outside this stack" and would have FAILED EVERY RELEASE, because the page correctly
 * requests the production API. A gate that fails on correct behaviour does not get fixed — it
 * gets deleted, and takes the checks that worked with it.
 *
 * So the claim is narrowed to what is actually true of this artifact, and it is the more valuable
 * claim anyway: the BAKED CONFIGURATION IS RIGHT. That can only be checked on the built image —
 * no source-level test can see it — and getting it wrong is a shipped incident, not a test
 * failure. It has happened here twice: `http://localhost:8080` served to real browsers, and a
 * `pub-*.r2.dev` origin that `frame-src` refused.
 */
test.describe('the client-web image was built with the right origins baked in', () => {
  test('the served document and its bundles name no loopback origin', async ({ page }) => {
    // A localhost URL in a production bundle is invisible to every source test — the dev server
    // resolves it — and fatal in a browser that is not the build machine.
    //
    // THE BUNDLES ONLY, NOT THE DOCUMENT. Server-rendered HTML legitimately reflects the runtime
    // environment, and this stack deliberately sets NEXT_PUBLIC_APP_URL to a loopback address —
    // so asserting the document is loopback-free would be asserting against the compose file
    // three directories away, and would fail for a reason that has nothing to do with the image.
    // The .js chunks are baked at build time and cannot be influenced by anything set here, which
    // makes them the only part of the response that says something about the ARTIFACT.
    const html = await (await page.request.get(APP, { timeout: 30_000 })).text();

    const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]).slice(0, 8);
    expect(scripts.length, 'the document referenced no scripts — it did not render').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const src of scripts) {
      const url = src.startsWith('http') ? src : new URL(src, APP).toString();
      const body = await (await page.request.get(url, { timeout: 30_000 })).text();
      // THE SAME PATTERN `deploy/scripts/scan-bundle-localhost.sh` USES, deliberately.
      //
      // A bare `http://localhost` is NOT a defect: the Firebase SDK ships one in its own
      // internals, so matching it would have failed this gate on every release — the repo learned
      // that once already and wrote it down in that script's comments, which is where this came
      // from. What is a defect is a loopback host with one of OUR ports on it, or an internal
      // Docker service name: those can only have arrived from a missing build variable.
      //
      // That script scans a REBUILD of the source. This scans the shipped image, which is the
      // only place a build-arg mistake between the two can show up.
      if (/(localhost|127\.0\.0\.1):(8080|3000|3001)|https?:\/\/(backend|worker|nginx|client-web|admin-web)(:|\/)/.test(body)) {
        offenders.push(url);
      }
    }
    expect(offenders, `production bundles embed a loopback origin:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('the page renders without a chunk-load or hydration failure', async ({ page }) => {
    // The signature of a partially-built or mis-assembled image: the document arrives, then the
    // JS that makes it an application fails to. Automatic deployment makes this more likely to
    // reach production, not less, because no one is watching the first page load any more.
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3_000);

    const fatal = errors.filter((e) =>
      /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported|Unexpected token '<'|Hydration failed/i.test(e),
    );
    expect(fatal, `the image serves a page that cannot boot:\n${fatal.join('\n')}`).toEqual([]);
  });
});

/**
 * A STORED KEY BECOMES SOMETHING A BROWSER CAN FETCH — through the adapter production uses.
 *
 * The owner named this flow: "legacy DB URL without token → backend processing/token minting →
 * valid final URL → resource successfully loads". Its full form needs a signed-in identity and
 * real production data, so it lives in `production-flows.spec.ts` and runs post-deploy. What
 * belongs HERE is the half that is a property of the IMAGE: given an object in the bucket, does
 * this build read it back and serve it correctly?
 *
 * That is not a small question. Both production incidents of this shape were the backend building
 * a URL from configuration instead of asking the storage adapter — one emitted
 * `http://localhost:8080/...` to real browsers, the other a `pub-*.r2.dev` origin that `frame-src`
 * refused. And `/sim-public/*` exists precisely because Supabase's public endpoint downgrades
 * `text/html` to `text/plain`, so an iframe pointed at the bucket shows raw source. That proxy
 * re-asserts the Content-Type, and whether THIS image still does so is exactly an image question.
 *
 * ── FAIL CLOSED, NEVER SKIP ───────────────────────────────────────────────────────────────────
 * The first version of this block walked whatever JSON a public endpoint returned and fetched any
 * URLs it found. Against a stack that seeds nothing that is an empty list, a loop that never runs,
 * and a test reporting PASS while asserting nothing. Vacuous green is worse than no test: it is
 * the failure the gate was built to stop, reproduced inside the gate. So the workflow writes real
 * objects into MinIO first and declares them through `CANDIDATE_STORAGE_FIXTURES`; if that is
 * absent these tests FAIL, because an environment that could not be produced is not a pass.
 */
test.describe('a stored object is served back by the image that will deploy', () => {
  interface Fixture { key: string; body: string; match: 'exact' | 'contains'; contentType: string }

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

  test('the object round trips: bucket → adapter → HTTP, with its bytes intact', async ({ request }) => {
    // `match` is declared by the seeding step rather than assumed here, because the route does
    // not treat every key the same and the difference is invisible from the key alone.
    // `injectSimBootSnippet` runs at SERVE time on entry HTML, so the served document is
    // deliberately not the stored one; a blanket byte-equality assertion would fail against a
    // correct image. Non-entry text keys are proxied unmodified and do get compared exactly.
    const exact = fixtures().filter((f) => f.match === 'exact');
    expect(exact.length, 'no byte-comparable fixture was seeded').toBeGreaterThan(0);

    for (const f of fixtures()) {
      const url = `${API}/sim-public/${f.key}`;
      const res = await request.get(url, { timeout: 30_000 });
      expect(res.status(), `seeded object did not load: ${url}`).toBe(200);
      const text = await res.text();
      if (f.match === 'exact') {
        // A 200 carrying an error page, a redirect body, or another object's contents is the
        // failure a status check cannot see.
        expect(text, `served the wrong content for ${f.key}`).toBe(f.body);
      } else {
        expect(text, `the served document lost the stored content of ${f.key}`).toContain(f.body);
      }
    }
  });

  test('the proxy re-asserts text/html, which the bucket would have downgraded', async ({ request }) => {
    // This is the whole reason /sim-public exists. Supabase's public endpoint force-downgrades
    // text/html to text/plain, so an iframe pointed at the bucket shows raw source. If a build
    // ever stops re-asserting the type, every simulation in production renders as plain text —
    // visible to every viewer, invisible to every source-level test.
    const html = fixtures().filter((f) => f.contentType === 'text/html');
    expect(html.length, 'no HTML fixture was seeded, so the downgrade check asserts nothing').toBeGreaterThan(0);
    for (const f of html) {
      const res = await request.get(`${API}/sim-public/${f.key}`, { timeout: 30_000 });
      expect(res.headers()['content-type'] ?? '', `content-type was downgraded for ${f.key}`).toContain('text/html');
    }
  });

  test('a key outside the simulations prefix is refused, however it is spelled', async ({ request }) => {
    // `/sim-public` serves without auth, so its prefix check is the only thing between an
    // anonymous request and a private object. `simulations/..%2f…` decodes to a `..` segment whose
    // leading part matches the allowed prefix while resolving back into the private tree.
    for (const key of ['exports/candidate-smoke/private.mp4', 'simulations/..%2fexports/private.mp4']) {
      const res = await request.get(`${API}/sim-public/${key}`, { maxRedirects: 0, timeout: 20_000 });
      expect(res.status(), `an out-of-prefix key was served: ${key}`).toBe(403);
    }
  });
});
