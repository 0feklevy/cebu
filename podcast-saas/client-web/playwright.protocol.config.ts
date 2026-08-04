import { defineConfig, devices } from '@playwright/test';

/**
 * THE HOSTILE-INPUT SUITE (e2e/sim-protocol.spec.ts) — Priority 4.8, second half.
 *
 * It drives the REAL v3 child runtime (backend-api/src/services/simulation/simRuntimeChild.ts,
 * embedded verbatim in the generated fixture package) in a real browser and deliberately sends it
 * stale and malformed messages: offers from the wrong source, offers with the wrong version or the
 * wrong number of ports, envelopes with the wrong identity, duplicated and reordered sequence
 * numbers, malformed payloads, structurally hostile objects, and a genuine A → B → A stale
 * acknowledgement.
 *
 * Like the publish canary it does NOT boot the application: the package bytes are served by an
 * in-process fixture server and addressed on the API origin through route interception, exactly as
 * production serves them under /sim-public/. Nothing here needs the Next server, and nothing here
 * touches the network.
 *
 *   npx playwright test --config=playwright.protocol.config.ts
 *
 * Output: e2e-results/sim-protocol-<engine>.json (the full attack ledger, including the evidence
 * for every attack that was proven ignored).
 *
 * ALL THREE ENGINES, ALWAYS. A message-port/origin guarantee that holds in Chromium and not in
 * WebKit is not a guarantee — the bootstrap rules this suite attacks are exactly the rules whose
 * enforcement differs most between engines, so the engines are not behind an opt-in flag.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sim-protocol.spec.ts',
  // The whole drive happens inside one beforeAll (which raises its own budget); the per-test timeout
  // covers only the assertions over the finished ledger, which are pure and instant.
  timeout: 1_500_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // ZERO retries. Every attack in this suite is deterministic by construction — the hostile message
  // is delivered by the harness, and the proof that it was ignored is a counter the child itself
  // keeps. A retry could only ever hide a real refusal-path defect behind a second roll of the dice,
  // and `flaky` is not an answer to "did the runtime accept a forged message".
  retries: 0,
  outputDir: 'e2e-results/protocol-artifacts',
  reporter: [['list'], ['json', { outputFile: 'e2e-results/sim-protocol-playwright.json' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 } },
  ],
});
