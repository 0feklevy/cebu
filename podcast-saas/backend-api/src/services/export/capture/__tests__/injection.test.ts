/**
 * The injection bundle, exercised as the EXACT code that ships: each test builds the real source
 * string (`composeInitBody`) and runs it against a fake window via `new Function('window', body)`.
 * No browser, no parallel re-implementation — the strings under test are the strings injected.
 *
 * Named mutation targets (per the task):
 *   • "frame N is pinned to exactly N/fps" fails if the clock advance is off-by-anything.
 *   • "the injected PRNG matches the reference" + "same configHash ⇒ same sequence" fail if the
 *     seeded PRNG drifts or stops depending on the hash.
 *   • "a bridge wrapping the already-shimmed rAF still drives virtual time" fails if the clock stops
 *     overriding requestAnimationFrame (the rAF-before-gate ordering).
 */

import { describe, it, expect } from 'vitest';

import {
  composeInitBody,
  mulberry32,
  hashToSeed,
  frameTimeMs,
  type InitScriptOptions,
} from '../injection.js';

interface FakeWindow {
  [key: string]: any;
  __SIM_CLOCK__?: any;
  __SIM_CAPTURE__?: any;
}

function makeFakeWindow(opts: { webglReturnsNull?: boolean } = {}): FakeWindow {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const nativeRaf = function nativeRaf(): number {
    return 0;
  };
  const win: FakeWindow = {
    Date,
    performance: {},
    Math: Object.create(Math),
    // A native setTimeout placeholder — captured by the shim as `realSetTimeout`, never fired here.
    setTimeout: (_fn: () => void, _ms: number): number => 0,
    requestAnimationFrame: nativeRaf,
    crypto: {
      getRandomValues: (arr: { length: number; [i: number]: number }) => arr,
    },
    HTMLCanvasElement: {
      prototype: {
        getContext(type: string): any {
          if (/webgl/i.test(type)) {
            if (opts.webglReturnsNull) return null;
            return {
              RENDERER: 7937,
              getExtension: (name: string) =>
                name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null,
              getParameter: (p: number) => (p === 37446 ? 'Test GPU Renderer' : 'other'),
            };
          }
          return { fillRect() {} };
        },
      },
    },
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ||= []).push(fn);
    },
    // Test-only: deliver a synthetic event to the registered listeners.
    __dispatch: (type: string, event: any) => {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
  };
  win.nativeRaf = nativeRaf;
  return win;
}

function install(win: FakeWindow, opts: InitScriptOptions): void {
  new Function('window', composeInitBody(opts))(win);
}

const OPTS = (over: Partial<InitScriptOptions> = {}): InitScriptOptions => ({
  fps: 50,
  configHash: 'config-hash-fixed',
  epochMs: 1_000_000,
  ...over,
});

describe('virtual clock', () => {
  it('pins frame N to exactly N/fps for rAF timestamps, performance.now and Date.now', () => {
    const win = makeFakeWindow();
    install(win, OPTS({ fps: 50, epochMs: 1_000_000 }));

    const seen: number[] = [];
    const loop = (ts: number) => {
      seen.push(ts);
      win.requestAnimationFrame(loop);
    };
    win.requestAnimationFrame(loop);

    for (let n = 1; n <= 5; n++) win.__SIM_CLOCK__.advanceToFrame(n);

    // frameMs = 1000/50 = 20; frame n's timestamp is exactly n*20.
    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => frameTimeMs(n, 50)));
    expect(win.performance.now()).toBe(frameTimeMs(5, 50)); // 100
    expect(win.Date.now()).toBe(1_000_000 + frameTimeMs(5, 50)); // epoch + 100
    expect(new win.Date().getTime()).toBe(1_000_000 + frameTimeMs(5, 50));
  });

  it('drives setInterval (the auto-script loop) deterministically under virtual time', () => {
    const win = makeFakeWindow();
    install(win, OPTS({ fps: 50 })); // frameMs = 20

    let ticks = 0;
    win.setInterval(() => {
      ticks += 1;
    }, 20);

    // Advance to virtual t = 1000ms (50 frames). A 20ms interval fires at 20,40,…,1000 ⇒ 50 times.
    for (let n = 1; n <= 50; n++) win.__SIM_CLOCK__.advanceToFrame(n);
    expect(ticks).toBe(50);
  });

  it('does not fire a timer scheduled beyond the current frame, and clearTimeout cancels', () => {
    const win = makeFakeWindow();
    install(win, OPTS({ fps: 50 }));

    let late = 0;
    win.setTimeout(() => {
      late += 1;
    }, 500);
    win.__SIM_CLOCK__.advanceToFrame(1); // t = 20ms, well before 500
    expect(late).toBe(0);

    let cancelled = 0;
    const id = win.setTimeout(() => {
      cancelled += 1;
    }, 10);
    win.clearTimeout(id);
    win.__SIM_CLOCK__.advanceToFrame(2); // t = 40ms, past 10, but it was cancelled
    expect(cancelled).toBe(0);

    win.__SIM_CLOCK__.advanceToFrame(30); // t = 600ms, past 500
    expect(late).toBe(1);
  });
});

