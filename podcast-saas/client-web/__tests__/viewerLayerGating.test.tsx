/**
 * Priority 5 — the GATE that decides whether the viewer composites through the layered
 * presentation surface at all.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM simPresentationLayers.test.tsx
 * That file proves the layered surface is safe. This one proves the viewer only uses it where it is
 * applicable — which is the more dangerous half. `SimPresentationLayers` reports
 * `incoming: 'hidden'` for as long as `presented` is false, and `presented` can only come from a v3
 * `SECTION_PRESENTED`. No v2 or legacy package has ever sent one and none ever will. So a viewer
 * that rendered the layered path unconditionally would hide the simulation, for the whole of every
 * section, for every package currently in storage.
 *
 * The gate therefore has to be BOTH halves and is asserted as both:
 *   • the publish-time canary classified this package `managed-presentable`, and
 *   • the runtime reports that THIS document is actually running the activation-scoped protocol.
 * Either one alone renders the legacy path, unchanged.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * The gate itself is real: the actual `useProjectPlayer`, the actual `HLSPlayerShell` JSX, the
 * actual `SimPresentationLayers` and the actual `decidePresentation`. What is doubled is the
 * SimRuntimeClient, because `modernActive()` is true only after a live MessagePort handshake with a
 * cross-origin child document — something jsdom cannot host, and something whose absence would
 * otherwise make the "modern" half of the gate untestable at this level (it is covered on the wire
 * by __tests__/simRuntimeClient.test.ts and the protocol e2e suite).
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig, SimulationOverlay } from '../components/viewer/types';
import { packageKeyOf } from '../lib/simPool';

// ── doubles ───────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  /** What the doubled runtime answers `modernActive()` with. */
  modernActive: { value: false },
  /** Every client the player created, so a test can drive telemetry from the real code path. */
  instances: [] as Array<{ emit: (event: string, detail?: Record<string, unknown>) => void }>,
  /** The `enableModern` setups the player armed, for the class-gate assertion. */
  enableModernCalls: [] as Array<{ packageClass: string }>,
}));

vi.mock('../lib/sim/SimRuntimeClient', () => {
  // Every method the player calls, so the doubled client is a drop-in for the lifecycle surface
  // without standing in for the DECISION under test — which is made in the player, from
  // `modernActive()` plus the config's canary class.
  class FakeSimRuntimeClient {
    private cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void };
    private state = {
      phase: 'mounting', documentKey: null, dynamic: null, ackCapable: null, ready: false,
      painted: false, currentScript: null, pendingScript: null, activationToken: 0, stopped: false,
      visible: false, muted: false, interactive: false, lastError: null,
    };

    constructor(cbs: { onTelemetry?: (event: string, detail?: Record<string, unknown>) => void } = {}) {
      this.cbs = cbs;
      h.instances.push(this);
    }

    getState() { return this.state; }
    modernActive() { return h.modernActive.value; }
    getModernState() {
      return {
        active: h.modernActive.value, documentState: 'READY', activationState: 'none',
        contextLost: false, failure: null, breakerOpen: false,
      };
    }
    enableModern(setup: { packageClass: string }) { h.enableModernCalls.push(setup); }
    /** Report a lifecycle conclusion exactly as the real client does — through onTelemetry. */
    emit(event: string, detail?: Record<string, unknown>) { this.cbs.onTelemetry?.(event, detail); }

    attach() {}
    handleFrameLoad() {}
    activate() {}
    deactivate() {}
    hide() {}
    suspend() {}
    resume() {}
    freeze() {}
    thaw() {}
    mute() {}
    unmute() {}
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
    present() {}
    retryModern() { return false; }
    setQuality() {}
    dispose() {}
  }
  return { SimRuntimeClient: FakeSimRuntimeClient };
});

// hls.js probes MediaSource at import time and is irrelevant to the gate; jsdom has no media
// pipeline, so the player's non-hls.js path is the one exercised either way.
vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: { ERROR: 'hlsError' } } }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
// next/link needs the App Router context the shell is not rendered inside here.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

// ── fixture ───────────────────────────────────────────────────────────────────────────────────

const SIM_URL = 'https://sims.example.com/pkg/index.html?section=sec-1&v=abcd1234';
const POSTER_URL = 'https://cdn.example.com/sim-public/simulations/p/s/posters/id/standard.webp';

