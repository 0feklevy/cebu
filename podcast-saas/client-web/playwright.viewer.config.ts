import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite for the REAL React viewer (e2e/viewer-e2e.spec.ts).
 *
 * Runs against a running client-web server (VIEWER_E2E_BASE_URL, default http://localhost:3000):
 * the real Next route, the real components, the real useProjectPlayer, the real generated bridge.
 * Only the player-config API is stubbed, so the fixture project is deterministic while everything
 * the browser executes stays production code.
 *
 * No `webServer` on purpose — building/starting a second Next server here would clobber the .next
 * directory of a dev server the developer is already running (audited: that corrupts it).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'viewer-e2e.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // ZERO retries. This is the release gate: a retry turns a real failure into `flaky` and, worse,
  // masks a mutation-kill signal — a deliberately broken build passed on retry while the clean one
  // failed, and the two were indistinguishable (audited). Use `--retries=N` on the command line
  // for diagnosis only, and report that result as flaky, never as passed.
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/viewer-e2e.json' }]],
  use: {
    baseURL: process.env.VIEWER_E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
