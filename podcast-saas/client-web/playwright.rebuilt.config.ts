import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser validation of the REBUILT production packages (e2e/rebuilt-packages.spec.ts),
 * before any write to shared storage. Requires REBUILT_DIR (see the spec header) and a running
 * backend for the asset proxy.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'rebuilt-packages.spec.ts',
  timeout: 180_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/rebuilt-packages.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
