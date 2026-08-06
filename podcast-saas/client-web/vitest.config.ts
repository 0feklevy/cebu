import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

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
    include: ['__tests__/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
