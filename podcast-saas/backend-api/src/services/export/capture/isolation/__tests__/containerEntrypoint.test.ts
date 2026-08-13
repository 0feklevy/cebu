/**
 * The in-container orchestration glue, verified on macOS with a FAKE driver. This proves the wiring
 * that §0.2 depends on WITHOUT the browser: the loopback server comes up on 127.0.0.1, the driver is
 * handed a loopback entry URL with the query/fragment intact, that URL actually serves the package,
 * and the validated result lands on the output mount. The real (headless-shell) driver is exercised
 * only in the Linux container.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';

import { runContainerCapture, type SimCaptureDriver } from '../containerEntrypoint.js';
import { CAPTURE_RESULT_FILENAME, type ContainerCaptureResult, type ContainerCaptureSpec } from '../captureJobBoundary.js';
import type { LoopbackPackageFile } from '../loopbackPackageServer.js';

const PACKAGE: LoopbackPackageFile[] = [
  { path: 'package/index.html', content: Buffer.from('<!doctype html><title>ok</title>') },
  { path: 'package/app.js', content: Buffer.from('console.log(1)') },
];

const SPEC: ContainerCaptureSpec = {
  specVersion: 1,
  sectionId: 'sec-42',
  simulationId: 'sim-42',
  configHash: 'cfg42',
  entryPath: 'package/index.html',
  entryQuery: '?section=sec-42&v=abc',
  entryFragment: '#simboot=1',
  startScript: { simpleUi: true, autoScript: true, uiHide: [] },
  durationSec: 2,
  fps: 30,
  width: 1920,
  height: 1080,
  warmupFrames: 30,
  posterKey: 'posters/p/s/poster.jpg',
  output: { format: 'jpeg', quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
  wallClockTimeoutSec: 60,
};

function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

describe('runContainerCapture', () => {
  it('serves the package on loopback, hands the driver a loopback entry URL, writes a validated result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    try {
      const outputDir = join(dir, 'out');
      let seenUrl = '';

      const driver: SimCaptureDriver = {
        async drive({ entryUrl, spec, outputDir: od, signal }) {
          seenUrl = entryUrl;
          // The URL must be loopback and carry the preserved query + fragment.
          expect(entryUrl.startsWith('http://127.0.0.1:')).toBe(true);
          expect(entryUrl).toContain('/package/index.html?section=sec-42&v=abc#simboot=1');
          expect(signal).toBeInstanceOf(AbortSignal);
          // And it must actually serve the package (fragment is client-side only, drop it for the GET).
          const res = await fetchText(entryUrl.split('#')[0]);
          expect(res.status).toBe(200);
          expect(res.body).toContain('<title>ok</title>');
          const result: ContainerCaptureResult = {
            resultVersion: 1,
            sectionId: spec.sectionId,
            status: 'ok',
            framesDir: 'frames',
            clipPath: null,
            frameCount: 60,
            rendererString: 'Google SwiftShader',
            gate: 'passed',
            reason: null,
            rendererIdentity: {
              imageDigest: 'sha256:' + 'c'.repeat(64),
              headlessShellVersion: '151.0.0.0',
              viewport: { w: 1920, h: 1080 },
              dpr: 1,
            },
            failure: null,
          };
          expect(od).toBe(outputDir);
          return result;
        },
      };

      const result = await runContainerCapture({
        packageFiles: PACKAGE,
        spec: SPEC,
        outputDir,
        driver,
      });

      expect(result.sectionId).toBe('sec-42');
      expect(seenUrl).toContain('127.0.0.1');
      const onDisk = JSON.parse(await readFile(join(outputDir, CAPTURE_RESULT_FILENAME), 'utf8'));
      expect(onDisk.frameCount).toBe(60);
      expect(onDisk.status).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops the loopback server even when the driver throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    let capturedUrl = '';
    try {
      const driver: SimCaptureDriver = {
        async drive({ entryUrl }) {
          capturedUrl = entryUrl;
          throw new Error('driver boom');
        },
      };
      await expect(
        runContainerCapture({ packageFiles: PACKAGE, spec: SPEC, outputDir: join(dir, 'out'), driver }),
      ).rejects.toThrow(/boom/);

      // After the failure the loopback port must be closed — a fresh GET must not connect.
      const port = capturedUrl.match(/127\.0\.0\.1:(\d+)/)?.[1];
      expect(port).toBeTruthy();
      await expect(fetchText(`http://127.0.0.1:${port}/package/index.html`)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a driver result that fails validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    try {
      const driver: SimCaptureDriver = {
        async drive() {
          return { resultVersion: 1, sectionId: 'x', status: 'bogus' } as unknown as CaptureResult;
        },
      };
      await expect(
        runContainerCapture({ packageFiles: PACKAGE, spec: SPEC, outputDir: join(dir, 'out'), driver }),
      ).rejects.toThrow(/status/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
