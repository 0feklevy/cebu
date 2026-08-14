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
  posterKey: null,
  output: { format: 'jpeg', quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
  wallClockTimeoutSec: 30,
};

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
    image: 'podcast-saas/export-worker:test',
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
      result: { ...FAILED_RESULT, status: 'ok', gate: 'passed', framesDir: 'frames', frameCount: 30, reason: null },
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
      result: { ...FAILED_RESULT, status: 'ok', gate: 'passed', framesDir: 'frames', frameCount: 30, reason: null, failure: null },
      exitCode: 0,
    });
    const result = await boundary(dockerBin).runCapture(SPEC, { inputDir, outputDir }, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.framesDir).toBe('frames');
  });
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
