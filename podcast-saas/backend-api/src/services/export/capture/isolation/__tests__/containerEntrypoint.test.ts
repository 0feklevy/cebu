/**
 * The in-container orchestration glue, verified on macOS with a FAKE driver. This proves the wiring
 * that §0.2 depends on WITHOUT the browser: the loopback server comes up on 127.0.0.1, the driver is
 * handed a loopback entry URL with the query/fragment intact, that URL actually serves the package,
 * and the validated result lands on the output mount. The real (headless-shell) driver is exercised
 * only in the Linux container.
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';

import { runContainerCapture, type SimCaptureDriver } from '../containerEntrypoint.js';
import { CaptureStageError } from '../../captureTypes.js';
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

  it('SERVES the production topology: a nested entry resolves ../bridge.js to the package root', async () => {
    // The positive half of the v0.1.23 fix, without docker. The package is the real shape — the
    // generated runtime at the ROOT, the entry one level down referencing it upward — and the
    // driver resolves that reference exactly as a browser would, against the entry URL. If the
    // container ever re-narrowed the package to the entry's directory (or flattened it), this 404s.
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    try {
      const nested: LoopbackPackageFile[] = [
        { path: 'bridge.js', content: Buffer.from('/* SIM_READY emitter */') },
        { path: 'guidance.js', content: Buffer.from('/* guidance */') },
        { path: 'scene/index.html', content: Buffer.from('<script src="../bridge.js?v=1"></script>') },
        { path: 'scene/src/main.js', content: Buffer.from('export const x = 1;') },
      ];
      const fetched: Record<string, { status: number; body: string }> = {};
      const driver: SimCaptureDriver = {
        async drive({ entryUrl, spec }) {
          // Resolve every reference the way the browser does — relative to the ENTRY URL.
          for (const ref of ['../bridge.js?v=1', '../guidance.js', './src/main.js']) {
            fetched[ref] = await fetchText(new URL(ref, entryUrl).toString());
          }
          return {
            resultVersion: 1, sectionId: spec.sectionId, status: 'ok', framesDir: null, clipPath: null,
            frameCount: 0, rendererString: '', gate: 'passed', reason: null,
            rendererIdentity: { imageDigest: 'i', headlessShellVersion: 'v', viewport: { w: 1, h: 1 }, dpr: 1 },
            failure: null,
          };
        },
      };

      await runContainerCapture({
        packageFiles: nested,
        spec: { ...SPEC, entryPath: 'scene/index.html' },
        outputDir: join(dir, 'out'),
        driver,
      });

      // 200 + the real bytes — the incident, inverted.
      expect(fetched['../bridge.js?v=1']?.status).toBe(200);
      expect(fetched['../bridge.js?v=1']?.body).toContain('SIM_READY emitter');
      expect(fetched['../guidance.js']?.status).toBe(200);
      expect(fetched['./src/main.js']?.body).toContain('export const x');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the MISSING package files in the failure — the v0.1.23 diagnostic', async () => {
    // The exact incident shape: the entry asks for `../bridge.js`, which staging never copied.
    // The request reaches the loopback server, misses, and must appear in the thrown error so the
    // next operator reads "package is missing …/bridge.js" instead of a bare SIM_READY timeout.
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    try {
      const driver: SimCaptureDriver = {
        async drive({ entryUrl }) {
          const base = entryUrl.slice(0, entryUrl.lastIndexOf('/'));
          await fetchText(`${base}/../bridge.js?v=abc`).catch(() => '');
          await fetchText(`${base}/../guidance.js`).catch(() => '');
          throw new CaptureStageError('bridge_ready', 'SIM_READY: no signal within 900 virtual frames');
        },
      };
      const err = await runContainerCapture({
        packageFiles: PACKAGE, spec: SPEC, outputDir: join(dir, 'out'), driver,
      }).catch((e: unknown) => e as Error);

      expect(err).toBeInstanceOf(CaptureStageError);
      expect((err as CaptureStageError).stage).toBe('bridge_ready'); // classification preserved
      expect((err as Error).message).toMatch(/SIM_READY: no signal/);
      expect((err as Error).message).toMatch(/package is missing 2 requested file\(s\)/);
      expect((err as Error).message).toContain('bridge.js');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a CUSTOMER manifest.json at the package root is served as an asset, never read as ours', async () => {
    // The mount is flat, so the package root IS the mount root — and `manifest.json` is a name
    // customers own (PWA/Vite builds ship one). Trusting it blindly died with
    // "manifest.files is not iterable" BEFORE the loopback even started, so nothing could explain
    // it. It must be treated as an ordinary package byte.
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    try {
      // Written to a REAL input mount and loaded by readManifestFilesFromInput — the code path the
      // container actually takes. (Passing packageFiles would bypass the loader under test.)
      const inputDir = join(dir, 'input');
      await mkdir(join(inputDir, 'scene'), { recursive: true });
      await writeFile(join(inputDir, 'manifest.json'), '{"name":"My Sim","short_name":"sim","icons":[]}');
      await writeFile(join(inputDir, 'bridge.js'), '/* bridge */');
      await writeFile(join(inputDir, 'scene', 'index.html'), '<script src="../bridge.js"></script>');

      let manifestFetch = { status: 0, body: '' };
      let bridgeFetch = { status: 0, body: '' };
      const driver: SimCaptureDriver = {
        async drive({ entryUrl, spec }) {
          manifestFetch = await fetchText(new URL('../manifest.json', entryUrl).toString());
          bridgeFetch = await fetchText(new URL('../bridge.js', entryUrl).toString());
          return {
            resultVersion: 1, sectionId: spec.sectionId, status: 'ok', framesDir: null, clipPath: null,
            frameCount: 0, rendererString: '', gate: 'passed', reason: null,
            rendererIdentity: { imageDigest: 'i', headlessShellVersion: 'v', viewport: { w: 1, h: 1 }, dpr: 1 },
            failure: null,
          };
        },
      };
      // No throw — and both the customer's manifest and the real bridge are served verbatim.
      await runContainerCapture({
        inputDir,
        spec: { ...SPEC, entryPath: 'scene/index.html' },
        outputDir: join(dir, 'out'),
        driver,
      });
      expect(manifestFetch.status).toBe(200);
      expect(manifestFetch.body).toContain('short_name');
      expect(bridgeFetch.status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds NO missing-file noise when the package served everything it was asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    try {
      const driver: SimCaptureDriver = {
        async drive() {
          throw new CaptureStageError('paint_ready', 'SIM_PAINTED: no signal');
        },
      };
      const err = await runContainerCapture({
        packageFiles: PACKAGE, spec: SPEC, outputDir: join(dir, 'out'), driver,
      }).catch((e: unknown) => e as Error);
      expect((err as Error).message).not.toMatch(/package is missing/);
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
