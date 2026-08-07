import { defineConfig, devices } from '@playwright/test';

/**
 * The simulation LEAK + STABILITY suite (Priority 6.7) — e2e/sim-leak.spec.ts.
 *
 * It drives the v3 protocol directly against the staged `v3allmanaged` package: no application, no
 * client-web server, no network. The package bytes come from an in-process fixture server and are
 * addressed on the API origin through route interception, exactly as production serves them under
 * /sim-public/ (the same arrangement playwright.canary.config.ts uses).
 *
 *   npx playwright test --config=playwright.leak.config.ts
 *   npx playwright test --config=playwright.leak.config.ts --project=chromium
 *
 * Output: e2e-results/sim-leak-<engine>.json (the per-kind plateau table plus every measured
 * observation) and e2e-results/sim-leak-playwright.json.
 *
 * WHY THE TIMEOUTS DIFFER PER ENGINE. The contract fixes the CYCLE COUNTS (100 A→B→A cycles, 100
 * suspend/resume round trips, 20 full document epochs) and those counts are never reduced to fit a
 * clock — a suite that quietly ran 40 cycles because an engine was slow would be reporting a
 * property it did not test. So the counts are constant across engines and the BUDGET moves instead:
 * Chromium gets 15 minutes, Firefox and WebKit 30, and a run that still does not finish is reported
 * with its measured duration rather than trimmed.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sim-leak.spec.ts',
  timeout: 900_000,
  expect: { timeout: 15_000 },
  // One page at a time: every test measures live resource counts inside a browser, and a second
  // worker competing for the same machine changes the timing the frame/tick counters are read on.
  fullyParallel: false,
  workers: 1,
  // ZERO retries. A leak that only shows up on one attempt in two is still a leak, and a stability
  // suite that is allowed a second try is measuring the retry, not the stability.
  retries: 0,
  outputDir: 'e2e-results/leak-artifacts',
  reporter: [['list'], ['json', { outputFile: 'e2e-results/sim-leak-playwright.json' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 }, timeout: 900_000 },
    // A leak that is absent in one engine and present in another is still a leak: Firefox and WebKit
    // schedule rAF, timers and object-URL revocation differently enough that the managed scope has
    // been wrong in exactly one of them before.
    { name: 'firefox', use: { ...devices['Desktop Firefox'], deviceScaleFactor: 1 }, timeout: 1_800_000 },
    { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 }, timeout: 1_800_000 },
  ],
});
