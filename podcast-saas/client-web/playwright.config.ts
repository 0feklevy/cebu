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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
