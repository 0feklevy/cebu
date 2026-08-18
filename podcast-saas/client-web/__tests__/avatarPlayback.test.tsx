/**
 * AVATAR STARTUP: AUDIBLE PLAYBACK, AND A SPINNER THAT CLEARS ON EVIDENCE.
 *
 * Two invariants, both about the same 20 lines of AvatarConversation:
 *
 * 1. NOBODY EVER CALLS play(). @anam-ai/js-sdk 4.15.0 has exactly one srcObject
 *    assignment (modules/StreamingClient.js:491) and zero occurrences of `.play(`
 *    in the whole package — it attaches the MediaStream and leaves playback to the
 *    element's native `autoPlay`. The element is `autoPlay playsInline` with NO
 *    `muted`, so a browser autoplay policy rejects it silently: no error, no event,
 *    no console line. The viewer gets a frozen frame and no audio. So the component
 *    must attempt playback itself, and when the attempt is refused with
 *    NotAllowedError it must fall back to MUTED playback (video at least moves) and
 *    offer a gesture control that restores audio. Muted is a fallback, never a
 *    destination.
 *
 * 2. THE SPINNER MUST CLEAR ON EVIDENCE, NOT ON A CLOCK.
 *    `VIDEO_STREAM_STARTED -> setTimeout(() => setVideoStarted(true), 2000)` fired
 *    on "a track was attached", which is emitted (StreamingClient.js:489) BEFORE
 *    srcObject is even assigned and says nothing about whether a frame was ever
 *    presented. In the autoplay-blocked case that hid the spinner over a frozen
 *    first frame after a flat 2s, which is exactly the shape of the user's
 *    "it starts and then just sits there" report. Evidence is the `playing` event
 *    or a requestVideoFrameCallback presentation. The 20s watchdog stays as the
 *    bounded failure path so a genuinely dead stream still surfaces an error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';

const anam = vi.hoisted(() => {
  const AnamEvent = {
    MESSAGE_HISTORY_UPDATED: 'MESSAGE_HISTORY_UPDATED',
    MESSAGE_STREAM_EVENT_RECEIVED: 'MESSAGE_STREAM_EVENT_RECEIVED',
    CONNECTION_ESTABLISHED: 'CONNECTION_ESTABLISHED',
    CONNECTION_CLOSED: 'CONNECTION_CLOSED',
    VIDEO_STREAM_STARTED: 'VIDEO_STREAM_STARTED',
    VIDEO_PLAY_STARTED: 'VIDEO_PLAY_STARTED',
    AUDIO_STREAM_STARTED: 'AUDIO_STREAM_STARTED',
    SERVER_WARNING: 'SERVER_WARNING',
    MIC_PERMISSION_DENIED: 'MIC_PERMISSION_DENIED',
  };
  const state = {
    listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    streamCalls: [] as string[],
  };
  return { AnamEvent, state };
});

vi.mock('@anam-ai/js-sdk', () => ({
  AnamEvent: anam.AnamEvent,
  createClient: () => ({
    addListener: (ev: string, fn: (...a: unknown[]) => void) => {
      const list = anam.state.listeners.get(ev) ?? [];
      list.push(fn);
      anam.state.listeners.set(ev, list);
    },
    streamToVideoElement: async (id: string) => { anam.state.streamCalls.push(id); },
    stopStreaming: async () => {},
    muteInputAudio: () => {},
    unmuteInputAudio: () => {},
  }),
}));

vi.mock('../components/avatar/avatarApi', () => ({
  startAvatarSession: vi.fn(async () => ({ provider: 'anam', sessionToken: 'tok', characterId: 'einstein' })),
  endAvatarSession: vi.fn(),
  analyzeVisual: vi.fn(async () => ({ type: 'none' })),
  analyzeImage: vi.fn(async () => ({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' })),
  getMemory: vi.fn(async () => ({ token: null, turns: [], profile: {} })),
  saveMemory: vi.fn(),
}));

import { AvatarConversation } from '../components/avatar/AvatarConversation';

/** What the browser's autoplay policy does to a play() call in a given test. */
type Policy = 'allow' | 'block-unmuted' | 'block-all';

let policy: Policy = 'allow';
/** `muted` state of the element at each play() attempt, in order. */
let playAttempts: boolean[] = [];

