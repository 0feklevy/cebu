/**
 * broll-player-001 — the player must consume config REVISIONS, and must apply them only at
 * shot boundaries.
 *
 * The audited defect: `onTick` is `useCallback(fn, [])`, frozen at mount, and the flat-overlay
 * updaters it calls (`updateBrollOverlay` / `updateAudioCutaway` / `updateImageOverlay`) plus the
 * prewarm scan all read `config.*` off the closed-over hook parameter. `ViewerPage` replaces the
 * config object post-mount (its fetch effect re-runs whenever the auth context hands it a new
 * `getIdToken` identity), so an editorial correction landed in React state and was then ignored
 * for the life of the session: the viewer played the clip list it fetched on first load, forever.
 *
 * The ruling this file encodes:
 *   • a new revision applies to FUTURE b-roll boundaries;
 *   • the CURRENTLY PLAYING clip is pinned until its OWN boundary — a correction can never flash
 *     or swap mid-shot;
 *   • the schedule and the prewarm plan come from ONE atomic revision and never drift apart.
 *
 * Everything drives the REAL `useProjectPlayer` through the REAL shell JSX with real `timeupdate`
 * ticks; only hls.js and `Audio` are doubled (jsdom has neither MediaSource nor playback).
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig } from '../components/viewer/types';

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

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

const B1 = { id: 'b1', hls_url: 'https://cdn.example.com/broll/b1.m3u8', global_offset_sec: 20, start_sec: 0, end_sec: 10, label: null, broll_volume: 1 };
const B2 = { id: 'b2', hls_url: 'https://cdn.example.com/broll/b2.m3u8', global_offset_sec: 40, start_sec: 0, end_sec: 10, label: null, broll_volume: 1 };

const B1_FIXED = { ...B1, hls_url: 'https://cdn.example.com/broll/b1-corrected.m3u8' };
const B2_FIXED = { ...B2, hls_url: 'https://cdn.example.com/broll/b2-corrected.m3u8' };
const CUT_A = { id: 'a1', audio_url: 'https://cdn.example.com/cut/a1.m4a', global_offset_sec: 12, start_sec: 0, end_sec: 4, label: null, broll_volume: 1 };

const base: PlayerConfig = {
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

/** Each revision is a NEW object, exactly as `setConfig(await r.json())` produces. */
const V1: PlayerConfig            = { ...base, broll_clips: [B1, B2] };
const V2_B1_CORRECTED: PlayerConfig = { ...base, broll_clips: [B1_FIXED, B2] };
const V2_B2_CORRECTED: PlayerConfig = { ...base, broll_clips: [B1, B2_FIXED] };
const V2_B1_DELETED: PlayerConfig   = { ...base, broll_clips: [B2] };
const V2_CUT_ADDED: PlayerConfig    = { ...base, broll_clips: [B1, B2], audio_cutaways: [CUT_A] };

// ── Audio double (jsdom has no playback; the cutaway lane constructs `new Audio(url)`) ────────

