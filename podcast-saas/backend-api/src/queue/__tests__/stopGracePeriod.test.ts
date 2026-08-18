import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  INLINE_DRAIN_TIMEOUT_MS,
  PGBOSS_STOP_TIMEOUT_MS,
  WEB_SHUTDOWN_BUDGET_MS,
  WORKER_SHUTDOWN_BUDGET_MS,
} from '../shutdownBudget.js';

/**
 * job-queue-004 — every deploy SIGKILLed in-flight jobs.
 *
 * Docker escalates SIGTERM to SIGKILL after `stop_grace_period`, which DEFAULTS TO 10 SECONDS.
 * The backend's shutdown path alone waits up to 25 s for inline jobs and then up to 30 s for
 * pg-boss, so `docker compose up -d` on a release killed the process a third of the way into its
 * own drain — every release, for a transcode measured in minutes, with nothing in the logs.
 *
 * The compose file cannot import the TypeScript constants, so this test is the joint: it reads the
 * REAL deploy/docker-compose.yml and fails if a service that drains jobs is given less time than
 * the code will actually take.
 */

const APP_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
const COMPOSE = readFileSync(join(APP_ROOT, 'deploy', 'docker-compose.yml'), 'utf8');

/** Duration strings compose accepts, normalised to ms. Bare numbers are seconds. */
function parseDuration(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(raw);
  if (!m) throw new Error(`unparseable duration: ${JSON.stringify(raw)}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return n;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: return n * 1000; // 's' and bare
  }
}

/**
 * Read one top-level key out of one service block. Deliberately a small hand-rolled reader rather
 * than a YAML dependency: the alternative is adding a package to production's dependency tree for
 * a single assertion. Service blocks are indented 2, their keys 4 — the whole file obeys that.
 */
function serviceValue(service: string, key: string): string | null {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) throw new Error(`no service block for ${service}`);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // next service / top-level key
    const m = new RegExp(`^ {4}${key}:\\s*(.+?)\\s*$`).exec(line);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

describe('job-queue-004 — compose must not SIGKILL a shutdown mid-drain', () => {
  it('the backend gets at least as long as its own drain can take', () => {
    const raw = serviceValue('backend', 'stop_grace_period');
    expect(raw, 'backend has no stop_grace_period — Docker SIGKILLs it after 10s').not.toBeNull();
    expect(parseDuration(raw!)).toBeGreaterThanOrEqual(WEB_SHUTDOWN_BUDGET_MS);
  });

  it('the worker gets at least as long as pg-boss needs to drain', () => {
    const raw = serviceValue('worker', 'stop_grace_period');
    expect(raw, 'worker has no stop_grace_period — Docker SIGKILLs it after 10s').not.toBeNull();
    expect(parseDuration(raw!)).toBeGreaterThanOrEqual(WORKER_SHUTDOWN_BUDGET_MS);
  });

  it("both are above Docker's 10s default — the number that caused the bug", () => {
    for (const svc of ['backend', 'worker']) {
      expect(parseDuration(serviceValue(svc, 'stop_grace_period')!), svc).toBeGreaterThan(10_000);
    }
  });

  it('the budgets are the timeouts the shutdown code actually enforces', () => {
    // Guards the other direction: someone raising a drain timeout without raising the compose
    // value gets a failure here rather than a silent return of the SIGKILL.
    expect(readFileSync(join(APP_ROOT, 'backend-api', 'src', 'queue', 'inlineDriver.ts'), 'utf8'))
      .toMatch(/INLINE_DRAIN_TIMEOUT_MS/);
    expect(readFileSync(join(APP_ROOT, 'backend-api', 'src', 'queue', 'pgBoss.ts'), 'utf8'))
      .toMatch(/PGBOSS_STOP_TIMEOUT_MS/);
    expect(WEB_SHUTDOWN_BUDGET_MS).toBeGreaterThanOrEqual(
      INLINE_DRAIN_TIMEOUT_MS + PGBOSS_STOP_TIMEOUT_MS,
    );
    expect(WORKER_SHUTDOWN_BUDGET_MS).toBeGreaterThanOrEqual(PGBOSS_STOP_TIMEOUT_MS);
  });
});
