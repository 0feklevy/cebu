/**
 * The v2 handshake driver, against a fake page + fake postMessage. Pins the exact sequence the plan
 * requires (SIM_READY → startScript{simpleUi,autoScript,hideSelectors} → SCRIPT_APPLIED →
 * SIM_PAINTED → warmup → exactly round(dur×fps) frames) and the "never hang" property: every wait
 * is bounded and fails LOUDLY with CaptureTimeoutError, never an infinite loop.
 */

import { describe, it, expect } from 'vitest';

import { runCaptureHandshake, parseSimUrl, CaptureTimeoutError, type DriverDeps } from '../driver.js';

interface FakeState {
  navigatedUrl: string | null;
  posted: Array<Record<string, unknown>>;
  captured: number[];
  steppedTo: number;
}

interface FakeOpts {
  /** Buffer SIM_READY at load (default true). */
  readyAtLoad?: boolean;
  /** Emit SIM_PAINTED once this virtual frame is reached (default: buffered at load). */
  paintAtFrame?: number;
  paintAtLoad?: boolean;
  emitPaint?: boolean;
  /** Emit SCRIPT_APPLIED when startScript arrives (default true). */
  emitApplied?: boolean;
  /** How the applied echo treats the token: matches (default) / omit / wrong. */
  appliedToken?: 'match' | 'omit' | 'wrong';
  /** A monotonically advancing clock (ms per call) — for the wall-clock timeout test. */
  clockStepMs?: number;
}

function makeFake(opts: FakeOpts = {}): { deps: DriverDeps; state: FakeState } {
  const state: FakeState = { navigatedUrl: null, posted: [], captured: [], steppedTo: 0 };
  const outbox: Array<Record<string, unknown>> = [];
  let painted = false;
  let clock = 1000;

  if (opts.readyAtLoad !== false) outbox.push({ type: 'SIM_READY' });
  if (opts.paintAtLoad) outbox.push({ type: 'SIM_PAINTED', v: 4 });

  const deps: DriverDeps = {
    navigate: async (url) => {
      state.navigatedUrl = url;
    },
    postToSim: async (message) => {
      state.posted.push(message);
      if (message.type === 'startScript' && opts.emitApplied !== false) {
        const token = message.token as number;
        const echo =
          opts.appliedToken === 'omit' ? undefined : opts.appliedToken === 'wrong' ? token + 1 : token;
        outbox.push({ type: 'SCRIPT_APPLIED', script: message.script, ...(echo === undefined ? {} : { token: echo }) });
      }
    },
    drainMessages: async () => outbox.splice(0),
    stepFrame: async (virtualFrame) => {
      state.steppedTo = virtualFrame;
      if (
        opts.emitPaint !== false &&
        !painted &&
        opts.paintAtFrame !== undefined &&
        virtualFrame >= opts.paintAtFrame
      ) {
        painted = true;
        outbox.push({ type: 'SIM_PAINTED', v: 4 });
      }
    },
    captureFrame: async (captureIndex) => {
      state.captured.push(captureIndex);
    },
    now: () => {
      const v = clock;
      clock += opts.clockStepMs ?? 0;
      return v;
    },
    yieldToEventLoop: async () => {},
  };
  return { deps, state };
}

const BASE = {
  url: 'http://127.0.0.1:9/sim/index.html?section=sec-1&v=7#simboot=%7B%7D',
  sectionId: 'sec-1',
  simpleUi: true,
  autoScript: true,
  fps: 30,
  durationSec: 1,
  warmupFrames: 3,
  token: 424242,
};

describe('runCaptureHandshake — the sequence', () => {
  it('navigates verbatim, runs the full v2 handshake, warms up, and captures exactly round(dur×fps)', async () => {
    const { deps, state } = makeFake({ paintAtFrame: 2 });
    const res = await runCaptureHandshake(deps, { ...BASE, uiHide: ['.controls', '#hud'] });

    // Navigation preserved the section query and simboot fragment untouched.
    expect(state.navigatedUrl).toBe(BASE.url);

    const start = state.posted.find((p) => p.type === 'startScript');
    expect(start).toMatchObject({
      type: 'startScript',
      script: 'sec-1',
      token: 424242,
      params: { simpleUi: true, autoScript: true, hideSelectors: ['.controls', '#hud'] },
    });
    expect(state.posted.some((p) => p.type === 'clearBootHide')).toBe(true);

    expect(res.sawReady).toBe(true);
    expect(res.sawApplied).toBe(true);
    expect(res.sawPainted).toBe(true);
    expect(res.frameCount).toBe(30);
    expect(res.warmupFrames).toBe(3);
    expect(state.captured).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('omits hideSelectors when uiHide is empty', async () => {
    const { deps, state } = makeFake({ paintAtLoad: true });
    await runCaptureHandshake(deps, { ...BASE, uiHide: [] });
    const start = state.posted.find((p) => p.type === 'startScript') as Record<string, any>;
    expect(start.params.hideSelectors).toBeUndefined();
    expect(start.params).toMatchObject({ simpleUi: true, autoScript: true });
  });

  it('accepts a SCRIPT_APPLIED that omits the token (older bridge)', async () => {
    const { deps } = makeFake({ paintAtLoad: true, appliedToken: 'omit' });
    const res = await runCaptureHandshake(deps, { ...BASE, uiHide: [] });
    expect(res.sawApplied).toBe(true);
  });
});

describe('runCaptureHandshake — bounded, fails loudly, never hangs', () => {
  it('throws CaptureTimeoutError when SIM_PAINTED never arrives (the rAF-collision hang guard)', async () => {
    const { deps } = makeFake({ emitPaint: false, paintAtFrame: 1 });
    await expect(
      runCaptureHandshake(deps, { ...BASE, uiHide: [], maxHandshakeFrames: 5 }),
    ).rejects.toThrow(/SIM_PAINTED: no signal within 5 virtual frames/);
  });

  it('throws when SIM_READY never arrives', async () => {
    const { deps } = makeFake({ readyAtLoad: false });
    await expect(
      runCaptureHandshake(deps, { ...BASE, uiHide: [], maxHandshakeFrames: 4 }),
    ).rejects.toThrow(/SIM_READY: no signal within 4 virtual frames/);
  });

  it('throws when SCRIPT_APPLIED echoes the wrong token', async () => {
    const { deps } = makeFake({ paintAtLoad: true, appliedToken: 'wrong' });
    await expect(
      runCaptureHandshake(deps, { ...BASE, uiHide: [], maxHandshakeFrames: 6 }),
    ).rejects.toThrow(/SCRIPT_APPLIED/);
  });

  it('honours the wall-clock timeout even when the frame budget is huge', async () => {
    const { deps } = makeFake({ readyAtLoad: false, clockStepMs: 100 });
    await expect(
      runCaptureHandshake(deps, { ...BASE, uiHide: [], readyTimeoutMs: 250, maxHandshakeFrames: 100_000 }),
    ).rejects.toThrow(CaptureTimeoutError);
  });
});

describe('parseSimUrl — the parts top-level navigation must preserve', () => {
  it('extracts section, v and the simboot fragment', () => {
    expect(parseSimUrl('http://127.0.0.1:8080/p/index.html?section=abc-1&v=42#simboot=%7B%22hide%22%3A%5B%5D%7D')).toEqual({
      section: 'abc-1',
      v: '42',
      hasSimboot: true,
    });
  });

  it('reports a missing simboot fragment and missing query', () => {
    expect(parseSimUrl('http://127.0.0.1:8080/p/index.html')).toEqual({ section: null, v: null, hasSimboot: false });
  });
});
