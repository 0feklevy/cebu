/**
 * Mutation E — the observability contract of `DockerCaptureBoundary` on a non-zero container exit.
 *
 * v0.1.22 reality: the entrypoint dutifully wrote its failed `result.json` ("exports neither
 * createBackend() nor a default backend"), the boundary threw a bare "exited 1", the provider's
 * `finally` deleted the job dir — and the root cause took live `docker events` + log attachment to
 * recover. These tests pin the repaired semantics, via a STUB docker binary (a node script), so the
 * real spawn/read path runs:
 *
 *   exit ≠ 0 + failed result.json  → the classified failure is RETURNED (status/gate failed, reason kept)
 *   exit ≠ 0 + ok result.json      → CONTRADICTION: throws (a dead container is never a success)
 *   exit ≠ 0 + no result.json      → throws, carrying a bounded SANITIZED stderr tail
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DockerCaptureBoundary,
  sanitizeStderrTail,
  type ContainerCaptureSpec,
} from '../captureJobBoundary.js';

const SPEC: ContainerCaptureSpec = {
  specVersion: 1,
  sectionId: 'sec-1',
  simulationId: null,
  configHash: 'cfg',
  entryPath: 'index.html',
  entryQuery: '',
  entryFragment: '',
  startScript: { simpleUi: false, autoScript: false, uiHide: [] },
  durationSec: 1,
  fps: 30,
  width: 640,
  height: 360,
  warmupFrames: 5,
  rendererProfile: 'swiftshader' as const,
  posterKey: null,
  output: { format: 'jpeg', quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
  wallClockTimeoutSec: 30,
};

/**
 * A PASSING result has to be internally consistent with the spec that asked for it — the frames are
 * about to be encoded at that size, so a 0×0 viewport on a success is a contradiction, not a
 * diagnostic. (A FAILED result keeps 0×0: a capture that died before it had a page reports that
 * honestly, and rejecting it would replace the real reason with a complaint about its viewport.)
 */
const FAILED_RESULT = {
  resultVersion: 1,
  sectionId: 'sec-1',
  status: 'failed',
  framesDir: null,
  clipPath: null,
  frameCount: 0,
  rendererString: '',
  gate: 'failed',
  reason: 'backend module X exports neither createBackend() nor a default backend',
  rendererIdentity: { imageDigest: 'img', headlessShellVersion: 'v', viewport: { w: 0, h: 0 }, dpr: 1 },
  failure: { code: 'capture_failed', detail: 'backend module X exports neither createBackend() nor a default backend' },
};

/**
 * A PASSING result has to be internally consistent with the spec that asked for it — those frames
 * are about to be encoded at that size, so a 0×0 viewport on a success is a contradiction rather
 * than a diagnostic. A FAILED result keeps 0×0: a capture that died before it had a page reports
 * that honestly, and rejecting it would replace the real reason with a complaint about its viewport.
 */
const PASSING_IDENTITY = {
  ...FAILED_RESULT,
  rendererIdentity: { imageDigest: 'img', headlessShellVersion: 'v', viewport: { w: 640, h: 360 }, dpr: 1 },
};

let scratch: string;
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A stand-in `docker` binary: finds the /output bind mount in its argv (exactly where the real
 * argv carries it), optionally writes a result.json there, emits stderr, exits with a chosen code.
 */
