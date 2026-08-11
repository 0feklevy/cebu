/**
 * P0.1 — the simulation→video exit, through the REAL shell and hook.
 *
 * THE DEFECT THIS PINS
 * Today's exit uncovers before it seeks. `resumeFromSim` (and the automatic `deactivateSim` at a
 * section boundary) freezes and MUTES the package, clears `showSimOverlay`, and only then assigns
 * `currentTime` and calls `play()` — so the cover is gone before the browser has been asked for
 * the frame, and whatever was last composited into that video element is what the viewer sees.
 *
 * WHAT IS REAL HERE
 * `useProjectPlayer`, `HLSPlayerShell`'s JSX, the whole activation and exit path, the transition
 * coordinator's reducer, and the frame-evidence probe. What is doubled is what jsdom cannot host:
 * `SimRuntimeClient` (the real one needs a cross-origin MessagePort handshake — its own behaviour
 * is covered in simRuntimeClient.test.ts), hls.js, and the video element's frame pipeline. The
 * doubled runtime RECORDS its lifecycle calls, because the audio half of this change is entirely
 * about WHEN `mute()` is called relative to the incoming media becoming audible.
 *
 * THE TWO STATES OF THE FLAG ARE BOTH ASSERTED. Flag OFF must be exactly today's behaviour, so
 * every flag-ON claim below has an OFF counterpart proving the difference is the flag and not the
 * refactor that carried it.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig } from '../components/viewer/types';

// ── doubles ───────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  /** Every lifecycle call the player made, in order. */
  calls: [] as string[],
  /** Every client the player built, so the test can report a lifecycle conclusion to it. */
  instances: [] as Array<{ emit: (event: string, detail?: Record<string, unknown>) => void }>,
}));

vi.mock('../lib/sim/SimRuntimeClient', () => {
  class FakeSimRuntimeClient {
    private key: string | null = null;
    private cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void };

    constructor(cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void } = {}) {
      this.cbs = cbs;
      h.instances.push(this);
    }

    /** Report a lifecycle conclusion exactly as the real client does — through onTelemetry. */
    emit(event: string, detail?: Record<string, unknown>) { this.cbs.onTelemetry?.(event, detail); }
    private state = {
      // `ready` and `painted` are true from the start: this suite is about the EXIT, so the
      // document is modelled as one that booted, painted and handed its section over long ago —
      // which is what a resident pooled frame actually is by the time a section ends.
      phase: 'mounting', documentKey: null, dynamic: null, ackCapable: null, ready: true,
      painted: true, currentScript: null, pendingScript: null, activationToken: 0, stopped: false,
      visible: false, muted: false, interactive: false, lastError: null,
    };

    private log(method: string) { h.calls.push(method); }

    getState() { return this.state; }
    modernActive() { return false; }
    getModernState() {
      return { active: false, documentState: 'READY', activationState: 'none', contextLost: false, failure: null, breakerOpen: false };
    }
    attach(_frame: unknown, documentKey: string | null) { this.key = documentKey; }
    handleFrameLoad() {}
    /**
     * Grant presentation, as the real client does once the document has painted and the section's
     * script has been applied. The player's reveal is gated on `getState().visible` — a double
     * that never granted it would render a suite in which the simulation is never on screen, and
     * every "the cover is still up" assertion below would be vacuously true.
     */
    activate() {
      this.log('activate');
      this.state = { ...this.state, visible: true, painted: true, phase: 'visible' };
    }
    // The two the exit's audio policy is about. `freeze` must happen at T0; `mute` must not,
    // and `deactivate` (which freezes AND mutes) must wait for the frame evidence.
    freeze() { this.log('freeze'); }
    mute() { this.log('mute'); }
    unmute() { this.log('unmute'); }
    deactivate() {
      this.log('deactivate');
      this.state = { ...this.state, visible: false, muted: true, phase: 'fading-out' };
    }
    enableModern() {}
    thaw() {}
    hide() {}
    suspend() {}
    resume() {}
    relayout() {}
    setGuidance() {}
    pauseAutomation() {}
    resumeAutomation() {}
    stopNow() { this.log('stopNow'); }
    startPaintRecovery() {}
    markPaintedByPolicy() {}
    cancelPendingApply() {}
    cancelDeferredStop() {}
    hasDeferredStop() { return false; }
    /** audit P0.5: the publication-time capability the player now hands every runtime. */
    setPackageAckCapable() {}
    /** audit P0.5: consulted by the terminal stall bound before it may force anything. */
    isHoldingApply() { return false; }
    /** audit: two-phase eviction. The double settles instantly — this suite is not about disposal. */
    evict() { return Promise.resolve({ outcome: 'no-document', counts: null, leaked: [], waitedMs: 0 }); }
    cancelEviction() { return false; }
    isEvicting() { return false; }
    evictionPhase() { return 'none'; }
    present() {}
    retryModern() { return false; }
    setQuality() {}
    dispose() {}
  }
  return { SimRuntimeClient: FakeSimRuntimeClient };
});

vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: { ERROR: 'hlsError' } } }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

// ── a hand-stepped animation clock ────────────────────────────────────────────────────────────
// The coordinator's parent-paint gate, its fallback frame counter and the player's own reveal all
// run on rAF. Owning it is what makes "the cover is still up" a statement about the gate rather
// than about how long the test happened to wait.

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCancelRaf = globalThis.cancelAnimationFrame;

async function frames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    const due = rafQueue;
    rafQueue = [];
    await act(async () => { for (const { cb } of due) cb(performance.now()); });
  }
}

// ── a video element whose frame pipeline the test owns ────────────────────────────────────────

interface FramePipeline {
  present(mediaTime: number): boolean;
  pending(): number;
}

/** Give an element a controllable `requestVideoFrameCallback`, as a real browser would have. */
function installRvfc(video: HTMLVideoElement): FramePipeline {
  let next = 1;
  const cbs = new Map<number, (now: number, meta: { mediaTime: number }) => void>();
  Object.defineProperty(video, 'requestVideoFrameCallback', {
    configurable: true,
    value: (cb: (now: number, meta: { mediaTime: number }) => void) => { const id = next++; cbs.set(id, cb); return id; },
  });
  Object.defineProperty(video, 'cancelVideoFrameCallback', {
    configurable: true,
    value: (id: number) => { cbs.delete(id); },
  });
  return {
    present(mediaTime) {
      const entry = [...cbs.entries()][0];
      if (!entry) return false;
      cbs.delete(entry[0]);
      entry[1](performance.now(), { mediaTime });
      return true;
    },
    pending: () => cbs.size,
  };
}

function stubMedia(c: HTMLElement) {
  c.querySelectorAll('video').forEach((v) => {
    Object.defineProperty(v, 'play', { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(v, 'pause', { configurable: true, value: () => {} });
  });
}

interface MediaClock {
  get(): number;
  set(t: number): void;
  /** Model a stalled element: below HAVE_CURRENT_DATA nothing can satisfy the fallback either. */
  setReadyState(n: number): void;
}

/** `currentTime` is a settable stub so the test drives the media clock, and seeks are observable. */
function controllableTime(video: HTMLVideoElement, initial = 0): MediaClock {
  let t = initial;
  let readyState = 4;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => t,
    set: (v: number) => { t = v; },
  });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => readyState });
  return { get: () => t, set: (v) => { t = v; }, setReadyState: (n) => { readyState = n; } };
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

const SIM_URL = 'https://sims.example.com/pkg/index.html?section=sec-1&v=abcd1234';

/** A MID-ROLL sim: 0–10 s of a 60 s segment. Leaving it is the automatic `deactivateSim` exit. */
function midRollConfig(coordinator: boolean): PlayerConfig {
  return baseConfig(coordinator, { start_sec: 0, end_sec: 10 }, 60);
}

/** A POST-ROLL sim: it starts at the segment's end, so the player shows "Go back to video". */
function postRollConfig(coordinator: boolean): PlayerConfig {
  return baseConfig(coordinator, { start_sec: 10, end_sec: 20 }, 10);
}

function baseConfig(coordinator: boolean, span: { start_sec: number; end_sec: number }, duration: number): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: null,
    sim_transition_coordinator: coordinator,
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: duration,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      captions: { status: 'ready', vtt_url: null },
      simulations: [{
        id: 'sec-1',
        start_sec: span.start_sec,
        end_sec: span.end_sec,
        simulation_url: SIM_URL,
        simulation_id: 'sim-1',
        package_revision: 'rev-abcd',
        package_class: null,
        sim_script: 'main',
        simple_ui: false,
        auto_script: true,
        label: 'Section one',
        type: 'simulation',
      }],
    }],
    broll_clips: [],
  };
}

/** The simulation cover: the pool overlay is composited only while it carries `visible`. */
const coverUp = (c: HTMLElement) => c.querySelector('.sim-overlay.visible') !== null;
const backButton = (c: HTMLElement) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('Go back to video')) ?? null;

