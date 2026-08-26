import { defineConfig, devices } from '@playwright/test';

/**
 * The authoring-overlay suite — the ONLY place the picker's badge geometry is checked.
 *
 * It runs its own in-process fixture server (no webServer here), exactly as the sim-transport and
 * sim-canary suites do, so it needs nothing running and reaches no network.
 *
 * Chromium only by default. The properties under test — client-rect coordinates, fixed
 * positioning, pointer-events, and `isTrusted` on a real gesture — are specified behaviour rather
 * than engine-dependent rendering, and three engines would triple the runtime of the slowest kind
 * of test this repo has for no additional signal. The cross-engine risk lives in the sim runtime,
 * which sim-transitions already runs on all three.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sim-authoring.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/sim-authoring.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
