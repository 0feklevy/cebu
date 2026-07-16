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
  },
});
