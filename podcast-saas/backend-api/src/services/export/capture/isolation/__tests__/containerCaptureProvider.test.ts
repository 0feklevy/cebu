/**
 * The production capture provider, verified WITHOUT docker: the pure pieces (URL→storage-key
 * parsing, env config, wall-clock cap) and the full captureSection orchestration against a FAKE
 * boundary + FAKE storage. What these prove on any host: the provider stages the package + spec
 * on the input mount exactly as the container expects, honours the boundary's verdict (gate
 * failures degrade loudly, never silently), and hands back a clip that OUTLIVES its job dir.
 * The docker execution itself is Linux-checklist territory (runbook §7), same as the boundary.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../../../lib/logger.js';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageService } from '../../../../storage/StorageService.js';
import { CaptureUnavailable, type CaptureSpec } from '../../captureTypes.js';
import {
  CAPTURE_SPEC_FILENAME,
  type CaptureIo,
  type ContainerCaptureResult,
  type ContainerCaptureSpec,
} from '../captureJobBoundary.js';
import {
  ContainerCaptureProvider,
  MAX_PACKAGE_BYTES,
  boundaryConfigFrom,
  configFromEnv,
  parseServedSimUrl,
  wallClockCapSec,
  type ContainerCaptureConfig,
} from '../containerCaptureProvider.js';

// ── parseServedSimUrl ───────────────────────────────────────────────────────────────────────────

/**
 * Probes that report exactly what the spec asked for.
 *
 * These suites drive the provider with fake frame bytes ('a', 'b'), so running a real `ffprobe` over
 * them would only prove that ffprobe rejects text. The pixel-reading half is exercised for real by
 * the end-to-end encode test; here it is stubbed to AGREE, so a staging or parsing regression is
 * what fails, not the fixture. The values are derived from the spec rather than hard-coded, because
 * a stub that always says 1920x1080 would quietly pass a provider that stopped checking.
 */
function probesFor(spec: { width: number; height: number; fps: number; durationSec: number }) {
  const frames = Math.round(spec.durationSec * spec.fps);
  return {
    probeImage: async () => ({ codec: 'mjpeg', width: spec.width, height: spec.height }),
    probeClip: async () => ({
      streams: 1, codec: 'h264', pixFmt: 'yuv420p',
      width: spec.width, height: spec.height, fps: spec.fps,
      durationSec: frames / spec.fps, frames,
    }),
  };
}

describe('parseServedSimUrl', () => {
  const REV_UUID = '11111111-2222-4333-8444-555555555555';

  it('resolves a revisioned sim-public URL to the PACKAGE ROOT, dropping query and fragment', () => {
    const parsed = parseServedSimUrl(
      `http://127.0.0.1:8080/api/v1/sim-public/simulations/p1/s1/revisions/${REV_UUID}/package/index.html?section=sec-1&v=abc#simboot=%7B%22hide%22%3A%5B%5D%7D`,
    );
    expect(parsed).toEqual({
      layout: 'revision',
      entryKey: `simulations/p1/s1/revisions/${REV_UUID}/package/index.html`,
      packageRoot: `simulations/p1/s1/revisions/${REV_UUID}/package`,
      entryPath: 'index.html',
    });
  });

  it('handles legacy keys and percent-encoded path segments, keeping the entry NESTED', () => {
    // The v0.1.23 shape: the package root is the simulation prefix, and the entry keeps its
    // directory so the stored `../bridge.js` still points at the root.
    const parsed = parseServedSimUrl(
      'https://api.flowvidco.com/api/v1/sim-public/simulations/p1/s1/boids%203d/index.html',
    );
    expect(parsed).toEqual({
      layout: 'legacy',
      entryKey: 'simulations/p1/s1/boids 3d/index.html',
      packageRoot: 'simulations/p1/s1',
      entryPath: 'boids 3d/index.html',
    });
  });

  it('returns null for non-sim URLs, malformed URLs, and keys the grammar refuses', () => {
    expect(parseServedSimUrl('https://api.flowvidco.com/api/v1/podcasts/x.mp3')).toBeNull();
    expect(parseServedSimUrl('not a url')).toBeNull();
    expect(parseServedSimUrl('https://api.flowvidco.com/api/v1/sim-public/orphan.html')).toBeNull();
    // Below the canonical simulations/<project>/<sim> depth — not an entry.
    expect(parseServedSimUrl('https://api.flowvidco.com/api/v1/sim-public/simulations/p1/s1')).toBeNull();
  });
});

