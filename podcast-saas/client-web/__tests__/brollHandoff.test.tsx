/**
 * P0.7 — the warm b-roll handoff must PROMOTE the standby, never "transfer" it.
 *
 * The audited defect: `activateBrollClip` moved the prewarmed hls.js instance onto the active
 * element with `detachMedia()` → `attachMedia(brollEl)`. In hls.js (1.6.x), `detachMedia()`
 * ends the MediaSource and drops every SourceBuffer — so the instance that spent 15s warming
 * arrived on screen cold anyway, and the standby element's buffered frames were thrown away.
 *
 * The fix mirrors the main path's `swapVideos()`: the standby element is promoted in place
 * (z-order + refs swap; nothing reparents, nothing detaches) and the outgoing instance is
 * destroyed on the element it owns, which becomes the next prewarm slot.
 *
 * Everything here drives the REAL `useProjectPlayer` through the REAL shell JSX with real
 * `timeupdate` ticks; only hls.js itself is doubled (jsdom has no MediaSource), with a double
 * that records exactly the calls whose absence/presence IS the invariant.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig } from '../components/viewer/types';

// ── the hls.js double ─────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  class FakeHls {
    static instances: FakeHls[] = [];
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any;
    url: string | null = null;
    media: HTMLMediaElement | null = null;
    destroyed = false;
    detachCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers = new Map<string, any[]>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(cfg: any) { this.config = { ...cfg }; FakeHls.instances.push(this); }
    loadSource(u: string) { this.url = u; }
    attachMedia(el: HTMLMediaElement) { this.media = el; }
    detachMedia() { this.detachCount++; this.media = null; }
    stopLoad() {}
    startLoad() {}
    destroy() { this.destroyed = true; }
    recoverMediaError() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(ev: string, fn: any) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(ev: string, fn: any) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((f) => f !== fn)); }
  }
  return { FakeHls };
});

vi.mock('hls.js', () => ({ default: h.FakeHls }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

// ── fixture: two b-roll clips, far enough apart that each is prewarmed in its own window ──────

const B1 = { id: 'b1', hls_url: 'https://cdn.example.com/broll/b1.m3u8', global_offset_sec: 20, start_sec: 0, end_sec: 10, label: null, broll_volume: 1 };
const B2 = { id: 'b2', hls_url: 'https://cdn.example.com/broll/b2.m3u8', global_offset_sec: 40, start_sec: 0, end_sec: 10, label: null, broll_volume: 1 };

const CONFIG: PlayerConfig = {
  project_id: 'proj-1',
  title: 'T',
  description: null,
  thumbnail_url: null,
  segments: [{
    id: 'vid-1',
    label: 'v.mp4',
    duration_sec: 60,
    hls_url: 'https://cdn.example.com/hls/master.m3u8',
    fallback_url: 'https://cdn.example.com/hls/fallback.mp4',
    hls_status: 'ready',
    captions: { status: 'ready', vtt_url: null },
    simulations: [],
  }],
  broll_clips: [B1, B2],
};

beforeEach(() => {
  h.FakeHls.instances.length = 0;
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
afterEach(cleanup);

async function mountPlayer() {
  const view = render(<HLSPlayerShell config={CONFIG} />);
  // jsdom's play()/pause() are "not implemented" — stub them on every media element.
  view.container.querySelectorAll('video').forEach((v) => {
    Object.defineProperty(v, 'play', { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(v, 'pause', { configurable: true, value: () => {} });
  });
  // Let the setup effect's dynamic hls.js import resolve (main video instances get built).
  await act(async () => { await Promise.resolve(); });

  const videos = [...view.container.querySelectorAll('video')];
  const mainVideo = videos[0] as HTMLVideoElement;             // videoA — the tick source
  const brollSlots = videos.slice(2) as HTMLVideoElement[];    // the two b-roll slots
  const slotAt = (z: string) => brollSlots.find((v) => v.style.zIndex === z)!;

  const tickAt = async (gt: number) => {
    Object.defineProperty(mainVideo, 'currentTime', { configurable: true, get: () => gt });
    await act(async () => { mainVideo.dispatchEvent(new Event('timeupdate')); });
  };

  /** The b-roll instance attached to `el` (there is at most one live per element). */
  const instanceOn = (el: HTMLMediaElement) =>
    h.FakeHls.instances.find((i) => i.media === el && !i.destroyed) ?? null;

  return { ...view, mainVideo, brollSlots, slotAt, tickAt, instanceOn };
}

