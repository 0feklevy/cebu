#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const root = process.cwd();

// 1. Verify required files exist
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

// 2. Wait for dev server to respond (up to 30s)
async function fetchStatus(path) {
  try {
    const res = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return 0;
  }
}

console.log('Waiting for dev server...');
let ready = false;
for (let i = 0; i < 30; i++) {
  if (await fetchStatus('/') !== 0) { ready = true; break; }
  await wait(1000);
}
if (!ready) {
  console.error('✗ Dev server not reachable on localhost:3000 after 30s');
  process.exit(1);
}

// 3. Check routes
const routes = ['/', '/new'];
let failed = false;

for (const route of routes) {
  const status = await fetchStatus(route);
  const ok = status === 200;
  console.log(`${ok ? '✓' : '✗'} ${route} → ${status || 'no response'}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('');
  console.error('Route check failed. If terminal shows Watchpack EMFILE errors:');
  console.error('  WATCHPACK_POLLING and CHOKIDAR_USEPOLLING must be set to true in dev.sh');
  console.error('  next.config.ts must have watchOptions.poll set');
  process.exit(1);
}

console.log('');
console.log('✓ Dev server is healthy');