// ── configFromEnv / wallClockCapSec ─────────────────────────────────────────────────────────────

describe('configFromEnv', () => {
  it('is null unless EXPORT_CAPTURE_IMAGE is set — the provider stays off by default', () => {
    expect(configFromEnv({})).toBeNull();
    expect(configFromEnv({ EXPORT_CAPTURE_IMAGE: '   ' })).toBeNull();
  });

  it('applies the documented defaults and coerces garbage numbers back to them', () => {
    const config = configFromEnv({
      EXPORT_CAPTURE_IMAGE: 'podcast-saas/export-worker:1.2.3',
      EXPORT_CAPTURE_MEMORY_MB: 'not-a-number',
    });
    expect(config).toMatchObject({
      image: 'podcast-saas/export-worker:1.2.3', rendererProfile: 'swiftshader',
      workDir: null,
      user: '10001:10001',
      cpus: '2',
      memoryMb: 2048,
      pidsLimit: 256,
      tmpfsScratchMb: 512,
      stopTimeoutSec: 10,
      dockerBin: 'docker',
      sandboxMechanism: 'userns',
      gpuCdiDevice: 'nvidia.com/gpu=0',
      maxOutputMb: 4096,
    });
  });

  it('honours explicit overrides', () => {
    const config = configFromEnv({
      EXPORT_CAPTURE_IMAGE: 'img:x',
      EXPORT_CAPTURE_WORKDIR: '/var/lib/flowvid-capture',
      EXPORT_CAPTURE_CPUS: '1.5',
      EXPORT_CAPTURE_MEMORY_MB: '3072',
      EXPORT_CAPTURE_DOCKER_BIN: '/usr/local/bin/docker',
    });
    expect(config).toMatchObject({
      workDir: '/var/lib/flowvid-capture',
      cpus: '1.5',
      memoryMb: 3072,
      dockerBin: '/usr/local/bin/docker',
    });
  });

  it('parses the sandbox mechanism from the STRICT allow-list only', () => {
    expect(
      configFromEnv({ EXPORT_CAPTURE_IMAGE: 'img:x', EXPORT_CAPTURE_SANDBOX_MECHANISM: 'sys-admin' }),
    ).toMatchObject({ sandboxMechanism: 'sys-admin' });
    expect(
      configFromEnv({ EXPORT_CAPTURE_IMAGE: 'img:x', EXPORT_CAPTURE_SANDBOX_MECHANISM: 'userns' }),
    ).toMatchObject({ sandboxMechanism: 'userns' });
  });

  it('THROWS on an unknown mechanism instead of silently defaulting (no quiet sandbox downgrade)', () => {
    // 'seccomp-profile' exists in the assembler but is deliberately NOT env-selectable (it needs a
    // curated profile file); arbitrary strings must never pass through to docker either.
    for (const bad of ['seccomp-profile', 'privileged', 'no-sandbox', 'SYS-ADMIN', 'anything']) {
      expect(() =>
        configFromEnv({ EXPORT_CAPTURE_IMAGE: 'img:x', EXPORT_CAPTURE_SANDBOX_MECHANISM: bad }),
      ).toThrow(/allowed: userns, sys-admin/);
    }
  });
});

describe('boundaryConfigFrom — the env → boundary chain link', () => {
  it('passes the sandbox mechanism through to the DockerCaptureBoundary configuration', () => {
    const config = configFromEnv({
      EXPORT_CAPTURE_IMAGE: 'img:x',
      EXPORT_CAPTURE_SANDBOX_MECHANISM: 'sys-admin',
    });
    expect(config).not.toBeNull();
    expect(boundaryConfigFrom(config as ContainerCaptureConfig)).toMatchObject({
      image: 'img:x',
      sandboxMechanism: 'sys-admin',
    });
  });
});

