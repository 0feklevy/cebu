/**
 * The document-start injection bundle (plan §4). Everything here is a PURE producer of JavaScript
 * source strings plus the tiny TypeScript references those strings mirror, so the whole thing is
 * unit-testable in Node with a fake window — no browser required to prove the clock is deterministic,
 * the PRNG is reproducible, and the rAF ordering against the bridge's gate is what the plan requires.
 *
 * What gets installed, in this order (order matters):
 *   1. VIRTUAL CLOCK — a shim over Date / Date.now / performance.now / setTimeout / setInterval /
 *      requestAnimationFrame. Frame N is pinned to EXACTLY N/fps. The bridge's `__SIM_RAF_GATE__`
 *      captures `window.requestAnimationFrame.bind(window)` when IT installs; because the clock
 *      installs FIRST (this bundle is an init script — it runs before any page script), the handle
 *      the gate keeps as its "raw"/"sys" rAF is the SHIMMED one, so the gate's own callbacks are
 *      virtual too. That is the documented hazard (plan §4 "The repo-specific hazard I would flag
 *      hardest" / failure mode 5) and it is exactly what we want — pinned by a test.
 *   2. SEEDED PRNG — mulberry32 seeded from `configHash` replaces `Math.random`, plus a
 *      `crypto.getRandomValues` patch (getRandomValues is not seedable by any spec mechanism, so it
 *      must be monkey-patched — plan §4).
 *   3. WEBGL PROBE — wraps `HTMLCanvasElement.prototype.getContext` to record whether a WebGL
 *      context was created and its `UNMASKED_RENDERER_WEBGL`, so the "failed context → black canvas"
 *      (M144) and "silent 2D fallback" failure modes are observable, not silent (plan §4 modes 1–2).
 *   4. MESSAGE COLLECTOR — buffers the sim's `postMessage`s (SIM_READY / SCRIPT_APPLIED / SIM_PAINTED)
 *      on `window.__SIM_CAPTURE__.messages` so the driver can drain them by polling.
 *
 * The clock exposes a control surface at `window.__SIM_CLOCK__`; the recordings live at
 * `window.__SIM_CAPTURE__`. Neither is something a real sim reads — they are the capture host's.
 */

export const SIM_CLOCK_GLOBAL = '__SIM_CLOCK__';
export const SIM_CAPTURE_GLOBAL = '__SIM_CAPTURE__';

/** Virtual time of frame `n` at `fps`, in ms — the number the whole design pins to. */
export function frameTimeMs(n: number, fps: number): number {
  return (n * 1000) / fps;
}

/**
 * mulberry32 — a ~10-line seeded PRNG, inlined rather than depending on `seedrandom` (plan §4).
 * This TS reference is the source of truth; `seededRandomSource` embeds the SAME algorithm, and a
 * test asserts the injected sequence equals this one for a given seed so the two cannot drift.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fold a config hash string into a 32-bit seed (FNV-1a). Deterministic and stable: the same
 * `configHash` always yields the same seed, so the same section captures byte-identically.
 */
