/**
 * P0.8 — the browser capability floor, as the VIEWER actually applies it.
 *
 * WHAT IS BEING PROVEN
 * The flagship packages resolve `three` through `<script type="importmap">`. WebKit shipped import
 * maps in Safari/iOS 16.4, so on 16.3 and older those packages do not run slowly — the bare
 * specifier never resolves, no module evaluates, and NOTHING EVER PAINTS. Before this change the
 * viewer had no idea: it booted the iframe, waited, hit the bounded stall ceiling, force-revealed a
 * frame that can never announce a paint, and left the user looking at a blank rectangle for the
 * whole section. The presentation policy has had the right surface for this the entire time
 * (`posterOnlyMode` → `poster-only-device`) and no production caller had ever set it.
 *
 * THE REGRESSION THIS FILE EXISTS TO CATCH IS THE OPPOSITE ONE. A floor that fires on the browser
 * alone would replace a working simulation with a still image for every user on an older Safari,
 * including for the many packages that use no import map at all. So the trigger is the AND of two
 * facts, and all four combinations are asserted — the three that must do nothing are the point.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * Real: `useProjectPlayer`, the `HLSPlayerShell` JSX, `browserFloor`, `SimPresentationLayers` and
 * `decidePresentation`. Doubled: the SimRuntimeClient (it needs a cross-origin MessagePort
 * handshake jsdom cannot host) and `HTMLScriptElement.supports`, which is the one host fact the
 * floor reads and the only way to stand in for a 2022 iPad in a test runner.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import { FLOOR_MESSAGES } from '../lib/sim/browserFloor';
import type { PlayerConfig, SimulationOverlay } from '../components/viewer/types';

// ── doubles ───────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ modernActive: { value: false } }));

vi.mock('../lib/sim/SimRuntimeClient', () => {
  class FakeSimRuntimeClient {
    private state = {
      phase: 'mounting', documentKey: null, dynamic: null, ackCapable: null, ready: false,
      painted: false, currentScript: null, pendingScript: null, activationToken: 0, stopped: false,
      visible: false, muted: false, interactive: false, lastError: null,
    };
    getState() { return this.state; }
    modernActive() { return h.modernActive.value; }
    getModernState() {
      return {
        active: h.modernActive.value, documentState: 'READY', activationState: 'none',
        contextLost: false, failure: null, breakerOpen: false,
      };
    }
    enableModern() {}
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
      captions: { status: 'ready', vtt_url: null },
      simulations: [{
        id: 'sec-1',
        start_sec: 0,
        end_sec: 10,
        simulation_url: SIM_URL,
        simulation_id: 'sim-1',
        package_revision: 'rev-abcd',
        package_class: null,
        poster_url: POSTER_URL,
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

/** Stand in for the host browser. `undefined` removes `supports` entirely, as pre-16.4 WebKit does. */
function browserSupports(importMaps: boolean | undefined): void {
  const Script = HTMLScriptElement as unknown as { supports?: (t: string) => boolean };
  if (importMaps === undefined) { delete Script.supports; return; }
  Script.supports = (type: string) => type === 'importmap' && importMaps;
}

/** Mount and drive the real activation path into the section that opens the timeline. */
async function mountAndEnterSim(config: PlayerConfig) {
  const view = render(<HLSPlayerShell config={config} />);
  await act(async () => { await Promise.resolve(); });
  const video = view.container.querySelector('video') as HTMLVideoElement;
  await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
  return view;
}

const root = (c: HTMLElement) => c.querySelector('.viewer-root') as HTMLElement;
const layered = (c: HTMLElement) => c.querySelector('[data-testid="sim-presentation"]');
const poolOverlay = (c: HTMLElement) => c.querySelector('.sim-overlay') as HTMLElement;

let originalSupports: ((t: string) => boolean) | undefined;

