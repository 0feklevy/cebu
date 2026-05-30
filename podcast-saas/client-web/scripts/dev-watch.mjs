#!/usr/bin/env node
/**
 * dev-watch — continuous health monitor for the Next.js dev server.
 *
 * Checks every 10 seconds:
 *   http://localhost:3000/
 *   http://localhost:3000/new
 *   /projects/$PROJECT_ID/editor   (real ID if PROJECT_ID env set, else fake sentinel)
 *   /projects/$PROJECT_ID/view
 *
 * Also scans the log file (DEV_LOG env, default /tmp/nextjs-dev.log) for
 * known error signatures after each check cycle.
 *
 * Does NOT auto-restart. Detects and reports loudly.
 *
 * Usage:
 *   pnpm dev:watch
 *   PROJECT_ID=<uuid> pnpm dev:watch
 *   DEV_LOG=/path/to/dev.log pnpm dev:watch
 */

import { readFile } from 'node:fs/promises';

const INTERVAL_MS = 10_000;
const FAKE_ID     = '00000000-0000-0000-0000-000000000000';
const checkId     = process.env.PROJECT_ID ?? FAKE_ID;
const devLog      = process.env.DEV_LOG ?? '/tmp/nextjs-dev.log';

const ERROR_SIGNATURES = [
  'EMFILE',
  'Watchpack Error',
  "Cannot find module './vendor-chunks'",
  'GET / 404',
  'SyntaxError',
];

const routes = [
  '/',
  '/new',
  `/projects/${checkId}/editor`,
  `/projects/${checkId}/view`,
];

async function fetchStatus(path) {
  try {
    const res = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return 0;
  }
}

async function scanLog() {
  try {
    const text = await readFile(devLog, 'utf-8');
    const lines = text.split('\n');
    const recent = lines.slice(-200);
    const hits = [];
    for (const sig of ERROR_SIGNATURES) {
      if (recent.some(l => l.includes(sig))) hits.push(sig);
    }
    return hits;
  } catch {
    return [];
  }
}

function ts() {
  return new Date().toLocaleTimeString();
}

console.log(`[${ts()}] dev:watch started (interval: ${INTERVAL_MS / 1000}s)`);
console.log(`[${ts()}] Project ID: ${checkId === FAKE_ID ? 'fake sentinel' : checkId}`);
console.log(`[${ts()}] Log file: ${devLog}`);
console.log('');

async function tick() {
  const statuses = await Promise.all(routes.map(async r => ({ r, s: await fetchStatus(r) })));
  const down     = statuses.find(({ s }) => s === 0);
  const failed   = statuses.filter(({ s }) => s !== 200);
  const logHits  = await scanLog();

  if (down) {
    console.error(`[${ts()}] ✗ Dev server is DOWN. Restart with: pnpm dev`);
    return;
  }

  if (failed.length > 0) {
    for (const { r, s } of failed) {
      console.error(`[${ts()}] ✗ Dev server route failure detected: ${r} → ${s}`);
    }
  } else {
    console.log(`[${ts()}] ✓ All routes OK (${statuses.map(({ s }) => s).join(', ')})`);
  }

  if (logHits.length > 0) {
    for (const sig of logHits) {
      console.error(`[${ts()}] ⚠ Log pattern detected: "${sig}" — check ${devLog}`);
    }
  }
}

await tick();
setInterval(tick, INTERVAL_MS);
