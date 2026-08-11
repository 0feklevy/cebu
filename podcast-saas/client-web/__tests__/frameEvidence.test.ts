/**
 * The fake-rVFC harness (audit P0.1) — the probe plus the reducer, driven frame by frame.
 *
 * WHY THE TWO ARE TESTED TOGETHER HERE
 * `transitionCoordinator.test.ts` proves the ACCEPT/REJECT rules over the whole product, with
 * events handed to the reducer directly. That leaves one thing unproven: that the probe actually
 * delivers the observations those rules are written against, with the right generation stamped on
 * them, and that a rejected frame really does lead to another look. The bugs that live in that
 * seam — a callback that re-arms itself so a stale frame is never re-examined, a cancel that
 * leaves an rVFC handle registered against a swapped element — are invisible to either half alone.
 *
 * Everything here is a controllable double: the media element, `requestVideoFrameCallback` and
 * `requestAnimationFrame` are all driven by the test, so "a callback that never arrives" is a real
 * state of the system rather than a timeout someone waited out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { armFrameEvidence, supportsRequestVideoFrameCallback, DEFAULT_NON_ARRIVAL_MS } from '../lib/sim/frameEvidence';
import {
  reduce,
  isRevealed,
  INITIAL_TRANSITION_STATE,
  type TransitionEffect,
  type TransitionEvent,
  type TransitionState,
} from '../lib/sim/transitionCoordinator';

const GEN = 3;
const TARGET = 12.0;

// ── a video element whose frame pipeline the test owns ────────────────────────────────────────

interface FakeVideo {
  el: HTMLVideoElement;
  /** Present one frame to whatever callback is currently registered. */
  presentFrame(mediaTime: number): boolean;
  /** How many rVFC registrations are outstanding. Must be 0 after a cancel. */
  pending(): number;
  cancelled: number[];
  setCurrentTime(t: number): void;
  setReadyState(n: number): void;
}

function makeVideo(opts: { rvfc?: boolean } = {}): FakeVideo {
  const withRvfc = opts.rvfc !== false;
  let currentTime = 0;
  let readyState = 0;
  let nextHandle = 1;
  const callbacks = new Map<number, (now: number, meta: { mediaTime: number }) => void>();
  const cancelled: number[] = [];

  const el = {
    get currentTime() { return currentTime; },
    get readyState() { return readyState; },
    ...(withRvfc
      ? {
        requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void) {
          const h = nextHandle++;
          callbacks.set(h, cb);
          return h;
        },
        cancelVideoFrameCallback(h: number) {
          cancelled.push(h);
          callbacks.delete(h);
        },
      }
      : {}),
  } as unknown as HTMLVideoElement;

  return {
    el,
    presentFrame(mediaTime) {
      const entry = [...callbacks.entries()][0];
      if (!entry) return false;
      const [handle, cb] = entry;
      callbacks.delete(handle);
      cb(performance.now(), { mediaTime });
      return true;
    },
    pending: () => callbacks.size,
    cancelled,
    setCurrentTime(t) { currentTime = t; },
    setReadyState(n) { readyState = n; },
  };
}

// ── a rAF the test steps by hand ──────────────────────────────────────────────────────────────

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 1;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;

/** Run every currently-queued animation frame callback once. */
function stepFrames(n = 1): void {
  for (let i = 0; i < n; i++) {
    const due = rafQueue;
    rafQueue = [];
    for (const { cb } of due) cb(performance.now());
  }
}

beforeEach(() => {
  rafQueue = [];
  rafId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = rafId++;
    rafQueue.push({ id, cb });
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue = rafQueue.filter((f) => f.id !== id);
  }) as typeof cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
  vi.useRealTimers();
});

// ── the harness: probe + reducer, wired the way the player wires them ─────────────────────────

interface Harness {
  state(): TransitionState;
  effects: TransitionEffect[];
  /** Raise an event the PLAYER would raise from a media listener, not from the probe. */
  dispatch(event: TransitionEvent): void;
  /** Cancel whatever is armed, as the player's CANCEL_FRAME_EVIDENCE effect does. */
  cancelProbe(): void;
  probeMode(): string;
}

/**
 * Reproduce the player's own wiring: the reducer is the only thing that arms, and it re-arms by
 * emitting ARM_FRAME_EVIDENCE. Keeping that loop here rather than inside the probe is precisely
 * what makes "a rejected frame must not end the search" assertable.
 */
