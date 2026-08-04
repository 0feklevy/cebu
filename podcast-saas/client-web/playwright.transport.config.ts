import { defineConfig, devices } from '@playwright/test';

/**
 * THE PARENT-TRANSPORT SUITE (e2e/sim-transport.spec.ts).
 *
 * It executes the SHIPPING module — lib/sim/SimTransport.ts, bundled fresh by esbuild in
 * `beforeAll` and injected into the harness page — against the real v3 child runtime embedded in
 * the generated fixture package. It is the only suite in this repository that runs that module in a
 * browser; every other one re-expresses it, and a re-expression cannot notice that it has drifted
 * from the code it imitates.
 *
 * Like the canary and the hostile-input suite it does NOT boot the application: the harness page
 * and the package bytes are served by an in-process fixture server and addressed on the API origin
 * through route interception. Nothing here needs the Next server, and nothing here touches the
 * network.
 *
 *   npx playwright test --config=playwright.transport.config.ts
 *
 * ALL THREE ENGINES, ALWAYS. Everything this suite asserts — MessagePort transfer, the exact-origin
 * offer, the ordering of a bootstrap accept, what a closed port does to a pending send — is engine
 * behaviour the transport is built on top of. A guarantee that holds in Chromium and not in WebKit
 * is not a guarantee, so the engines are not behind an opt-in flag.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sim-transport.spec.ts',
  // Each test mounts a real document and completes a real handshake; the two bounded-wait tests
  // additionally sit out the transport's own 1.5s bootstrap deadline twice.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // ZERO retries. Every fact here is deterministic by construction: the message is delivered by the
  // harness and the outcome is a callback the transport itself made. A retry could only hide a real
  // transport defect behind a second roll of the dice, and `flaky` is not an answer to "did the
  // parent accept a forged acknowledgement".
  retries: 0,
  outputDir: 'e2e-results/transport-artifacts',
  reporter: [['list'], ['json', { outputFile: 'e2e-results/sim-transport-playwright.json' }]],
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
