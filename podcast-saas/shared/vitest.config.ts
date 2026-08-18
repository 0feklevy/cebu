import { defineConfig } from 'vitest/config';
import { maxTestWorkers } from '../vitest.workers.mjs';

/**
 * `shared` had no test runner at all until now, so `pnpm -r test` walked straight past it and the
 * modules every other workspace depends on were only ever exercised through client-web's suite.
 * That is not the same guarantee: client-web's tests run in jsdom, under Next's tsconfig, and reach
 * these modules through the bundler's resolution of the extensionless `shared/src/sim/x` specifier
 * exported by package.json. The backend reaches the SAME modules as compiled Node16 ESM, where
 * every internal import must carry an explicit `.js`. A dropped extension inside `shared` would
 * therefore stay green in client-web forever while breaking the backend at runtime.
 *
 * So this project deliberately mirrors the CONSUMER that has the stricter contract:
 *   • environment 'node' — no DOM, no jsdom shims. `crypto.getRandomValues` is Node's real
 *     WebCrypto here, which is the branch simIdentity takes on the server.
 *   • tests import siblings with the same `./x.js` specifiers the production sources use, so the
 *     Node16 module graph is what is under test, not a bundler's forgiving approximation.
 */
export default defineConfig({
  test: {
    // No `globals` on purpose: every test imports describe/it/expect explicitly, so `tsc --noEmit`
    // over src/** typechecks this suite without needing an ambient `types` entry in tsconfig.json.
    globals: false,
    environment: 'node',
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
    // each — see ../vitest.workers.mjs for the arithmetic and why it is half, not all.
    maxWorkers: maxTestWorkers(),
    hookTimeout: 20_000,
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/_archive/**'],
  },
});
