import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser validation of the REBUILT simulation packages (e2e/rebuilt-packages.spec.ts),
 * before any write to shared storage.
 *
 * NO PREREQUISITES for the default run: the spec generates its own control dump (synthetic stored
 * bytes pushed through the real rebuild transforms) and those packages reference nothing external,
 * so it needs neither a backend nor a database. Set REBUILT_DIR to ALSO drive a real
 * `prove-sim-rebuild.ts --dump-dir` dump; that is the case whose assets are proxied to a running
 * backend (SIM_BACKEND_ORIGIN, default http://localhost:8080).
 *
 * `workers: 1` is load-bearing beyond ordering: the control dump is generated into one shared
 * directory, and concurrent workers would race to rewrite the bytes another worker is serving.
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
