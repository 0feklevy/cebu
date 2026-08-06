/**
 * Adaptive simulation-pool behavior tests (feat/sim-pool-adaptive).
 *
 * GATED: runs only when SIM_POOL_E2E_BASE_URL is set (the default e2e suite targets the
 * deployed site and must not require a local viewer + WebGL sims). Point it at a local dev
 * server or a preview deploy that serves the seeded fixture:
 *
 *   cd backend-api && tsx --env-file=../.env src/scripts/seed-sim-pool-fixture.ts
 *   SIM_POOL_E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/sim-pool.spec.ts
 *
 * The fixture (seed-sim-pool-fixture.ts) has 3 distinct sim packages + a branch:
 *   Main path: §A1 boids(minimal-ui, 20-35s), §A2 boids(full-ui, 50-62s), §B murmuration(72-88s)
 *   Deep dive (branch): §C pluck-boids (LEGACY bridge)
 * Package C is branch-only → must NOT be pooled on the main path.
 *
 * Assertions observe the viewer EXTERNALLY (iframe count, .sim-overlay.visible, telemetry via
 * ?simdebug=1) — no app instrumentation beyond the shipped telemetry hook.
 */
import { test, expect, type Page } from '@playwright/test';
import { installLoopbackGuard, type NetworkGuard } from './networkGuard';

const BASE = process.env.SIM_POOL_E2E_BASE_URL;
/**
 * Package identities come from the FIXTURE, never from a human-readable substring.
 *
 * Pool keys are `packageKeyOf(url)` = origin + pathname of the SERVED document, which under the
 * synthetic seeder is a UUID path under the active revision. A predicate like
 * `key.includes('pluck-boids')` can therefore never match anything, which made the branch-preload
 * assertion unfalsifiable: it passed whether or not the branch package was preloaded.
 */
const LEGACY_PACKAGE_KEY = process.env.SIM_POOL_LEGACY_PACKAGE_KEY ?? '0f1c7e01-0000-4000-a000-000000000003';
const MAIN_PACKAGE_KEYS = (process.env.SIM_POOL_MAIN_PACKAGE_KEYS
  ?? '0f1c7e01-0000-4000-a000-000000000001,0f1c7e01-0000-4000-a000-000000000002').split(',');
/** The branch package's two occurrences (global seconds on the BRANCH video). */
const C1 = { start: 15, end: 30 };
const C2 = { start: 40, end: 55 };
const keyed = (ev: Array<Record<string, unknown>>, id: string) =>
  ev.filter((e) => typeof e.key === 'string' && (e.key as string).includes(id));
const FIXTURE = '00000000-0000-4000-a000-0000000f1c7e';
// Main-path sim sections (global seconds) — from the fixture seed.
const A1 = { start: 20, end: 35 };   // boids, minimal UI
const A2 = { start: 50, end: 62 };   // boids, full UI (same package)
const B  = { start: 72, end: 88 };   // murmuration

test.skip(!BASE, 'Set SIM_POOL_E2E_BASE_URL to run the sim-pool fixture suite');
// Serial so a shared browser isn't thrashed; retries absorb real-HLS-over-network seek jitter
// (backward seeks can re-buffer, which briefly stalls timeupdate — an environmental factor,
// not a pool bug). These assert BEHAVIOR, not timing budgets (see sim-pool-audit-report.md).
// RETRIES OFF. The file previously configured `retries: 2` to absorb real-HLS-over-network seek
// jitter, but a suite that needs a second attempt has not proven anything — the same standard the
// canary config already applies. Serial is kept: a shared browser thrashed by parallel WebGL
// documents is a genuine environmental problem, not a flaky assertion.
test.describe.configure({ mode: 'serial', retries: 0 });

/**
 * LOOPBACK-ONLY, ENFORCED. This suite runs against a fully synthetic local fixture (synthetic org,
 * project, sections; locally generated simulation packages carrying the real bridge and child
 * runtime; a locally encoded HLS ladder; local-disk storage). Pointing the base URL at localhost
 * does not prove the PAGE stayed local, so every request is intercepted: anything that is not
 * localhost/127.0.0.1/::1 is aborted and fails the test by name. The hosts actually contacted are
 * recorded and reported.
 */
