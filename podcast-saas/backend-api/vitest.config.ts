import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Tests run against shared's SOURCE, production runs against its dist.
  //
  // `shared/sim/*` is mapped to `dist` in the exports map, because plain node cannot resolve raw
  // TypeScript (see runtimeModuleResolution.test.ts for why that mapping exists). Without this
  // alias the unit suite would silently test the LAST BUILT copy of shared: editing a shared source
  // file and re-running the backend tests would exercise stale code and pass. That is exactly how a
  // mutation of shared/src/sim/prepareBudget.ts survived a test that should have killed it.
  //
  // The alias is test-only. `runtimeModuleResolution.test.ts` still proves the real dist mapping
  // resolves in node, so pointing tests at source cannot hide a broken build.
  resolve: {
    alias: [
      { find: /^shared\/sim\/(.*)$/, replacement: resolve(HERE, '../shared/src/sim/$1.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // PGlite boots a real WASM Postgres per test file — several suites replay all 51 migrations
    // into one. Under full-suite parallel load that regularly exceeds the 5s default, and the
    // resulting failure is a TIMEOUT with passing assertions, which reads as a logic bug and is
    // not one. Verified: the affected file passes in isolation and timed out at 6.7s in a loaded
    // run. This raises the budget for starting a database; it weakens no assertion.
    //
    // Raised 30s → 60s after the linear-export and sim-capture PGlite suites landed: under
    // `release:verify`, which runs every workspace's suite concurrently, the added DB-booting files
    // starved each other past 30s and 18 hooks timed out — every one with passing assertions, all
    // green in isolation (backend-alone: 2178 passed) and green cross-workspace at 60s. The
    // "realistic timeout" 32691ce chose simply grew with the suite; the number tolerates a slower
    // DB boot under contention and weakens nothing.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['src/**/*.test.ts'],
    // src/_archive holds the retired v1 podcast pipeline. Its tests import a
    // db/index.js that no longer exists in the archive tree, so they cannot run.
    // It is dead code kept for reference only — excluded from the active suite so
    // a green run reflects the live codebase. Revive + fix these if v1 returns.
    exclude: [...configDefaults.exclude, 'src/_archive/**'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts'],
      exclude: ['src/db/**'],
    },
  },
});