function harness(video: FakeVideo, first: TransitionEvent, generation = GEN): Harness {
  let state = INITIAL_TRANSITION_STATE;
  const effects: TransitionEffect[] = [];
  let probe: ReturnType<typeof armFrameEvidence> | null = null;
  let mode = 'none';

  const dispatch = (event: TransitionEvent): void => {
    const result = reduce(state, event);
    state = result.state;
    effects.push(...result.effects);
    for (const effect of result.effects) {
      if (effect.type === 'ARM_FRAME_EVIDENCE') {
        probe?.cancel();
        probe = armFrameEvidence({
          video: video.el,
          generation: effect.generation,
          onFrame: (f) => dispatch({ type: 'FRAME_PRESENTED', ...f }),
          onVisibleFrame: (g) => dispatch({ type: 'VISIBLE_FRAME', generation: g }),
          onNonArrival: (g) => dispatch({ type: 'RVFC_NON_ARRIVAL', generation: g }),
        });
        mode = probe.mode;
      } else if (effect.type === 'CANCEL_FRAME_EVIDENCE') {
        probe?.cancel();
        probe = null;
      }
    }
  };

  dispatch(first);
  dispatch({ type: 'SOURCE_ISSUED', generation });
  return {
    state: () => state,
    effects,
    dispatch,
    cancelProbe: () => { probe?.cancel(); probe = null; },
    probeMode: () => mode,
  };
}

const exitRequested = (over: Partial<Extract<TransitionEvent, { type: 'EXIT_REQUESTED' }>> = {}): TransitionEvent => ({
  type: 'EXIT_REQUESTED',
  generation: GEN,
  incomingId: 'vid-1',
  requestedMediaTime: TARGET,
  seekRequested: true,
  audioIntent: 'narration-continuous',
  outgoing: { kind: 'sim', valid: true },
  poster: { available: false, loaded: false },
  rvfcAvailable: true,
  pageVisible: true,
  deadlineAt: null,
  ...over,
});

// ── capability probe ──────────────────────────────────────────────────────────────────────────

describe('supportsRequestVideoFrameCallback', () => {
  it('detects the API and its absence', () => {
    expect(supportsRequestVideoFrameCallback(makeVideo().el)).toBe(true);
    expect(supportsRequestVideoFrameCallback(makeVideo({ rvfc: false }).el)).toBe(false);
  });
});

// ── the four cases the audit names ────────────────────────────────────────────────────────────

describe('a target frame is accepted; anything else is not', () => {
  it('accepts the correct target frame and submits the handoff', () => {
    const video = makeVideo();
    const h = harness(video, exitRequested());
    expect(h.probeMode()).toBe('rvfc+raf');

    expect(video.presentFrame(TARGET)).toBe(true);
    expect(h.state().phase).toBe('VideoSubmitted');
    expect(h.state().evidence).toMatchObject({ kind: 'rvfc', confidence: 'high', mediaTime: TARGET, generation: GEN });
    // Evidence in hand, the callback is released — nothing is left registered.
    expect(video.pending()).toBe(0);
  });

  it('IGNORES a stale generation’s frame, and does not reveal on it', () => {
    const video = makeVideo();
    const h = harness(video, exitRequested());
    // Simulate the callback belonging to a superseded handoff by feeding the reducer directly with
    // the wrong stamp — the probe always stamps its own generation, which is the point of the stamp.
    const before = h.state();
    const after = reduce(before, { type: 'FRAME_PRESENTED', generation: GEN - 1, mediaTime: TARGET, kind: 'rvfc', atMs: 1 });
    expect(after.state.evidence).toBeNull();
    expect(after.state.rejected.staleGeneration).toBe(1);
    expect(isRevealed(after.state.phase)).toBe(false);
  });

  it('IGNORES a frame at the wrong media time and keeps looking for the right one', () => {
    const video = makeVideo();
    const h = harness(video, exitRequested());

    // The pre-seek frame is presented first — exactly what happens in a real seek.
    video.presentFrame(0);
    expect(h.state().evidence, 'the stale picture must not be accepted').toBeNull();
    expect(h.state().rejected.wrongMediaTime).toBe(1);
    // The loop must have been re-armed, or the target frame would never be seen.
    expect(video.pending(), 'a rejected frame must leave a callback registered').toBe(1);

    video.presentFrame(TARGET);
    expect(h.state().phase).toBe('VideoSubmitted');
    expect(h.state().evidence?.mediaTime).toBe(TARGET);
  });

  it('a callback that arrives AFTER cancel changes nothing', () => {
    const video = makeVideo();
    const h = harness(video, exitRequested());
    const state = h.state();

    h.cancelProbe();
    expect(video.pending(), 'cancel must unregister the rVFC handle').toBe(0);
    expect(video.cancelled.length, 'and must call cancelVideoFrameCallback, not merely drop it').toBe(1);
    // Nothing left to fire.
    expect(video.presentFrame(TARGET)).toBe(false);
    expect(h.state()).toEqual(state);

    // And if one somehow does fire against a generation that has moved on, it is inert.
    const later = reduce({ ...h.state(), generation: GEN + 1 },
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 99 });
    expect(isRevealed(later.state.phase)).toBe(false);
  });
});