describe('wallClockCapSec', () => {
  it('scales with duration and never exceeds the 600s ceiling', () => {
    expect(wallClockCapSec(2)).toBe(102);
    expect(wallClockCapSec(15)).toBe(180);
    expect(wallClockCapSec(10_000)).toBe(600);
  });
});

// ── captureSection orchestration (fake boundary, fake storage, no docker) ───────────────────────

const SPEC: CaptureSpec = {
  servedSimUrl:
    'http://127.0.0.1:8080/api/v1/sim-public/simulations/p1/s1/revisions/rev-01HZX9K4TQ8M/package/index.html?section=sec-1&v=abc#simboot=%7B%22hide%22%3A%5B%5D%7D',
  sectionId: 'sec-1',
  simpleUi: true,
  autoScript: true,
  uiHide: ['.hud'],
  durationSec: 2,
  fps: 30,
  width: 1920,
  height: 1080,
  configHash: 'cfg-1',
  posterKey: 'posters/p1/sec-1.png',
};

/** Two-file fake package under the URL's baseDir prefix. */
function fakeStorage(): StorageService {
  const objects: Record<string, Buffer> = {
    'simulations/p1/s1/revisions/rev-01HZX9K4TQ8M/package/index.html': Buffer.from('<!doctype html><title>sim</title>'),
    'simulations/p1/s1/revisions/rev-01HZX9K4TQ8M/package/app.js': Buffer.from('console.log(1)'),
  };
  return {
    listObjects: async (prefix: string) =>
      Object.keys(objects).filter((k) => k.startsWith(prefix)),
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
    gpuCdiDevice: 'nvidia.com/gpu=0',
    maxOutputMb: 4096,
  };
}

