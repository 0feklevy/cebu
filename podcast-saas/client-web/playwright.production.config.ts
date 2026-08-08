import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the PRODUCTION AUDIT only.
 *
 * WHY THIS EXISTS — the failure it fixes
 * --------------------------------------
 * The production audit used to run `npx playwright test` with the default config, whose
 * `testDir: './e2e'` collects every spec in the directory. Only two of those are
 * production audits; the other nine are local suites (sim-canary, sim-leak, sim-protocol,
 * sim-transport, sim-pool, sim-transitions, sim-perf, rebuilt-packages, viewer-e2e) that
 * import backend-api source and `shared/sim/*`.
 *
 * `shared/sim/*` resolves through shared's exports map to its BUILT dist, and the audit
 * job installs only `--filter ops-release --filter client-web` — so backend-api's
 * dependencies are absent and shared is never built. Playwright therefore died during
 * COLLECTION, before a single browser opened:
 *
 *     Error: Cannot find module 'shared/sim/canaryContract'
 *     - backend-api/src/services/simulation/canaryJudge.ts
 *     - client-web/e2e/sim-canary.spec.ts        (run 31199562890)
 *
 * No results.json was produced, which made playwright-summary and browser-audit fail with
 * ENOENT, which the old `|| true` swallowed — so a browser verification that never ran was
 * indistinguishable from one that passed.
 *
 * The fix is the real dependency contract, not an alias: the production audit genuinely
 * needs only the two self-contained specs, and those import nothing outside client-web
 * (`@playwright/test` plus node builtins). The local suites keep their full-workspace
 * assumptions unchanged, so this does NOT hide emitted-runtime behaviour from them — the
 * `shared/sim/*` → dist mapping is still exercised by backend-api's
 * runtimeModuleResolution test and by the local e2e suites under `pnpm test:e2e`.
 *
 * SECOND BUG THIS FIXES: the audit workflow installs only the chromium browser, while the
 * default config declares chromium + firefox + webkit projects. Even with module
 * resolution repaired, two thirds of the matrix would have failed to launch. Auditing
 * production over one engine is the correct scope — engine divergence is a property of the
 * sim runtime and belongs to the local three-engine matrix, not to a liveness check.
 */
export default defineConfig({
  testDir: './e2e',
  // Explicit allow-list, not a glob: a new local spec dropped into e2e/ must not silently
  // join the production audit and reintroduce a cross-package import.
  testMatch: ['production-audit.spec.ts', 'production-smoke.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // No retries. A flaky production probe must be visible as a finding, not smoothed away:
  // retrying until green is how an audit starts lying about availability.
  retries: 0,
  outputDir: 'e2e-results/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-results/results.json' }],
    ['html', { outputFolder: 'e2e-results/html', open: 'never' }],
  ],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'https://flowvidco.com',
    trace: 'retain-on-failure',
    // Screenshots of an authenticated admin session can contain customer data, so they are
    // captured only on failure and the workflow scrubs the artifact set before upload.
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } }],
});
