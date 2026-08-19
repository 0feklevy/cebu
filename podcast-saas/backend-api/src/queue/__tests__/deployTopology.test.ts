/**
 * The deployed queue topology, asserted against the committed compose files.
 *
 * The GPU capture fleet only works if exactly one process consumes `project_export`, and it is the
 * one with the Tesla T4. That is not a property of the code — the code is happy to consume any
 * queue it is told to — it is a property of two YAML files that a deploy rewrites. So it is checked
 * here, where a wrong answer fails the build, rather than discovered in production as an export
 * that captured on SwiftShader over 2 vCPUs and lost every section to the wall clock.
 *
 * The failure this replaces was real and silent: the production worker ran with WORKER_QUEUES
 * unset, which the allowlist reads as "every queue", so it raced the GPU orchestrator for export
 * jobs. Nothing logged a conflict; the export simply sometimes went to the wrong machine.
 *
 * These are STATIC assertions over the checked-in configuration. They cannot prove a given VM is
 * running that configuration, but they make the intended topology impossible to drift away from by
 * omission — which is how it drifted the first time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGBOSS_JOB_NAMES } from '../pgBoss.js';
import { resolveWorkerQueues } from '../pgBossDriver.js';
import type { JobName } from '../types.js';

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'deploy');
const mainCompose = readFileSync(join(DEPLOY, 'docker-compose.yml'), 'utf8');
const gpuCompose = readFileSync(join(DEPLOY, 'docker-compose.gpu-worker.yml'), 'utf8');

/** The `environment:` mapping of one service, flattened to key → raw value. */
function serviceEnv(compose: string, service: string): Record<string, string> {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `  ${service}:`);
  if (start === -1) throw new Error(`service ${service} not found`);
  // The service block runs until the next line indented by exactly two spaces.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]!)) { end = i; break; }
  }
  const block = lines.slice(start, end);
  const envAt = block.findIndex((l) => l.trim() === 'environment:');
  if (envAt === -1) return {};
  const out: Record<string, string> = {};
  for (let i = envAt + 1; i < block.length; i++) {
    const line = block[i]!;
    if (/^\s{0,4}\S/.test(line) && !/^\s{6}/.test(line)) break; // left the environment mapping
    const m = /^\s{6}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const generalWorker = serviceEnv(mainCompose, 'worker');
const backend = serviceEnv(mainCompose, 'backend');
const orchestrator = serviceEnv(gpuCompose, 'export-orchestrator');

describe('the general worker never consumes project_export', () => {
  it('declares WORKER_QUEUES explicitly — an unset value means EVERY queue', () => {
    // This is the exact regression: unset is not "no queues", it is "all of them".
    expect(generalWorker.WORKER_QUEUES).toBeDefined();
    expect(generalWorker.WORKER_QUEUES!.trim()).not.toBe('');
  });

  it('omits project_export, and nothing else', () => {
    const declared = generalWorker.WORKER_QUEUES!.split(',').map((q) => q.trim());
    const expected = PGBOSS_JOB_NAMES.filter((q) => q !== 'project_export');
    // Sorted equality, so adding a durable queue without adding it here fails HERE rather than
    // silently leaving that queue with no consumer at all.
    expect([...declared].sort()).toEqual([...expected].sort());
    expect(declared).not.toContain('project_export');
  });

  it('the allowlist parser accepts that list and resolves it to exactly those queues', () => {
    // Not just a string comparison: the value has to survive the real parser, so a stray space,
    // a typo or a renamed queue is a startup error rather than a queue nobody consumes.
    const resolved = resolveWorkerQueues(PGBOSS_JOB_NAMES, {
      WORKER_QUEUES: generalWorker.WORKER_QUEUES,
    } as NodeJS.ProcessEnv);
    expect(resolved).not.toContain('project_export');
    expect(resolved).toHaveLength(PGBOSS_JOB_NAMES.length - 1);
  });
});

describe('the GPU orchestrator consumes project_export and nothing else', () => {
  it('declares exactly project_export', () => {
    expect(orchestrator.WORKER_QUEUES).toBe('project_export');
    const resolved = resolveWorkerQueues(PGBOSS_JOB_NAMES, {
      WORKER_QUEUES: orchestrator.WORKER_QUEUES,
    } as NodeJS.ProcessEnv);
    expect(resolved).toEqual(['project_export' as JobName]);
  });

  it('runs exports serially and asks for the hardware renderer with ONE explicit CDI device', () => {
    expect(orchestrator.QUEUE_EXPORT_CONCURRENCY).toBe('1');
    expect(orchestrator.EXPORT_CAPTURE_RENDERER).toBe('hardware');
    expect(orchestrator.EXPORT_CAPTURE_GPU_CDI_DEVICE).toMatch(/^nvidia\.com\/gpu=(\d{1,3}|GPU-[0-9a-fA-F-]+)$/);
    // `all` would hand the container every GPU on the host; one section renders on one device.
    expect(orchestrator.EXPORT_CAPTURE_GPU_CDI_DEVICE).not.toContain('all');
  });

  it('every durable queue has exactly one consumer across the two hosts', () => {
    const general = generalWorker.WORKER_QUEUES!.split(',').map((q) => q.trim());
    const gpu = orchestrator.WORKER_QUEUES!.split(',').map((q) => q.trim());
    for (const queue of PGBOSS_JOB_NAMES) {
      const consumers = [general.includes(queue), gpu.includes(queue)].filter(Boolean).length;
      expect({ queue, consumers }).toEqual({ queue, consumers: 1 });
    }
  });
});

describe('the API stamps the renderer and the admission ceilings into every plan', () => {
  it('freezes the hardware profile at plan time', () => {
    // The profile is fingerprinted into the frozen plan by the API, and the orchestrator honours
    // what the plan says — so this value, not the worker's environment, decides what a job renders
    // with. A plan frozen without it resolves to software and dies on the wall clock.
    expect(backend.EXPORT_CAPTURE_RENDERER).toBe('hardware');
  });

  it('carries admission ceilings that admit the real flagship project', () => {
    // Measured: 11 sim windows, longest 27.2 s, 4,710 frames. Defaults of 15 s / 2,700 frames
    // refused it outright at the door.
    expect(Number(backend.EXPORT_MAX_SIM_WINDOW_SEC)).toBeGreaterThanOrEqual(28);
    expect(Number(backend.EXPORT_MAX_TOTAL_FRAMES)).toBeGreaterThanOrEqual(4710);
  });

  it('does NOT give the public API a GPU, a docker socket, or a capture image', () => {
    // The API plans; it never captures. Docker socket access on the request-serving process is
    // the thing the whole split exists to prevent.
    expect(backend.EXPORT_CAPTURE_IMAGE).toBeUndefined();
    expect(backend.EXPORT_CAPTURE_GPU_CDI_DEVICE).toBeUndefined();
    const backendBlock = mainCompose.slice(mainCompose.indexOf('  backend:'), mainCompose.indexOf('  worker:'));
    expect(backendBlock).not.toContain('docker.sock');
  });
});
