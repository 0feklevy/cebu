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
