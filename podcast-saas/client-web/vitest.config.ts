import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { maxTestWorkers } from '../shared/vitest.workers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Unit/regression tests for client-web (jsdom). The Playwright production suite
// lives separately under e2e/ and is NOT run by vitest.
export default defineConfig({
  // tsconfig uses jsx:"preserve" (Next); vitest (vite 8 / rolldown) must transform
  // JSX itself — configured via oxc (the esbuild option is ignored on vite 8).
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      // Tests run against shared's SOURCE, production runs against its dist — the same rule
      // backend-api/vitest.config.ts already applies, for the same reason.
      //
      // `shared/sim/*` resolves to `dist` through shared's exports map (plain node cannot load raw
      // TypeScript). Without this alias every client-web test that imports a shared module
      // exercises the LAST BUILT copy: editing shared/src and re-running the suite tests stale
      // code and passes. That is not hypothetical here — a mutation deleting the entire
      // `no-lab-budget` guard from shared/src/sim/adaptiveQuality.ts SURVIVED this suite, because
      // the assertions were reading a dist built before the mutation.
      //
      // The alias is test-only. backend-api's runtimeModuleResolution.test.ts still proves the real
      // dist mapping resolves under plain node, so pointing tests at source cannot hide a broken
      // build.
      { find: /^shared\/sim\/(.*)$/, replacement: resolve(HERE, '../shared/src/sim/$1.ts') },
      { find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // CONTENTION ALLOWANCE, not a licence for slow tests.
    //
    // vitest's default is 5s, and it assumes an idle machine. `pnpm release:verify` runs every
    // workspace's suite CONCURRENTLY, and this repo's audits run many agents at once — under a load
    // average near 50, a jsdom test that takes 200ms idle can take ten seconds without anything
    // being wrong with it. That is not hypothetical: 42 client-web tests went red in exactly that
    // state during the 2026-08-15 audit and were briefly read as a regression. Every one of them
    // passed on an idle machine (1405/1405), which is the signature of a timeout, not a bug — and a
    // suite that cries wolf under load is worse than no suite, because the next real red gets waved
    // through.
    //
    // 20s, not backend-api's 60s: nothing here boots a database, so the honest budget is far
    // smaller. It buys ~4x headroom for scheduler starvation while still surfacing a genuinely hung
    // test in twenty seconds rather than a minute. If a test in these suites ever legitimately needs
    // more than this, the test is doing something that belongs in backend-api or in Playwright.
    testTimeout: 20_000,
    // Bounded so `pnpm -r test` (release:verify) cannot ask four suites for the whole machine
    // each — see shared/vitest.workers.mjs for the arithmetic and why it is half, not all.
    maxWorkers: maxTestWorkers(),
    hookTimeout: 20_000,
    // Pins navigator hardware metrics — see the file's header for why a suite that reads the
    // host's real core count is testing the hardware, not the product.
    setupFiles: ['./vitest.setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    /**
     * PIN THE API ORIGIN THE SUITE RESOLVES AGAINST.
     *
     * `shared/src/sim/simUrl` computes `API_BASE` from `process.env.NEXT_PUBLIC_API_URL` at module
     * load, falling back to `http://localhost:8080` only outside production. The rebase then
     * short-circuits when the stored URL is ALREADY on that origin
     * (`if (u.origin === base.origin) return u`).
     *
     * So the suite's behaviour depended on ambient environment. Locally the fallback applied and the
     * fixture (stored under `https://api.flowvidco.com`) was rebased, which is what the tests
     * assert. Under `pnpm release:verify` — the project's own gate — `release-verify.sh` exports
     * `NEXT_PUBLIC_API_URL=https://api.flowvidco.com`, the fixture is already on that origin,
     * nothing is rebased, and three assertions failed in CI while passing on every developer
     * machine.
     *
     * Pinning it here makes the suite hermetic and, more importantly, keeps the rebase test
     * MEANINGFUL: the fixture origin and this origin differ, so a cross-origin rebase is genuinely
     * exercised in every environment rather than accidentally short-circuiting in some of them.
     */
    env: {
      NEXT_PUBLIC_API_URL: 'http://localhost:8080',
    },
  },
});
