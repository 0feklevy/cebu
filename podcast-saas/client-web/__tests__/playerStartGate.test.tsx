/**
 * P0.6 quick wins — the initial-play race, exercised through the REAL shell + hook.
 *
 * The audited defect family: `startPlayback` flipped `started` unconditionally, so
 *   • a click that landed before the async init (dynamic hls.js import → loadSource →
 *     attachMedia) had attached a source dropped the poster over a black, sourceless element;
 *   • a rejected `video.play()` (autoplay policy, interrupted load) was swallowed by
 *     `safePlay`, leaving `started: true` — poster gone, play button gone, black frame,
 *     nothing actionable on screen;
 *   • the thumbnail was keyed on `started` alone, so even a SUCCESSFUL start showed black
 *     between the click and the first presented frame (THUMB — interim fix here; the full
 *     rVFC first-frame gate is a later wave).
 *
 * What is real here: `useProjectPlayer`, `HLSPlayerShell`'s JSX, the readiness gate, the
 * pending-start queue and the `videoLive` latch. What is doubled: hls.js (jsdom has no media
 * pipeline — `isSupported: false` routes init down the native-src path, which still ends in
 * the readiness flush) and the media elements' play()/pause() stubs.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import type { PlayerConfig } from '../components/viewer/types';

vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: { ERROR: 'hlsError' } } }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
// next/link needs the App Router context the shell is not rendered inside here.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const THUMB_URL = 'https://cdn.example.com/thumbs/proj-1.jpg';

function makeConfig(over: Partial<PlayerConfig> = {}): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: THUMB_URL,
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: 60,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      // 'ready' with no VTT keeps the caption poller and the VTT fetch out of this test.
      captions: { status: 'ready', vtt_url: null },
      simulations: [],
    }],
    broll_clips: [],
    ...over,
  };
}

const playButton = (c: HTMLElement) => c.querySelector('[aria-label="Play video"]');
const thumbnail  = (c: HTMLElement) => c.querySelector('img');
const mainVideo  = (c: HTMLElement) => c.querySelector('video') as HTMLVideoElement;

/** jsdom's HTMLMediaElement.play()/pause() are "not implemented" — stub them per element. */
function stubMedia(c: HTMLElement, play: () => Promise<void> = () => Promise.resolve()) {
  c.querySelectorAll('video').forEach((v) => {
    Object.defineProperty(v, 'play', { configurable: true, value: play });
    Object.defineProperty(v, 'pause', { configurable: true, value: () => {} });
  });
}

/** Let the setup effect's dynamic hls.js import resolve and the readiness flush run. */
const flushInit = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
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
  vi.useRealTimers();
});

describe('the init-readiness gate (P0.6b)', () => {
  it('a click BEFORE init completes queues the start — poster and play button stay — and flushes on readiness', async () => {
    const { container } = render(<HLSPlayerShell config={makeConfig()} />);
    stubMedia(container);

    // No await since render: the dynamic import's microtask has NOT run yet, so this click
    // races the init exactly the way a fast viewer on a slow chunk does.
    fireEvent.click(playButton(container)!);

    // The gate must park the intent: nothing started, nothing dropped.
    expect(playButton(container), 'play button must survive a pre-ready click').not.toBeNull();
    expect(thumbnail(container), 'poster must survive a pre-ready click').not.toBeNull();

    // Init completes → the queued start flushes through the NORMAL path.
    await flushInit();
    expect(playButton(container), 'the queued start must fire once the source is attached').toBeNull();
  });

  it('a click after init behaves exactly as before the gate (started flips immediately)', async () => {
    const { container } = render(<HLSPlayerShell config={makeConfig()} />);
    stubMedia(container);
    await flushInit();

    fireEvent.click(playButton(container)!);
    expect(playButton(container), 'ready-path click starts immediately').toBeNull();
  });
});

describe('rejected play() reverts to an actionable state (P0.6c)', () => {
  it('restores the play button and keeps the poster when the browser refuses to play', async () => {
    const { container } = render(<HLSPlayerShell config={makeConfig()} />);
    stubMedia(container, () => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    await flushInit();

    await act(async () => {
      fireEvent.click(playButton(container)!);
      // Drain the rejection → safePlay(false) → revert merge.
      await Promise.resolve(); await Promise.resolve();
    });

    expect(playButton(container), 'a rejected play must bring the play button back').not.toBeNull();
    expect(thumbnail(container), 'the poster must still cover the (black) frame').not.toBeNull();
  });

  it('does NOT revert when the video is actually playing by the time the rejection settles', async () => {
    const { container } = render(<HLSPlayerShell config={makeConfig()} />);
    const video = mainVideo(container);
    stubMedia(container, () => Promise.reject(new DOMException('interrupted', 'AbortError')));
    // Another path (a second gesture) got it playing while the first promise settled.
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    await flushInit();

    await act(async () => {
      fireEvent.click(playButton(container)!);
      await Promise.resolve(); await Promise.resolve();
    });

    expect(playButton(container), 'a playing video must never get the poster slammed back over it').toBeNull();
  });
});

describe('the thumbnail hides on started && videoLive — never merely on the click (THUMB)', () => {
  it('covers the black gap between the click and the first "playing", then drops', async () => {
    const { container } = render(<HLSPlayerShell config={makeConfig()} />);
    stubMedia(container);
    const video = mainVideo(container);
    await flushInit();

    expect(thumbnail(container), 'poster up before the click').not.toBeNull();

    fireEvent.click(playButton(container)!);
    expect(playButton(container), 'the button itself gives immediate click feedback').toBeNull();
    expect(thumbnail(container), 'poster must OUTLIVE the click until frames actually present').not.toBeNull();

    await act(async () => { video.dispatchEvent(new Event('playing')); });
    expect(thumbnail(container), 'first "playing" drops the cover').toBeNull();

    // Later stall recoveries / seeks fire 'playing' again — the latch must not re-render churn
    // or resurrect the poster.
    await act(async () => { video.dispatchEvent(new Event('playing')); });
    expect(thumbnail(container)).toBeNull();
  });
});

describe('autoStart routes through readiness and paces AFTER it (P0.6d)', () => {
  it('never blind-fires its 600ms timer before init; the 600ms counts from readiness', async () => {
    vi.useFakeTimers();
    const { container } = render(<HLSPlayerShell config={makeConfig()} autoStart />);
    stubMedia(container);

    // Pre-readiness, today's blind `setTimeout(start, 600)` would have fired here.
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(playButton(container), 'no start may fire before the source is attached').not.toBeNull();

    // Init completes → the pacing timer is armed NOW (jsdom readyState is 0, so the
    // readyState>=2 fast path is not taken and the timer path is the one under test).
    await flushInit();
    expect(playButton(container), 'readiness alone does not start — pacing preserved').not.toBeNull();

    act(() => { vi.advanceTimersByTime(599); });
    expect(playButton(container), '600ms have not elapsed since readiness yet').not.toBeNull();

    act(() => { vi.advanceTimersByTime(1); });
    expect(playButton(container), 'starts 600ms after readiness').toBeNull();
  });
});
