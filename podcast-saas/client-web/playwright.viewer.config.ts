import { defineConfig, devices } from '@playwright/test';
import {
  resolveViewerE2eTarget,
  shouldStartViewerE2eServer,
  viewerE2ePort,
  viewerE2eServerEnv,
} from './e2e/viewerE2eTarget';

/**
 * End-to-end suite for the REAL React viewer (e2e/viewer-e2e.spec.ts).
 *
 * Runs against a running client-web server (VIEWER_E2E_BASE_URL, default http://localhost:3100):
 * the real Next route, the real components, the real useProjectPlayer, the real generated bridge.
 * Only the player-config API is stubbed, so the fixture project is deterministic while everything
 * the browser executes stays production code.
 *
 * TARGET IS LOOPBACK-ONLY, ENFORCED. `resolveViewerE2eTarget` throws on any non-loopback value, so
 * this suite cannot be aimed at the deployed site the way its sibling configs deliberately are.
 * See e2e/viewerE2eTarget.ts for why that is an invariant rather than a convention.
 *
 * THE `webServer` IS OPT-IN (`VIEWER_E2E_START_SERVER=1`), never automatic — not even under CI.
 * Starting a second Next server clobbers the .next directory of a dev server the developer is
 * already running (audited: that corrupts it), so a developer's default experience is unchanged:
 * no server is started, and the suite talks to whatever they already have up. CI sets the opt-in
 * and gets its own app on a port that is not the developer's 3000.
 */
const BASE_URL = resolveViewerE2eTarget();

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
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  // `next dev`, not `next build && next start`: next.config.ts FAILS a production build whose
  // NEXT_PUBLIC_* URLs are loopback (the baked-localhost incident), and this suite is loopback by
  // construction. Dev mode is still the real route, the real components and the real bridge.
  //
  // `reuseExistingServer: false` on purpose — when a runner asked for its own app, silently
  // adopting a stranger's server on that port is how a suite ends up reporting on the wrong build.
  webServer: shouldStartViewerE2eServer()
    ? {
        command: `pnpm exec next dev -p ${viewerE2ePort(BASE_URL)}`,
        url: BASE_URL,
        reuseExistingServer: false,
        // Cold `next dev` on a CI runner compiles the route on first request.
        timeout: 300_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: viewerE2eServerEnv(),
      }
    : undefined,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
