/**
 * AVATAR STARTUP COST — the two things the connect path spends before it can spend
 * anything useful. Both were measured before being touched; the numbers are in
 * components/avatar/anamSdk.ts and in the comment above the prime in
 * AvatarConversation.tsx.
 *
 * (a) THE "OPUS PRE-WARM". A 150ms unconditional sleep sat in front of every
 *     connect, justified as warming the OPUS decoder. It cannot do that: the
 *     oscillator feeds a WebAudio MediaStreamDestination, whose track is raw PCM
 *     that never touches a codec, while Anam's audio is decoded inside the
 *     RTCPeerConnection — a pipeline the media element's decoder is not part of.
 *     The AudioContext opened here is closed again before the session starts, and
 *     @anam-ai/js-sdk 4.15.0 never constructs one. What the block DOES do is call
 *     play() on the real <video> element while the click that opened the popup is
 *     still user activation, which is what keeps the SDK's later srcObject +
 *     native autoPlay from being refused. That part is load-bearing and is kept
 *     and asserted here. The sleep is not: nothing observes it — `await play()`
 *     has already resolved by then — so it was 150ms of dead serial latency.
 *
 * (b) THE STATIC SDK IMPORT. `import { createClient } from '@anam-ai/js-sdk'` in
 *     AvatarConversation put the SDK in the static graph of every public viewer
 *     route. Measured: 91,660 B minified / 23,105 B gzipped for
 *     `import { createClient, AnamEvent }` (esbuild, minify, es2022), of which
 *     27,531 B minified is the `buffer` npm polyfill the SDK pulls in for a single
 *     base64 decode. In the checked-in Next build that is
 *     .next/static/chunks/385-*.js — 89,856 B raw / 22,506 B gzipped — listed in
 *     app-build-manifest.json for /[slug], /v/[shareToken], /pl/[shareToken],
 *     /c/[courseSlug]/[lessonSlug], /projects/[id]/view and /playlists/[id]/view.
 *     Every viewer downloaded, parsed and compiled it; only the ones who click
 *     "Ask!" ever call it. So it is split — and preloaded on hover/focus and on
 *     popup-open so click-to-first-frame does not pay for the split.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';

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
    /** How many times the SDK module body has been evaluated. 0 == not in the static graph. */
    evaluated: 0,
    listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    /** Ordered log of the startup steps the tests care about. */
    order: [] as string[],
    streamCalls: [] as string[],
  };
  return { AnamEvent, state };
});

vi.mock('@anam-ai/js-sdk', () => {
  anam.state.evaluated += 1;
  return {
    AnamEvent: anam.AnamEvent,
    createClient: () => ({
      addListener: (ev: string, fn: (...a: unknown[]) => void) => {
        const list = anam.state.listeners.get(ev) ?? [];
        list.push(fn);
        anam.state.listeners.set(ev, list);
      },
      streamToVideoElement: async (id: string) => {
        anam.state.order.push('streamToVideoElement');
        anam.state.streamCalls.push(id);
      },
      stopStreaming: async () => {},
      muteInputAudio: () => {},
      unmuteInputAudio: () => {},
    }),
  };
});

const api = vi.hoisted(() => ({ startCalls: 0 }));
vi.mock('../components/avatar/avatarApi', () => ({
  startAvatarSession: vi.fn(async () => { api.startCalls += 1; return { provider: 'anam', sessionToken: 'tok', characterId: 'einstein' }; }),
  endAvatarSession: vi.fn(),
  analyzeVisual: vi.fn(async () => ({ type: 'none' })),
  analyzeImage: vi.fn(async () => ({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' })),
  getMemory: vi.fn(async () => ({ token: null, turns: [], profile: {} })),
  saveMemory: vi.fn(),
}));

import { AvatarConversation } from '../components/avatar/AvatarConversation';
import { AskAvatarButton } from '../components/avatar/AskAvatarButton';

/**
 * Captured at collection time, AFTER the imports above have been evaluated, so this
 * assertion is independent of the order the tests run in. Importing the avatar UI
 * must not drag the SDK in with it.
 */
const evaluatedAfterStaticImports = anam.state.evaluated;

class FakeAudioContext {
  static closed = 0;
  resume = async () => {};
  createMediaStreamDestination = () => ({ stream: { id: 'silent' } as unknown as MediaStream });
  createOscillator = () => ({ connect: () => {}, start: () => {}, stop: () => {} });
  createGain = () => ({ gain: { setValueAtTime: () => {} }, connect: () => {} });
  close = () => { FakeAudioContext.closed += 1; };
}

let srcObjectLog: unknown[] = [];
const flush = async () => {
  await act(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); });
};

describe('AvatarConversation — startup cost', () => {
  beforeEach(() => {
    anam.state.listeners.clear();
    anam.state.order = [];
    anam.state.streamCalls = [];
    api.startCalls = 0;
    srcObjectLog = [];
    FakeAudioContext.closed = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get(this: { __src?: unknown }) { return this.__src ?? null; },
      set(this: { __src?: unknown }, v: unknown) { this.__src = v; srcObjectLog.push(v); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: function (this: HTMLMediaElement) {
        anam.state.order.push('play');
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  // FIRST, deliberately: the SDK module is evaluated at most once per file, so this is
  // the only place the 0 -> 1 transition caused by a preload can be observed.
  it('preloads the SDK chunk on hover, without minting anything', async () => {
    const { getByRole } = render(<AskAvatarButton onClick={() => {}} />);
    expect(anam.state.evaluated).toBe(0);

    fireEvent.mouseEnter(getByRole('button'));
    await flush();

    expect(anam.state.evaluated).toBe(1);
    // Hover warms a static chunk. It must never reach the billable mint.
    expect(api.startCalls).toBe(0);
  });

  it('does not park the connect behind a fixed pre-warm sleep', async () => {
    // No timer is ever advanced. If the connect still needs a wall-clock delay to
    // finish, streamToVideoElement never runs and this fails.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();

    expect(anam.state.streamCalls).toEqual(['anam-avatar-video']);
  });

  it('still primes the real avatar element for autoplay before the SDK attaches, then releases it', async () => {
    // The load-bearing half of the old "OPUS pre-warm": play() on the actual
    // element while the opening click is still user activation.
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();

    expect(anam.state.order.indexOf('play')).toBeGreaterThanOrEqual(0);
    expect(anam.state.order.indexOf('play')).toBeLessThan(anam.state.order.indexOf('streamToVideoElement'));
    // The silent source is handed back before the SDK attaches the real stream.
    expect(srcObjectLog).toEqual([{ id: 'silent' }, null]);
    expect(FakeAudioContext.closed).toBe(1);
  });

  it('keeps the Anam SDK out of the viewer surface\'s static import graph', () => {
    expect(evaluatedAfterStaticImports).toBe(0);
  });

  it('loads the SDK when the conversation actually connects', async () => {
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();

    expect(anam.state.evaluated).toBeGreaterThan(0);
    expect(anam.state.streamCalls).toEqual(['anam-avatar-video']);
  });

  it('preloads on focus too — a keyboard user gets the same warm chunk', async () => {
    const { getByRole } = render(<AskAvatarButton onClick={() => {}} variant="pill" />);
    fireEvent.focus(getByRole('button'));
    await flush();

    expect(anam.state.evaluated).toBeGreaterThan(0);
    expect(api.startCalls).toBe(0);
  });
});
