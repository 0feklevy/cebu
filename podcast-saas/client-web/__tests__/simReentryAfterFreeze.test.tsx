/**
 * RE-ENTERING A SECTION WHOSE DOCUMENT THE PLAYER ITSELF FROZE.
 *
 * THE DEFECT THIS PINS
 * The resident pool freezes constantly — a background frame the instant it paints, a warm frame
 * when its budget expires, and (under the transition coordinator) the OUTGOING frame at T0 of an
 * exit, so its last valid frame can serve as the cover. Exactly one of `updateSimOverlay`'s four
 * activation branches ever undid that: the COLD one, which calls `rt.resume()` with a comment
 * explaining why a frozen document cannot be driven. The two WARM branches — the ones a re-entry
 * takes, because the frame is still resident and still painted — did not.
 *
 * On the v2 path the omission was invisible, because `activate()` posts `SIM_RESUME` itself. On the
 * v3 path it is not: `SIM_RESUME` does not undo the child's `scope.pause()` (only `RESUME_DOCUMENT`
 * does) and `activateModern` posts nothing equivalent. So `enter S1 → leave to video → scrub back
 * into S1` handed the section to a document that `modernActive()` reported dead, the activation
 * fell into the handshake-window deferral, held hidden, and 6.5 s later failed — with no recovery
 * surface (the cover/poll block is skipped on the warm branch, `simSurfaceMounted` is false and
 * `retryModern` refuses). The section then played as bare video for its whole duration, on EVERY
 * re-entry, until the failures opened the breaker.
 *
 * WHAT IS REAL HERE: `useProjectPlayer`, `HLSPlayerShell`'s JSX, the pool, the exit path and the
 * transition coordinator. What is doubled is `SimRuntimeClient`, because the real one needs a
 * cross-origin MessagePort handshake jsdom cannot host — but the double models the ONE v3 fact the
 * defect turns on: a document that has been suspended and not resumed CANNOT be activated. That
 * fact is asserted directly, against the real client and a real port, in
 * `simRuntimeClientModern.test.ts` ('THAWS a freeze the child has not confirmed yet',
 * 'ACTIVATING a frozen document resumes it').
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig } from '../components/viewer/types';

// ── the double ────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  /** Every lifecycle call the player made, in order. */
  calls: [] as string[],
  instances: [] as Array<{ emit: (event: string, detail?: Record<string, unknown>) => void }>,
}));

vi.mock('../lib/sim/SimRuntimeClient', () => {
  class FakeSimRuntimeClient {
    private cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void };
    /**
     * THE v3 FACT. `freeze()`/`suspend()` put the child's managed scope in `scope.pause()`; only
     * `RESUME_DOCUMENT` — which `thaw()`/`resume()` send — takes it out. While it is set the
     * document does not accept activation commands, which is precisely what `modernActive()`
     * reports to `activate()`.
     */
    private suspended = false;
    private state = {
      // Resident, booted and painted: what a pooled frame IS by the time a section is re-entered.
      phase: 'mounting', documentKey: null, dynamic: true, ackCapable: null, ready: true,
      painted: true, currentScript: null, pendingScript: null, activationToken: 0, stopped: false,
      visible: false, muted: false, interactive: false, lastError: null,
    };

    constructor(cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void } = {}) {
      this.cbs = cbs;
      h.instances.push(this);
    }

    emit(event: string, detail?: Record<string, unknown>) { this.cbs.onTelemetry?.(event, detail); }
    private log(m: string) { h.calls.push(m); }
    getState() { return this.state; }
    modernActive() { return !this.suspended; }
    getModernState() {
      return {
        active: !this.suspended,
        documentState: this.suspended ? 'SUSPENDED' : 'DOCUMENT_READY',
        activationState: 'none', contextLost: false, failure: null, breakerOpen: false,
      };
    }
    attach() {}
    handleFrameLoad() {}

    /**
     * Present a section — or hold it, exactly as the real client's handshake-window deferral does
     * when `modernActive()` is false. Nothing is revealed and no failure is raised: the section is
     * simply held hidden, which is the state the viewer sat in for the whole section.
     */
    activate() {
      if (this.suspended) { this.log('activate-while-suspended'); return; }
      this.log('activate');
      this.state = { ...this.state, visible: true, painted: true, phase: 'visible' };
      this.emit('reveal', {});
    }

    freeze() { this.log('freeze'); this.suspended = true; }
    suspend() { this.log('suspend'); this.suspended = true; }
    thaw() { this.log('thaw'); this.suspended = false; }
    resume() { this.log('resume'); this.suspended = false; }
    /** The bundled exit: freeze + silence + teardown. It suspends, like the freeze inside it. */
    deactivate() {
      this.log('deactivate');
      this.suspended = true;
      this.state = { ...this.state, visible: false, muted: true, phase: 'fading-out' };
    }

    enableModern() {}
    mute() { this.log('mute'); }
    unmute() {}
    hide() {}
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

// ── a hand-stepped animation clock (the player's reveal is behind a double rAF) ────────────────

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCancelRaf = globalThis.cancelAnimationFrame;

async function frames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    const due = rafQueue;
    rafQueue = [];
    await act(async () => { for (const { cb } of due) cb(0); });
  }
}