describe('warm b-roll activation promotes the standby in place (P0.7)', () => {
  it('the prewarmed instance is NEVER detached, keeps its element, and the slots swap roles', async () => {
    const { slotAt, tickAt, instanceOn } = await mountPlayer();

    const activeSlot0  = slotAt('8');
    const standbySlot0 = slotAt('-1');
    expect(activeSlot0, 'shell renders one active and one standby b-roll slot').toBeTruthy();
    expect(standbySlot0).toBeTruthy();

    // t=10: b1 (at 20s) is inside the 15s prewarm window → a standby instance warms IN the
    // standby element.
    await tickAt(10);
    const warm = instanceOn(standbySlot0);
    expect(warm, 'prewarm must buffer into the standby element').not.toBeNull();
    expect(warm!.url).toBe(B1.hls_url);
    expect(warm!.config.maxBufferLength, 'prewarm uses the standby budget').toBe(20);

    // t=21: b1 is live → the warm standby must be PROMOTED, not transferred.
    await tickAt(21);

    // The invariant the audit found violated: detachMedia() would have ended the MediaSource
    // and dropped every SourceBuffer — the "warm" instance arrived cold.
    expect(warm!.detachCount, 'the promoted instance must never be detached').toBe(0);
    expect(warm!.media, 'the promoted instance keeps the element it buffered into').toBe(standbySlot0);
    expect(warm!.destroyed).toBe(false);

    // Role swap, exactly like the main path's swapVideos(): the element that warmed is now on
    // top; the old active element became the (hidden) standby slot for the next prewarm.
    expect(standbySlot0.style.zIndex).toBe('8');
    expect(activeSlot0.style.zIndex).toBe('-1');
    // And the shell's state-bound opacity tracks the PROMOTED element (both slots bind it).
    expect(standbySlot0.style.opacity, 'the promoted slot is the visible overlay').toBe('1');

    // Promotion re-applies the ACTIVE buffer budget (standby warmed with 20s).
    expect(warm!.config.maxBufferLength).toBe(10);
    // The active overlay must have fatal-error recovery (prewarm never attached one).
    expect(warm!.handlers.get('hlsError')?.length ?? 0, 'promoted instance gets fatal recovery').toBeGreaterThan(0);
  });

  it('the next prewarm reuses the demoted element and the stale outgoing instance is destroyed cleanly', async () => {
    const { slotAt, tickAt, instanceOn } = await mountPlayer();
    const activeSlot0  = slotAt('8');
    const standbySlot0 = slotAt('-1');

    await tickAt(10);                       // prewarm b1 into standbySlot0
    const first = instanceOn(standbySlot0)!;
    await tickAt(21);                       // promote b1 (roles swapped)

    // t=26: b2 (at 40s) enters the prewarm window → it must warm into the DEMOTED element
    // (the old active slot), never touching the instance that was just promoted.
    await tickAt(26);
    const second = instanceOn(activeSlot0);
    expect(second, 'prewarm after a promotion lands on the demoted element').not.toBeNull();
    expect(second!.url).toBe(B2.hls_url);
    expect(first.detachCount, 'prewarming the NEXT clip must not disturb the live one').toBe(0);
    expect(first.destroyed).toBe(false);

    // t=41: b2 is live → second promotion. The outgoing (b1) instance is stale — destroyed on
    // the element it owns — and the roles swap back.
    await tickAt(41);
    expect(second!.detachCount, 'second promotion: still no detach anywhere').toBe(0);
    expect(second!.media).toBe(activeSlot0);
    expect(first.destroyed, 'the finished clip’s instance is destroyed, not leaked').toBe(true);
    expect(activeSlot0.style.zIndex).toBe('8');
    expect(standbySlot0.style.zIndex).toBe('-1');
  });

  it('a clip with NO warm standby still takes the cold path (fresh instance on the active slot)', async () => {
    const { slotAt, tickAt, instanceOn } = await mountPlayer();
    const activeSlot0 = slotAt('8');

    // Jump straight into b1 with no prewarm tick beforehand: cold activation.
    await tickAt(21);
    const cold = instanceOn(activeSlot0);
    expect(cold, 'cold path streams on the active element').not.toBeNull();
    expect(cold!.url).toBe(B1.hls_url);
    expect(cold!.config.maxBufferLength, 'cold path uses the active budget').toBe(10);
    // No promotion happened — roles unchanged.
    expect(activeSlot0.style.zIndex).toBe('8');
  });
});