function configWith(over: Partial<SimulationOverlay>): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: null,
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: 60,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      // 'ready' with no VTT keeps the caption poller and the VTT fetch out of this test entirely.
      captions: { status: 'ready', vtt_url: null },
      simulations: [{
        id: 'sec-1',
        start_sec: 0,
        end_sec: 10,
        simulation_url: SIM_URL,
        simulation_id: 'sim-1',
        package_revision: 'rev-abcd',
        package_class: null,
        sim_script: 'main',
        simple_ui: false,
        auto_script: true,
        label: 'Section one',
        type: 'simulation',
        ...over,
      }],
    }],
    broll_clips: [],
  };
}

/**
 * Mount the player and drive it into the sim section that opens the timeline.
 *
 * The section starts at 0 and jsdom's media element reports `currentTime === 0`, so ONE real
 * `timeupdate` runs the player's own `onTick` → `updateSimOverlay(0, 0)` → the real activation
 * path. Nothing about the section change is simulated.
 */
async function mountAndEnterSim(config: PlayerConfig) {
  const view = render(<HLSPlayerShell config={config} />);
  // Let the setup effect's dynamic hls.js import resolve so the media listeners are attached.
  await act(async () => { await Promise.resolve(); });
  const video = view.container.querySelector('video') as HTMLVideoElement;
  await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

  /**
   * Play PAST the sim section, so the player takes its real hand-back-to-video path.
   *
   * Driving this with the actual media clock rather than by poking state is what makes the
   * node-identity assertion mean something: a remount, or a state poke that re-renders nothing,
   * would both "pass" while proving nothing about what happens when a modern package ends.
   */
  const leaveSimSection = async () => {
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 20 });
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
  };

  return { ...view, leaveSimSection };
}

const layered = (c: HTMLElement) => c.querySelector('[data-testid="sim-presentation"]');
const pool = (c: HTMLElement) => c.querySelector('.sim-overlay');
const incoming = (c: HTMLElement) => c.querySelector('[data-testid="sim-layer-incoming"]');

