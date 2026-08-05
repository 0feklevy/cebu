import { defineConfig, devices } from '@playwright/test';

/**
 * Production smoke/audit tests run against the DEPLOYED site (not a local dev
 * server), so the base URL is configurable and there is no webServer.
 *
 *   SMOKE_BASE_URL=https://flowvidco.com npx playwright test
 *
 * Outputs (consumed by the release pipeline):
 *   e2e-results/results.json        Playwright JSON report (pass/fail counts)
 *   e2e-results/browser-audit.json  flowvid.browser-audit/v1 (production-audit.spec.ts)
 *   e2e-results/html                HTML report (uploaded on failure)
 *   e2e-results/artifacts           traces + screenshots on failure
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  outputDir: 'e2e-results/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-results/results.json' }],
    ['html', { outputFolder: 'e2e-results/html', open: 'never' }],
  ],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'https://flowvidco.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: false,
  },
  // Three engines, because the sim runtime's riskiest surfaces diverge between them:
  // requestVideoFrameCallback shipped years apart across engines, WebKit and Gecko differ on
  // MessageChannel/transferable timing, and WebGL context-loss behaviour is engine-specific. A
  // single-engine matrix cannot see any of that.
  //
  // Chromium stays first so the common case fails fastest.
  //
  // deviceScaleFactor is PINNED TO 1 on every project, overriding the device presets.
  // `devices['Desktop Safari']` is a Retina profile (DSR 2) while `Desktop Chrome` is not, so
  // without this the matrix compares device profiles rather than engines — and the difference is
  // not cosmetic. Poster capture is DPR-dependent, and `posterIdentity` has NO dpr axis: at DSR 2
  // the canary captures 2560x1440 where it expects 1280x720, i.e. one poster identity mapping to
  // images four times the size depending on which machine ran the capture. Pinning it makes the
  // captured bytes a property of the package, which is what the identity claims they are.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 } },
  ],
});
