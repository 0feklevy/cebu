import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit/regression tests for client-web (jsdom). The Playwright production suite
// lives separately under e2e/ and is NOT run by vitest.
export default defineConfig({
  // tsconfig uses jsx:"preserve" (Next); vitest (vite 8 / rolldown) must transform
  // JSX itself — configured via oxc (the esbuild option is ignored on vite 8).
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'jsdom',
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
