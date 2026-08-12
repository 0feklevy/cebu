import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { canWarmUnpaused, learnCanEmitPaint } from '../lib/simCapability';
import { SimRuntimeClient } from '../lib/sim/SimRuntimeClient';

/** Temporarily define a navigator property (jsdom getters aren't spyable). */
function withNavProp(prop: string, value: unknown, run: () => void) {
  const had = Object.prototype.hasOwnProperty.call(navigator, prop);
  const prev = (navigator as unknown as Record<string, unknown>)[prop];
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true });
  try { run(); }
  finally {
    if (had) Object.defineProperty(navigator, prop, { value: prev, configurable: true, writable: true });
    else delete (navigator as unknown as Record<string, unknown>)[prop];
  }
}

/** Nest withNavProp over several properties. jsdom reports the HOST's hardwareConcurrency, so
 *  every case pins cores (and memory) explicitly — otherwise results vary by CI machine. */
function withNavProps(props: Record<string, unknown>, run: () => void) {
  const entries = Object.entries(props);
  const step = (i: number): void =>
    i === entries.length ? run() : withNavProp(entries[i][0], entries[i][1], () => step(i + 1));
  step(0);
}

describe('canWarmUnpaused — when it is worth warming a hidden sim unpaused', () => {
  const finePointer = () => vi.stubGlobal('matchMedia', () => ({ matches: false }) as MediaQueryList);
  afterEach(() => vi.unstubAllGlobals());

  it('returns a boolean and never throws in a jsdom environment', () => {
    expect(typeof canWarmUnpaused()).toBe('boolean');
  });

  it('skips warming under Data Saver, even on a strong device', () => {
    withNavProps({ connection: { saveData: true }, deviceMemory: 8, hardwareConcurrency: 8 }, () =>
      expect(canWarmUnpaused()).toBe(false));
  });

  it('skips warming on low-memory devices (deviceMemory <= 4), whatever the core count', () => {
    withNavProps({ deviceMemory: 4, hardwareConcurrency: 16, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(false));
  });

  it('skips warming on few-core devices (hardwareConcurrency <= 4), whatever the memory', () => {
    // The ≤4 threshold matches the lowend=1 hint shared/src/sim/simUrl.ts stamps into sim URLs.
    finePointer();
    withNavProps({ deviceMemory: 8, hardwareConcurrency: 4, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(false));
  });

  it('CLASSIFY regression: 4 cores + unknown memory + fine pointer is LOW-END (lowend=1 ⇒ tier below all)', () => {
    // The audited contradiction: this exact device gets `lowend=1` in its sim URL
    // (simUrl.ts: hardwareConcurrency <= 4) yet used to be classified strong here,
    // warming every frame unpaused ('all'). The two classifiers must agree.
    finePointer();
    withNavProps({ deviceMemory: undefined, hardwareConcurrency: 4, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(false));
  });

  it('treats a device with NEITHER memory nor cores reported as unknown = conservative (skip)', () => {
    finePointer();
    withNavProps({ deviceMemory: undefined, hardwareConcurrency: undefined, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(false));
  });

  it('skips warming on coarse-pointer (touch) devices, even with strong reported hardware', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse') }) as MediaQueryList);
    withNavProps({ deviceMemory: 8, hardwareConcurrency: 8, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(false));
  });

  it('warms on a capable device (fine pointer, ample memory and cores, no Data Saver)', () => {
    finePointer();
    withNavProps({ deviceMemory: 8, hardwareConcurrency: 8, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(true));
  });

  it('one strong signal is enough when the other is unknown (only BOTH-unknown is conservative)', () => {
    finePointer();
    withNavProps({ deviceMemory: 8, hardwareConcurrency: undefined, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(true));
    withNavProps({ deviceMemory: undefined, hardwareConcurrency: 8, connection: undefined }, () =>
      expect(canWarmUnpaused()).toBe(true));
  });
});

/**
 * PAINT-ACK CAPABILITY vs THE RUNTIME'S CAPABILITIES.
 *
 * The pool keeps one capability the runtime deliberately does not model: can this PACKAGE emit
 * SIM_PAINTED at all (is its injected rAF gate the v4 one)? It is the only thing that licenses the
 * viewer's bounded hold to force-reveal an unpainted frame, so it must not be a second, drifting
 * copy of the runtime's `dynamic` (in-place dispatch) or `ackCapable` (SCRIPT_APPLIED acks).
 *
 * These drive the REAL SimRuntimeClient against a fake document and prove each case where the
 * three answers legitimately differ — i.e. that folding them into one flag would be wrong.
 */
describe('learnCanEmitPaint — a capability of the PAINT channel, not of dispatch or script acks', () => {
  let listeners: ((e: MessageEvent) => void)[] = [];

  /** Stand-in for the cross-origin iframe (mirrors simRuntimeClient.test.ts). */
  const makeFrame = () => {
    const win = { postMessage: () => {} };
    return { el: { contentWindow: win } as unknown as HTMLIFrameElement, win };
  };
  const fromChild = (win: object, data: unknown) => {
    const ev = { source: win, data } as unknown as MessageEvent;
    for (const l of [...listeners]) l(ev);
  };

  beforeEach(() => {
    listeners = [];
    vi.stubGlobal('window', {
      addEventListener: (t: string, fn: (e: MessageEvent) => void) => { if (t === 'message') listeners.push(fn); },
      removeEventListener: (t: string, fn: (e: MessageEvent) => void) => {
        if (t === 'message') listeners = listeners.filter((l) => l !== fn);
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Attach a client to a fresh fake document, exactly as the pool does. */
  const boot = () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-1');
    return { c, win };
  };

  it('is FALSE for a document that acknowledges every script but never paints (ackCapable ≠ canEmitPaint)', () => {
    // A DOM / setInterval-canvas package: the bridge runs and acks section bodies, but nothing
    // ever drives requestAnimationFrame, so no SIM_PAINTED can exist. This is the class the
    // viewer's terminal stall fallback exists for — and it is why the flag may not be derived
    // from `ackCapable`.
    const { c, win } = boot();
    fromChild(win, { type: 'SIM_READY', dispatch: 'load-time' });
    c.activate({ script: 'main' });
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'main', token: c.getState().activationToken });

    const st = c.getState();
    expect(st.ackCapable, 'the document proved it acknowledges scripts').toBe(true);
    expect(st.painted).toBe(false);

    let canEmitPaint = false;
    canEmitPaint = learnCanEmitPaint(canEmitPaint, { dynamic: st.dynamic });
    expect(canEmitPaint, 'ack-capable must NOT imply paint-capable').toBe(false);
  });

  it('is TRUE for a load-time-locked document that paints (dynamic ≠ canEmitPaint)', () => {
    // A package rebuilt with the v4 rAF gate but still one document per section: it paints
    // honestly and must NAVIGATE to change section. Deriving the flag from `dynamic` would
    // wrongly force-reveal this frame at the bounded ceiling instead of holding for its paint.
    const { c, win } = boot();
    fromChild(win, { type: 'SIM_READY', dispatch: 'load-time' });
    fromChild(win, { type: 'SIM_PAINTED' });

    const st = c.getState();
    expect(st.dynamic, 'the document cannot switch sections in place').toBe(false);

    let canEmitPaint = false;
    canEmitPaint = learnCanEmitPaint(canEmitPaint, { dynamic: st.dynamic });
    expect(canEmitPaint, 'no evidence yet from dispatch alone').toBe(false);
    canEmitPaint = learnCanEmitPaint(canEmitPaint, { painted: st.painted });
    expect(canEmitPaint, 'a real paint PROVES the capability, whatever dispatch says').toBe(true);
  });

  it('survives a reload that resets the runtime — capability is per-PACKAGE, `painted` is per-DOCUMENT', () => {
    const { c, win } = boot();
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_PAINTED' });
    let canEmitPaint = learnCanEmitPaint(false, { painted: c.getState().painted });
    expect(canEmitPaint).toBe(true);

    // navigateFrame()/back-to-video pristine reload: a NEW document on the same pooled package.
    c.handleFrameLoad();
    const st = c.getState();
    expect(st.painted, 'the fresh document has drawn nothing').toBe(false);
    expect(st.dynamic, 'and has not classified its dispatch yet').toBe(null);
    expect(st.ackCapable).toBe(null);

    canEmitPaint = learnCanEmitPaint(canEmitPaint, { painted: st.painted, dynamic: st.dynamic });
    expect(canEmitPaint, 'a package that has proven it paints does not stop being able to').toBe(true);
  });

  it('treats an unclassified document as not-yet-capable (null dispatch is not a promise)', () => {
    expect(learnCanEmitPaint(false, {})).toBe(false);
    expect(learnCanEmitPaint(false, { dynamic: null })).toBe(false);
    expect(learnCanEmitPaint(false, { dynamic: true })).toBe(true);
    expect(learnCanEmitPaint(true, { dynamic: false, painted: false }), 'monotonic').toBe(true);
  });
});
