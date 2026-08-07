import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the sim-transition suite — runs the SAME frame-by-frame spec across
// Chromium, Firefox and WebKit. It uses its own in-process fixture server (no webServer here).
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sim-transitions.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/sim-transitions.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
