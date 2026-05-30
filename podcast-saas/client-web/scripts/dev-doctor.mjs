#!/usr/bin/env node
/**
 * dev-doctor — full preflight check for the client-web dev server.
 *
 * Assumes the dev server is ALREADY running (started with: pnpm dev).
 * Does NOT start another server, does NOT wait for one to come up.
 * Fails immediately with a clear message if port 3000 is not reachable.
 *
 * Checks:
 *   1. Required route files exist on disk
 *   2. No duplicate root route (route-group leftover)
 *   3. Port 3000 is reachable
 *   4. Core routes return 200
 *   5. Dev log scanned for stale Next cache signatures
 *
 * Optional: PROJECT_ID=<real-uuid> pnpm dev:doctor
 *   When PROJECT_ID is set, checks /projects/$ID/editor and /projects/$ID/view
 *   with the real ID instead of the fake UUID sentinel.
 *   The fake UUID proves routing only; the real ID proves the actual data path.
 *
 * Optional: DEV_LOG=<path> pnpm dev:doctor
 *   Path to the Next.js dev log written by dev.sh (default /tmp/nextjs-dev.log).
 */

import { existsSync } from 'node:fs';
import { readFile   } from 'node:fs/promises';

const root      = process.cwd();
const projectId = process.env.PROJECT_ID ?? null;
const devLog    = process.env.DEV_LOG ?? '/tmp/nextjs-dev.log';
const FAKE_ID   = '00000000-0000-0000-0000-000000000000';

// ── 1. File-system structure ─────────────────────────────────────────────────

const required = [
  'app/page.tsx',
  'app/layout.tsx',
  'app/projects/[id]/editor/page.tsx',
  'app/projects/[id]/view/page.tsx',
  'next.config.ts',
];

let structureOk = true;
for (const file of required) {
  if (!existsSync(`${root}/${file}`)) {
    console.error(`✗ Missing required file: ${file}`);
    structureOk = false;
  }
}
if (!structureOk) process.exit(1);
console.log('✓ Route files present');

if (existsSync(`${root}/app/(marketing)/page.tsx`)) {
  console.error('✗ Duplicate root route: app/(marketing)/page.tsx still exists alongside app/page.tsx');
  process.exit(1);
}

// ── 2. Server reachability — fail immediately, no waiting ────────────────────

async function fetchStatus(path) {
  try {
    const res = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(4000) });
    return res.status;
  } catch {
    return 0;
  }
}

const ping = await fetchStatus('/');
if (ping === 0) {
  console.error('');
  console.error('✗ Dev server is not running. Start it with:');
  console.error('');
  console.error('    pnpm dev');
  console.error('');
  process.exit(1);
}

// ── 3. Route checks ──────────────────────────────────────────────────────────

const idLabel = projectId ? `real (${projectId.slice(0, 8)}…)` : `fake sentinel`;
console.log(`\nChecking routes with ${idLabel} project ID:`);

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

// ── 4. Stale Next dev cache detection ────────────────────────────────────────

const STALE_SIGNATURES = [
  "Cannot find module './vendor-chunks",
  'app-pages-internals.js',
  'main-app.js',
  'layout.js',
  'GET / 404',
];

let staleHits = [];
try {
  const log  = await readFile(devLog, 'utf-8');
  const tail = log.split('\n').slice(-300).join('\n');
  staleHits  = STALE_SIGNATURES.filter(sig => tail.includes(sig));
} catch {
  // Log file doesn't exist yet — not a failure, just means dev.sh wasn't used
}

if (staleHits.length > 0) {
  console.error('');
  console.error('⚠ Stale Next dev cache detected in dev log:');
  for (const sig of staleHits) console.error(`  "${sig}"`);
  console.error('');
  console.error('Fix: stop dev, delete .next once, restart:');
  console.error('  Ctrl-C in the dev terminal');
  console.error('  rm -rf .next');
  console.error('  pnpm dev');
  failed = true;
}

// ── 5. Final result ──────────────────────────────────────────────────────────

if (failed) {
  console.error('');
  console.error('One or more checks failed. Possible causes:');
  console.error('  • Watchpack EMFILE: ensure WATCHPACK_POLLING=true is set in dev.sh');
  console.error('  • Stale .next cache: stop dev, rm -rf .next, pnpm dev');
  console.error('  • next.config.ts missing watchOptions.poll config');
  console.error('  • Duplicate root route (app/(marketing)/page.tsx leftover)');
  if (projectId) {
    console.error(`  • Project ${projectId} may not exist in the database`);
    console.error('  • Backend API may be down (check port 8080)');
  }
  process.exit(1);
}

console.log('');
console.log('✓ Dev server is healthy — all routes return 200');
