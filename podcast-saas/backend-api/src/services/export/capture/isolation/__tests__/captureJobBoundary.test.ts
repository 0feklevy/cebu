/**
 * The trusted/untrusted boundary — pure halves, verifiable on macOS. The container-running half
 * (`DockerCaptureBoundary.runCapture`) is verified-in-container: PENDING (macOS cannot run beginFrame).
 *
 * The load-bearing property here: the spec handed to untrusted code carries NO credential and NO
 * external origin — only the query/fragment needed for dispatch and the package-relative entry path.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RendererIdentity, SimCaptureWindow } from '../../../types.js';
import {
  buildCaptureSpec,
  parseCaptureResult,
  writeCaptureInput,
  readCaptureResult,
  expectedFrameCount,
  FORBIDDEN_SPEC_KEY_SUBSTRINGS,
  CAPTURE_SPEC_FILENAME,
  CAPTURE_RESULT_FILENAME,
  type ContainerCaptureResult,
  type ContainerCaptureSpec,
} from '../captureJobBoundary.js';

function simWindow(overrides: Partial<SimCaptureWindow> = {}): SimCaptureWindow {
  return {
    kind: 'sim-capture',
    startSec: 4,
    endSec: 19,
    sectionId: 'sec-1',
    label: 'a scripted sim',
    simulationId: 'sim-1',
    servedUrl: 'https://api.flowvidco.com/sim-public/simulations/p/s/revisions/r/package/index.html?section=sec-1&v=deadbeefcafe0001#simboot=1',
    simpleUi: true,
    autoScript: true,
    uiHide: ['#chrome', '.debug'],
    configHash: 'cfg9999',
    posterKey: 'posters/p/s/poster.jpg',
    ...overrides,
  };
}

const OPTS = {
  entryPath: 'package/index.html',
  output: { format: 'jpeg' as const, quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
  fps: 30,
  width: 1920,
  height: 1080,
  warmupFrames: 30,
  wallClockTimeoutSec: 120,
};

describe('buildCaptureSpec', () => {
  it('preserves ?section=&v= query and #simboot= fragment VERBATIM', () => {
    const spec = buildCaptureSpec(simWindow(), OPTS);
    expect(spec.entryQuery).toBe('?section=sec-1&v=deadbeefcafe0001');
    expect(spec.entryFragment).toBe('#simboot=1');
  });

  it('drops the external origin and path (never sent to untrusted code)', () => {
    const spec = buildCaptureSpec(simWindow(), OPTS);
    const json = JSON.stringify(spec);
    expect(json).not.toContain('flowvidco.com');
    expect(json).not.toContain('https://');
    expect(json).not.toContain('/sim-public/');
    // The entry path is the package-relative manifest entry, not the URL path.
    expect(spec.entryPath).toBe('package/index.html');
  });

  it('carries the configHash as the PRNG seed axis and the exact startScript params', () => {
    const spec = buildCaptureSpec(simWindow(), OPTS);
    expect(spec.configHash).toBe('cfg9999');
    expect(spec.startScript).toEqual({ simpleUi: true, autoScript: true, uiHide: ['#chrome', '.debug'] });
  });

  it('defaults uiHide to [] when undefined', () => {
    const spec = buildCaptureSpec(simWindow({ uiHide: undefined }), OPTS);
    expect(spec.startScript.uiHide).toEqual([]);
  });

  it('computes duration from the window and the frame count from duration×fps', () => {
    const spec = buildCaptureSpec(simWindow({ startSec: 4, endSec: 19 }), OPTS);
    expect(spec.durationSec).toBe(15);
    expect(expectedFrameCount(spec)).toBe(450);
  });

  it('handles a stored relative servedUrl (no origin)', () => {
    const spec = buildCaptureSpec(simWindow({ servedUrl: '/sim-public/x/index.html?section=s2&v=abc#simboot=1' }), OPTS);
    expect(spec.entryQuery).toBe('?section=s2&v=abc');
    expect(spec.entryFragment).toBe('#simboot=1');
  });

  it('throws when there is nothing to capture (no servedUrl)', () => {
    expect(() => buildCaptureSpec(simWindow({ servedUrl: null }), OPTS)).toThrow(/poster fallback/);
  });

  it('the serialized spec contains no credential-shaped key', () => {
    const spec = buildCaptureSpec(simWindow(), OPTS);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v)) {
          keys.push(k.toLowerCase());
          walk(val);
        }
      }
    };
    walk(spec);
    for (const bad of FORBIDDEN_SPEC_KEY_SUBSTRINGS) {
      expect(keys.some((k) => k.includes(bad))).toBe(false);
    }
  });
});

const RENDERER: RendererIdentity = {
  imageDigest: 'sha256:' + 'b'.repeat(64),
  headlessShellVersion: '151.0.0.0',
  viewport: { w: 1920, h: 1080 },
  dpr: 1,
};

function okResult(overrides: Partial<ContainerCaptureResult> = {}): ContainerCaptureResult {
  return {
    resultVersion: 1,
    sectionId: 'sec-1',
    status: 'ok',
    framesDir: 'frames',
    clipPath: null,
    frameCount: 450,
    rendererString: 'Google SwiftShader',
    gate: 'passed',
    reason: null,
    rendererIdentity: RENDERER,
    failure: null,
    ...overrides,
  };
}

describe('parseCaptureResult', () => {
  it('round-trips a well-formed result', () => {
    const parsed = parseCaptureResult(JSON.stringify(okResult()));
    expect(parsed.status).toBe('ok');
    expect(parsed.frameCount).toBe(450);
    expect(parsed.rendererIdentity.headlessShellVersion).toBe('151.0.0.0');
    expect(parsed.rendererString).toBe('Google SwiftShader');
    expect(parsed.gate).toBe('passed');
  });

  it('accepts an object as well as a JSON string', () => {
    expect(parseCaptureResult(okResult()).status).toBe('ok');
  });

  it('rejects a bad version, status, frameCount, gate, rendererString, rendererIdentity', () => {
    expect(() => parseCaptureResult(okResult({ resultVersion: 2 as unknown as 1 }))).toThrow(/resultVersion/);
    expect(() => parseCaptureResult(okResult({ status: 'weird' as unknown as 'ok' }))).toThrow(/status/);
    expect(() => parseCaptureResult(okResult({ frameCount: -1 }))).toThrow(/frameCount/);
    expect(() => parseCaptureResult(okResult({ gate: 'meh' as unknown as 'passed' }))).toThrow(/gate/);
    expect(() => parseCaptureResult(okResult({ rendererString: 5 as unknown as string }))).toThrow(/rendererString/);
    expect(() => parseCaptureResult(okResult({ rendererIdentity: {} as unknown as RendererIdentity }))).toThrow(/rendererIdentity/);
  });

  it('rejects invalid JSON and non-objects', () => {
    expect(() => parseCaptureResult('{not json')).toThrow(/JSON/);
    expect(() => parseCaptureResult(42 as unknown)).toThrow();
  });

  it('carries a failure and a gate reason through', () => {
    const parsed = parseCaptureResult(
      okResult({ status: 'failed', gate: 'failed', reason: 'dead webgl context', failure: { code: 'black-frame', detail: 'webgl null' } }),
    );
    expect(parsed.failure).toEqual({ code: 'black-frame', detail: 'webgl null' });
    expect(parsed.reason).toBe('dead webgl context');
  });
});

describe('writeCaptureInput / readCaptureResult (mount I/O)', () => {
  it('materializes package bytes at their paths + the spec, and reads a result back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capio-'));
    try {
      const inputDir = join(dir, 'in');
      const outputDir = join(dir, 'out');
      const spec: ContainerCaptureSpec = buildCaptureSpec(simWindow(), OPTS);
      await writeCaptureInput(
        inputDir,
        [
          { path: 'package/index.html', content: Buffer.from('<html></html>') },
          { path: 'package/app.js', content: Buffer.from('1') },
        ],
        spec,
      );
      expect((await readFile(join(inputDir, 'package/index.html'), 'utf8'))).toBe('<html></html>');
      const writtenSpec = JSON.parse(await readFile(join(inputDir, CAPTURE_SPEC_FILENAME), 'utf8'));
      expect(writtenSpec.sectionId).toBe('sec-1');

      // Simulate the container's result and read it back through the validator.
      const { writeFile } = await import('node:fs/promises');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, CAPTURE_RESULT_FILENAME), JSON.stringify(okResult()), 'utf8');
      const result = await readCaptureResult(outputDir);
      expect(result.frameCount).toBe(450);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unsafe package path on write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capio-'));
    try {
      await expect(
        writeCaptureInput(join(dir, 'in'), [{ path: '../escape.js', content: Buffer.from('x') }], buildCaptureSpec(simWindow(), OPTS)),
      ).rejects.toThrow(/unsafe/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
