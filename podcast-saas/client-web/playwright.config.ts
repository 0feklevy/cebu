import { defineConfig, devices } from '@playwright/test';

/**
 * Production smoke tests run against the DEPLOYED site (not a local dev server), so the
 * base URL is configurable and there is no webServer. Point it at the release with:
 *   SMOKE_BASE_URL=https://flowvidco.com npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'https://flowvidco.com',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
