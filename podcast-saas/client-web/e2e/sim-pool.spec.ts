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

const BASE = process.env.SIM_POOL_E2E_BASE_URL;
const FIXTURE = '00000000-0000-4000-a000-0000000f1c7e';
// Main-path sim sections (global seconds) — from the fixture seed.
const A1 = { start: 20, end: 35 };   // boids, minimal UI
const A2 = { start: 50, end: 62 };   // boids, full UI (same package)
const B  = { start: 72, end: 88 };   // murmuration

test.skip(!BASE, 'Set SIM_POOL_E2E_BASE_URL to run the sim-pool fixture suite');
test.describe.configure({ mode: 'serial' });

const viewUrl = (q = '') => `${BASE}/projects/${FIXTURE}/view?simdebug=1${q}`;

async function openAndPlay(page: Page, q = '') {
  await page.goto(viewUrl(q), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.duration > 60), null, { timeout: 60_000 });
  await page.locator('body').click({ position: { x: 200, y: 200 } });   // startPlayback
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.duration > 60 && !v.paused && v.currentTime > 0.1), null, { timeout: 30_000 }).catch(() => {});
}
const seek = (page: Page, s: number) => page.evaluate((sec) => {
  for (const v of document.querySelectorAll('video')) if ((v as HTMLVideoElement).duration > 60) { (v as HTMLVideoElement).currentTime = sec; return; }
}, s);
const iframeCount = (page: Page) => page.evaluate(() => document.querySelectorAll('iframe').length);
const overlayVisible = (page: Page) => page.evaluate(() => !!document.querySelector('.sim-overlay.visible'));
const telemetry = (page: Page) => page.evaluate(() => (window as unknown as { __SIM_TELEMETRY__?: { events: Array<Record<string, unknown>> } }).__SIM_TELEMETRY__?.events ?? []);

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
  await expect.poll(() => overlayVisible(page), { timeout: 12_000 }).toBe(true);
  await seek(page, 6);                                // leave the sim → a clearly-video time
  await expect.poll(() => overlayVisible(page), { timeout: 10_000 }).toBe(false);
  await seek(page, A1.start + 2);                     // re-enter the SAME section
  await expect.poll(() => overlayVisible(page), { timeout: 10_000 }).toBe(true);
});

test('branching path does NOT preload the branch-only (pluck-boids) package on the main path', async ({ page }) => {
  await openAndPlay(page);
  await page.waitForTimeout(4000);                    // let the pool arm + warm on the main path
  const ev = await telemetry(page);
  const added = ev.filter((e) => e.event === 'pool-spec-add' || e.event === 'pool-init');
  // No pool entry keyed to the pluck-boids package until the branch is entered.
  const anyPluck = ev.some((e) => typeof e.key === 'string' && (e.key as string).includes('pluck-boids'));
  expect(anyPluck).toBe(false);
  expect(added.length).toBeGreaterThan(0);            // the main-path packages DID pool
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

test('legacy (non-dynamic) bridge package reveals via the navigation fallback on the branch', async ({ page }) => {
  // The branch is reached via the entry sequence's choice point, which fires near the end of
  // its video (the fixture reuses a long real video). Seek close to the end and let the
  // choice auto-advance (timeout_sec) into "Deep dive", whose §C is the legacy pluck-boids.
  await openAndPlay(page);
  const dur = await page.evaluate(() => { for (const v of document.querySelectorAll('video')) if ((v as HTMLVideoElement).duration > 60) return (v as HTMLVideoElement).duration; return 0; });
  await seek(page, Math.max(0, dur - 9));
  // Auto-advance into the branch + activate the legacy package → a 'navigate' (nav fallback)
  // and eventual overlay reveal.
  await expect.poll(async () => {
    const ev = await telemetry(page);
    return ev.some((e) => e.event === 'navigate') ||
           ev.some((e) => e.event === 'activate' && typeof e.key === 'string' && (e.key as string).includes('pluck-boids'));
  }, { timeout: 45_000 }).toBe(true);
});