beforeEach(() => {
  h.modernActive.value = false;
  originalSupports = (HTMLScriptElement as unknown as { supports?: (t: string) => boolean }).supports;
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

afterEach(() => {
  cleanup();
  const Script = HTMLScriptElement as unknown as { supports?: (t: string) => boolean };
  if (originalSupports) Script.supports = originalSupports; else delete Script.supports;
});

// ── the one combination that must degrade ─────────────────────────────────────────────────────

describe('a package that needs import maps, on a browser that has none', () => {
  it('covers the section with its poster instead of a frame that will never paint', async () => {
    browserSupports(undefined);                       // Safari/iOS 16.3 and older
    const { container } = await mountAndEnterSim(configWith({ requires_import_maps: true }));

    const surface = layered(container);
    expect(surface, 'the layered surface must mount even off the modern path').not.toBeNull();
    // The EXACT policy branch, not merely "a poster is showing". `poster-only-device` is the one
    // that says nothing is broken and no live frame will be attempted — distinct from a failure,
    // which would put the recovery surface up and offer a retry that cannot help.
    expect(surface!.getAttribute('data-reason')).toBe('poster-only-device');
    expect(surface!.getAttribute('data-layer')).toBe('poster');
    expect(container.querySelector('[data-testid="sim-poster"]')!.getAttribute('src')).toBe(POSTER_URL);
  });

  it('never composites the blank frame — not even past the terminal stall bound', async () => {
    // THE DEFECT IN ITS ORIGINAL FORM, and it needs the clock to reach it. On the legacy path the
    // reveal is paint-gated, but the TERMINAL bound (SIM_BOOT_STALLED_MS, 5 s) exists precisely for
    // documents that can never announce a paint and force-reveals them best-effort — which is
    // exactly this package. Without the floor short-circuit the user gets the empty iframe over the
    // video five seconds into the section and keeps it for the rest of it.
    vi.useFakeTimers();
    try {
      browserSupports(undefined);
      const { container } = await mountAndEnterSim(configWith({ requires_import_maps: true }));
      expect(poolOverlay(container).classList.contains('visible')).toBe(false);

      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(
        poolOverlay(container).classList.contains('visible'),
        'the terminal stall bound composited a frame that can never paint',
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the missing CAPABILITY in the DOM, not a browser or a device', async () => {
    browserSupports(undefined);
    const { container } = await mountAndEnterSim(configWith({ requires_import_maps: true }));
    expect(root(container).getAttribute('data-sim-floor')).toBe('import-maps');
  });

  it('says why, rather than spinning forever, when the section has no poster', async () => {
    // With a poster the still image IS the explanation. Without one the cover would otherwise be a
    // spinner over a black rectangle, promising a frame that cannot arrive for the rest of the
    // section — the exact lie this finding is about.
    browserSupports(undefined);
    const { container } = await mountAndEnterSim(
      configWith({ requires_import_maps: true, poster_url: null }),
    );

    const notice = container.querySelector('[data-testid="sim-floor-notice"]');
    expect(notice, 'no honest cue where the spinner used to be').not.toBeNull();
    expect(notice!.textContent).toBe(FLOOR_MESSAGES['import-maps']);
    expect(container.querySelector('.sim-overlay-spinner'), 'the endless spinner is still there').toBeNull();
  });

  it('forgets the requirement when the section is left', async () => {
    // The requirement describes ONE package. A cover that outlived its section would sit over the
    // video for the rest of the project.
    browserSupports(undefined);
    const { container } = await mountAndEnterSim(configWith({ requires_import_maps: true }));
    expect(root(container).getAttribute('data-sim-floor')).toBe('import-maps');

    const video = container.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 20 });
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });

    expect(root(container).getAttribute('data-sim-floor')).toBeNull();
    expect(layered(container)).toBeNull();
  });
});

// ── the three that must change NOTHING ────────────────────────────────────────────────────────
//
// A blanket downgrade is the regression that matters. Each of these is a real population: packages
// with no import map (most of them), packages published before detection existed (all of them, on
// the day the migration lands), and every modern browser (nearly all traffic).

describe('every other combination leaves the package exactly as it was', () => {
  const unaffected = async (over: Partial<SimulationOverlay>, supports: boolean | undefined) => {
    browserSupports(supports);
    const { container } = await mountAndEnterSim(configWith(over));
    expect(layered(container), 'a layered cover appeared for a package that can run').toBeNull();
    expect(root(container).getAttribute('data-sim-floor')).toBeNull();
    expect(container.querySelector('[data-testid="sim-floor-notice"]')).toBeNull();
    return container;
  };

  it('requires import maps + a browser that HAS them → untouched', async () => {
    await unaffected({ requires_import_maps: true }, true);
  });

  it('recorded as NOT requiring them + a browser without them → untouched', async () => {
    // The package that would have run perfectly well on that iPad. Degrading it is a self-inflicted
    // outage for a capability it never uses.
    await unaffected({ requires_import_maps: false }, undefined);
  });

  it('UNKNOWN requirement + a browser without them → untouched', async () => {
    // Every package published before P0.8 detection existed. Unknown is not "yes": treating it as a
    // requirement would poster the entire back catalogue on older browsers in a single deploy.
    await unaffected({ requires_import_maps: null }, undefined);
    cleanup();
    await unaffected({}, undefined);   // field absent entirely, e.g. an older backend
  });

  it('is not fooled by a `supports` that answers with something other than a boolean', async () => {
    // A polyfill or an extension can leave a `supports` that returns a truthy non-boolean. The
    // detector demands `=== true`, so this browser counts as lacking the feature — and the package
    // that needs import maps is therefore covered.
    (HTMLScriptElement as unknown as { supports: (t: string) => unknown }).supports = () => 'yes';
    const { container } = await mountAndEnterSim(configWith({ requires_import_maps: true }));
    expect(root(container).getAttribute('data-sim-floor')).toBe('import-maps');
  });
});
