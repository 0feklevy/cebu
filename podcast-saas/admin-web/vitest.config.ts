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
    include: ['__tests__/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