export function hashToSeed(hash: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < hash.length; i++) {
    h ^= hash.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The mulberry32 body, shared verbatim between the TS reference and the injected string. */
const MULBERRY32_JS = `function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }`;

/** Deterministic per-frame timer-fire ceiling — guards against `setInterval(fn, 0)` livelock. */
const MAX_TIMER_FIRES_PER_STEP = 100_000;
/** Interval delays are clamped to at least this many ms (mirrors the browser's nested-timer floor). */
const MIN_INTERVAL_MS = 1;

export interface ClockOptions {
  fps: number;
  epochMs: number;
}

/**
 * The virtual clock source. When run with `window` in scope it installs the shim and exposes
 * `window.__SIM_CLOCK__` with `advanceToFrame(n)` — advance to frame `n` (virtual time `n/fps`),
 * firing all timers due up to that instant and then the frame's rAF callbacks.
 */
export function clockShimSource(opts: ClockOptions): string {
  const frameMs = 1000 / opts.fps;
  return `;(function () {
  var frameMs = ${frameMs};
  var epochMs = ${opts.epochMs};
  var fps = ${opts.fps};
  var MAX_FIRES = ${MAX_TIMER_FIRES_PER_STEP};
  var MIN_INTERVAL = ${MIN_INTERVAL_MS};

  // Native handles captured BEFORE we override anything — the only way back to the real event loop.
  var nativeSetTimeout = (typeof window.setTimeout === 'function') ? window.setTimeout.bind(window) : null;
  var nativeRaf = (typeof window.requestAnimationFrame === 'function') ? window.requestAnimationFrame.bind(window) : null;

  var nowMs = 0;
  var frameIndex = 0;
  var timers = [];        // { id, cb, dueAt, intervalMs|null, args|null }
  var rafCbs = [];        // { id, cb }
  var nextTimerId = 1;
  var nextRafId = 1;

  // Fire every timer whose due time is <= target, earliest first, rescheduling intervals. Bounded.
  function advanceToTime(target) {
    var fires = 0;
    while (true) {
      var idx = -1, best = Infinity;
      for (var i = 0; i < timers.length; i++) {
        var t = timers[i];
        if (t.dueAt <= target && t.dueAt < best) { best = t.dueAt; idx = i; }
      }
      if (idx === -1) break;
      if (++fires > MAX_FIRES) break;   // deterministic ceiling; never livelock
      var timer = timers[idx];
      nowMs = timer.dueAt;
      if (timer.intervalMs == null) { timers.splice(idx, 1); }
      else { timer.dueAt = timer.dueAt + timer.intervalMs; }
      try { timer.cb.apply(null, timer.args || []); } catch (e) { /* a sim callback threw; keep the clock alive */ }
    }
    nowMs = target;
  }

  // Advance to frame n: run due timers up to n/fps, then this frame's rAF callbacks with ts = n/fps.
  function advanceToFrame(n) {
    advanceToTime(n * frameMs);
    var pending = rafCbs;
    rafCbs = [];                         // reset FIRST: a callback that reschedules lands next frame
    var ts = nowMs;
    for (var i = 0; i < pending.length; i++) {
      try { pending[i].cb(ts); } catch (e) { /* keep going */ }
    }
    frameIndex = n;
    return { frame: n, timeMs: nowMs, rafRan: pending.length };
  }

  // ── Date: no-arg constructor and Date.now() read virtual time; every other form is unchanged ──
  var RealDate = window.Date;
  function VirtualDate() {
    if (arguments.length === 0) return new RealDate(epochMs + nowMs);
    return new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))();
  }
  VirtualDate.now = function () { return Math.floor(epochMs + nowMs); };
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  VirtualDate.prototype = RealDate.prototype;
  window.Date = VirtualDate;

  // ── performance.now ──
  if (!window.performance) { try { window.performance = {}; } catch (e) {} }
  if (window.performance) {
    try { window.performance.now = function () { return nowMs; }; }
    catch (e) {
      try { Object.defineProperty(window.performance, 'now', { value: function () { return nowMs; }, configurable: true }); } catch (e2) {}
    }
  }

  // ── timers ──
  window.setTimeout = function (fn, delay) {
    if (typeof fn !== 'function') return 0;
    var id = nextTimerId++;
    var extra = arguments.length > 2 ? [].slice.call(arguments, 2) : null;
    timers.push({ id: id, cb: fn, dueAt: nowMs + (+delay || 0), intervalMs: null, args: extra });
    return id;
  };
  window.setInterval = function (fn, delay) {
    if (typeof fn !== 'function') return 0;
    var id = nextTimerId++;
    var d = Math.max(+delay || 0, MIN_INTERVAL);
    var extra = arguments.length > 2 ? [].slice.call(arguments, 2) : null;
    timers.push({ id: id, cb: fn, dueAt: nowMs + d, intervalMs: d, args: extra });
    return id;
  };
  window.clearTimeout = function (id) {
    for (var i = 0; i < timers.length; i++) { if (timers[i].id === id) { timers.splice(i, 1); return; } }
  };
  window.clearInterval = window.clearTimeout;

  // ── requestAnimationFrame — the handle the bridge gate will capture and wrap ──
  window.requestAnimationFrame = function (cb) {
    if (typeof cb !== 'function') return 0;
    var id = nextRafId++;
    rafCbs.push({ id: id, cb: cb });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    for (var i = 0; i < rafCbs.length; i++) { if (rafCbs[i].id === id) { rafCbs.splice(i, 1); return; } }
  };

  window.${SIM_CLOCK_GLOBAL} = {
    fps: fps,
    frameMs: frameMs,
    epochMs: epochMs,
    now: function () { return nowMs; },
    dateNow: function () { return epochMs + nowMs; },
    frame: function () { return frameIndex; },
    pendingRaf: function () { return rafCbs.length; },
    pendingTimers: function () { return timers.length; },
    advanceToTime: advanceToTime,
    advanceToFrame: advanceToFrame,
    // A door back to the real event loop, so the host can yield for postMessage delivery without
    // un-virtualizing anything. postMessage rides the real task queue, not the shimmed timers.
    realSetTimeout: nativeSetTimeout,
    realRaf: nativeRaf
  };
})();`;
}

/** The seeded-PRNG source: replaces `Math.random` and patches `crypto.getRandomValues`. */
export function seededRandomSource(seed: number): string {
  return `;(function () {
  var __seed = ${seed >>> 0};
  ${MULBERRY32_JS}
  var __rng = mulberry32(__seed);
  try { window.Math.random = __rng; } catch (e) {}
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    try {
      window.crypto.getRandomValues = function (arr) {
        if (!arr || typeof arr.length !== 'number') return arr;
        var bpe = arr.BYTES_PER_ELEMENT || 1;
        var range = bpe >= 4 ? 4294967296 : (bpe === 2 ? 65536 : 256);
        for (var i = 0; i < arr.length; i++) { arr[i] = Math.floor(__rng() * range); }
        return arr;
      };
    } catch (e) {}
  }
  window.${SIM_CAPTURE_GLOBAL} = window.${SIM_CAPTURE_GLOBAL} || {};
  window.${SIM_CAPTURE_GLOBAL}.seed = __seed;
})();`;
}

/** The WebGL context-creation probe: records outcome + renderer on `window.__SIM_CAPTURE__.webgl`. */
export function webglProbeSource(): string {
  return `;(function () {
  window.${SIM_CAPTURE_GLOBAL} = window.${SIM_CAPTURE_GLOBAL} || {};
  window.${SIM_CAPTURE_GLOBAL}.webgl = { attempted: false, ok: false, renderer: '', type: '' };
  var proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (!proto || typeof proto.getContext !== 'function') return;
  var orig = proto.getContext;
  proto.getContext = function (type) {
    var ctx = orig.apply(this, arguments);
    try {
      if (typeof type === 'string' && /webgl/i.test(type)) {
        var rec = window.${SIM_CAPTURE_GLOBAL}.webgl;
        rec.attempted = true;
        rec.type = type;
        rec.ok = !!ctx;
        if (ctx && !rec.renderer) {
          var r = '';
          try {
            var ext = ctx.getExtension('WEBGL_debug_renderer_info');
            if (ext) r = String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL));
          } catch (e) {}
          if (!r) { try { r = String(ctx.getParameter(ctx.RENDERER)); } catch (e2) {} }
          rec.renderer = r || '';
        }
      }
    } catch (e) {}
    return ctx;
  };
})();`;
}

/** Buffers the sim's window postMessages so the driver can drain them by polling. */
export function messageCollectorSource(): string {
  return `;(function () {
  window.${SIM_CAPTURE_GLOBAL} = window.${SIM_CAPTURE_GLOBAL} || {};
  window.${SIM_CAPTURE_GLOBAL}.messages = window.${SIM_CAPTURE_GLOBAL}.messages || [];
  if (typeof window.addEventListener !== 'function') return;
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && typeof d === 'object' && typeof d.type === 'string') {
      window.${SIM_CAPTURE_GLOBAL}.messages.push(d);
    }
  });
})();`;
}

export interface InitScriptOptions {
  fps: number;
  configHash: string;
  epochMs: number;
}

/**
 * The concatenated init body (clock → PRNG → WebGL probe → message collector), referencing the
 * global `window`. This is the exact code the unit tests run against a fake window, and the exact
 * code `buildInitScript` wraps for injection — so tests exercise what ships.
 */
export function composeInitBody(opts: InitScriptOptions): string {
  const seed = hashToSeed(opts.configHash);
  return [
    clockShimSource({ fps: opts.fps, epochMs: opts.epochMs }),
    seededRandomSource(seed),
    webglProbeSource(),
    messageCollectorSource(),
  ].join('\n');
}

/**
 * The full document-start script to hand a browser (Playwright `addInitScript`, or CDP
 * `Page.addScriptToEvaluateOnNewDocument`). It runs before ANY page script — which is what puts the
 * clock's rAF in place before the bridge gate wraps it.
 */
export function buildInitScript(opts: InitScriptOptions): string {
  return `;(function (window) {
  'use strict';
${composeInitBody(opts)}
})(typeof window !== 'undefined' ? window : this);`;
}
