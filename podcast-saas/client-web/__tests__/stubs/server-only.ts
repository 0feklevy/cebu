/**
 * `server-only` is a Next.js BUILD MARKER, not an installed package: Next aliases the specifier
 * inside its own bundler config so that importing a server module from a Client Component is a
 * build error. Nothing installs it, so vite cannot resolve it, and any test whose subject is a
 * server module (`lib/courseApi.ts`) failed to load at import time rather than failing an
 * assertion.
 *
 * This empty module is the alias vitest resolves that specifier to (see vitest.config.ts). It is
 * test-only: the real guarantee still comes from `next build`, which is where the marker means
 * something.
 */
export {};
