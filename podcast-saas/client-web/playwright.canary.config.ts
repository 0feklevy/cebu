import { defineConfig, devices } from '@playwright/test';

/**
 * The publish-time browser canary (e2e/sim-canary.spec.ts).
 *
 * It certifies a STAGED simulation package: it does not boot the application, does not need a
 * client-web server, and does not touch the network — the package bytes are served by an in-process
 * fixture server and addressed on the API origin through route interception, exactly as production
 * serves them under /sim-public/.
 *
 *   npx playwright test --config=playwright.canary.config.ts
 *
 * Output: e2e-results/sim-canary.json (a CanaryReport, consumed by canaryJudge on the server) and
 * e2e-results/sim-canary-posters/<identity>/<size>.png.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sim-canary.spec.ts',
  // The whole run happens inside one beforeAll (which raises its own budget); the per-test timeout
  // covers only the assertions over the finished report, which are pure and instant.
  timeout: 900_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // ZERO retries. This is a publication gate: a package that needed a second attempt has not
  // demonstrated the guarantee, and `flaky` is not a classification the contract has.
  retries: 0,
  outputDir: 'e2e-results/canary-artifacts',
  reporter: [['list'], ['json', { outputFile: 'e2e-results/sim-canary-playwright.json' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Posters are captured at exact pixel sizes; a scale factor other than 1 would silently make
    // every capture twice the requested dimensions.
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } },
    // A guarantee that holds in one engine and not another is not a guarantee — merge the reports
    // with mergeCanaryReports() to get one verdict. Enable with CANARY_ALL_ENGINES=1.
    ...(process.env.CANARY_ALL_ENGINES
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'], deviceScaleFactor: 1 } },
          { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 } },
        ]
      : []),
  ],
});
