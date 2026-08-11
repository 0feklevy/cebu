/**
 * Two ways a pooled frame could be taken away from the section that owns it — through the REAL
 * shell and hook.
 *
 * 1. RE-ENTRY AFTER `DISPOSE_DOCUMENT` (CRITICAL). `ensurePooledSpec` handles a user coming back
 *    past the eviction grace by disposing the dying runtime and navigating the element to a fresh
 *    document. But `SimRuntimeClient.dispose()` SETTLES the pending eviction (forced, so no owner
 *    is left awaiting a promise nothing can resolve) — so `dropPooled`'s `.then` runs one microtask
 *    LATER, after the new runtime and the new document already exist, and removed them. At the
 *    'single' and 'all' tiers nothing re-adds the spec, so the section the user just re-entered has
 *    no iframe for the rest of the session.
 *
 * 2. A REVEAL OUTLIVING THE PLAYER. `revealSim` composites behind a double animation frame and
 *    nothing owned those frames: an unmount cancelled the two timers `clearRevealTimers` knows
 *    about and left the frames queued. The callback then ran against a dead tree and reached
 *    `simPainted(url)` — which is `runtimeFor(key)`, which CREATES a `SimRuntimeClient` when the
 *    map has none. Unmounting during a reveal therefore built a runtime for a player that no longer
 *    exists, after the cleanup that would have disposed it had already run.
 *
 * WHAT IS REAL HERE: `useProjectPlayer`, `HLSPlayerShell`'s JSX, the pool, the residency rules and
 * the eviction plumbing. What is doubled is `SimRuntimeClient`, because the real one needs a
 * cross-origin MessagePort handshake jsdom cannot host — but the double reproduces the ONE
 * behaviour each defect turns on: `dispose()` settles a pending eviction, and `cancelEviction()`
 * refuses once disposal has begun. Both are asserted directly in simRuntimeClient.test.ts.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig, SimulationOverlay } from '../components/viewer/types';

// ── doubles ───────────────────────────────────────────────────────────────────────────────────

interface FakeClient {
  documentKey: string | null;
  disposed: boolean;
  /** Resolve the pending eviction, as DISPOSED or the deadline would. */
  settleEvict: ((outcome: string) => void) | null;
  /** How far the eviction has got. The test drives this to choose reclaim-vs-too-late. */
  phase: string;
}

const h = vi.hoisted(() => ({
  /** Every client the player built, newest last. */
  instances: [] as Array<{ documentKey: string | null; disposed: boolean; phase: string }>,
  /** Client constructions, so a test can prove one was NOT built. */
  constructed: 0,
  /** When true, `cancelEviction()` refuses — i.e. DISPOSE_DOCUMENT has already gone out. */
  pastGrace: { value: false },
}));

