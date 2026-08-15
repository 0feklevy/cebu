/**
 * The beginFrame backend — LOGIC ONLY. It cannot capture on macOS (measured), so these tests pin the
 * parts that don't need a browser: the exact flag set (§4's six `--deterministic-mode` switches, the
 * GL flags, the forbidden list), the CDP message shapes, and the honest macOS/host refusal. Nothing
 * here claims a capture happened.
 */

import { describe, it, expect } from 'vitest';

import {
  compositedSamplerExpression,
  assembleBeginFrameFlags,
  assertNoForbiddenFlags,
  buildCreateTargetParams,
  buildScreenshotParams,
  buildBeginFrameSchedule,
  assertBeginFrameRunnable,
  BeginFrameBackend,
  createBackend,
  DETERMINISTIC_MODE_SWITCHES,
  GL_SWITCHES,
} from '../beginFrameBackend.js';
import { CaptureUnavailable } from '../captureTypes.js';

describe('assembleBeginFrameFlags', () => {
  const flags = assembleBeginFrameFlags({ width: 1920, height: 1080 });

  it('includes --deterministic-mode and all six switches it implies, spelled out', () => {
    expect(flags).toContain('--deterministic-mode');
    for (const s of DETERMINISTIC_MODE_SWITCHES) expect(flags).toContain(s);
    expect(DETERMINISTIC_MODE_SWITCHES).toHaveLength(6);
  });

  it('includes the self-applied switches --deterministic-mode does NOT set', () => {
    expect(flags).toContain('--hide-scrollbars');
    expect(flags).toContain('--force-device-scale-factor=1');
    expect(flags).toContain('--force-color-profile=srgb');
    expect(flags).toContain('--disable-background-timer-throttling');
    expect(flags).toContain('--mute-audio');
    expect(flags).toContain('--disable-dev-shm-usage');
  });

  it('uses SwiftShader for GL and keeps --enable-unsafe-swiftshader as belt-and-braces', () => {
    expect(GL_SWITCHES).toEqual(['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
    for (const s of GL_SWITCHES) expect(flags).toContain(s);
    expect(flags).toContain('--window-size=1920,1080');
  });

  it('never emits a forbidden flag, and rejects one passed as extra', () => {
    // The measured killers: --site-per-process vetoes deterministic-mode; --disable-gpu / --use-angle=gl
    // / --in-process-gpu / --single-process break WebGL on a GPU-less box; --no-sandbox is off by design.
    expect(() => assembleBeginFrameFlags({ width: 1, height: 1, extra: ['--disable-gpu'] })).toThrow(/forbidden/);
    expect(() => assembleBeginFrameFlags({ width: 1, height: 1, extra: ['--site-per-process'] })).toThrow(/forbidden/);
    expect(() => assembleBeginFrameFlags({ width: 1, height: 1, extra: ['--use-angle=gl'] })).toThrow(/forbidden/);
    expect(() => assembleBeginFrameFlags({ width: 1, height: 1, extra: ['--no-sandbox'] })).toThrow(/forbidden/);
  });

  it('assertNoForbiddenFlags allows --use-angle=swiftshader but rejects --use-angle=gl', () => {
    expect(() => assertNoForbiddenFlags(['--use-angle=swiftshader'])).not.toThrow();
    expect(() => assertNoForbiddenFlags(['--use-angle=gl'])).toThrow(/forbidden/);
  });
});

describe('CDP message shapes', () => {
  it('createTarget enables begin-frame control at the requested size', () => {
    expect(buildCreateTargetParams('http://127.0.0.1:5/x', 800, 600)).toEqual({
      method: 'Target.createTarget',
      params: { url: 'http://127.0.0.1:5/x', enableBeginFrameControl: true, width: 800, height: 600, newWindow: true },
    });
  });

  it('screenshot params are the measured JPEG q80 optimizeForSpeed lever', () => {
    expect(buildScreenshotParams()).toEqual({ format: 'jpeg', quality: 80, optimizeForSpeed: true });
  });

  it('the frame schedule ticks at 1000/fps, warms up without readback, then screenshots', () => {
    const steps = buildBeginFrameSchedule({ fps: 30, totalFrames: 5, warmupFrames: 2, startTicks: 0 });
    expect(steps).toHaveLength(5);
    const interval = 1000 / 30;

    // Warmup frames: no screenshot, no display churn.
    expect(steps[0].params.screenshot).toBeUndefined();
    expect(steps[0].params.noDisplayUpdates).toBe(true);
    expect(steps[1].params.screenshot).toBeUndefined();

    // Kept frames: screenshot present, display updates on.
    expect(steps[2].params.screenshot).toEqual({ format: 'jpeg', quality: 80, optimizeForSpeed: true });
    expect(steps[2].params.noDisplayUpdates).toBe(false);

    // frameTimeTicks = start + k·interval; interval carried on every step.
    steps.forEach((s, k) => {
      expect(s.method).toBe('HeadlessExperimental.beginFrame');
      expect(s.params.interval).toBeCloseTo(interval, 9);
      expect(s.params.frameTimeTicks).toBeCloseTo(k * interval, 9);
    });
  });
});

describe('host refusal (honest — where this cannot capture, it says so)', () => {
  it('assertBeginFrameRunnable throws the measured macOS error on darwin', () => {
    try {
      assertBeginFrameRunnable('darwin', '/opt/chrome-headless-shell');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureUnavailable);
      expect((err as Error).message).toMatch(/not supported on macOS/i);
    }
  });

  it('refuses on Linux when no pinned browser is named (outside the worker image)', () => {
    // '' is the explicit "not named" case; `undefined` would fall through to the env default,
    // which is exactly the environment dependence these tests must not have.
    expect(() => assertBeginFrameRunnable('linux', '')).toThrow(CaptureUnavailable);
    expect(() => assertBeginFrameRunnable('linux', '')).toThrow(/CHROME_HEADLESS_SHELL_PATH/);
  });

  it('ACCEPTS Linux + a named browser — the container case (the transport now exists)', () => {
    expect(assertBeginFrameRunnable('linux', '/opt/chrome-headless-shell')).toBe('/opt/chrome-headless-shell');
  });

  it('isAvailable is false on macOS and false without a browser, INDEPENDENT of this host env', async () => {
    // Explicit platform + executablePath: the verdict must not depend on whether the machine
    // running the suite happens to export CHROME_HEADLESS_SHELL_PATH.
    expect(new BeginFrameBackend().name).toBe('begin-frame');
    expect(await new BeginFrameBackend({ platform: 'darwin', executablePath: '/opt/x' }).isAvailable()).toBe(false);
    expect(await new BeginFrameBackend({ platform: 'linux', executablePath: '' }).isAvailable()).toBe(false);
    expect(
      await new BeginFrameBackend({ platform: 'linux', executablePath: '/nonexistent-browser' }).isAvailable(),
    ).toBe(false);
  });

  it('captureSection on macOS refuses with CaptureUnavailable (the poster-fallback signal)', async () => {
    const backend = new BeginFrameBackend({ platform: 'darwin', executablePath: '/opt/x' });
    await expect(
      backend.captureSection({
        servedSimUrl: 'http://127.0.0.1:5/x?section=a&v=1#simboot=%7B%7D',
        sectionId: 'a',
        simpleUi: false,
        autoScript: true,
        uiHide: [],
        durationSec: 5,
        fps: 30,
        width: 1920,
        height: 1080,
        configHash: 'deadbeef',
        posterKey: 'poster/a',
      }),
    ).rejects.toBeInstanceOf(CaptureUnavailable);
  });

  it('createBackend() yields a usable instance — the export the v0.1.22 image lacked', async () => {
    const backend = createBackend();
    expect(typeof backend.captureSection).toBe('function');
    expect(typeof backend.isAvailable).toBe('function');
    expect(backend.name).toBe('begin-frame');
  });
});

/**
 * The gate sampler. This is the v0.1.27 false-RED: a WebGL drawing buffer is cleared once
 * composited unless the context asked for `preserveDrawingBuffer`, so the old sampler — which read
 * back the canvas ELEMENT — saw transparent black and called a perfectly rendering simulation
 * `uniform_canvas`. Proven on the real Ubuntu host: three.js loaded offline, `rendererString` was a
 * live SwiftShader string, 60 frames differed and showed the scene, and the gate still failed.
 *
 * The fake page below is the exact discriminator: reading the canvas element yields zeros, decoding
 * the captured JPEG yields content. A sampler that passes only if it looked at the screenshot.
 */
describe('sanity-gate sampler judges the captured frame, not the canvas element', () => {
  const GRID = 4;

  /** Runs a generated sampler expression against a page whose canvas read-back is blank. */
  async function runSampler(expr: string): Promise<{ result: unknown; drewFrom: string[] }> {
    const drewFrom: string[] = [];
    const canvasEl = {
      __kind: 'canvas-element',
      width: 640,
      height: 360,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    };
    const makeOffscreen = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (src: { __kind?: string }) => {
          drewFrom.push(src?.__kind ?? 'unknown');
        },
        // Zeros for the canvas element (the cleared drawing buffer), content for the screenshot.
        getImageData: () => ({
          data: drewFrom.includes('decoded-screenshot')
            ? Array.from({ length: GRID * GRID * 4 }, (_, i) => (i * 37) % 256)
            : new Array(GRID * GRID * 4).fill(0),
        }),
      }),
    });
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { document: g.document, Image: g.Image, innerWidth: g.innerWidth, innerHeight: g.innerHeight };
    g.document = { querySelectorAll: () => [canvasEl], createElement: () => makeOffscreen() };
    g.innerWidth = 640;
    g.innerHeight = 360;
    g.Image = class {
      __kind = 'decoded-screenshot';
      src = '';
      naturalWidth = 640;
      naturalHeight = 360;
      async decode(): Promise<void> {}
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const result = await (new Function(`return (${expr});`)() as Promise<unknown>);
      return { result, drewFrom };
    } finally {
      Object.assign(globalThis, saved);
    }
  }

  it('samples the decoded screenshot — a rendering WebGL sim without preserveDrawingBuffer passes', async () => {
    const { result, drewFrom } = await runSampler(compositedSamplerExpression(GRID, 'QUJD'));

    expect(drewFrom).toEqual(['decoded-screenshot']); // NOT the canvas element
    const parsed = JSON.parse(String(result)) as { width: number; rgba: number[] };
    expect(parsed.width).toBe(GRID);
    expect(new Set(parsed.rgba).size).toBeGreaterThan(1); // content, not a uniform frame
  });

  it('embeds the frame as a data: URL — no network, so --network none is untouched', () => {
    const expr = compositedSamplerExpression(GRID, 'QUJD');
    expect(expr).toContain("'data:image/jpeg;base64,QUJD'");
    expect(expr).not.toMatch(/https?:/);
  });

  it('refuses to evaluate screenshot data that is not base64 (no expression injection)', () => {
    expect(() => compositedSamplerExpression(GRID, "'); fetch('http://x'); ('")).toThrow(/not base64/);
  });

  it('keeps canvas-region semantics: the box is mapped into image pixels, not the whole viewport', () => {
    const expr = compositedSamplerExpression(GRID, 'QUJD');
    expect(expr).toContain('getBoundingClientRect');
    expect(expr).toContain('drawImage(img, x, y, w, h, 0, 0');
  });
});