function installRvfc(video: HTMLVideoElement) {
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
    present(mediaTime: number) {
      const entry = [...cbs.entries()][0];
      if (!entry) return false;
      cbs.delete(entry[0]);
      entry[1](0, { mediaTime });
      return true;
    },
    pending: () => cbs.size,
  };
}

function controllableTime(video: HTMLVideoElement, initial = 0) {
  let t = initial;
  Object.defineProperty(video, 'currentTime', {
    configurable: true, get: () => t, set: (v: number) => { t = v; },
  });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
  return { get: () => t, set: (v: number) => { t = v; } };
}

// ── fixture: one mid-roll simulation, 0–10 s of a 60 s segment ─────────────────────────────────

const SIM_URL = 'https://sims.example.com/pkg/index.html?section=sec-1&v=abcd1234';

function config(coordinator: boolean): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: null,
    sim_transition_coordinator: coordinator,
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: 60,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      captions: { status: 'ready', vtt_url: null },
      simulations: [{
        id: 'sec-1',
        start_sec: 0,
        end_sec: 10,
        simulation_url: SIM_URL,
        simulation_id: 'sim-1',
        package_revision: 'rev-abcd',
        package_class: 'managed-presentable',
        sim_script: 'main',
        simple_ui: false,
        auto_script: true,
        label: 'Section one',
        type: 'simulation',
      }],
    }],
    broll_clips: [],
  } as unknown as PlayerConfig;
}

const coverUp = (c: HTMLElement) => c.querySelector('.sim-overlay.visible') !== null;

function stubMedia(c: HTMLElement) {
  c.querySelectorAll('video').forEach((v) => {
    Object.defineProperty(v, 'play', { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(v, 'pause', { configurable: true, value: () => {} });
  });
}

async function mountInSim(coordinator: boolean) {
  const view = render(<HLSPlayerShell config={config(coordinator)} />);
  await act(async () => { await Promise.resolve(); });
  stubMedia(view.container);
  const video = view.container.querySelector('video') as HTMLVideoElement;
  const clock = controllableTime(video, 0);
  const pipeline = installRvfc(video);
  await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
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

describe('scrubbing back into a section the player froze on the way out', () => {
  it('resumes the document before driving it — the coordinated exit path', async () => {
    const { container, video, clock, pipeline } = await mountInSim(true);
    expect(coverUp(container), 'the simulation never came up — this proves nothing').toBe(true);

    // Leave for the video. Under the coordinator this freezes the outgoing package at T0 so its
    // last valid frame is the cover, and tears it down only once the incoming frame is proven.
    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(h.calls, 'the exit did not freeze — this proves nothing').toContain('freeze');
    await act(async () => { pipeline.present(20); });
    await frames(2);
    expect(coverUp(container), 'the exit never completed').toBe(false);

    // Scrub back in. The frame is still resident and still painted, so this takes the WARM branch.
    h.calls.length = 0;
    clock.set(2);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    await frames(3);

    expect(
      h.calls,
      'the re-entry activated a document nothing had resumed — held hidden, then handshake-failed',
    ).not.toContain('activate-while-suspended');
    expect(h.calls, 'the re-entry never resumed the frozen document').toContain('thaw');
    expect(coverUp(container), 'the re-entered section never came back on screen').toBe(true);
  });

  it('resumes it on the plain exit path too — the coordinator is off by default', async () => {
    // Flag OFF is the shipping configuration, and `deactivateSim` freezes there as well (inside
    // `SimRuntimeClient.deactivate()`), so the same re-entry has the same requirement.
    const { container, video, clock } = await mountInSim(false);
    expect(coverUp(container)).toBe(true);

    clock.set(20);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(h.calls, 'the exit did not tear down — this proves nothing').toContain('deactivate');
    expect(coverUp(container)).toBe(false);

    h.calls.length = 0;
    clock.set(2);
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    await frames(3);

    expect(h.calls, 'the re-entry activated a suspended document').not.toContain('activate-while-suspended');
    expect(coverUp(container), 'the re-entered section never came back on screen').toBe(true);
  });

  it('and it is not once-only: every re-entry gets a running document', async () => {
    // The failure repeated on EVERY re-entry and eventually opened the breaker, so one successful
    // round trip is not the claim — the loop is.
    const { container, video, clock } = await mountInSim(false);
    for (let i = 0; i < 3; i++) {
      clock.set(20);
      await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
      h.calls.length = 0;
      clock.set(2);
      await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
      await frames(3);
      expect(h.calls, `re-entry ${i + 1} drove a suspended document`).not.toContain('activate-while-suspended');
      expect(coverUp(container), `re-entry ${i + 1} left the section off screen`).toBe(true);
    }
  });
});
