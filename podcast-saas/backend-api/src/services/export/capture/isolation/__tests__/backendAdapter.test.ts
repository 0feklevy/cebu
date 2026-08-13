/**
 * The alignment bridge to the sibling's `capture/captureTypes.ts` in-process backend contract.
 *
 * These prove the translation both ways — this layer's `ContainerCaptureSpec` + loopback URL → the
 * backend's `CaptureSpec` (`servedSimUrl`), and the backend's `CaptureResult` → this layer's
 * `ContainerCaptureResult` — and that the backend's artifacts are relocated onto the /output mount
 * with output-relative paths (they would otherwise be lost on the ephemeral tmpfs).
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CaptureResult as BackendCaptureResult,
  CaptureSpec as BackendCaptureSpec,
  SimCaptureBackend,
} from '../../captureTypes.js';
import type { RendererIdentity } from '../../../types.js';
import { backendToDriver, toBackendSpec, RELOCATED_FRAMES_DIR } from '../backendAdapter.js';
import type { ContainerCaptureSpec } from '../captureJobBoundary.js';

const RENDERER: RendererIdentity = {
  imageDigest: 'sha256:' + 'd'.repeat(64),
  headlessShellVersion: '151.0.0.0',
  viewport: { w: 1920, h: 1080 },
  dpr: 1,
};

function containerSpec(overrides: Partial<ContainerCaptureSpec> = {}): ContainerCaptureSpec {
  return {
    specVersion: 1,
    sectionId: 'sec-7',
    simulationId: 'sim-7',
    configHash: 'cfg7',
    entryPath: 'package/index.html',
    entryQuery: '?section=sec-7&v=abc',
    entryFragment: '#simboot=1',
    startScript: { simpleUi: true, autoScript: false, uiHide: ['#x'] },
    durationSec: 5,
    fps: 30,
    width: 1920,
    height: 1080,
    warmupFrames: 30,
    posterKey: 'posters/p/s/poster.jpg',
    output: { format: 'jpeg', quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
    wallClockTimeoutSec: 120,
    ...overrides,
  };
}

describe('toBackendSpec', () => {
  it('maps a ContainerCaptureSpec + loopback URL to the backend CaptureSpec', () => {
    const loopbackUrl = 'http://127.0.0.1:5555/package/index.html?section=sec-7&v=abc#simboot=1';
    const backendSpec = toBackendSpec(containerSpec(), loopbackUrl);
    expect(backendSpec.servedSimUrl).toBe(loopbackUrl);
    expect(backendSpec.sectionId).toBe('sec-7');
    expect(backendSpec.simpleUi).toBe(true);
    expect(backendSpec.autoScript).toBe(false);
    expect(backendSpec.uiHide).toEqual(['#x']);
    expect(backendSpec.width).toBe(1920);
    expect(backendSpec.height).toBe(1080);
    expect(backendSpec.configHash).toBe('cfg7');
  });

  it('coalesces a null configHash / posterKey to empty string (the backend needs a seed string)', () => {
    const backendSpec = toBackendSpec(containerSpec({ configHash: null, posterKey: null }), 'http://127.0.0.1:1/e');
    expect(backendSpec.configHash).toBe('');
    expect(backendSpec.posterKey).toBe('');
  });
});

describe('backendToDriver', () => {
  it('drives a backend, relocates frames onto /output, and returns a ContainerCaptureResult', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adapter-'));
    try {
      // A backend that writes two frames to its OWN dir (simulating the ephemeral tmpfs).
      const backendFramesDir = join(dir, 'scratch-frames');
      await mkdir(backendFramesDir, { recursive: true });
      await writeFile(join(backendFramesDir, 'frame-000001.jpg'), 'a');
      await writeFile(join(backendFramesDir, 'frame-000002.jpg'), 'b');

      let seenSpec: BackendCaptureSpec | null = null;
      const backend: SimCaptureBackend = {
        name: 'fake',
        async isAvailable() {
          return true;
        },
        async captureSection(spec): Promise<BackendCaptureResult> {
          seenSpec = spec;
          return {
            framesDir: backendFramesDir,
            frameCount: 150,
            rendererString: 'Google SwiftShader',
            gate: 'passed',
          };
        },
      };

      const outputDir = join(dir, 'out');
      const driver = backendToDriver(backend, { rendererIdentity: RENDERER });
      const result = await driver.drive({
        entryUrl: 'http://127.0.0.1:9/package/index.html?section=sec-7&v=abc#simboot=1',
        spec: containerSpec(),
        outputDir,
        signal: new AbortController().signal,
      });

      // The backend saw the loopback URL as servedSimUrl.
      expect(seenSpec!.servedSimUrl).toContain('127.0.0.1');

      // The result is output-relative and carries the injected identity.
      expect(result.framesDir).toBe(RELOCATED_FRAMES_DIR);
      expect(result.clipPath).toBeNull();
      expect(result.frameCount).toBe(150);
      expect(result.rendererString).toBe('Google SwiftShader');
      expect(result.gate).toBe('passed');
      expect(result.rendererIdentity).toEqual(RENDERER);
      expect(result.status).toBe('ok');

      // The frames were actually copied onto the output mount.
      const relocated = await readdir(join(outputDir, RELOCATED_FRAMES_DIR));
      expect(relocated.sort()).toEqual(['frame-000001.jpg', 'frame-000002.jpg']);
      expect(await readFile(join(outputDir, RELOCATED_FRAMES_DIR, 'frame-000001.jpg'), 'utf8')).toBe('a');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('relocates a clip when the backend produced one instead of frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adapter-'));
    try {
      const clipSrc = join(dir, 'scratch', 'sec-7.mp4');
      await mkdir(join(dir, 'scratch'), { recursive: true });
      await writeFile(clipSrc, 'MP4');

      const backend: SimCaptureBackend = {
        name: 'fake-clip',
        async isAvailable() {
          return true;
        },
        async captureSection(): Promise<BackendCaptureResult> {
          return { clipPath: clipSrc, frameCount: 150, rendererString: 'r', gate: 'passed' };
        },
      };

      const outputDir = join(dir, 'out');
      const result = await backendToDriver(backend, { rendererIdentity: RENDERER }).drive({
        entryUrl: 'http://127.0.0.1:9/e',
        spec: containerSpec(),
        outputDir,
        signal: new AbortController().signal,
      });

      expect(result.framesDir).toBeNull();
      expect(result.clipPath).toBe('sec-7.mp4');
      expect(await readFile(join(outputDir, 'sec-7.mp4'), 'utf8')).toBe('MP4');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
