// Flat ESLint config for client-web (committed, non-interactive — replaces `next lint`,
// which prompts when no config exists). Uses the same toolchain as backend-api. Rules are
// typescript-eslint's recommended set with inherently-noisy stylistic rules relaxed to
// warnings, so `eslint .` fails only on genuine errors while still surfacing cleanups.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'next.config.ts',
      'postcss.config.js',
      'tailwind.config.*',
      'scripts/**',
      'e2e/**',
      '**/*.config.{js,mjs,cjs,ts}',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      '@next/next': nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // Real React-hooks lint (the source relies on these being defined + active).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Surfaced as warnings (not errors): App-Router-prone rule, intentional `<\/script>`
      // escapes, and deliberate short-circuit expressions in pre-existing code.
      '@next/next/no-html-link-for-pages': 'warn',
      'no-useless-escape': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      // TypeScript's own checker handles undefined identifiers; no-undef is noise in TS.
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'warn',
      'no-empty': 'warn',
    },
  },
);
