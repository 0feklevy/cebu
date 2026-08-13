/**
 * The beginFrame backend — LOGIC ONLY. It cannot capture on macOS (measured), so these tests pin the
 * parts that don't need a browser: the exact flag set (§4's six `--deterministic-mode` switches, the
 * GL flags, the forbidden list), the CDP message shapes, and the honest macOS/host refusal. Nothing
 * here claims a capture happened.
 */

import { describe, it, expect } from 'vitest';

import {
  assembleBeginFrameFlags,
  assertNoForbiddenFlags,
  buildCreateTargetParams,
  buildScreenshotParams,
  buildBeginFrameSchedule,
  assertBeginFrameRunnable,
  BeginFrameBackend,
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

describe('host refusal (honest — this cannot capture here)', () => {
  it('assertBeginFrameRunnable throws the measured macOS error on darwin', () => {
    try {
      assertBeginFrameRunnable('darwin');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CaptureUnavailable);
      expect((err as Error).message).toMatch(/not supported on macOS/i);
    }
  });

  it('assertBeginFrameRunnable refuses on other hosts too (transport is container-wired)', () => {
    expect(() => assertBeginFrameRunnable('linux')).toThrow(CaptureUnavailable);
  });

  it('the backend is not available and captureSection throws CaptureUnavailable', async () => {
    const backend = new BeginFrameBackend();
    expect(backend.name).toBe('begin-frame');
    expect(await backend.isAvailable()).toBe(false);
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
});
