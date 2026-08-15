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
  assertFrameSet,
  assertResultMatchesSpec,
  assertRegularArtifact,
  assertWithinOutputDir,
  frameFileName,
  MAX_RESULT_BYTES,
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

/**
 * `result.json` is written on a mount the untrusted container can write, and its `framesDir` /
 * `clipPath` tell a PRIVILEGED reader which file to open: the provider copies the clip and
 * `ProjectExportService` uploads those bytes to storage as the section's MP4. So the two fields are
 * an instruction from untrusted code to a trusted reader, and validating them as "a string" is not
 * validation. Two independent escapes had to be closed:
 *
 *   traversal — `join('/out', '../../../etc/passwd')` is `/etc/passwd`; `join` only ignores a
 *               LEADING slash, it never confines.
 *   symlink   — the mount is container-writable, so a link named exactly `section.mp4` pointing at
 *               a host file is followed by both `copyFile` and ffmpeg.
 */
describe('the container cannot aim the trusted reader at an arbitrary host file', () => {
  const escapes = [
    '../../../../etc/passwd',
    '../.env',
    '/etc/passwd',
    'frames/../../..',
    './frames',
    'frames/',
    'section.mp4.bak',
    '',
  ];

  it.each(escapes)('parseCaptureResult refuses clipPath %j', (bad) => {
    expect(() => parseCaptureResult(JSON.stringify(okResult({ clipPath: bad, framesDir: null })))).toThrow(
      /must name a known artifact|bad clipPath/,
    );
  });

  it.each(escapes)('parseCaptureResult refuses framesDir %j', (bad) => {
    expect(() => parseCaptureResult(JSON.stringify(okResult({ framesDir: bad })))).toThrow(
      /must name a known artifact|bad framesDir/,
    );
  });

  it('still accepts the two legitimate artifact names', () => {
    expect(parseCaptureResult(JSON.stringify(okResult({ framesDir: 'frames' }))).framesDir).toBe('frames');
    expect(
      parseCaptureResult(JSON.stringify(okResult({ framesDir: null, clipPath: 'section.mp4' }))).clipPath,
    ).toBe('section.mp4');
  });

  it('assertWithinOutputDir follows a symlink and refuses the one that leaves the output dir', async () => {
    const { symlink, writeFile: wf, mkdir: md } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-confine-'));
    try {
      const outputDir = join(root, 'output');
      await md(outputDir, { recursive: true });
      const secret = join(root, 'secret.env');
      await wf(secret, 'DATABASE_URL=postgres://real');

      // The attack: a link named exactly like a legitimate artifact, pointing outside.
      await symlink(secret, join(outputDir, 'section.mp4'));
      await expect(assertWithinOutputDir(outputDir, 'section.mp4')).rejects.toThrow(/outside the output directory/);

      // The honest case still resolves, and returns a real path the caller can read.
      await md(join(outputDir, 'frames'), { recursive: true });
      await expect(assertWithinOutputDir(outputDir, 'frames')).resolves.toContain('frames');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('assertWithinOutputDir refuses an artifact that does not exist rather than guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boundary-missing-'));
    try {
      await expect(assertWithinOutputDir(root, 'section.mp4')).rejects.toThrow(/not readable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The rest of the output boundary. The artifact-NAME allowlist and directory confinement closed the
 * first two escapes; these cover what was still open one level down, each with a concrete primitive:
 *
 *   result.json itself   — a symlink to a character device makes the trusted reader allocate
 *                          without bound (measured: ~6.8 GB in 2.5 s on Node 22) until the process
 *                          holding every tenant's credentials is OOM-killed.
 *   entries inside frames/ — ffmpeg opens each frame in the HOST namespace and follows symlinks, so
 *                          confining only the directory still let any host file that decodes as an
 *                          image be encoded into the served MP4.
 *
 * The container is already dead when these run, so verify-then-use has no TOCTOU gap.
 */
describe('the output boundary below the artifact name', () => {
  const NAME_PATTERN = 'frame-%06d.jpg';

  async function frames(root: string, count: number): Promise<string> {
    const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
    const dir = join(root, 'frames');
    await md(dir, { recursive: true });
    for (let i = 0; i < count; i++) await wf(join(dir, frameFileName(NAME_PATTERN, i)), `f${i}`);
    return dir;
  }

  it('frameFileName expands the trusted printf pattern', () => {
    expect(frameFileName('frame-%06d.jpg', 0)).toBe('frame-000000.jpg');
    expect(frameFileName('frame-%06d.jpg', 42)).toBe('frame-000042.jpg');
    expect(() => frameFileName('frame.jpg', 0)).toThrow(/%0Nd/);
  });

  it('refuses a result.json that is a symlink out of the output dir', async () => {
    const { symlink, writeFile: wf, mkdir: md } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-result-'));
    try {
      const out = join(root, 'output');
      await md(out, { recursive: true });
      await wf(join(root, 'secret.env'), 'DATABASE_URL=postgres://real');
      await symlink(join(root, 'secret.env'), join(out, 'result.json'));
      await expect(readCaptureResult(out)).rejects.toThrow(/outside the output directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a result.json larger than the cap, before parsing it', async () => {
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-big-'));
    try {
      const out = join(root, 'output');
      await md(out, { recursive: true });
      await wf(join(out, 'result.json'), Buffer.alloc(MAX_RESULT_BYTES + 1, 0x20));
      await expect(readCaptureResult(out)).rejects.toThrow(/over the .* cap/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an honest result.json of ordinary size', async () => {
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-ok-'));
    try {
      const out = join(root, 'output');
      await md(out, { recursive: true });
      await wf(join(out, 'result.json'), JSON.stringify(okResult()));
      await expect(readCaptureResult(out)).resolves.toMatchObject({ sectionId: 'sec-1', gate: 'passed' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a frames directory holding a SYMLINK where a frame should be', async () => {
    const { symlink, writeFile: wf, unlink } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-frames-'));
    try {
      const dir = await frames(root, 3);
      await wf(join(root, 'host-secret.jpg'), 'JPEGBYTES');
      // The exact attack: a link named like a legitimate frame. ffmpeg would have opened it.
      await unlink(join(dir, 'frame-000001.jpg'));
      await symlink(join(root, 'host-secret.jpg'), join(dir, 'frame-000001.jpg'));

      await expect(
        assertFrameSet(root, 'frames', { expectedFrames: 3, namePattern: NAME_PATTERN }),
      ).rejects.toThrow(/not a regular file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an unexpected extra entry, and a missing frame', async () => {
    const { writeFile: wf, unlink } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-count-'));
    try {
      const dir = await frames(root, 3);
      await wf(join(dir, 'frame-000009.jpg'), 'extra');
      await expect(
        assertFrameSet(root, 'frames', { expectedFrames: 3, namePattern: NAME_PATTERN }),
      ).rejects.toThrow(/unexpected entr/);

      await unlink(join(dir, 'frame-000009.jpg'));
      await unlink(join(dir, 'frame-000002.jpg'));
      await expect(
        assertFrameSet(root, 'frames', { expectedFrames: 3, namePattern: NAME_PATTERN }),
      ).rejects.toThrow(/missing frame-000002\.jpg/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts exactly the frame set the trusted side expects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boundary-good-'));
    try {
      await frames(root, 5);
      await expect(
        assertFrameSet(root, 'frames', { expectedFrames: 5, namePattern: NAME_PATTERN }),
      ).resolves.toContain('frames');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a frames path that is a regular file, and a clip path that is a directory', async () => {
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'boundary-kind-'));
    try {
      await wf(join(root, 'frames'), 'not a directory');
      await expect(
        assertFrameSet(root, 'frames', { expectedFrames: 1, namePattern: NAME_PATTERN }),
      ).rejects.toThrow(/not a directory/);

      await md(join(root, 'section.mp4'), { recursive: true });
      await expect(assertRegularArtifact(root, 'section.mp4')).rejects.toThrow(/not a regular file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Binding the result to the spec. `parseCaptureResult` proves the JSON is well-SHAPED; these prove
 * it is well-FOUNDED. The container authors every field, so on its own the result is a claim: it can
 * name another section, report a frame count that does not fill the window, or report a viewport it
 * never rendered at. Each corrupts something downstream — the wrong clip spliced into the timeline,
 * a clip too short for its window, a 320x180 render stretched across a 1080p frame — and none of
 * them looks like a failure when it happens.
 */
describe('a result must match the spec that asked for it', () => {
  const spec = (over: Partial<ContainerCaptureSpec> = {}): ContainerCaptureSpec =>
    buildCaptureSpec(simWindow(), { ...OPTS, ...over });

  it('accepts an honest result', () => {
    expect(() => assertResultMatchesSpec(okResult(), spec())).not.toThrow();
  });

  it('refuses a result for a DIFFERENT section — the wrong clip in the timeline', () => {
    expect(() => assertResultMatchesSpec(okResult({ sectionId: 'sec-other' }), spec()))
      .toThrow(/is for section .*not sec-1/);
  });

  it('refuses a passing result whose frame count does not fill the window', () => {
    // 15 s at 30 fps = 450 frames. 449 leaves a gap the assembler would silently stretch or pad.
    expect(() => assertResultMatchesSpec(okResult({ frameCount: 449 }), spec()))
      .toThrow(/claims 449 frames.*needs 450/);
  });

  it('allows a FAILING result to stop early — an incomplete run is not a lie', () => {
    expect(() => assertResultMatchesSpec(okResult({ gate: 'failed', frameCount: 12 }), spec())).not.toThrow();
  });

  it('refuses a viewport or DPR the capture never rendered at', () => {
    const smallViewport = okResult({
      rendererIdentity: { ...RENDERER, viewport: { w: 320, h: 180 } },
    });
    expect(() => assertResultMatchesSpec(smallViewport, spec())).toThrow(/viewport 320×180/);

    const wrongDpr = okResult({ rendererIdentity: { ...RENDERER, dpr: 2 } });
    expect(() => assertResultMatchesSpec(wrongDpr, spec())).toThrow(/DPR 2/);
  });

  it('refuses a passing result with both artifact forms, or neither', () => {
    expect(() => assertResultMatchesSpec(okResult({ framesDir: 'frames', clipPath: 'section.mp4' }), spec()))
      .toThrow(/exactly one of frames or a clip, got 2/);
    expect(() => assertResultMatchesSpec(okResult({ framesDir: null, clipPath: null }), spec()))
      .toThrow(/exactly one of frames or a clip, got 0/);
  });
});
