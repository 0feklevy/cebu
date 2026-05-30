#!/usr/bin/env node
/**
 * dev-check — quick port + route health check.
 *
 * Skips file-system structure checks.
 * Fails immediately with a clear message if the server is not running.
 * Use pnpm dev:doctor for the full preflight (includes file-system checks).
 *
 * Optional: PROJECT_ID=<real-uuid> pnpm dev:check
 *   When set, checks /projects/$ID/editor and /projects/$ID/view with the real ID.
 */

async function fetchStatus(path) {
  try {
    const res = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(4000) });
    return res.status;
  } catch {
    return 0;
  }
}

const projectId = process.env.PROJECT_ID ?? null;
const FAKE_ID   = '00000000-0000-0000-0000-000000000000';

const ping = await fetchStatus('/');
if (ping === 0) {
  console.error('✗ Dev server is not running. Start it with: pnpm dev');
  process.exit(1);
}

const checkId = projectId ?? FAKE_ID;
const routes = [
  '/',
  '/new',
  `/projects/${checkId}/editor`,
  `/projects/${checkId}/view`,
];

let failed = false;
for (const route of routes) {
  const status = await fetchStatus(route);
  const ok = status === 200;
  console.log(`${ok ? '✓' : '✗'} ${route} → ${status || 'no response'}`);
  if (!ok) failed = true;
}

if (failed) process.exit(1);
console.log('');
console.log('✓ All routes 200');
