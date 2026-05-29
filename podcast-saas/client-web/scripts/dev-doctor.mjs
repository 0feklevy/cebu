#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const root = process.cwd();

// 1. Verify required route files exist on disk
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

// Ensure no duplicate root route (route group leftover)
if (existsSync(`${root}/app/(marketing)/page.tsx`)) {
  console.error('✗ Duplicate root route: app/(marketing)/page.tsx still exists alongside app/page.tsx');
  process.exit(1);
}

// 2. Wait for dev server (up to 45s)
async function fetchStatus(path) {
  try {
    const res = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(4000) });
    return res.status;
  } catch {
    return 0;
  }
}

console.log('Waiting for dev server...');
let ready = false;
for (let i = 0; i < 45; i++) {
  if (await fetchStatus('/') !== 0) { ready = true; break; }
  process.stdout.write('.');
  await wait(1000);
}
if (!ready) {
  console.error('\n✗ Dev server not reachable on localhost:3000 after 45s');
  process.exit(1);
}
console.log('');

// 3. Check routes
// Dynamic project routes use a fake UUID — data fetching is client-side so
// the server always returns 200 as long as the route is registered.
const FAKE_ID = '00000000-0000-0000-0000-000000000000';
const routes = [
  '/',
  '/new',
  `/projects/${FAKE_ID}/editor`,
  `/projects/${FAKE_ID}/view`,
];

let failed = false;
for (const route of routes) {
  const status = await fetchStatus(route);
  const ok = status === 200;
  console.log(`${ok ? '✓' : '✗'} ${route} → ${status || 'no response'}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('');
  console.error('Route check failed.');
  console.error('If terminal shows Watchpack EMFILE errors:');
  console.error('  → WATCHPACK_POLLING=true and CHOKIDAR_USEPOLLING=true must be set in dev.sh');
  console.error('  → next.config.ts must have watchOptions.poll configured');
  process.exit(1);
}

console.log('');
console.log('✓ Dev server is healthy — all routes return 200');
