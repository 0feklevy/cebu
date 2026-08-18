/**
 * The trusted capture contract, end to end — the production shape, not the unit shape.
 *
 * Each piece of this chain existed and was tested in isolation, and the chain still did not hold:
 * `ContainerCaptureSpec` carried `rendererProfile`, but `CaptureSpec` — the contract the backend
 * actually receives — did not, so `BeginFrameBackend` fell back to reading `EXPORT_CAPTURE_RENDERER`
 * from ITS OWN environment, inside the untrusted container. The trusted side's choice never reached
 * the flags. The same shape of gap had already happened twice (warmupFrames, the cost log), which is
 * why this file tests the WIRE, not the pieces: config → serialized spec → loaded backend → flags.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCaptureSpec, type ContainerCaptureSpec } from '../isolation/captureJobBoundary.js';
import { toBackendSpec } from '../isolation/backendAdapter.js';
import { BeginFrameBackend, assembleBeginFrameFlags } from '../beginFrameBackend.js';
import type { SimCaptureWindow } from '../../types.js';

const WINDOW: SimCaptureWindow = {
  kind: 'sim-capture',
  startSec: 0,
  endSec: 1,
  sectionId: 'sec-e2e',
  label: 'e2e',
  simulationId: 'sim-1',
  servedUrl: 'https://api.flowvidco.com/sim-public/simulations/p/s/pkg/index.html?section=sec-e2e&v=h1',
  simpleUi: false,
  autoScript: true,
  uiHide: [],
  configHash: 'cfg',
  posterKey: null,
};

function containerSpec(rendererProfile: 'swiftshader' | 'hardware'): ContainerCaptureSpec {
  return buildCaptureSpec(WINDOW, {
    entryPath: 'pkg/index.html',
    output: { format: 'jpeg', quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
    fps: 10,
    width: 320,
    height: 180,
    warmupFrames: 0,
    rendererProfile,
    wallClockTimeoutSec: 30,
  });
}

describe('the renderer profile crosses the wire, not the environment', () => {
  it('SURVIVES SERIALIZATION: hardware in the config is hardware in the JSON the container reads', () => {
    const spec = containerSpec('hardware');
    const parsed = JSON.parse(JSON.stringify(spec)) as ContainerCaptureSpec;
    expect(parsed.rendererProfile).toBe('hardware');
  });

  it('REACHES THE BACKEND SPEC: toBackendSpec forwards it — the link that was missing', () => {
    const backendSpec = toBackendSpec(containerSpec('hardware'), 'http://127.0.0.1:1/pkg/index.html');
    expect(backendSpec.rendererProfile).toBe('hardware');
  });

  it('DECIDES THE FLAGS from the spec, with a hostile child environment trying to say otherwise', async () => {
    // The exact production failure: the trusted side says hardware, the container's env says
    // software (or nothing). The env must be IGNORED — it is on the wrong side of the boundary.
    const saved = process.env.EXPORT_CAPTURE_RENDERER;
    process.env.EXPORT_CAPTURE_RENDERER = 'swiftshader';
    const scratch = await mkdtemp(join(tmpdir(), 'contract-'));
    try {
      const seen: string[][] = [];
      const backend = new BeginFrameBackend({
        workDir: scratch,
        // SYNCHRONOUS, because the real `launchHeadlessShell` is synchronous: it returns a
        // `HeadlessShellHandle`, and `captureSection` calls it inside a plain try/catch with no
        // `await`. An `async` double returns a rejected promise instead of throwing, so that
        // try/catch cannot see it — the rejection escapes as an UNHANDLED error after the test has
        // already passed. Vitest then exits non-zero with "Errors 1" while reporting every test
        // green, which fails the release gate for a reason no failing assertion explains. The
        // `as never` cast is what let the shape mismatch through the type checker.
        launch: ((opts: { flags?: readonly string[] } | undefined) => {
          seen.push([...(opts?.flags ?? [])]);
          throw new Error('stop after flag assembly — the observation above is the test');
        }) as never,
      });
      const backendSpec = toBackendSpec(containerSpec('hardware'), 'http://127.0.0.1:1/pkg/index.html');
      await backend.captureSection(backendSpec).catch(() => {});

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('--use-angle=vulkan');
      expect(seen[0]).not.toContain('--use-angle=swiftshader');
    } finally {
      await rm(scratch, { recursive: true, force: true });
      if (saved === undefined) delete process.env.EXPORT_CAPTURE_RENDERER;
      else process.env.EXPORT_CAPTURE_RENDERER = saved;
    }
  });

  it('an EMPTY or UNKNOWN profile on the backend spec fails — no silent software fallback', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'contract-'));
    try {
      const backend = new BeginFrameBackend({
        workDir: scratch,
        // Synchronous for the same reason as above — a rejected promise here would escape unhandled
        // the moment this guard ever fired, turning a clear failure into an unexplained exit code.
        launch: (() => { throw new Error('must not launch'); }) as never,
      });
      const good = toBackendSpec(containerSpec('hardware'), 'http://127.0.0.1:1/pkg/index.html');
      for (const bad of [undefined, '', 'gpu', 'HARDWARE']) {
        await expect(
          backend.captureSection({ ...good, rendererProfile: bad as never }),
        ).rejects.toThrow(/renderer profile/);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('the hardware flag set exists and still refuses the forbidden switches', () => {
    const flags = assembleBeginFrameFlags({ width: 320, height: 180, profile: 'hardware' });
    expect(flags).toContain('--use-angle=vulkan');
    expect(flags).not.toContain('--no-sandbox');
    expect(flags).not.toContain('--use-angle=gl');
  });
});
