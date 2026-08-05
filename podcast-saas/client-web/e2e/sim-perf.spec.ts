/**
 * MEASURED runtime cost of the simulation pipeline (Priority 8.11 / 8.12).
 *
 * WHY THIS EXISTS RATHER THAN A UNIT BENCHMARK
 * An optimisation claim built from synthetic objects measures the benchmark, not the product. Every
 * number here comes from a real browser running the real viewer against the seeded fixture: real
 * WebGL documents, real HLS video, real transitions. Chrome's CDP supplies process-level CPU and
 * heap; `performance.memory` supplies JS heap where available.
 *
 * GATED the same way the sim-pool suite is, because it needs the seeded fixture and a live app:
 *   cd backend-api && tsx --env-file=../.env src/scripts/seed-sim-pool-fixture.ts
 *   SIM_POOL_E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/sim-perf.spec.ts --project=chromium
 *
 * These assertions are deliberately LOOSE. The purpose is to produce evidence and to catch a gross
 * regression, not to pin a number that varies with the machine — a tight threshold here would fail
 * for reasons that have nothing to do with the code.
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.SIM_POOL_E2E_BASE_URL;
const FIXTURE = '00000000-0000-4000-a000-0000000f1c7e';
const A1 = 20, A2 = 50, B = 72;

test.skip(!BASE, 'Set SIM_POOL_E2E_BASE_URL to run the perf measurement suite');
test.describe.configure({ mode: 'serial', retries: 0 });

interface Sample { label: string; jsHeapMb: number | null; cpuMs: number | null; frames: number; transitions: number[] }

/**
 * Process metrics from CDP, not `performance.memory`.
 *
 * `performance.memory` is quantised and cached by Chrome for privacy — it reported the identical
 * figure at every point in a run where document count went 0 -> 1 -> 2, i.e. it cannot discriminate
 * the thing being measured. CDP's Performance domain reports the real used heap and cumulative task
 * duration, which do move.
 */
async function metrics(page: Page): Promise<{ heapMb: number | null; cpuMs: number | null }> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const { metrics: m } = await cdp.send('Performance.getMetrics') as unknown as
      { metrics: { name: string; value: number }[] };
    await cdp.detach().catch(() => {});
    const get = (n: string): number | null => m.find((x) => x.name === n)?.value ?? null;
    const heap = get('JSHeapUsedSize');
    const task = get('TaskDuration');
    return {
      heapMb: heap === null ? null : Math.round((heap / 1048576) * 10) / 10,
      cpuMs: task === null ? null : Math.round(task * 1000),
    };
  } catch {
    // Non-Chromium engines have no CDP. Reported as null rather than guessed.
    return { heapMb: null, cpuMs: null };
  }
}

/** Transition totals the runtime measured itself — the same numbers RUM would report. */
async function transitions(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    ((window as unknown as { __SIM_TELEMETRY__?: { events: Array<Record<string, unknown>> } })
      .__SIM_TELEMETRY__?.events ?? [])
      .filter((e) => e.event === 'reveal' && typeof e.totalMs === 'number')
      .map((e) => e.totalMs as number));
}

async function open(page: Page, q = ''): Promise<void> {
  await page.goto(`${BASE}/projects/${FIXTURE}/view?simdebug=1${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('video')?.play().catch(() => {}));
}
async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate((x) => { const v = document.querySelector('video'); if (v) v.currentTime = x; }, t);
}

const samples: Sample[] = [];

test.afterAll(() => {
  mkdirSync('e2e-results', { recursive: true });
  writeFileSync('e2e-results/sim-perf.json', JSON.stringify(samples, null, 2));
  for (const s of samples) {
    const t = [...s.transitions].sort((a, b) => a - b);
    const p50 = t.length ? Math.round(t[Math.floor(t.length / 2)]! * 10) / 10 : null;
    const max = t.length ? Math.round(t[t.length - 1]! * 10) / 10 : null;
    // eslint-disable-next-line no-console
    console.log(`PERF ${s.label.padEnd(14)} heap=${String(s.jsHeapMb ?? 'n/a').padStart(6)}MB `
      + `cpu=${String(s.cpuMs ?? 'n/a').padStart(6)}ms docs=${s.frames} n=${t.length} `
      + `p50=${p50 ?? 'n/a'}ms max=${max ?? 'n/a'}ms`);
  }
});

/** Drive the player into a sim section and wait until it is actually on screen. */
async function enterSim(page: Page, at: number): Promise<void> {
  await seek(page, at + 2);
  await page.waitForFunction(() => !!document.querySelector('.sim-overlay.visible'), null,
    { timeout: 20_000 }).catch(() => { /* recorded as a miss rather than a hard failure */ });
  await page.waitForTimeout(1200);
}

async function snapshot(page: Page, label: string): Promise<Sample> {
  const m = await metrics(page);
  const s: Sample = {
    label,
    jsHeapMb: m.heapMb,
    cpuMs: m.cpuMs,
    frames: await page.evaluate(() => document.querySelectorAll('iframe.sim-pool-frame').length),
    transitions: await transitions(page),
  };
  samples.push(s);
  return s;
}

test('COLD vs WARM transition latency, measured in a real browser', async ({ page }) => {
  // COLD: a fresh document that has never run this section. This is the number a first-time viewer
  // experiences and the one predictive preparation exists to remove.
  await open(page);
  await enterSim(page, A1);
  const cold = await snapshot(page, 'cold@A1');

  // WARM: leave and re-enter the SAME package. The document is resident and painted, so the
  // transition is the reveal decision alone — which is precisely the pool's value.
  await seek(page, 5);
  await page.waitForTimeout(2500);
  await enterSim(page, A1);
  const warm = await snapshot(page, 'warm@A1');

  // A DIFFERENT package in the same session: resident under the pool, cold under single mode.
  await enterSim(page, B);
  await snapshot(page, 'pool@B');

  expect(cold.transitions.length + warm.transitions.length,
    'no transition was measured at all — every number in this run would be empty').toBeGreaterThan(0);
  // The pool is bounded; accumulation would show here first.
  expect(warm.frames).toBeLessThanOrEqual(6);
});

test('kill switch: single mode holds fewer documents than the pool', async ({ page }) => {
  await open(page, '&simpool=single');
  await enterSim(page, A1);
  await snapshot(page, 'single@A1');
  await enterSim(page, B);
  const last = await snapshot(page, 'single@B');

  for (const s of samples.filter((x) => x.label.startsWith('single@'))) {
    expect(s.frames, `${s.label} held ${s.frames} documents`).toBeLessThanOrEqual(1);
  }
  const poolMax = Math.max(0, ...samples.filter((s) => !s.label.startsWith('single@')).map((s) => s.frames));
  expect(last.frames).toBeLessThanOrEqual(poolMax);
});
