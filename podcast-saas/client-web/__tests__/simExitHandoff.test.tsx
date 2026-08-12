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
import { SIM_EXIT_STOP_MS } from '../lib/sim/protocol';
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

/**
 * The coordinator's own breadcrumb trail, captured.
 *
 * The real `simTelemetry` is a no-op unless the page carries `?simdebug=1`, so recording it here is
 * the only way to observe an effect whose ONLY output is a telemetry line — which is exactly what a
 * timer firing after unmount is.
 */
const tel = vi.hoisted(() => ({ events: [] as { event: string; detail: Record<string, unknown> }[] }));
vi.mock('../lib/simTelemetry', () => ({
  simTelemetry: (event: string, detail?: Record<string, unknown>) =>
    tel.events.push({ event, detail: detail ?? {} }),
}));
const telEvents = () => tel.events.map((e) => e.event);

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

/**
 * THE COVER AS THE COMPOSITOR SEES IT — the resident frame's own opacity.
 *
 * `.sim-overlay.visible` is only HALF of what puts a simulation on screen. `SimPoolOverlay` shows a
 * frame on `spec.key === activeKey && visible`, and `activeKey` is `state.activeSimUrl`: releasing
 * that key alone starts `.sim-pool-frame`'s 200 ms opacity transition with the overlay class
 * untouched. So a test written against the class passes while the viewer watches the cover fade,
 * which is exactly how the T0 release below survived. Anything asserting "the cover is up" during a
 * handoff must assert THIS.
 */
const poolFrameOpacity = (c: HTMLElement): string | null => {
  const el = c.querySelector('.sim-overlay .sim-pool-frame') as HTMLIFrameElement | null;
  return el ? el.style.opacity : null;
};
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
  tel.events.length = 0;
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

/**
 * Tab away, and come back.
 *
 * `visibilityState` is a getter on `document`, so it is redefined rather than assigned — and the
 * event is dispatched separately, exactly as the browser orders it: the property is already the new
 * value by the time any listener runs.
 */
async function setPageHidden(hidden: boolean): Promise<void> {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true, get: () => (hidden ? 'hidden' : 'visible'),
  });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}