beforeEach(() => {
  h.modernActive.value = false;
  h.instances.length = 0;
  h.enableModernCalls.length = 0;
  // This runner's jsdom is started without a localStorage backing file, so `window.localStorage`
  // is undefined. The shell persists the viewer's caption style through it; an in-memory stand-in
  // keeps that unrelated effect from throwing during mount.
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

// ── the legacy path is untouched ──────────────────────────────────────────────────────────────

/**
 * Drive the pipeline until `check` holds, INSIDE act().
 *
 * `vi.waitFor` is the wrong tool for this file. Its callback runs outside React's `act()`, so a
 * state update arriving from `revealSim`'s double rAF is not guaranteed to have been flushed to the
 * DOM when the assertion reads an attribute — the poll can therefore spin for its whole timeout
 * against a React tree that has the update queued but not applied. Advancing real time inside
 * `act()` is what lets both the rAF callbacks and the passive effects run and commit.
 *
 * This bounds the wait without weakening the claim: the final assertion still runs, and still
 * fails, if the condition never becomes true.
 */
async function settleUntil(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { check(); return; } catch (err) {
      if (Date.now() >= deadline) throw err;
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

describe('viewer layer gating: packages that are not proven modern', () => {
  it('renders the pool overlay directly — no layered surface — when the package was never canaried', async () => {
    const { container } = await mountAndEnterSim(configWith({ package_class: null }));

    expect(layered(container)).toBeNull();
    const overlay = pool(container);
    expect(overlay).not.toBeNull();
    // Same parent it has always had. Re-parenting the pool is not cosmetic: it would unmount and
    // rebuild every resident simulation document the pool exists to keep warm.
    expect(overlay!.parentElement!.classList.contains('viewer-root')).toBe(true);
  });

  it('renders the pool overlay directly for a legacy-cooperative package', async () => {
    // `legacy-cooperative` is the BEST a v2 package can be classified: it acknowledges applies and
    // emits paints. It still never sends SECTION_PRESENTED, so it must never reach a surface whose
    // only route to visibility is one.
    const { container } = await mountAndEnterSim(configWith({ package_class: 'legacy-cooperative' }));

    expect(layered(container)).toBeNull();
    expect(pool(container)!.parentElement!.classList.contains('viewer-root')).toBe(true);
  });

  it('renders the pool overlay directly when the class is managed-presentable but the runtime is NOT modern', async () => {
    // The verdict alone is not enough. A canary-proven package whose document has not adopted a
    // port — a stale cached copy, a failed handshake, a transport that fell back to legacy — is
    // being driven over v2 right now, whatever it proved at publish time.
    h.modernActive.value = false;
    const { container } = await mountAndEnterSim(configWith({ package_class: 'managed-presentable' }));

    expect(layered(container)).toBeNull();
    expect(pool(container)!.parentElement!.classList.contains('viewer-root')).toBe(true);
  });

  it('never arms the modern path with anything below managed-presentable', async () => {
    await mountAndEnterSim(configWith({ package_class: 'legacy-cooperative' }));
    // The player arms unconditionally and the client refuses — so what is asserted here is that the
    // player passes the CONFIG's verdict through unaltered, rather than inventing a better one.
    expect(h.enableModernCalls.map((c) => c.packageClass)).toEqual(['legacy-cooperative']);
  });
});

// ── the modern path ───────────────────────────────────────────────────────────────────────────

describe('viewer layer gating: a proven modern package', () => {
  const modernConfig = () => configWith({ package_class: 'managed-presentable', poster_url: POSTER_URL });

  it('renders the layered surface ALONGSIDE the pool, never around it', async () => {
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(modernConfig());

    expect(layered(container)).not.toBeNull();
    // The pool is still mounted, and it is a SIBLING of the layered surface rather than a child.
    //
    // This is not a styling preference. React unmounts and rebuilds a subtree whose parent changes,
    // so a layered surface that wrapped the pool would destroy every warmed iframe each time
    // `simModern` flipped — which happens on every hand-back to video, and on every package change
    // in a mixed project. That is precisely the cost the resident pool exists to avoid.
    const poolEl = pool(container)!;
    expect(poolEl).not.toBeNull();
    expect(layered(container)!.contains(poolEl)).toBe(false);
    expect(poolEl.parentElement!.classList.contains('viewer-root')).toBe(true);
    // With the frame outside, the middle layer holds nothing — the cover composites over the pool.
    expect(incoming(container)!.querySelector('.sim-overlay')).toBeNull();
  });

  it('does NOT composite on the acknowledgement alone — the gate can still refuse after it', async () => {
    // The defect this pins: the client emits `modern-section-presented` BEFORE reveal() runs, and
    // reveal() can still refuse (context lost, package-revision or document mismatch). The viewer
    // used to set simPresented from that breadcrumb AND to ignore `modern-reveal-refused`
    // (it fell through to `default: return`), so poolVisible went true while the runtime's own
    // state.visible stayed false — a frame the gate had just rejected was composited at full
    // opacity for the rest of the section, with nothing to clear it.
    //
    // MUTATION SCOPE, stated honestly: this kills the ORIGINAL pair, not either half alone. The fix
    // has two parts — composite on the decision, and withdraw on refusal — and either one alone is
    // sufficient, so neither is individually observable. Reverting both together fails this test;
    // reverting one does not. Verified by mutation rather than assumed.
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(modernConfig());

    // Acknowledgement arrives, then the gate REFUSES. No 'reveal' event is emitted.
    await act(async () => {
      h.instances[0].emit('modern-section-presented', { frames: 1 });
      h.instances[0].emit('modern-reveal-refused', { refusal: 'package-revision-mismatch' });
    });

    expect(
      incoming(container)!.getAttribute('data-visibility'),
      'the viewer composited a frame the reveal gate refused',
    ).toBe('hidden');
    expect(pool(container)!.className, 'the pool overlay was made visible by a refused reveal')
      .not.toContain('visible');
  });

  it('keeps the SAME pool DOM node across a modern/legacy flip — the warm pool is never rebuilt', async () => {
    h.modernActive.value = true;
    const { container, leaveSimSection } = await mountAndEnterSim(modernConfig());
    const before = pool(container)!;
    expect(before).not.toBeNull();
    expect(layered(container)).not.toBeNull();

    // Hand back to video: `simModern` goes false and the layered surface unmounts.
    await leaveSimSection();
    const after = pool(container)!;

    // Node IDENTITY, not merely presence. A rebuilt pool would be a different element holding
    // freshly-created iframes, and every document warmed for the rest of the timeline would be gone.
    expect(after).toBe(before);
    expect(layered(container)).toBeNull();
  });

  it('holds the incoming frame hidden until the runtime reports PRESENTED', async () => {
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(modernConfig());

    expect(incoming(container)!.getAttribute('data-visibility')).toBe('hidden');
    expect(layered(container)!.getAttribute('data-reason')).toBe('awaiting-presentation-poster');
    // A hidden frame is out of the tab order and out of the a11y tree — a simulation the user
    // cannot see is a simulation the user must not be able to drive.
    expect(incoming(container)!.hasAttribute('inert')).toBe(true);

    // The one event that is allowed to authorise a reveal, arriving the way the real client sends
    // it. Nothing else in this test moves — no timer, no paint, no load.
    expect(h.instances).toHaveLength(1);
    await act(async () => {
      // The real client emits the acknowledgement breadcrumb FIRST and only then, if the reveal
      // gate allows it, emits 'reveal'. The gate can refuse in between (context lost, package
      // revision or document mismatch), which is why the viewer composites on the decision and
      // not on the acknowledgement. The mock must reproduce that order or it would assert a
      // contract the product does not have.
      h.instances[0].emit('modern-section-presented', { frames: 1 });
      h.instances[0].emit('reveal');
    });

    expect(incoming(container)!.getAttribute('data-visibility')).toBe('revealed');
    expect(layered(container)!.getAttribute('data-reason')).toBe('presented-live');
    expect(incoming(container)!.hasAttribute('inert')).toBe(false);
  });

  it('covers with the poster the backend resolved for this section', async () => {
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(modernConfig());

    const poster = container.querySelector('[data-testid="sim-poster"]') as HTMLImageElement;
    expect(poster).not.toBeNull();
    expect(poster.getAttribute('src')).toBe(POSTER_URL);
    expect(container.querySelector('[data-testid="sim-layer-cover"]')!.getAttribute('data-cover')).toBe('poster');
  });

  it('falls back to a neutral cover when the section has no poster', async () => {
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(configWith({ package_class: 'managed-presentable' }));

    const cover = container.querySelector('[data-testid="sim-layer-cover"]')!;
    expect(cover.getAttribute('data-cover')).toBe('neutral');
    expect(container.querySelector('[data-testid="sim-poster"]')).toBeNull();
    // Not a featureless black rectangle: the player's existing wait affordance fills the slot.
    expect(container.querySelector('[data-testid="sim-cover-fallback"] .sim-overlay-spinner')).not.toBeNull();
  });

  it('raises the recovery surface on a bounded modern failure, and clears it on retry', async () => {
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(modernConfig());
    // LET THE MOUNT FINISH BEFORE EMITTING. `revealSim` captures `warmGenRef` when it schedules and
    // drops the reveal if that generation moved by the time its double rAF runs
    // (useProjectPlayer.ts:838) — and nothing retries a dropped reveal. Emitting while the mount is
    // still settling let a warm-generation bump land inside that window, so the reveal was
    // discarded and `simPresented` never propagated: the observed failure was the poll timing out
    // with `reason=awaiting-presentation-poster`, ~1 in 12 full-suite runs and never in isolation.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    await act(async () => {
      // The real client emits the acknowledgement breadcrumb FIRST and only then, if the reveal
      // gate allows it, emits 'reveal'. The gate can refuse in between (context lost, package
      // revision or document mismatch), which is why the viewer composites on the decision and
      // not on the acknowledgement. The mock must reproduce that order or it would assert a
      // contract the product does not have.
      h.instances[0].emit('modern-section-presented', { frames: 1 });
      h.instances[0].emit('reveal');
    });

    await act(async () => { h.instances[0].emit('modern-failure', { kind: 'present-timeout' }); });
    // Same asynchronous route as every other assertion in this file: SimPresentationLayers
    // publishes its decision through a passive effect, so a synchronous read after `act` is a race.
    // Observed failing ~1 in 20 full-suite runs as `expected 'poster' to be 'recovery'` — the
    // intermediate branch, caught mid-propagation.
    await settleUntil(() => {
      expect(
          layered(container)!.getAttribute('data-layer'),
          `reason=${layered(container)?.getAttribute('data-reason')}`,
        ).toBe('recovery');
    });
    // A failure the viewer cannot leave is the one thing a failure surface must never be.
    expect(container.querySelector('[data-testid="sim-recovery"] button')).not.toBeNull();
    // And the frame it could not vouch for is off screen again.
    expect(incoming(container)!.getAttribute('data-visibility')).toBe('hidden');

    await act(async () => { h.instances[0].emit('modern-retry', { attempt: 2 }); });
    await settleUntil(() => {
      expect(layered(container)!.getAttribute('data-layer')).not.toBe('recovery');
    });
  });

  it('re-covers a presented frame whose rendering context was lost', async () => {
    h.modernActive.value = true;
    const { container } = await mountAndEnterSim(modernConfig());
    // LET THE MOUNT FINISH BEFORE EMITTING. `revealSim` captures `warmGenRef` when it schedules and
    // drops the reveal if that generation moved by the time its double rAF runs
    // (useProjectPlayer.ts:838) — and nothing retries a dropped reveal. Emitting while the mount is
    // still settling let a warm-generation bump land inside that window, so the reveal was
    // discarded and `simPresented` never propagated: the observed failure was the poll timing out
    // with `reason=awaiting-presentation-poster`, ~1 in 12 full-suite runs and never in isolation.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    await act(async () => {
      // The real client emits the acknowledgement breadcrumb FIRST and only then, if the reveal
      // gate allows it, emits 'reveal'. The gate can refuse in between (context lost, package
      // revision or document mismatch), which is why the viewer composites on the decision and
      // not on the acknowledgement. The mock must reproduce that order or it would assert a
      // contract the product does not have.
      h.instances[0].emit('modern-section-presented', { frames: 1 });
      h.instances[0].emit('reveal');
    });
    // AWAIT THE PIPELINE, DO NOT ASSUME IT SETTLED. `revealSim` schedules its merge behind a DOUBLE
    // rAF, and SimPresentationLayers publishes its decision through a passive effect — so the
    // attribute this asserts is reached asynchronously. Reading it immediately passed most of the
    // time and failed about twice in five full-suite runs, diagnosed by printing the policy branch:
    // `reason=awaiting-presentation-poster`, i.e. simPresented had not propagated yet.
    //
    // waitFor still FAILS if the frame is never revealed — it bounds the wait, it does not weaken
    // the assertion — and the exact policy branch is reported on timeout so a real regression is
    // diagnosable rather than a bare 'hidden'.
    await settleUntil(() => {
      expect(
          incoming(container)!.getAttribute('data-visibility'),
          `layer=${layered(container)?.getAttribute('data-layer')} reason=${layered(container)?.getAttribute('data-reason')}`,
        ).toBe('revealed');
    });

    await act(async () => { h.instances[0].emit('modern-context-lost'); });
    // AWAIT THE PIPELINE HERE TOO. The re-cover reaches the DOM by the same asynchronous route as
    // the reveal above — SimPresentationLayers publishes through a passive effect — so reading the
    // attribute after a fixed number of microtask turns is a race, not a settle. It failed roughly
    // 1 in 8 FULL-SUITE runs (never when the file ran alone, which is what makes it look like a
    // product bug rather than a test one) and was confirmed pre-existing by reproducing it on a
    // clean worktree at HEAD.
    //
    // waitFor bounds the wait without weakening the claim: if the frame is never re-covered this
    // still fails, and the policy branch is reported so a real regression stays diagnosable.
    await settleUntil(() => {
      expect(
          incoming(container)!.getAttribute('data-visibility'),
          `layer=${layered(container)?.getAttribute('data-layer')} reason=${layered(container)?.getAttribute('data-reason')}`,
        ).toBe('hidden');
    });
  });
});

// ── the two branches host the SAME pool ───────────────────────────────────────────────────────

describe('viewer layer gating: the pool overlay is the same in both branches', () => {
  it('renders identical pool markup whether or not the layered surface wraps it', async () => {
    const legacy = await mountAndEnterSim(configWith({ package_class: null }));
    const legacyPool = pool(legacy.container)!.outerHTML;
    cleanup();

    h.modernActive.value = true;
    h.instances.length = 0;
    const modern = await mountAndEnterSim(configWith({ package_class: 'managed-presentable' }));
    const modernPool = pool(modern.container)!.outerHTML;

    // Byte-identical: the two branches are handed ONE element with one set of props, so the only
    // difference between them is what surrounds the pool — never what the pool is told to do.
    expect(modernPool).toBe(legacyPool);
    // …and it really is the pooled package's frame, not an empty container that would make the
    // comparison above vacuous.
    expect(modernPool).toContain(packageKeyOf(SIM_URL));
  });
});