vi.mock('../lib/sim/SimRuntimeClient', () => {
  class FakeSimRuntimeClient implements FakeClient {
    documentKey: string | null = null;
    disposed = false;
    settleEvict: ((outcome: string) => void) | null = null;
    phase = 'none';
    private cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void };
    private state = {
      phase: 'mounting', documentKey: null, dynamic: true, ackCapable: null, ready: true,
      painted: true, currentScript: null, pendingScript: null, activationToken: 0, stopped: false,
      visible: true, muted: false, interactive: false, lastError: null,
    };

    constructor(cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void } = {}) {
      this.cbs = cbs;
      h.constructed += 1;
      h.instances.push(this);
    }

    emit(event: string, detail?: Record<string, unknown>) { this.cbs.onTelemetry?.(event, detail); }
    getState() { return this.state; }
    modernActive() { return false; }
    getModernState() {
      return { active: false, documentState: 'READY', activationState: 'none', contextLost: false, failure: null, breakerOpen: false };
    }
    attach(_frame: unknown, documentKey: string | null) { this.documentKey = documentKey; }

    /** Phase one. Held open until the test (or `dispose`) settles it — exactly like the real one. */
    evict() {
      this.phase = 'grace';
      return new Promise<{ outcome: string; counts: null; leaked: never[]; waitedMs: number }>((resolve) => {
        this.settleEvict = (outcome: string) => {
          this.settleEvict = null;
          this.phase = 'evicted';
          resolve({ outcome, counts: null, leaked: [], waitedMs: 0 });
        };
      });
    }
    /** Legal only before DISPOSE_DOCUMENT. Past it the caller must build a fresh generation. */
    cancelEviction() {
      if (h.pastGrace.value || this.phase !== 'grace') return false;
      this.settleEvict?.('cancelled');
      this.phase = 'none';
      return true;
    }
    isEvicting() { return this.phase === 'grace' || this.phase === 'disposing'; }
    evictionPhase() { return this.phase; }
    /**
     * THE MECHANISM. A disposed client settles its own pending eviction as FORCED rather than
     * leaving the owner on a `.then()` that can never run — which is what schedules the microtask
     * that used to remove the brand-new frame.
     */
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.settleEvict?.('forced');
    }

    handleFrameLoad() {}
    activate() {}
    deactivate() {}
    enableModern() {}
    freeze() {}
    thaw() {}
    mute() {}
    unmute() {}
    hide() {}
    suspend() {}
    resume() {}
    relayout() {}
    setGuidance() {}
    pauseAutomation() {}
    resumeAutomation() {}
    stopNow() {}
    startPaintRecovery() {}
    markPaintedByPolicy() {}
    cancelPendingApply() {}
    cancelDeferredStop() {}
    hasDeferredStop() { return false; }
    setPackageAckCapable() {}
    isHoldingApply() { return false; }
    present() {}
    retryModern() { return false; }
    setQuality() {}
  }
  return { SimRuntimeClient: FakeSimRuntimeClient };
});

vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: { ERROR: 'hlsError' } } }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

// ── fixture: two packages on one segment, at the 'single' kill-switch tier ─────────────────────

const PKG_A = 'https://sims.example.com/pkg-a/index.html?section=a1&v=aaaa';
const PKG_B = 'https://sims.example.com/pkg-b/index.html?section=b1&v=bbbb';

const section = (over: Partial<SimulationOverlay>): SimulationOverlay => ({
  id: 'sec',
  start_sec: 0,
  end_sec: 5,
  simulation_url: PKG_A,
  simulation_id: 'sim-a',
  package_revision: 'rev-a',
  package_class: null,
  sim_script: 'main',
  simple_ui: false,
  auto_script: true,
  label: 'A',
  type: 'simulation',
  ...over,
} as SimulationOverlay);

function twoPackageConfig(): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: null,
    // THE KILL SWITCH. 'single' is the tier where this defect is permanent: nothing re-adds a
    // spec the eviction removed, so the re-entered section is covered for its whole duration.
    sim_pool_mode: 'single',
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: 60,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      captions: { status: 'ready', vtt_url: null },
      simulations: [
        section({ id: 'sec-a', start_sec: 0, end_sec: 5, simulation_url: PKG_A, simulation_id: 'sim-a' }),
        section({ id: 'sec-b', start_sec: 5, end_sec: 10, simulation_url: PKG_B, simulation_id: 'sim-b', label: 'B' }),
      ],
    }],
    broll_clips: [],
  } as unknown as PlayerConfig;
}

/** Frames the pool currently has in the DOM, by package. */
const framesFor = (c: HTMLElement, marker: string) =>
  [...c.querySelectorAll('iframe')].filter((f) => (f.getAttribute('src') ?? '').includes(marker));

beforeEach(() => {
  h.instances.length = 0;
  h.constructed = 0;
  h.pastGrace.value = false;
  if (!window.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
      },
    });
  }
});

afterEach(cleanup);

/** Move the media clock and let the player's own tick run. Nothing about the boundary is simulated. */
async function seekTo(video: HTMLVideoElement, t: number) {
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => t });
  await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
}