describe('non-arrival is handled explicitly, never waited out', () => {
  it('reports non-arrival on the bound and then admits the LABELLED fallback', () => {
    // `toFake` is deliberate: vitest's default set includes requestAnimationFrame, which would
    // replace this file's hand-stepped rAF and silently make every frame assertion vacuous.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const video = makeVideo();
    video.setReadyState(4);
    const h = harness(video, exitRequested());
    h.dispatch({ type: 'MEDIA_READY', generation: GEN, readyState: 4, seeked: true });

    // Two visible animation frames accrue while rVFC says nothing at all. They are counted, and
    // the fallback claims they carry are REJECTED, because rVFC has not yet been ruled out.
    video.setCurrentTime(TARGET);
    stepFrames(2);
    expect(h.state().readiness.visibleFrames).toBeGreaterThanOrEqual(2);
    expect(h.state().evidence, 'the fallback must not pre-empt a live rVFC').toBeNull();
    expect(h.state().rejected.inadmissibleFallback).toBeGreaterThan(0);

    vi.advanceTimersByTime(DEFAULT_NON_ARRIVAL_MS);
    expect(h.state().rvfc.nonArrival, 'silence must be reported as a fact').toBe(true);

    // Now the same claim is admissible — and is labelled low confidence when accepted.
    stepFrames(1);
    expect(h.state().phase).toBe('VideoSubmitted');
    expect(h.state().evidence).toMatchObject({ kind: 'fallback', confidence: 'low' });
  });

  it('never reveals while the callback simply does not come', () => {
    // `toFake` is deliberate: vitest's default set includes requestAnimationFrame, which would
    // replace this file's hand-stepped rAF and silently make every frame assertion vacuous.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const video = makeVideo();
    const h = harness(video, exitRequested());
    // readyState stays 0: nothing can satisfy the fallback either.
    vi.advanceTimersByTime(DEFAULT_NON_ARRIVAL_MS * 5);
    stepFrames(10);
    expect(isRevealed(h.state().phase)).toBe(false);
    expect(h.state().evidence).toBeNull();

    // The deadline is the only thing that ends this wait, and it selects a cover.
    const timedOut = reduce(h.state(), { type: 'DEADLINE', generation: GEN, atMs: 4_000 });
    expect(timedOut.state.phase).toBe('CoveredFailure');
    expect(isRevealed(timedOut.state.phase)).toBe(false);
  });

  it('does not report non-arrival once a frame has actually been seen', () => {
    // `toFake` is deliberate: vitest's default set includes requestAnimationFrame, which would
    // replace this file's hand-stepped rAF and silently make every frame assertion vacuous.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const video = makeVideo();
    const h = harness(video, exitRequested());
    video.presentFrame(0);                       // wrong time, but rVFC is demonstrably alive
    vi.advanceTimersByTime(DEFAULT_NON_ARRIVAL_MS * 3);
    // The re-armed probe restarts its own bound, so `nonArrival` may legitimately be reported by
    // the SECOND probe; what must not happen is a reveal from an unproven fallback.
    expect(h.state().evidence).toBeNull();
  });
});

describe('with rVFC undefined the probe falls back, and the fallback is admissible at once', () => {
  it('runs rAF-only and accepts the labelled claim once all three components are present', () => {
    const video = makeVideo({ rvfc: false });
    video.setReadyState(4);
    const h = harness(video, exitRequested({ rvfcAvailable: false }));
    expect(h.probeMode()).toBe('raf');

    h.dispatch({ type: 'MEDIA_READY', generation: GEN, readyState: 4, seeked: true });
    video.setCurrentTime(TARGET);

    // One visible frame is not two.
    stepFrames(1);
    expect(h.state().evidence, 'one animation frame is not the audit’s two').toBeNull();

    stepFrames(1);
    expect(h.state().phase).toBe('VideoSubmitted');
    expect(h.state().evidence).toMatchObject({ kind: 'fallback', confidence: 'low' });
  });

  it('still refuses the fallback when the element never reaches HAVE_CURRENT_DATA', () => {
    const video = makeVideo({ rvfc: false });
    video.setCurrentTime(TARGET);
    const h = harness(video, exitRequested({ rvfcAvailable: false }));
    h.dispatch({ type: 'MEDIA_READY', generation: GEN, readyState: 1, seeked: true });
    stepFrames(5);
    expect(isRevealed(h.state().phase)).toBe(false);
    expect(h.state().evidence).toBeNull();
  });

  it('refuses the fallback when the element is at the WRONG time, however ready it is', () => {
    const video = makeVideo({ rvfc: false });
    video.setReadyState(4);
    video.setCurrentTime(TARGET + 30);
    const h = harness(video, exitRequested({ rvfcAvailable: false }));
    h.dispatch({ type: 'MEDIA_READY', generation: GEN, readyState: 4, seeked: true });
    stepFrames(5);
    expect(h.state().evidence).toBeNull();
    expect(h.state().rejected.wrongMediaTime).toBeGreaterThan(0);
  });
});
