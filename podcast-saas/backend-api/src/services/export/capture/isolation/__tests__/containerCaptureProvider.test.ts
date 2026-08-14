/**
 * The production capture provider, verified WITHOUT docker: the pure pieces (URL→storage-key
 * parsing, env config, wall-clock cap) and the full captureSection orchestration against a FAKE
 * boundary + FAKE storage. What these prove on any host: the provider stages the package + spec
 * on the input mount exactly as the container expects, honours the boundary's verdict (gate
 * failures degrade loudly, never silently), and hands back a clip that OUTLIVES its job dir.
 * The docker execution itself is Linux-checklist territory (runbook §7), same as the boundary.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('parseServedSimUrl', () => {
  it('splits a revisioned sim-public URL into baseDir + entryPath, dropping query and fragment', () => {
    const parsed = parseServedSimUrl(
      'http://127.0.0.1:8080/api/v1/sim-public/simulations/p1/s1/revisions/r1/package/index.html?section=sec-1&v=abc#simboot=%7B%22hide%22%3A%5B%5D%7D',
    );
    expect(parsed).toEqual({
      entryKey: 'simulations/p1/s1/revisions/r1/package/index.html',
      baseDir: 'simulations/p1/s1/revisions/r1/package',
      entryPath: 'index.html',
    });
  });

  it('handles legacy flat keys and percent-encoded path segments', () => {
    const parsed = parseServedSimUrl(
      'https://api.flowvidco.com/api/v1/sim-public/simulations/p1/boids%203d/index.html',
    );
    expect(parsed).toEqual({
      entryKey: 'simulations/p1/boids 3d/index.html',
      baseDir: 'simulations/p1/boids 3d',
      entryPath: 'index.html',
    });
  });

  it('returns null for non-sim URLs, malformed URLs, and keys with no directory', () => {
    expect(parseServedSimUrl('https://api.flowvidco.com/api/v1/podcasts/x.mp3')).toBeNull();
    expect(parseServedSimUrl('not a url')).toBeNull();
    expect(parseServedSimUrl('https://api.flowvidco.com/api/v1/sim-public/orphan.html')).toBeNull();
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
      image: 'podcast-saas/export-worker:1.2.3',
      workDir: null,
      user: '10001:10001',
      cpus: '2',
      memoryMb: 2048,
      pidsLimit: 256,
      tmpfsScratchMb: 512,
      stopTimeoutSec: 10,
      dockerBin: 'docker',
      sandboxMechanism: 'userns',
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
    'http://127.0.0.1:8080/api/v1/sim-public/simulations/p1/s1/revisions/r1/package/index.html?section=sec-1&v=abc#simboot=%7B%22hide%22%3A%5B%5D%7D',
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
    'simulations/p1/s1/revisions/r1/package/index.html': Buffer.from('<!doctype html><title>sim</title>'),
    'simulations/p1/s1/revisions/r1/package/app.js': Buffer.from('console.log(1)'),
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
    rendererIdentity: {
      image: 'podcast-saas/export-worker:test',
      chromeHeadlessShellVersion: 'test',
      viewport: '1920x1080',
      dpr: 1,
    } as ContainerCaptureResult['rendererIdentity'],
    failure: null,
    ...partial,
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
        await writeFile(join(io.outputDir, 'clip.mp4'), Buffer.from('fake-mp4-bytes'));
        return okResult({ clipPath: 'clip.mp4' });
      },
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage());

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
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, fakeStorage());

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
    const provider = new ContainerCaptureProvider(config, boundary, fakeStorage());

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