const videoEl = () => document.getElementById('anam-avatar-video') as HTMLVideoElement;
const emit = (ev: string, ...args: unknown[]) => {
  (anam.state.listeners.get(ev) ?? []).forEach((fn) => fn(...args));
};
/** Let queued microtasks (and the component's deferred play attempt) run. */
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const spinnerVisible = () => document.querySelector('.avatar-waiting-overlay') !== null;

describe('AvatarConversation — audible playback and evidence-based spinner', () => {
  beforeEach(() => {
    policy = 'allow';
    playAttempts = [];
    anam.state.listeners.clear();
    anam.state.streamCalls = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: function (this: HTMLMediaElement) {
        playAttempts.push(this.muted);
        const blocked = policy === 'block-all' || (policy === 'block-unmuted' && !this.muted);
        if (blocked) return Promise.reject(new DOMException('play() failed: autoplay policy', 'NotAllowedError'));
        // A real browser fires `playing` when playback actually begins, before the
        // play() promise settles.
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const mount = async () => {
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    // The prime (see AvatarConversation) plays the element before connecting; only
    // attempts made against the REAL stream are under test here.
    playAttempts = [];
  };

  it('explicitly attempts UNMUTED playback once the real stream is attached', async () => {
    await mount();
    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();

    expect(playAttempts).toContain(false);
    expect(videoEl().muted).toBe(false);
  });

  it('falls back to MUTED playback when autoplay is refused, and offers a control that restores audio', async () => {
    policy = 'block-unmuted';
    await mount();
    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();

    // Unmuted first, muted only as the fallback.
    expect(playAttempts).toEqual([false, true]);
    expect(videoEl().muted).toBe(true);

    // The viewer is not stranded in silence: a real control is offered.
    const enable = screen.getByRole('button', { name: /sound|audio/i });

    // Clicking it is a user gesture, so the policy now permits audio.
    policy = 'allow';
    await act(async () => { fireEvent.click(enable); });
    await flush();

    expect(videoEl().muted).toBe(false);
    expect(screen.queryByRole('button', { name: /sound|audio/i })).toBeNull();
  });

  it('does not render the enable-audio control when audio played on the first attempt', async () => {
    await mount();
    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();

    expect(videoEl().muted).toBe(false);
    expect(screen.queryByRole('button', { name: /sound|audio/i })).toBeNull();
  });

  it('clears the spinner on the element\'s `playing` event, with no timer advanced', async () => {
    // Nothing plays on its own here, so `playing` is the only evidence in the test —
    // which is the point: the spinner tracks presentation, not the play() call.
    policy = 'block-all';
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await mount();
    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();
    expect(spinnerVisible()).toBe(true);

    await act(async () => { videoEl().dispatchEvent(new Event('playing')); });
    expect(spinnerVisible()).toBe(false);
  });

  it('clears the spinner on a requestVideoFrameCallback presentation', async () => {
    policy = 'block-all';
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const frameCallbacks: Array<() => void> = [];
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    const el = videoEl();
    // jsdom implements neither half; define them so a presented frame can be simulated.
    Object.defineProperty(el, 'requestVideoFrameCallback', {
      configurable: true,
      value: (cb: () => void) => { frameCallbacks.push(cb); return frameCallbacks.length; },
    });
    Object.defineProperty(el, 'cancelVideoFrameCallback', { configurable: true, value: () => {} });

    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();
    expect(frameCallbacks.length).toBeGreaterThan(0);
    expect(spinnerVisible()).toBe(true);

    await act(async () => { frameCallbacks.forEach((cb) => cb()); });
    expect(spinnerVisible()).toBe(false);
  });

  it('keeps the spinner up over a frozen stream — a track attaching is not a frame', async () => {
    // Fully blocked: the track attached, nothing is being presented, nothing plays.
    policy = 'block-all';
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await mount();
    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(spinnerVisible()).toBe(true);
    expect(screen.queryByText(/⚠/)).toBeNull();
  });

  it('still surfaces an error rather than spinning forever when no frame ever arrives', async () => {
    policy = 'block-all';
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await mount();
    emit(anam.AnamEvent.VIDEO_STREAM_STARTED, {});
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
    expect(screen.getByText(/⚠/)).toBeTruthy();
  });
});