const audioUrls: string[] = [];
class FakeAudio {
  src: string;
  volume = 1;
  muted = false;
  currentTime = 0;
  paused = true;
  constructor(src?: string) { this.src = src ?? ''; audioUrls.push(this.src); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

beforeEach(() => {
  h.FakeHls.instances.length = 0;
  audioUrls.length = 0;
  Object.defineProperty(window, 'Audio', { configurable: true, writable: true, value: FakeAudio });
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

async function mountPlayer(initial: PlayerConfig = V1) {
  const view = render(<HLSPlayerShell config={initial} />);
  view.container.querySelectorAll('video').forEach((v) => {
    Object.defineProperty(v, 'play', { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(v, 'pause', { configurable: true, value: () => {} });
  });
  await act(async () => { await Promise.resolve(); });

  const videos = [...view.container.querySelectorAll('video')];
  const mainVideo = videos[0] as HTMLVideoElement;
  const brollSlots = videos.slice(2) as HTMLVideoElement[];
  const slotAt = (z: string) => brollSlots.find((v) => v.style.zIndex === z)!;

  const tickAt = async (gt: number) => {
    Object.defineProperty(mainVideo, 'currentTime', { configurable: true, get: () => gt });
    await act(async () => { mainVideo.dispatchEvent(new Event('timeupdate')); });
  };

  /** Hand the player a NEW config object, exactly as ViewerPage's `setConfig` does. */
  const publish = async (next: PlayerConfig) => {
    await act(async () => { view.rerender(<HLSPlayerShell config={next} />); });
  };

  const instanceOn = (el: HTMLMediaElement) =>
    h.FakeHls.instances.find((i) => i.media === el && !i.destroyed) ?? null;
  const liveUrls = () => h.FakeHls.instances.filter((i) => !i.destroyed).map((i) => i.url);
  const everLoaded = (url: string) => h.FakeHls.instances.some((i) => i.url === url);

  return { ...view, mainVideo, brollSlots, slotAt, tickAt, publish, instanceOn, liveUrls, everLoaded };
}

// ── 1. a new revision reaches a FUTURE boundary ───────────────────────────────────────────────

describe('a config revision published mid-session reaches future b-roll boundaries', () => {
  it('prewarms and plays the CORRECTED url for a clip that has not started yet', async () => {
    const { slotAt, tickAt, publish, instanceOn } = await mountPlayer(V1);
    const standbySlot0 = slotAt('-1');

    // t=5 already sits inside b1's 15s prewarm window, so the OLD url is warmed first — under
    // the revision that was current at the time, which is correct.
    await tickAt(5);
    const staleWarm = instanceOn(standbySlot0)!;
    expect(staleWarm.url).toBe(B1.hls_url);

    // The correction is published while nothing is on screen.
    await publish(V2_B1_CORRECTED);

    // t=10: the revision commits. `prewarmBroll` dedupes on clip ID, and the id did not change —
    // so without the standby reconciliation the warm buffer would keep the superseded media for
    // the whole session even though the schedule had moved on.
    await tickAt(10);
    expect(staleWarm.destroyed, 'the warm buffer from the superseded revision is discarded').toBe(true);
    const warm = instanceOn(standbySlot0);
    expect(warm, 'the standby is re-warmed').not.toBeNull();
    expect(warm!.url, 'prewarm reads the published revision, not the mount-time config').toBe(B1_FIXED.hls_url);

    // t=21: b1 goes live — the promoted instance carries the corrected url onto the screen.
    await tickAt(21);
    expect(instanceOn(slotAt('8'))!.url).toBe(B1_FIXED.hls_url);
  });

  it('an audio cutaway added by a later revision fires at its offset', async () => {
    const { tickAt, publish } = await mountPlayer(V1);

    await tickAt(5);
    await publish(V2_CUT_ADDED);

    // The cutaway lane reads the same committed revision as the b-roll lane.
    await tickAt(13);
    expect(audioUrls, 'the cutaway published mid-session must play').toContain(CUT_A.audio_url);
  });
});

// ── 2. the pin: the shot on screen is never disturbed ─────────────────────────────────────────

describe('the currently playing clip is pinned until its own boundary', () => {
  it('a revision that DELETES the live clip does not cut it off mid-shot', async () => {
    const { slotAt, tickAt, publish, instanceOn } = await mountPlayer(V1);
    const standbySlot0 = slotAt('-1');

    await tickAt(10);                     // warm b1
    await tickAt(21);                     // b1 live (standby promoted to z=8)
    const live = instanceOn(standbySlot0)!;
    expect(live.url).toBe(B1.hls_url);
    expect(standbySlot0.style.opacity, 'b1 is on screen').toBe('1');

    // An editor deletes b1 while it is on screen. The correction must NOT reach this shot.
    await publish(V2_B1_DELETED);
    await tickAt(23);
    await tickAt(25);
    await tickAt(29);

    expect(live.destroyed, 'the live clip is never torn down mid-shot').toBe(false);
    expect(standbySlot0.style.opacity, 'no flash to main video mid-shot').toBe('1');

    // ...and it ends at its OWN boundary (20 + 10), under the revision it started with.
    await tickAt(31);
    expect(standbySlot0.style.opacity, 'the pin releases at the shot boundary').toBe('0');
  });
});

// ── 3. schedule and prewarm plan share ONE revision ───────────────────────────────────────────

describe('the schedule and the prewarm plan never drift apart', () => {
  it('a standby warmed under the old revision is discarded when the new revision commits', async () => {
    const { slotAt, tickAt, publish, instanceOn, everLoaded } = await mountPlayer(V1);
    const activeSlot0  = slotAt('8');
    const standbySlot0 = slotAt('-1');

    await tickAt(10);                     // warm b1
    await tickAt(21);                     // b1 live; roles swapped
    await tickAt(26);                     // warm b2 (OLD url) into the demoted element
    const staleWarm = instanceOn(activeSlot0)!;
    expect(staleWarm.url).toBe(B2.hls_url);

    // b2 is corrected while b1 is still on screen: the revision is pinned, so the stale warm
    // survives for now — but it must not survive the commit.
    await publish(V2_B2_CORRECTED);
    await tickAt(28);
    expect(staleWarm.destroyed, 'still pinned while b1 plays').toBe(false);

    // t=31: b1 has ended, the revision commits — the standby it warmed is now for a shot that
    // will never play, so it is discarded and re-warmed from the committed revision.
    await tickAt(31);
    expect(staleWarm.destroyed, 'the stale standby is discarded at the commit').toBe(true);
    expect(everLoaded(B2_FIXED.hls_url), 'the standby is re-warmed from the committed revision').toBe(true);

    // t=41: b2 goes live with the corrected url.
    await tickAt(41);
    const nowLive = instanceOn(slotAt('8'));
    expect(nowLive, 'b2 is on screen').not.toBeNull();
    expect(nowLive!.url).toBe(B2_FIXED.hls_url);
    expect(standbySlot0).toBeTruthy();
  });
});