function okResult(partial: Partial<ContainerCaptureResult>): ContainerCaptureResult {
  return {
    resultVersion: 1,
    sectionId: 'sec-1',
    status: 'ok',
    framesDir: null,
    clipPath: null,
    frameCount: 60,
    rendererString: 'ANGLE (test)',
    gate: 'passed',
    reason: null,
    // The REAL RendererIdentity shape (types.ts). The previous fixture carried the pre-refactor
    // field names under an `as` cast — which is how a fixture goes stale without a test noticing.
    rendererIdentity: {
      imageDigest: 'sha256:test', headlessShellVersion: 'test',
      viewport: { w: 1920, h: 1080 }, dpr: 1,
    },
    failure: null,
    ...partial,
    // `Partial` lets an override carry an explicit undefined, which the wire type
    // forbids (cost is `| null`, never absent). Normalize after the spread.
    cost: partial.cost ?? null,
  };
}

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('ContainerCaptureProvider.captureSection', () => {
  it('stages the package + spec on the input mount and returns the clip OUTSIDE the removed job dir', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-test-'));
    let seenSpec: ContainerCaptureSpec | null = null;
    let seenInputDir = '';
    const boundary = {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        seenSpec = spec;
        seenInputDir = io.inputDir;
        // The staged input must be complete BEFORE the container starts.
        const staged = JSON.parse(await readFile(join(io.inputDir, CAPTURE_SPEC_FILENAME), 'utf8'));
        expect(staged.sectionId).toBe('sec-1');
        await access(join(io.inputDir, 'index.html'));
        await access(join(io.inputDir, 'app.js'));
        // Mimic a clip-emitting container backend.
        await writeFile(join(io.outputDir, 'section.mp4'), Buffer.from('fake-mp4-bytes'));
        return okResult({ clipPath: 'section.mp4' });
      },
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage(), probesFor(SPEC));

    const result = await provider.captureSection(SPEC);

    // The container spec carried the parsed entry + verbatim query/fragment + the section script.
    expect(seenSpec).toMatchObject({
      entryPath: 'index.html',
      entryQuery: '?section=sec-1&v=abc',
      sectionId: 'sec-1',
      durationSec: 2,
      wallClockTimeoutSec: 102,
      startScript: { simpleUi: true, autoScript: true, uiHide: ['.hud'] },
    });
    expect((seenSpec as unknown as ContainerCaptureSpec).entryFragment).toContain('#simboot=');

    // The clip survives even though the job dir (input+output mounts) is removed.
    expect(result.gate).toBe('passed');
    expect(result.clipPath).toBeTruthy();
    expect(String(await readFile(result.clipPath as string))).toBe('fake-mp4-bytes');
    await expect(access(seenInputDir)).rejects.toThrow();
  });

  it('degrades LOUDLY on a gate failure: verdict + reason pass through, no clip is invented', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-test-'));
    const boundary = {
      async runCapture(): Promise<ContainerCaptureResult> {
        return okResult({ gate: 'failed', reason: 'all frames byte-identical', frameCount: 60 });
      },
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage(), probesFor(SPEC));

    const result = await provider.captureSection(SPEC);
    expect(result.gate).toBe('failed');
    expect(result.reason).toBe('all frames byte-identical');
    expect(result.clipPath).toBeUndefined();
  });

  it('throws CaptureUnavailable when the worker image is not runnable on this host', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-test-'));
    const boundary = {
      async runCapture(): Promise<ContainerCaptureResult> {
        throw new Error('must not be reached');
      },
    };
    const config = { ...testConfig(scratch), dockerBin: '/nonexistent-docker-binary' };
    const provider = new ContainerCaptureProvider(config, boundary, fakeStorage(), probesFor(SPEC));

    await expect(provider.captureSection(SPEC)).rejects.toBeInstanceOf(CaptureUnavailable);
  });

  it('fails loudly when the URL parses but storage has no package under the prefix', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-test-'));
    const boundary = {
      async runCapture(): Promise<ContainerCaptureResult> {
        throw new Error('must not be reached');
      },
    };
    const empty = {
      listObjects: async () => [],
      readObject: async () => Buffer.alloc(0),
    } as unknown as StorageService;
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, empty);

    await expect(provider.captureSection(SPEC)).rejects.toThrow(/no package objects/);
  });

  it('exposes the package-size ceiling as a real, testable constant', () => {
    expect(MAX_PACKAGE_BYTES).toBe(256 * 1024 * 1024);
  });
});

/**
 * The provider half of the trusted contract — the links that were missing even though every piece
 * existed. `warmupFrames` was hardcoded to the default here, so the value a controlled experiment
 * set never reached the container; the cost split was parsed and validated at the boundary and then
 * reached no log or metric anything could read.
 */
describe('the provider forwards what the trusted side decided', () => {
  it.each([0, 7])('warmupFrames=%i from the CALLER reaches the container spec', async (warmupFrames) => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-warmup-'));
    let seen: ContainerCaptureSpec | null = null;
    const boundary = {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        seen = spec;
        await writeFile(join(io.outputDir, 'section.mp4'), Buffer.from('mp4'));
        return okResult({ clipPath: 'section.mp4' });
      },
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage(), probesFor(SPEC));
    await provider.captureSection({ ...SPEC, warmupFrames });
    expect(seen!.warmupFrames).toBe(warmupFrames);
  });

  it('the JOB\'s renderer profile beats the provider\'s env-resolved config', async () => {
    // An operator flipping EXPORT_CAPTURE_RENDERER after enqueue must not change what an
    // already-consented job renders with.
    scratch = await mkdtemp(join(tmpdir(), 'ccp-prof-'));
    let seen: ContainerCaptureSpec | null = null;
    const boundary = {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        seen = spec;
        await writeFile(join(io.outputDir, 'section.mp4'), Buffer.from('mp4'));
        return okResult({ clipPath: 'section.mp4' });
      },
    };
    const provider = new ContainerCaptureProvider(
      { ...testConfig(scratch), rendererProfile: 'swiftshader' }, boundary, fakeStorage(), probesFor(SPEC));
    await provider.captureSection({ ...SPEC, rendererProfile: 'hardware' });
    expect(seen!.rendererProfile).toBe('hardware');
  });

  it('the cost split reaches the HOST log on the happy path — observability, not just parsing', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-cost-'));
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      const cost = { simMs: 153, flushMs: 19, rasterMs: 5193, writeMs: 1, frames: 60 };
      const boundary = {
        async runCapture(_spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
          await writeFile(join(io.outputDir, 'section.mp4'), Buffer.from('mp4'));
          return { ...okResult({ clipPath: 'section.mp4' }), cost };
        },
      };
      const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage(), probesFor(SPEC));
      const result = await provider.captureSection(SPEC);

      // On the returned result, so the service can persist it…
      expect(result.cost).toEqual(cost);
      // …and in a structured host log entry, so "why is this slow" has an answer without a rebuild.
      const costLog = infoSpy.mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].includes('section captured'),
      );
      expect(costLog?.[0]).toMatchObject({ cost });
    } finally {
      infoSpy.mockRestore();
    }
  });
});