/** Mount, let init settle, and drive the media clock into the simulation section. */
async function mountInSim(config: PlayerConfig, at = 0) {
  const view = render(<HLSPlayerShell config={config} />);
  await act(async () => { await Promise.resolve(); });
  stubMedia(view.container);
  const video = view.container.querySelector('video') as HTMLVideoElement;
  const clock = controllableTime(video, at);
  const pipeline = installRvfc(video);
  await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
  // The runtime is the authority on whether a document may be presented; the player composites
  // only on its `reveal`. Reporting it here is what puts the simulation on screen, exactly as a
  // painted, applied document does in the product.
  await act(async () => { h.instances[0]?.emit('reveal', {}); });
  // The player's own reveal is behind a double rAF.
  await frames(3);
  return { ...view, video, clock, pipeline };
}

beforeEach(() => {
  h.calls.length = 0;
  h.instances.length = 0;
  rafQueue = [];
  rafId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = rafId++;
    rafQueue.push({ id, cb });
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { rafQueue = rafQueue.filter((f) => f.id !== id); }) as typeof cancelAnimationFrame;
  if (!window.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
      },
    });
  }
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancelRaf;
  vi.useRealTimers();
});

// ── flag OFF: byte-for-byte today ─────────────────────────────────────────────────────────────

describe('flag OFF — the exit behaves exactly as it did before the coordinator', () => {
  it('the automatic exit uncovers immediately, with no frame evidence of any kind', async () => {
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(false));
    expect(coverUp(container), 'the simulation is on screen inside its section').toBe(true);

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    expect(coverUp(container), 'today the cover drops on the boundary, unconditionally').toBe(false);
    expect(pipeline.pending(), 'nothing may register a frame callback with the flag off').toBe(0);
    // The bundled freeze+mute+teardown, at T0 — the ordering the audit measured.
    expect(h.calls).toContain('deactivate');
    expect(h.calls, 'the split freeze/mute is a coordinator behaviour only').not.toContain('freeze');
  });

  it('the explicit "go back to video" uncovers before the seek, as today', async () => {
    const { container, clock, pipeline } = await mountInSim(postRollConfig(false), 10);
    expect(coverUp(container)).toBe(true);
    const button = backButton(container);
    expect(button, 'a post-roll simulation offers the return control').not.toBeNull();

    await act(async () => { fireEvent.click(button!); });

    expect(coverUp(container), 'today the overlay is cleared on the click itself').toBe(false);
    expect(pipeline.pending()).toBe(0);
    expect(clock.get(), 'and the seek happened after the uncover').toBe(0);
  });
});

// ── flag ON: the cover is held until the requested frame is proven ────────────────────────────

describe('flag ON — the automatic exit holds the cover until the frame is proven', () => {
  it('keeps the simulation composited across the boundary, then uncovers on a matching frame', async () => {
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    expect(coverUp(container)).toBe(true);

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    // THE FIX: the boundary alone no longer uncovers.
    expect(coverUp(container), 'the outgoing simulation must still be on screen').toBe(true);
    expect(pipeline.pending(), 'a frame callback is registered against the incoming video').toBe(1);
    expect(h.calls, 'the scene is frozen at T0 — the last valid frame is the cover').toContain('freeze');
    expect(h.calls, 'but it is NOT torn down yet').not.toContain('deactivate');

    // The frame the handoff asked for reaches the compositor.
    await act(async () => { pipeline.present(20); });
    // The cross-fade waits for a parent paint even after evidence.
    expect(coverUp(container), 'evidence alone does not uncover — a paint is still required').toBe(true);

    await frames(2);
    expect(coverUp(container), 'proven frame + parent paint uncovers').toBe(false);
    expect(h.calls).toContain('deactivate');
  });

  it('ignores a frame at the pre-boundary position and keeps the cover up', async () => {
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    // A frame from before the handoff's target — the picture the exit is trying to replace.
    await act(async () => { pipeline.present(2); });
    await frames(2);
    expect(coverUp(container), 'a frame at the wrong media time must not uncover').toBe(true);
    expect(pipeline.pending(), 'and the search must continue').toBe(1);

    await act(async () => { pipeline.present(20); });
    await frames(2);
    expect(coverUp(container)).toBe(false);
  });

  it('a deadline selects a cover and a retry — it never uncovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(coverUp(container)).toBe(true);

    // No frame ever arrives. Run past the handoff's whole deadline.
    await act(async () => { vi.advanceTimersByTime(4_100); });

    expect(coverUp(container), 'a timeout must never authorise a reveal (audit §21 rule 7)').toBe(true);
    expect(h.calls, 'and must not run the teardown either').not.toContain('deactivate');
    // The recovery is actionable: the player re-surfaces its return control.
    expect(backButton(container), 'a covered failure must be escapable').not.toBeNull();

    // …and it is a RECOVERY, not a dead end: the handoff is replayed and looks again.
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(pipeline.pending(), 'the replay must re-arm a frame callback').toBe(1);
    expect(coverUp(container), 'the replay is still covered until IT is proven').toBe(true);
  });

  it('stays covered indefinitely while the element itself can prove nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container, video, clock } = await mountInSim(midRollConfig(true));
    // A genuinely stalled element: no frame callback, and below HAVE_CURRENT_DATA the labelled
    // fallback is inadmissible too. There is no evidence to be had, so the cover is the answer.
    clock.setReadyState(0);
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    for (let i = 0; i < 6; i++) {
      await act(async () => { vi.advanceTimersByTime(3_000); });
      await frames(4);
    }
    expect(coverUp(container), 'no evidence, no reveal — for as long as that stays true').toBe(true);
    expect(h.calls).not.toContain('deactivate');
  });

  it('recovers through the LABELLED fallback when rVFC never fires but the element is fine', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(pipeline.pending(), 'rVFC is registered — it simply never fires').toBe(1);

    // Two visible animation frames before the non-arrival bound prove nothing yet: the fallback is
    // inadmissible while rVFC is still believed to be alive.
    await frames(2);
    expect(coverUp(container), 'the fallback must not pre-empt a live rVFC').toBe(true);

    // Past the bound, silence is a reported fact and the labelled fallback becomes admissible.
    await act(async () => { vi.advanceTimersByTime(500); });
    await frames(4);
    expect(coverUp(container), 'seeked + readyState>=2 + two visible frames is evidence too').toBe(false);
    expect(h.calls).toContain('deactivate');
  });
});