describe('seeded PRNG', () => {
  const collectRandom = (configHash: string, count: number): number[] => {
    const win = makeFakeWindow();
    install(win, OPTS({ configHash }));
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(win.Math.random());
    return out;
  };

  it('is reproducible from a fixed configHash and differs for a different one', () => {
    const a = collectRandom('the-same-hash', 6);
    const b = collectRandom('the-same-hash', 6);
    const c = collectRandom('a-different-hash', 6);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });

  it('matches the TS mulberry32 reference for the same seed (no source drift)', () => {
    const injected = collectRandom('config-hash-fixed', 5);
    const ref = mulberry32(hashToSeed('config-hash-fixed'));
    const reference = [ref(), ref(), ref(), ref(), ref()];
    expect(injected).toEqual(reference);
  });

  it('patches crypto.getRandomValues to be seeded, deterministic and in-range', () => {
    const fill = (configHash: string): number[] => {
      const win = makeFakeWindow();
      install(win, OPTS({ configHash }));
      const arr = new Uint8Array(8);
      win.crypto.getRandomValues(arr);
      return Array.from(arr);
    };
    const a = fill('seed-x');
    const b = fill('seed-x');
    const c = fill('seed-y');
    expect(a).toEqual(b); // same hash ⇒ same bytes
    expect(c).not.toEqual(a);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

describe('WebGL probe', () => {
  it('records a live context and its unmasked renderer', () => {
    const win = makeFakeWindow();
    install(win, OPTS());
    const ctx = win.HTMLCanvasElement.prototype.getContext('webgl');
    expect(ctx).not.toBeNull();
    expect(win.__SIM_CAPTURE__.webgl).toEqual({
      attempted: true,
      ok: true,
      renderer: 'Test GPU Renderer',
      type: 'webgl',
    });
  });

  it('records the M144 dead-context trap (context attempted but null)', () => {
    const win = makeFakeWindow({ webglReturnsNull: true });
    install(win, OPTS());
    const ctx = win.HTMLCanvasElement.prototype.getContext('webgl2');
    expect(ctx).toBeNull();
    expect(win.__SIM_CAPTURE__.webgl.attempted).toBe(true);
    expect(win.__SIM_CAPTURE__.webgl.ok).toBe(false);
  });

  it('ignores non-webgl contexts', () => {
    const win = makeFakeWindow();
    install(win, OPTS());
    win.HTMLCanvasElement.prototype.getContext('2d');
    expect(win.__SIM_CAPTURE__.webgl.attempted).toBe(false);
  });
});

describe('message collector', () => {
  it('buffers typed postMessages for the driver to drain', () => {
    const win = makeFakeWindow();
    install(win, OPTS());
    win.__dispatch('message', { data: { type: 'SIM_READY' } });
    win.__dispatch('message', { data: { type: 'SIM_PAINTED', v: 4 } });
    win.__dispatch('message', { data: 'not-an-object' }); // ignored
    win.__dispatch('message', { data: { noType: true } }); // ignored
    expect(win.__SIM_CAPTURE__.messages).toEqual([{ type: 'SIM_READY' }, { type: 'SIM_PAINTED', v: 4 }]);
  });
});

describe('rAF ordering vs the bridge gate (THE documented hazard)', () => {
  it('a bridge wrapping the already-shimmed rAF still drives virtual time', () => {
    const win = makeFakeWindow();
    const nativeRaf = win.requestAnimationFrame;

    install(win, OPTS({ fps: 30 }));

    // 1) The clock installs FIRST (it is an init script), so it OWNS requestAnimationFrame now.
    expect(win.requestAnimationFrame).not.toBe(nativeRaf);

    // 2) The bridge's __SIM_RAF_GATE__ then captures `requestAnimationFrame.bind(window)` (which is
    //    the SHIMMED one) and wraps it, acking a "paint" on the first callback that actually runs.
    const gateCapturedRaf = win.requestAnimationFrame.bind(win);
    let paintPosted = false;
    win.requestAnimationFrame = (cb: (ts: number) => void) =>
      gateCapturedRaf((ts: number) => {
        cb(ts);
        if (!paintPosted) paintPosted = true; // stands in for postMessage({type:'SIM_PAINTED'})
      });

    // 3) The sim schedules through the WRAPPED rAF.
    let seen = -1;
    win.requestAnimationFrame((ts: number) => {
      seen = ts;
    });

    // 4) Advancing the virtual clock must flow through both wrappers to the sim callback.
    win.__SIM_CLOCK__.advanceToFrame(1);
    expect(seen).toBe(frameTimeMs(1, 30)); // virtual time reached the sim through the gate
    expect(paintPosted).toBe(true); // and the gate's first-paint wrap ran under virtual time
  });
});