let guard: NetworkGuard;
/** Set ONLY by the guard self-test, which fires one deliberate (non-routable) violation. */
let guardSelfTestExpectedViolation = false;
test.beforeEach(async ({ page }, testInfo) => {
  guardSelfTestExpectedViolation = false;
  guard = await installLoopbackGuard(page, testInfo);
});
test.afterEach(async () => {
  if (guardSelfTestExpectedViolation) {
    expect(guard.violations(), 'the self-test expected exactly its own deliberate violation')
      .toEqual(['198.51.100.1']);
  } else {
    guard.assertLoopbackOnly();
  }
  // eslint-disable-next-line no-console
  console.log(`[network-guard] hosts contacted: ${guard.hosts().join(', ') || '(none)'}`);
});

const viewUrl = (q = '') => `${BASE}/projects/${FIXTURE}/view?simdebug=1${q}`;

async function openAndPlay(page: Page, q = '') {
  await page.goto(viewUrl(q), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.duration > 60), null, { timeout: 60_000 });
  await page.locator('body').click({ position: { x: 200, y: 200 } });   // startPlayback
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.duration > 60 && !v.paused && v.currentTime > 0.1), null, { timeout: 30_000 }).catch(() => {});
}
// Seek EVERY main video (>60s): the player crossfades between an A/B pair, so setting only
// the first match can hit the off-screen standby while the active one keeps playing.
const seek = (page: Page, s: number) => page.evaluate((sec) => {
  for (const v of document.querySelectorAll('video')) if ((v as HTMLVideoElement).duration > 60) (v as HTMLVideoElement).currentTime = sec;
}, s);
/**
 * SIM frames only.
 *
 * This counted every `iframe` on the page, which silently included the Firebase auth SDK's hidden
 * RPC helper. That helper is present on WebKit at moments it is not on Chromium, so the kill-switch
 * assertion failed there with 2 — and the sim pool held exactly one frame the whole time. A count
 * that includes documents the player does not own cannot say anything about the pool.
 */
const iframeCount = (page: Page) => page.evaluate(() =>
  document.querySelectorAll('iframe.sim-pool-frame').length);
const overlayVisible = (page: Page) => page.evaluate(() => !!document.querySelector('.sim-overlay.visible'));
const telemetry = (page: Page) => page.evaluate(() => (window as unknown as { __SIM_TELEMETRY__?: { events: Array<Record<string, unknown>> } }).__SIM_TELEMETRY__?.events ?? []);

// The fixture is REVISION-BACKED, and this proves it rather than asserting it in a comment.
//
// The seeder writes package bytes ONLY under the active revision prefix and leaves the stored
// `simulation_url` pointing at the legacy prefix, which holds nothing. So if `active_revision_id` /
// `active_revision_entry_key` were missing — or buildPlayerConfig stopped rewriting the url from
// them — the player would be handed the legacy url and every simulation document would 404. A
// previous version of this fixture wrote no pointer at all and silently ran the legacy path while
// its own comment claimed otherwise.
test('every simulation resolves through its ACTIVE REVISION, not the legacy prefix', async ({ page }) => {
  const res = await page.request.get(`${BASE!.replace(':3010', ':8080')}/api/v1/projects/${FIXTURE}/player-config`);
  expect(res.ok(), 'player-config did not load').toBe(true);
  const cfg = await res.json() as { segments: Array<{ simulations: Array<{ simulation_url?: string }> }> };
  const urls = cfg.segments.flatMap((sg) => sg.simulations.map((x) => x.simulation_url)).filter(Boolean) as string[];
  expect(urls.length, 'no simulation sections in the fixture').toBeGreaterThan(0);

  const REV = /\/revisions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//;
  const legacy = urls.filter((u) => !REV.test(u));
  expect(legacy, 'a simulation resolved through the LEGACY prefix — the active pointer is missing').toEqual([]);

  // …and the revision bytes are really there: entry AND its sibling bridge, which the entry loads
  // with a RELATIVE script tag.
  const entry = urls[0]!.split('?')[0]!;
  const bridge = entry.replace(/[^/]+$/, 'bridge.js');
  expect((await page.request.get(entry)).status(), 'revision entry document did not serve').toBe(200);
  expect((await page.request.get(bridge)).status(), 'revision bridge did not serve beside the entry').toBe(200);
});