async function stubDocker(behavior: {
  result?: Record<string, unknown>;
  stderr?: string;
  exitCode: number;
}): Promise<{ dockerBin: string; inputDir: string; outputDir: string }> {
  scratch = await mkdtemp(join(tmpdir(), 'boundary-diag-'));
  const inputDir = join(scratch, 'input');
  const outputDir = join(scratch, 'output');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const dockerBin = join(scratch, 'docker-stub.js');
  await writeFile(
    dockerBin,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const out = process.argv.map(a => /^type=bind,src=(.+),dst=\\/output/.exec(a)).find(Boolean);
const RESULT = ${behavior.result ? JSON.stringify(JSON.stringify(behavior.result)) : 'null'};
if (out && RESULT) fs.writeFileSync(path.join(out[1], 'result.json'), RESULT);
if (${JSON.stringify(behavior.stderr ?? '')}) process.stderr.write(${JSON.stringify(behavior.stderr ?? '')});
process.exit(${behavior.exitCode});
`,
    'utf8',
  );
  await chmod(dockerBin, 0o755);
  return { dockerBin, inputDir, outputDir };
}

function boundary(dockerBin: string): DockerCaptureBoundary {
  return new DockerCaptureBoundary({
    image: 'podcast-saas/export-worker:test', rendererProfile: 'swiftshader',
    user: '1000:1000',
    cpus: '2',
    memoryMb: 2048,
    pidsLimit: 256,
    tmpfsScratchMb: 512,
    stopTimeoutSec: 5,
    sandboxMechanism: 'sys-admin',
    dockerBin,
  });
}

describe('DockerCaptureBoundary — non-zero exit diagnostics (Mutation E)', () => {
  it('exit 1 + failed result.json ⇒ the CLASSIFIED failure comes back, reason intact — never a bare "exited 1"', async () => {
    const { dockerBin, inputDir, outputDir } = await stubDocker({ result: FAILED_RESULT, exitCode: 1 });
    const result = await boundary(dockerBin).runCapture(SPEC, { inputDir, outputDir }, new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.gate).toBe('failed');
    expect(result.reason).toContain('exports neither createBackend()');
  });

  it('exit 1 + an "ok" result.json ⇒ throws on the contradiction — a dead container is never a success', async () => {
    const { dockerBin, inputDir, outputDir } = await stubDocker({
      result: { ...PASSING_IDENTITY, status: 'ok', gate: 'passed', framesDir: 'frames', frameCount: 30, reason: null },
      exitCode: 1,
    });
    await expect(
      boundary(dockerBin).runCapture(SPEC, { inputDir, outputDir }, new AbortController().signal),
    ).rejects.toThrow(/exited 1.*claims status "ok"/s);
  });

  it('exit 137 + no result.json ⇒ throws with a bounded sanitized stderr tail', async () => {
    const { dockerBin, inputDir, outputDir } = await stubDocker({
      stderr: 'garbage\u001b[31mANSI\u001b[0m\nOOM approaching\nkilled\n',
      exitCode: 137,
    });
    const err = await boundary(dockerBin)
      .runCapture(SPEC, { inputDir, outputDir }, new AbortController().signal)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited 137/);
    expect((err as Error).message).toContain('killed');
    expect((err as Error).message).not.toContain('\u001b'); // control chars stripped
  });

  it('exit 0 + a valid result ⇒ resolves normally (the happy path is untouched)', async () => {
    const { dockerBin, inputDir, outputDir } = await stubDocker({
      result: { ...PASSING_IDENTITY, status: 'ok', gate: 'passed', framesDir: 'frames', frameCount: 30, reason: null, failure: null },
      exitCode: 0,
    });
    const result = await boundary(dockerBin).runCapture(SPEC, { inputDir, outputDir }, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.framesDir).toBe('frames');
  });
});

/**
 * The TERMINATION contract of `spawnDocker`, which the diagnostics rewrite touched but did not
 * previously cover: cancellation (AbortSignal) and the per-section wall clock. Both are container
 * lifecycle, so both are exercised against a stub `docker` that behaves like one — `run` stays
 * alive until a `stop`/`kill` invocation tells it to die, and every invocation is logged.
 */
async function lifecycleDocker(): Promise<{ dockerBin: string; inputDir: string; outputDir: string; log: () => string }> {
  scratch = await mkdtemp(join(tmpdir(), 'boundary-life-'));
  const inputDir = join(scratch, 'input');
  const outputDir = join(scratch, 'output');
  const logFile = join(scratch, 'docker-calls.log');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const dockerBin = join(scratch, 'docker-lifecycle.js');
  await writeFile(
    dockerBin,
    `#!/usr/bin/env node
const fs = require('fs');
const LOG = ${JSON.stringify(logFile)};
const TERM = ${JSON.stringify(join(scratch, 'terminate'))};
const verb = process.argv[2];
fs.appendFileSync(LOG, process.argv.slice(2).join(' ') + '\\n');
if (verb === 'run') {
  // A live container: exits only once something asks it to (or a hard test-safety ceiling).
  process.on('exit', () => { try { fs.appendFileSync(LOG, 'run-exit\\n'); } catch {} });
  const poll = setInterval(() => { if (fs.existsSync(TERM)) { clearInterval(poll); process.exit(137); } }, 20);
  setTimeout(() => process.exit(99), 20000).unref?.();
} else {
  fs.writeFileSync(TERM, verb); // stop/kill both terminate the container
  process.exit(0);
}
`,
    'utf8',
  );
  await chmod(dockerBin, 0o755);
  // Empty until the stub's first invocation — pollers read it before the child has spawned.
  const log = (): string => {
    try {
      return readFileSync(logFile, 'utf8');
    } catch {
      return '';
    }
  };
  return { dockerBin, inputDir, outputDir, log };
}

/** Poll until the predicate holds or the budget runs out — no fixed sleeps. */
async function until(predicate: () => boolean, budgetMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > budgetMs) throw new Error('until: predicate never held');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('DockerCaptureBoundary — termination paths (cancellation and the wall clock)', () => {
  it('AbortSignal DURING the run stops the container gracefully, settles promptly, stays classified', async () => {
    const { dockerBin, inputDir, outputDir, log } = await lifecycleDocker();
    const controller = new AbortController();
    const running = boundary(dockerBin)
      .runCapture(SPEC, { inputDir, outputDir }, controller.signal)
      .catch((e: unknown) => e as Error);

    await until(() => log().includes('run '), 5_000); // the container is genuinely up
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await running;

    // Settles well inside the 5s escalation window — the graceful stop was enough.
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(log()).toMatch(/^stop /m);
    expect(log()).not.toMatch(/^kill /m); // escalation was never needed, and was cleared
    // No orphan: the container process actually terminated.
    expect(log()).toContain('run-exit');
    // The failure is still classified, never a silent success.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/exited 137/);
  }, 20_000);

  it('the wall clock hard-kills the container, bounded, and the promise settles with no orphan', async () => {
    const { dockerBin, inputDir, outputDir, log } = await lifecycleDocker();
    const startedAt = Date.now();
    const outcome = await boundary(dockerBin)
      .runCapture({ ...SPEC, wallClockTimeoutSec: 1 }, { inputDir, outputDir }, new AbortController().signal)
      .catch((e: unknown) => e as Error);

    // Fired on the 1s wall clock and stayed bounded — not the 30s of the default spec.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(log()).toMatch(/^kill --signal=KILL /m);
    expect(log()).toContain('run-exit');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/exited 137/);
  }, 25_000);

  it('a signal already aborted BEFORE the call never runs docker at all', async () => {
    // The old behaviour launched the container and then stopped it — a cold Chrome start spent on
    // a job nobody wants, and `docker stop` racing a container that may not exist yet. Cancelled
    // before the start means NOTHING starts.
    const { dockerBin, inputDir, outputDir, log } = await lifecycleDocker();
    const controller = new AbortController();
    controller.abort();
    const outcome = await boundary(dockerBin)
      .runCapture(SPEC, { inputDir, outputDir }, controller.signal)
      .catch((e: unknown) => e as Error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/cancelled before the container started/);
    // MUTATION TARGET: remove the early guard and docker runs — this log stops being empty.
    expect(log()).not.toContain('run-exit');
    expect(log()).not.toMatch(/^run /m);
  }, 20_000);
});

describe('sanitizeStderrTail — untrusted bytes, bounded and stripped', () => {
  it('strips control characters, keeps at most 40 lines and ~2KB', () => {
    const noisy = Array.from({ length: 100 }, (_, i) => `line-${i}[2J${'x'.repeat(60)}`).join('\n');
    const tail = sanitizeStderrTail(noisy);
    expect(tail).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/); // eslint-disable-line no-control-regex
    expect(tail.split('\n').length).toBeLessThanOrEqual(40);
    expect(tail.length).toBeLessThanOrEqual(2_100);
    expect(tail).toContain('line-99'); // the TAIL survives — the newest evidence wins
  });
});