/**
 * The provider consumes artifacts and owns temporary directories — two things the first hardening
 * pass left half-done. Probing only the first and last frame let a wrong-sized MIDDLE frame reach
 * the viewer; a throw after clipOut was created leaked it onto the host forever.
 */
describe('the provider validates every frame and leaks no clip directory', () => {
  it('rejects a wrong-sized MIDDLE frame, not just the ends', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-mid-'));
    const boundary = {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        const frames = join(io.outputDir, 'frames');
        await mkdir(frames, { recursive: true });
        const n = Math.round(spec.durationSec * spec.fps);
        for (let i = 0; i < n; i++) {
          await writeFile(join(frames, `frame-${String(i).padStart(6, '0')}.jpg`), Buffer.from(`f${i}`));
        }
        return okResult({ framesDir: 'frames', clipPath: null, frameCount: n });
      },
    };
    // Wrong size for ONE frame in the MIDDLE, keyed by name rather than call order: probing only
    // the first and last would never open this file, which is exactly the gap under test.
    const total = Math.round(SPEC.durationSec * SPEC.fps);
    const badName = `frame-${String(Math.floor(total / 2)).padStart(6, '0')}.jpg`;
    const probes = {
      probeImage: async (path: string) => (path.endsWith(badName)
        ? { codec: 'mjpeg', width: 16, height: 16 }
        : { codec: 'mjpeg', width: SPEC.width, height: SPEC.height }),
      probeClip: async () => ({ streams: 1, codec: 'h264', pixFmt: 'yuv420p', width: SPEC.width, height: SPEC.height, fps: SPEC.fps, durationSec: 2, frames: 60 }),
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage(), probes);
    await expect(provider.captureSection(SPEC)).rejects.toThrow(/16x16, not the requested/);
  });

  it('deletes the clip directory when a later step throws — no orphan on the host', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ccp-leak-'));
    const boundary = {
      async runCapture(_spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        await writeFile(join(io.outputDir, 'section.mp4'), Buffer.from('mp4'));
        return okResult({ clipPath: 'section.mp4' });
      },
    };
    // A clip whose probe FAILS the match: the clipOut directory has been created by then.
    const probes = {
      probeImage: async () => ({ codec: 'mjpeg', width: SPEC.width, height: SPEC.height }),
      probeClip: async () => ({ streams: 1, codec: 'h264', pixFmt: 'yuv420p', width: 2, height: 2, fps: SPEC.fps, durationSec: 2, frames: 60 }),
    };
    const before = (await readdir(scratch)).filter((n) => n.startsWith('clip-'));
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage(), probes);
    await expect(provider.captureSection(SPEC)).rejects.toThrow(/2x2/);
    const after = (await readdir(scratch)).filter((n) => n.startsWith('clip-'));
    // MUTATION TARGET: drop the catch that rm's clipOut and this directory survives.
    expect(after).toEqual(before);
  });
});
