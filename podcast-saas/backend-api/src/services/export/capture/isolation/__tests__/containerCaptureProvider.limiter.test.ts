/**
 * REGRESSION GUARD for the frame→clip encode's place in the global ffmpeg concurrency cap.
 *
 * WHAT THIS DEFENDS, and why it is a guard rather than a red-to-green.
 * `encodeFramesToClip` was, for three commits, the ONE ffmpeg spawn in the process that did not go
 * through `runFfmpegLimited`. On the 2-vCPU worker host that is the system's scaling constraint,
 * that meant a burst of captures could put an unbounded number of x264 runs on the machine while
 * the limiter built to prevent exactly that never saw them. It is wired now (audit performance-004
 * was refuted against this tree), and this test exists so it cannot quietly come unwired again:
 * deleting the `runFfmpegLimited(...)` wrapper turns this RED (mutation-verified).
 *
 * The assertion is the limiter's own queue, not a spy on a mock. Every slot is held, then a capture
 * is driven to the encode; if the encode respects the cap it must QUEUE, and `ffmpegLimiterState()`
 * is the only thing that can see that. The injected probes deliberately do NOT touch the limiter,
 * so the encode is the sole candidate for the queued task — an unlimited encode leaves `queued` at
 * zero and this test fails on its own deadline rather than on a stub's say-so.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageService } from '../../../../storage/StorageService.js';
import type { CaptureSpec } from '../../captureTypes.js';
import { runFfmpegLimited, ffmpegLimiterState } from '../../../../ffmpegLimit.js';
import {
  frameFileName,
  type CaptureIo,
  type ContainerCaptureResult,
  type ContainerCaptureSpec,
} from '../captureJobBoundary.js';
import { ContainerCaptureProvider, type ContainerCaptureConfig } from '../containerCaptureProvider.js';

/** A tiny window: 1s @ 2fps = 2 frames, so the staged frame set stays trivial. */
const SPEC: CaptureSpec = {
  servedSimUrl:
    'http://127.0.0.1:8080/api/v1/sim-public/simulations/p1/s1/revisions/rev-01HZX9K4TQ8M/package/index.html?section=sec-1',
  sectionId: 'sec-1',
  simpleUi: true,
  autoScript: false,
  uiHide: [],
  durationSec: 1,
  fps: 2,
  width: 320,
  height: 180,
  configHash: 'cfg-1',
  posterKey: null,
};

function fakeStorage(): StorageService {
  const objects: Record<string, Buffer> = {
    'simulations/p1/s1/revisions/rev-01HZX9K4TQ8M/package/index.html':
      Buffer.from('<!doctype html><title>sim</title>'),
  };
  return {
    listObjects: async (prefix: string) => Object.keys(objects).filter((k) => k.startsWith(prefix)),
    readObject: async (key: string) => {
      const found = objects[key];
      if (!found) throw new Error(`missing ${key}`);
      return found;
    },
  } as unknown as StorageService;
}

/** `dockerBin: 'true'` exits 0 for any argv, so isAvailable() passes without docker installed. */
function testConfig(workDir: string): ContainerCaptureConfig {
  return {
    image: 'podcast-saas/export-worker:test',
    rendererProfile: 'swiftshader',
    workDir,
    user: '10001:10001',
    cpus: '2',
    memoryMb: 2048,
    pidsLimit: 256,
    tmpfsScratchMb: 512,
    stopTimeoutSec: 10,
    dockerBin: 'true',
    sandboxMechanism: 'userns',
  };
}

/** Probes that AGREE with the spec and never take a limiter slot — see the file header. */
const probes = {
  probeImage: async () => ({ codec: 'mjpeg', width: SPEC.width, height: SPEC.height }),
  probeClip: async () => ({
    streams: 1, codec: 'h264', pixFmt: 'yuv420p',
    width: SPEC.width, height: SPEC.height, fps: SPEC.fps,
    durationSec: 1, frames: 2,
  }),
};

/** A boundary that emits a FRAMES directory — the shape the in-container backend actually returns. */
const framesBoundary = {
  async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
    const framesDir = join(io.outputDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    for (let i = 0; i < 2; i++) {
      // Not real JPEG bytes: this test never needs the encode to SUCCEED, only to ask for a slot.
      await writeFile(join(framesDir, frameFileName(spec.output.namePattern, i)), Buffer.from('x'));
    }
    return {
      resultVersion: 1,
      sectionId: 'sec-1',
      status: 'ok',
      framesDir: 'frames',
      clipPath: null,
      frameCount: 2,
      rendererString: 'ANGLE (test)',
      gate: 'passed',
      reason: null,
      rendererIdentity: {
        image: 'podcast-saas/export-worker:test', rendererProfile: 'swiftshader',
        chromeHeadlessShellVersion: 'test', viewport: '320x180', dpr: 1,
      } as ContainerCaptureResult['rendererIdentity'],
      failure: null,
    };
  },
};

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('frame→clip encode is inside the global ffmpeg cap', () => {
  it('QUEUES behind a saturated limiter instead of spawning x264 unbounded', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-limiter-'));
    const { max } = ffmpegLimiterState();

    // Hold every slot with tasks that settle only when we say so.
    const release: Array<() => void> = [];
    const held = Array.from({ length: max }, () =>
      runFfmpegLimited(() => new Promise<void>((r) => release.push(r))),
    );
    // Let each holder actually acquire before the capture starts.
    while (ffmpegLimiterState().active < max) await new Promise((r) => setTimeout(r, 5));

    const provider = new ContainerCaptureProvider(
      testConfig(scratch), framesBoundary, fakeStorage(), probes,
    );
    const capture = provider.captureSection(SPEC).catch((e: unknown) => e);

    // The encode must appear in the limiter's QUEUE. An unwrapped spawn never does, and this
    // deadline is what fails then — nothing else in the flow asks the limiter for a slot.
    const deadline = Date.now() + 15_000;
    while (ffmpegLimiterState().queued === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      ffmpegLimiterState().queued,
      'the frame→clip encode did not queue behind the global ffmpeg cap — it is bypassing runFfmpegLimited',
    ).toBeGreaterThanOrEqual(1);

    for (const r of release) r();
    await Promise.all(held);
    // The encode itself fails (the frames are the byte 'x', not JPEG); this test is about the
    // SLOT, and the failure path must still hand the slot back.
    await capture;
    expect(ffmpegLimiterState()).toMatchObject({ active: 0, queued: 0 });
  }, 30_000);
});
