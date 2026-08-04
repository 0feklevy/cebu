import { defineConfig } from 'vitest/config';

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
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/_archive/**'],
  },
});
