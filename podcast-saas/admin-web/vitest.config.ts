import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit/regression tests for admin-web (jsdom). admin-web has no Playwright suite; everything
// under __tests__/ runs here.
export default defineConfig({
  // tsconfig uses jsx:"preserve" (Next), so nothing has compiled the JSX by the time vitest sees
  // it — vitest must transform it itself, via oxc (the esbuild option is ignored on vite 8).
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
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
    hookTimeout: 20_000,
    include: ['__tests__/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
