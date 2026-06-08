// ESLint flat config for backend-api.
//
// Scope: the live backend source. The retired v1 pipeline under src/_archive and
// build output are ignored. Rules are typescript-eslint's recommended set, with a
// few inherently-noisy stylistic rules relaxed to warnings so the command fails
// only on genuine problems (errors) while still surfacing cleanups (warnings).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'src/_archive/**',   // retired v1 podcast pipeline — dead code, not part of the active suite
      'dist/**',
      'node_modules/**',
      '*.config.mjs',
      'drizzle.config.ts',
      'vitest.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Test files use loose typing for mocks/fixtures.
    files: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
