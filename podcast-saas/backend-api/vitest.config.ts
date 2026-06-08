import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
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