describe('flag ON — the explicit return holds the cover until the frame is proven', () => {
  it('seeks first, holds the simulation, and uncovers only on the requested frame', async () => {
    const { container, clock, pipeline } = await mountInSim(postRollConfig(true), 10);
    expect(coverUp(container)).toBe(true);

    await act(async () => { fireEvent.click(backButton(container)!); });

    // The ordering the audit asked for: the seek is issued while the cover is still up.
    expect(clock.get(), 'the seek must be issued at T0').toBe(0);
    expect(coverUp(container), 'the simulation must survive the click').toBe(true);
    expect(pipeline.pending()).toBe(1);
    expect(h.calls).toContain('freeze');
    expect(h.calls).not.toContain('deactivate');

    await act(async () => { pipeline.present(0); });
    await frames(2);
    expect(coverUp(container), 'the requested frame reached the compositor — now it may uncover').toBe(false);
    expect(h.calls, 'the original teardown still runs, just later').toContain('deactivate');
  });

  it('retains the package’s gain until the incoming video is audible, then releases it', async () => {
    const { container, video, pipeline } = await mountInSim(postRollConfig(true), 10);
    await act(async () => { fireEvent.click(backButton(container)!); });

    // Pixels are proven — that must NOT be what silences the package.
    await act(async () => { pipeline.present(0); });
    expect(h.calls, 'decoded pixels are not audible samples').not.toContain('mute');

    // 'playing' is the incoming media's own readiness signal.
    await act(async () => { video.dispatchEvent(new Event('playing')); });
    expect(h.calls, 'the gain is released only once the incoming media is audible').toContain('mute');
    expect(h.calls.indexOf('freeze'), 'freeze at T0, mute later — never together').toBeLessThan(h.calls.indexOf('mute'));
  });

  it('never silences the package while the handoff is still waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = await mountInSim(postRollConfig(true), 10);
    await act(async () => { fireEvent.click(backButton(container)!); });
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(h.calls, 'an unproven, unheard handoff leaves the outgoing audio alone').not.toContain('mute');
  });
});

// ── the two flag states differ ONLY in the gate ───────────────────────────────────────────────

describe('the flag is the whole difference', () => {
  it('both flag states end in the same place — one immediately, one on evidence', async () => {
    const off = await mountInSim(midRollConfig(false));
    off.clock.set(20);
    await act(async () => { off.video.dispatchEvent(new Event('timeupdate')); });
    const offCalls = [...h.calls];
    expect(coverUp(off.container)).toBe(false);

    cleanup();
    h.calls.length = 0;

    const on = await mountInSim(midRollConfig(true));
    on.clock.set(20);
    await act(async () => { on.video.dispatchEvent(new Event('timeupdate')); });
    await act(async () => { on.pipeline.present(20); });
    await frames(2);

    expect(coverUp(on.container), 'the same end state, reached on proof').toBe(false);
    // Same teardown, plus the freeze that splits the audio out of it.
    expect(h.calls.filter((c) => c === 'deactivate')).toEqual(offCalls.filter((c) => c === 'deactivate'));
  });
});