describe('re-entering a package whose eviction has passed the grace window', () => {
  it('keeps the frame the re-entry just built — a settled-by-dispose eviction removes nothing', async () => {
    const view = render(<HLSPlayerShell config={twoPackageConfig()} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.container.querySelector('video') as HTMLVideoElement;

    // A is entered and mounted.
    await seekTo(video, 0);
    expect(framesFor(view.container, 'pkg-a').length, 'A never mounted').toBe(1);

    // B is entered. At 'single' the pass evicts A — phase one only: the element STAYS while the
    // child is given its chance to answer, which is what makes the window below reachable at all.
    await seekTo(video, 6);
    const evictingA = h.instances.find((i) => (i.documentKey ?? '').includes('pkg-a'));
    expect(evictingA, 'A got no runtime').toBeDefined();
    expect(evictingA!.phase, "A's eviction never started").toBe('grace');
    expect(framesFor(view.container, 'pkg-a').length, 'phase one must not unmount the element').toBe(1);

    // …and the grace closes: DISPOSE_DOCUMENT has gone out, so a reclaim is refused and the only
    // correct answer is a NEW generation on the same element.
    h.pastGrace.value = true;

    // The user comes back to A.
    await seekTo(video, 2);
    // The disposal settled inside that re-entry, so the eviction's `.then` is queued right now.
    // Draining it is the whole point: the defect is a microtask, and a test that never let the
    // microtask run would pass against the broken code.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(
      framesFor(view.container, 'pkg-a').length,
      'the re-entered section lost its iframe to the eviction it had already superseded',
    ).toBe(1);
    // And the frame that survived is the FRESH one: the runtime the eviction was started for is
    // disposed, and a live, undisposed runtime owns the key.
    expect(evictingA!.disposed, 'the dying runtime should have been disposed by the re-entry').toBe(true);
    const live = h.instances.filter((i) => (i.documentKey ?? '').includes('pkg-a') && !i.disposed);
    expect(live.length, 'no live runtime owns the re-entered package').toBe(1);
  });

  it('still removes the frame when the package was NOT re-entered', async () => {
    // The guard must not turn eviction off. Same path, no re-entry: the element goes when the
    // child answers, exactly as before.
    const view = render(<HLSPlayerShell config={twoPackageConfig()} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.container.querySelector('video') as HTMLVideoElement;

    await seekTo(video, 0);
    await seekTo(video, 6);
    const evictingA = h.instances.find((i) => (i.documentKey ?? '').includes('pkg-a')) as unknown as FakeClient;
    expect(evictingA.phase).toBe('grace');

    await act(async () => { evictingA.settleEvict?.('clean'); await Promise.resolve(); });
    expect(framesFor(view.container, 'pkg-a').length, 'a genuine eviction stopped removing the element').toBe(0);
  });
});

/**
 * rAF, OWNED. The double frame IS the window every claim below is about, so the test steps it
 * rather than waiting on jsdom's ~16ms loop and hoping an event lands inside it.
 */
function ownAnimationFrames() {
  const queue: FrameRequestCallback[] = [];
  const handles = new Map<number, FrameRequestCallback>();
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  let nextHandle = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextHandle++;
    handles.set(id, cb);
    queue.push(cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    const cb = handles.get(id);
    handles.delete(id);
    if (cb) { const i = queue.indexOf(cb); if (i >= 0) queue.splice(i, 1); }
  }) as typeof globalThis.cancelAnimationFrame;
  return {
    pending: () => queue.length,
    /** Run exactly the frames queued right now; anything they schedule waits for the next step. */
    async step() {
      const due = queue.splice(0, queue.length);
      await act(async () => { for (const cb of due) cb(0); });
    },
    /** Step until nothing is queued, bounded — an unbounded drain would hide a reveal that loops. */
    async drain(maxSteps: number) {
      for (let i = 0; i < maxSteps && queue.length > 0; i += 1) await this.step();
      return queue.length;
    },
    restore() {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
}

const revealed = (c: HTMLElement) => c.querySelector('.sim-overlay')?.classList.contains('visible') === true;
const clientFor = (marker: string) =>
  h.instances.find((i) => (i.documentKey ?? '').includes(marker)) as unknown as
    { emit: (e: string, d?: Record<string, unknown>) => void };

describe('a reveal composition never outlives the player', () => {
  it('unmounting mid-reveal builds no runtime and leaves no queued frame', async () => {
    const raf = ownAnimationFrames();
    try {
      const view = render(<HLSPlayerShell config={twoPackageConfig()} />);
      await act(async () => { await Promise.resolve(); });
      const video = view.container.querySelector('video') as HTMLVideoElement;
      await seekTo(video, 0);

      // A reveal is in flight: the runtime granted presentation and the player scheduled its
      // composition. Step ONE frame so the second is queued and the unmount lands between them.
      await act(async () => { clientFor('pkg-a').emit('reveal'); });
      await raf.step();
      expect(raf.pending(), 'the reveal did not schedule its second frame').toBeGreaterThan(0);

      const builtBeforeUnmount = h.constructed;
      cleanup();

      // Whatever the event loop still holds must do nothing. Running the queue by hand is the
      // strongest form of the claim: even a callback the canceller could not reach is inert.
      await raf.drain(4);

      expect(
        h.constructed,
        'a reveal that ran after unmount built a SimRuntimeClient nothing will ever dispose',
      ).toBe(builtBeforeUnmount);
    } finally {
      raf.restore();
    }
  });
});

describe('a reveal dropped by a generation bump is recoverable', () => {
  it('re-arms when the SAME section is still the one being revealed', async () => {
    // The P0.5 gate turned a first activation on a painted pooled document from `reveal-now` into a
    // hold released by SCRIPT_APPLIED, one or more macrotasks later — which is exactly where a
    // `warmGenRef` bump lands. A scrub out of a section and straight back into it inside the
    // composition window bumps the generation twice while the user never leaves the section, and
    // the runtime has ALREADY granted presentation, so it will not announce a second time: a
    // discarded reveal was final and the section stayed covered for its whole duration.
    const raf = ownAnimationFrames();
    try {
      const view = render(<HLSPlayerShell config={twoPackageConfig()} />);
      await act(async () => { await Promise.resolve(); });
      const video = view.container.querySelector('video') as HTMLVideoElement;
      await seekTo(video, 0);

      await act(async () => { clientFor('pkg-a').emit('reveal'); });
      await raf.step();                       // first frame ran; the composition is mid-flight

      // Out of the section and straight back in — two generation bumps, same section either side.
      await seekTo(video, 30);
      await seekTo(video, 2);

      const stillQueued = await raf.drain(12);
      expect(stillQueued, 'the re-arm never settled — it must be bounded, not a loop').toBe(0);
      expect(revealed(view.container), 'the section the user is in was left covered').toBe(true);
    } finally {
      raf.restore();
    }
  });

  it('still DROPS when the generation moved because the section changed', async () => {
    // The bound and the identity check are what keep the re-arm from becoming "reveal anyway".
    // A reveal raised for A must never composite once B owns the screen — that is the wrong-section
    // frame the whole gate exists to prevent.
    const raf = ownAnimationFrames();
    try {
      const view = render(<HLSPlayerShell config={twoPackageConfig()} />);
      await act(async () => { await Promise.resolve(); });
      const video = view.container.querySelector('video') as HTMLVideoElement;
      await seekTo(video, 0);

      await act(async () => { clientFor('pkg-a').emit('reveal'); });
      await raf.step();
      await seekTo(video, 6);                 // now inside section B, a different package

      const stillQueued = await raf.drain(12);
      expect(stillQueued, 'a dropped reveal kept re-arming').toBe(0);
      expect(revealed(view.container), "A's reveal composited over B's section").toBe(false);
    } finally {
      raf.restore();
    }
  });
});
