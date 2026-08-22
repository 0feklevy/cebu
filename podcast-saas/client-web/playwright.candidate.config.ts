/**
 * The release-candidate image gate. Runs ONLY `candidate-smoke.spec.ts`, against the containers.
 *
 * `testMatch` is explicit for the same reason `playwright.production.config.ts` spells it out: the
 * default config collects every spec in `e2e/`, and most of them import backend-api and shared/sim
 * SOURCE — which this job neither installs nor builds, so Playwright would die during collection
 * before a browser ever opened, and the failure would look like a broken gate rather than a
 * misconfigured one.
 *
 * `retries: 0` and `forbidOnly` are deliberate: this gate decides whether a release deploys, and a
 * retry would let an intermittent cross-image failure pass on its second attempt — which is
 * exactly the kind of failure worth blocking on.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['candidate-smoke.spec.ts'],
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: [
    ['list'],
    // The gate reads this file. Its absence is a CRITICAL finding, never a pass.
    ['json', { outputFile: 'e2e-results/candidate-smoke.json' }],
  ],
  use: {
    baseURL: process.env.CANDIDATE_APP_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