test('direct seek into an unprepared simulation eventually reveals (no indefinite hold, no permanent blank)', async ({ page }) => {
  await openAndPlay(page);
  await seek(page, A2.start + 2);
  // Revealed within the section's lifetime (bounded); never stuck hidden.
  await expect.poll(() => overlayVisible(page), { timeout: 12_000 }).toBe(true);
  // And the revealed sim actually painted (telemetry records a paint before/at the reveal).
  const ev = await telemetry(page);
  expect(ev.some((e) => e.event === 'sim-painted')).toBe(true);
});

test('rapid seeking across simulation sections ends in a consistent single-visible state', async ({ page }) => {
  await openAndPlay(page);
  for (const s of [A1.start + 1, B.start + 1, A2.start + 1, A1.end + 3, B.start + 2]) {
    await seek(page, s);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(3000);
  // Exactly one sim overlay layer, and no runaway iframe growth.
  const visibleLayers = await page.evaluate(() => document.querySelectorAll('.sim-overlay.visible').length);
  expect(visibleLayers).toBeLessThanOrEqual(1);
  expect(await iframeCount(page)).toBeLessThanOrEqual(4);
});

test('leaving and immediately re-entering the same simulation re-reveals it', async ({ page }) => {
  await openAndPlay(page);
  await seek(page, A1.start + 2);
  await expect.poll(() => overlayVisible(page), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(1500);                   // let any in-flight reveal settle before leaving
  await seek(page, A1.end + 4);                       // leave FORWARD into the buffered gap (35-50)
  await expect.poll(() => overlayVisible(page), { timeout: 15_000 }).toBe(false);
  await seek(page, A1.start + 2);                     // re-enter the SAME section — the core claim
  await expect.poll(() => overlayVisible(page), { timeout: 15_000 }).toBe(true);
});

test('branching path does NOT preload the branch-only package on the main path', async ({ page }) => {
  await openAndPlay(page);
  await page.waitForTimeout(4000);                    // let the pool arm + warm on the main path
  const ev = await telemetry(page);

  // The main path DID pool — otherwise "C is absent" would be trivially true because nothing pooled.
  const added = ev.filter((e) => e.event === 'pool-spec-add' || e.event === 'pool-init');
  expect(added.length, 'nothing pooled at all, so the absence of C proves nothing').toBeGreaterThan(0);
  const mainResident = MAIN_PACKAGE_KEYS.filter((k) => keyed(ev, k).length > 0);
  expect(mainResident.length, 'no main-path package became resident').toBeGreaterThan(0);

  // …and the branch-only package is absent, matched by its ACTUAL fixture identity.
  expect(keyed(ev, LEGACY_PACKAGE_KEY).map((e) => e.event),
    'the branch-only package was preloaded before the branch was chosen').toEqual([]);
});

test('kill switch (?simpool=single) keeps at most one sim iframe resident', async ({ page }) => {
  await openAndPlay(page, '&simpool=single');
  const init = await telemetry(page);
  expect(init.some((e) => e.event === 'pool-init' && e.mode === 'single')).toBe(true);
  await seek(page, A1.start + 2);
  await expect.poll(() => overlayVisible(page), { timeout: 12_000 }).toBe(true);
  await seek(page, B.start + 2);                      // different package
  await page.waitForTimeout(2500);
  // Single mode drops non-active frames each tick — never a resident pool.
  expect(await iframeCount(page)).toBeLessThanOrEqual(1);
});

test('the load-time-locked package uses the per-URL NAVIGATION fallback between its two occurrences', async ({ page }) => {
  // Reaching the branch means playing the entry video to its choice point and waiting out the
  // auto-advance, which alone exceeds the default per-test budget.
  test.setTimeout(240_000);
  // Package C advertises a bare SIM_READY, so the viewer cannot dispatch sections into a resident
  // document: moving between its two occurrences must NAVIGATE the frame. The fixture gives C two
  // sections with different section ids sharing one pooled package identity, which is what makes
  // `spec.src !== sectionUrl` — the condition `legacyNeedsNav` requires — actually reachable.
  //
  // NO ACTIVATION ESCAPE HATCH. An `activate` event is emitted for every section long before the
  // navigate decision, so accepting it as proof made this test pass even with the fallback deleted.
  await openAndPlay(page);

  // Reach the branch the way the product does: the entry sequence's choice point fires near the end
  // of its video and auto-advances (behavior 'continue', timeout_sec 8) into "Deep dive".
  const dur = await page.evaluate(() => {
    for (const v of document.querySelectorAll('video')) if ((v as HTMLVideoElement).duration > 60) return (v as HTMLVideoElement).duration;
    return 0;
  });
  await seek(page, Math.max(0, dur - 8));
  // WE ARE ON THE BRANCH WHEN THE BRANCH VIDEO IS LOADED, identified by a duration BAND centred on
  // the branch video's 60s, far from the entry video's 95s.
  //
  // Two earlier attempts were wrong and are worth recording: `duration > 10 && duration < 60`
  // excluded the branch video's own 60s at the boundary (chromium happened to round inside the
  // window, firefox and webkit did not), and `currentSrc.includes('/branch/')` can never match
  // because hls.js plays through MSE, so `currentSrc` is a `blob:` URL and carries no path at all.
  const BRANCH_SEC = 60;
  const onBranch = () => page.evaluate((target) =>
    [...document.querySelectorAll('video')].some((v) => Math.abs((v as HTMLVideoElement).duration - target) < 10),
  BRANCH_SEC);
  await expect.poll(onBranch, { timeout: 90_000 }).toBe(true);

  const seekBranch = (sec: number) => page.evaluate(([s, target]) => {
    for (const v of document.querySelectorAll('video')) {
      const el = v as HTMLVideoElement;
      if (Math.abs(el.duration - target) < 10) el.currentTime = s;
    }
  }, [sec, BRANCH_SEC]);

  // First occurrence: the frame mounts on C1's url and reveals.
  await seekBranch(C1.start + 3);
  await expect.poll(() => overlayVisible(page), { timeout: 45_000 }).toBe(true);
  const afterC1 = await telemetry(page);
  expect(keyed(afterC1, LEGACY_PACKAGE_KEY).length, 'package C never became resident').toBeGreaterThan(0);
  const navsBefore = afterC1.filter((e) => e.event === 'navigate').length;

  // Second occurrence: a DIFFERENT section url on the SAME pooled package → navigation fallback.
  await seekBranch(C2.start + 3);
  await expect.poll(async () => {
    const ev = await telemetry(page);
    return ev.filter((e) => e.event === 'navigate').length;
  }, { timeout: 60_000 }).toBeGreaterThan(navsBefore);

  // And it must still end up presented — a fallback that navigates but never reveals is a failure.
  await expect.poll(() => overlayVisible(page), { timeout: 45_000 }).toBe(true);
});

/**
 * SELF-TEST of the loopback guard's WIRING (its policy is unit-tested in networkGuard.test.ts).
 *
 * Every other test in this suite passes when the guard blocks nothing — which is also exactly what
 * a disabled guard reports. This is the one test a no-op guard cannot pass: it fires a deliberate
 * non-loopback request and requires the guard to have both BLOCKED and RECORDED it.
 *
 * The target is 198.51.100.1 (RFC 5737 TEST-NET-2): guaranteed non-routable and DNS-free, so even
 * if the guard were broken the request could not actually reach a live endpoint — the self-test
 * never becomes the leak it exists to prevent.
 */
test('the guard itself blocks and records a non-loopback request (self-test)', async ({ page }) => {
  await page.goto(viewUrl(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() =>
    fetch('https://198.51.100.1/guard-selftest', { mode: 'no-cors' }).catch(() => undefined));
  await expect.poll(() => guard.violations(), { timeout: 10_000 }).toContain('198.51.100.1');
  expect(() => guard.assertLoopbackOnly(),
    'a blocked request must fail the run, not merely be counted').toThrow(/198\.51\.100\.1/);
  // Consume the violation so afterEach's assertLoopbackOnly reflects the REAL traffic of this test.
  guardSelfTestExpectedViolation = true;
});