afterEach(async () => {
  cleanup();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancelRaf;
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(document, 'hidden');
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

  it('a handoff that failed while the tab was hidden re-arms when the tab comes back', async () => {
    // THE WEDGE THIS PINS. Hiding cancels evidence and disarms rVFC, and neither rVFC nor rAF runs
    // on a hidden page — so the 4 s deadline fires with nothing to show for it and the handoff
    // lands in `CoveredFailure`. The automatic replay then re-issued the SAME handoff with
    // `pageVisible: false`, which cannot arm anything either, and burned another 4 s per attempt
    // until the three-attempt budget was gone. On return, `VISIBILITY` re-armed only for a WAIT
    // phase, and `CoveredFailure` is not one — so COMMIT_REVEAL never ran, the caller's uncover
    // never ran, and the frozen simulation stayed at full opacity over a playing, audible video
    // for the rest of the section. The only way out was the "Go back to video" button.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(pipeline.pending(), 'the handoff never armed — this proves nothing').toBe(1);

    // The viewer switches tabs mid-handoff.
    await setPageHidden(true);
    expect(pipeline.pending(), 'a hidden page must not hold a frame callback').toBe(0);

    // No frame can arrive, so the whole deadline elapses. Ten times over, in fact: nothing hidden
    // may spend the retry budget on an attempt that provably cannot produce evidence.
    await act(async () => { vi.advanceTimersByTime(40_000); });
    expect(coverUp(container), 'a timeout must never authorise a reveal (audit §21 rule 7)').toBe(true);
    expect(h.calls, 'the teardown ran without evidence').not.toContain('deactivate');
    expect(pipeline.pending(), 'a retry was issued to a hidden page').toBe(0);

    // …and back. THE FIX: the return is what reconsiders the failure.
    await setPageHidden(false);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(pipeline.pending(), 'the handoff never re-armed after the page came back').toBe(1);
    expect(coverUp(container), 'the replay is still covered until IT is proven').toBe(true);

    // And the replay completes the exit the viewer has been stuck in.
    await act(async () => { pipeline.present(20); });
    await frames(2);
    expect(coverUp(container), 'the proven replay never uncovered').toBe(false);
    expect(h.calls).toContain('deactivate');
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

  it('the cross-fade timer does not outlive the player', async () => {
    // AN UNOWNED TIMER. `COMMIT_REVEAL` calls `endHandoff()` — which clears `handoffActiveRef` and,
    // incidentally, the very ref it is about to reuse — and THEN arms the cross-fade. So the fade
    // timer is the one thing the handoff leaves behind that no owner could reach:
    // `cancelCoordinatedExit` early-returns on `!handoffActiveRef.current`, and the unmount cleanup
    // goes through that same cancel. It fired into a torn-down tree and re-entered
    // `dispatchTransition` there. It only emits telemetry today, so this is a stray timer rather
    // than a state write — but "only telemetry" is a property of the current effect list, not of
    // the ownership, and the next effect added to `FADE_COMPLETE` inherits the hole.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const view = await mountInSim(postRollConfig(true), 10);
    await act(async () => { fireEvent.click(backButton(view.container)!); });
    await act(async () => { view.pipeline.present(0); });
    await frames(2);
    expect(telEvents(), 'the reveal never committed — this proves nothing').toContain('transition-reveal');
    expect(telEvents(), 'the fade completed before the unmount — the window is not open').not.toContain('transition-live');

    // The viewer navigates away mid-fade.
    await act(async () => { view.unmount(); });
    tel.events.length = 0;
    await act(async () => { vi.advanceTimersByTime(SIM_EXIT_STOP_MS * 4); });

    expect(
      telEvents(),
      'the cross-fade timer survived the unmount and re-entered the reducer against a dead tree',
    ).not.toContain('transition-live');
  });

  it('a re-entry mid-fade takes the timer with it', async () => {
    // The other caller of `cancelCoordinatedExit`, and the common one: the viewer scrubs back into
    // the section while its exit fade is still running.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { video, clock, pipeline } = await mountInSim(midRollConfig(true));
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    await act(async () => { pipeline.present(20); });
    await frames(2);
    expect(telEvents()).toContain('transition-reveal');

    // Back into the simulation, inside the fade. `cancelCoordinatedExit` runs — and its early
    // return on `!handoffActiveRef.current` is the whole problem: COMMIT_REVEAL cleared that flag
    // before arming the timer, so the cancel used to walk straight past the one thing left to
    // cancel and the abandoned handoff went on to declare itself LIVE over a re-entered section.
    tel.events.length = 0;
    h.calls.length = 0;
    clock.set(2);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    await frames(3);
    expect(h.calls, 'the section was never re-entered — this proves nothing').toContain('activate');

    await act(async () => { vi.advanceTimersByTime(SIM_EXIT_STOP_MS * 4); });
    expect(telEvents(), 'the abandoned handoff’s fade timer still ran').not.toContain('transition-live');
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

// ── the cover the coordinator holds is the FRAME, not the overlay class ───────────────────────

/**
 * THE DEFECT THIS PINS (a regression introduced by the `activeSimUrl` fix itself).
 *
 * `deactivateSim` began clearing the rendered `state.activeSimUrl` UNCONDITIONALLY, outside the
 * coordinator branch — correct for a flag-off exit, and fatal for a coordinated one. The frozen
 * simulation frame IS the cover during a handoff, and `SimPoolOverlay` composites a frame on
 * `spec.key === activeKey && visible`. Nulling the key at T0 therefore started the 200 ms fade the
 * instant the exit was requested, while the coordinator was still holding and had committed
 * nothing: `.sim-overlay.visible` stayed on the DOM (so every existing assertion above passed) and
 * the viewer watched the cover disappear over an unproven video frame anyway.
 *
 * Worst on the paths where nothing ever commits — the deadline, the covered failure, the retry —
 * because there the cover is not merely early, it is the entire answer, and it was gone.
 */
describe('flag ON — the resident frame stays composited for as long as the coordinator holds', () => {
  it('does not release the rendered active key at T0 on the automatic exit', async () => {
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    expect(poolFrameOpacity(container), 'the simulation is on screen inside its section').toBe('1');

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    expect(
      poolFrameOpacity(container),
      'the cover the coordinator is holding faded out at T0',
    ).toBe('1');
    expect(coverUp(container), 'and the overlay class agrees — it always did').toBe(true);

    await act(async () => { pipeline.present(20); });
    await frames(2);
    expect(poolFrameOpacity(container), 'the proven frame must release it').toBe('0');
  });

  it('holds the frame across a deadline, a covered failure and the replay', async () => {
    // The path with no commit at the end of it. A cover that has already faded is not a cover, so
    // "a deadline never authorises a reveal" was true of the state machine and false on screen.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    await act(async () => { vi.advanceTimersByTime(4_100); });
    expect(
      poolFrameOpacity(container),
      'the deadline uncovered — by fading the frame rather than by committing',
    ).toBe('1');

    // …and the replay the covered failure schedules inherits the same cover.
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(pipeline.pending(), 'the replay never re-armed — this proves nothing').toBe(1);
    expect(poolFrameOpacity(container), 'the replay is covered by the same frame').toBe('1');
  });

  it('holds the frame across the explicit return, whose seek re-enters deactivateSim', async () => {
    // `resumeFromSim`'s `issueSeek` calls `updateSimOverlay`, which calls `deactivateSim` again
    // while the handoff it just started is still in flight. That second pass is the one that
    // released the key: the coordinator answers "already mine" and commits nothing, so the release
    // had no owner and no evidence behind it.
    const { container, pipeline } = await mountInSim(postRollConfig(true), 10);
    expect(poolFrameOpacity(container)).toBe('1');

    await act(async () => { fireEvent.click(backButton(container)!); });

    expect(poolFrameOpacity(container), 'the real seek dropped the cover on the click').toBe('1');

    await act(async () => { pipeline.present(0); });
    await frames(2);
    expect(poolFrameOpacity(container), 'the requested frame is proven — now it may go').toBe('0');
  });

  it('flag OFF still releases it at T0, exactly as before', async () => {
    // The other half: the hold belongs to the coordinator, not to the frame. With the flag off the
    // key is released on the boundary tick, which is today's behaviour and must stay it.
    const { container, video, clock } = await mountInSim(midRollConfig(false));
    expect(poolFrameOpacity(container)).toBe('1');

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    expect(poolFrameOpacity(container), 'flag off must be byte-for-byte today').toBe('0');
  });
});

// ── the LOW-END tier must hold the same cover ─────────────────────────────────────────────────

/**
 * THE DEFECT THIS PINS (found by CI's 2-core runner, invisible on every developer machine).
 *
 * `canWarmUnpaused()` reads the host's real `hardwareConcurrency`, and at ≤4 cores the pool runs
 * the 'window' tier — whose planner keeps only the plan, `activeSimUrlRef`, and frames mid-fade or
 * mid-eviction. `deactivateSim` nulled that ref UNCONDITIONALLY at T0, so on a coordinated exit
 * the planner `dropPooled()`-ed the element the coordinator was holding as its cover, on the first
 * tick, on every device the 'window' tier exists for. At the 'all' tier there is no eviction rule
 * at all, which is exactly why every >4-core machine passed while CI failed.
 *
 * The global vitest pin (vitest.setup.ts) runs the suite at 8 cores, so WITHOUT this explicit
 * low-end case the fix would be unpinned: reverting the ref guard would pass the entire pinned
 * suite. Cores are forced to 2 here, instance-level, BEFORE mount — the tier latches on first
 * render and never re-reads.
 */
describe('flag ON, LOW-END (2 cores, window tier) — the held cover survives the planner', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'hardwareConcurrency');
  });

  it('the window-tier planner does not unmount the frame the coordinator is holding', async () => {
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    expect(poolFrameOpacity(container), 'the simulation is on screen inside its section').toBe('1');

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    // NULL here — not '0' — is the low-end failure shape: the element was not faded, it was gone.
    expect(
      poolFrameOpacity(container),
      'the window-tier planner dropped the element under the held cover at T0',
    ).toBe('1');

    // The hold must survive further video-only ticks: every tick re-runs the planner, and every
    // re-run is a fresh chance for a disagreeing ref to hand it the frame.
    clock.set(21);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(poolFrameOpacity(container), 'a later tick reclaimed the held cover').toBe('1');

    // Evidence within DEFAULT_FRAME_TOLERANCE_SEC of the time requested at T0. In production rVFC
    // fires per presented frame, so near-request evidence arrives within ~one frame of arming;
    // the harness fires only on demand, and a frame a whole second late is DELIBERATELY rejected
    // (that is the pre-boundary/tolerance rule its own test pins). Late delivery of a valid frame
    // is fine; a frame at the wrong media time is not.
    await act(async () => { pipeline.present(20.1); });
    await frames(2);
    expect(poolFrameOpacity(container), 'the proven frame must still release it').toBe('0');
  });

  it('after the commit, the window tier DOES reclaim the frame — the hold is not a leak', async () => {
    // The other half of the low-end story, and what pins `uncover`'s release of the residency
    // ref: if the commit did not release it, "never drop the live frame" would keep a dead
    // section's WebGL context resident for the rest of the session — on exactly the devices the
    // 'window' tier exists to protect. (The harness runtime has no deferred-stop, so the fade
    // guard is inert here and the reclaim lands on the first tick after the release; in
    // production it lands one tick later, after `hasDeferredStop()` clears.)
    const { container, video, clock, pipeline } = await mountInSim(midRollConfig(true));
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    await act(async () => { pipeline.present(20); });
    await frames(2);
    expect(poolFrameOpacity(container), 'released after the proof').toBe('0');

    clock.set(22);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(
      poolFrameOpacity(container),
      'the committed exit must let the window tier reclaim the frame',
    ).toBeNull();
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
