/**
 * THE CLIENT HALF OF THE AVATAR CONNECT: WHAT IT SPENDS, WHAT IT SAYS, AND WHAT IT
 * CAN PROVE.
 *
 * Four invariants, all about the span between the "Ask!" click and the first frame —
 * the slowest path in the product and, until now, the only one with no instrumentation
 * at either end of it.
 *
 * 1. A DELIBERATE SESSION-START POLICY. `sdk.createClient(token, {...})` used to pass
 *    `voiceDetection` and nothing else, which left the vendor's own defaults in force:
 *    @anam-ai/js-sdk 4.15.0 lib/constants.js sets DEFAULT_START_SESSION_MAX_ATTEMPTS = 3
 *    and DEFAULT_START_SESSION_REQUEST_TIMEOUT_MS = 10000, and
 *    CoreApiRestClient.isRetryableError treats EVERY 5xx as retryable — including the
 *    vendor's own 503 "There are no available personas". So a busy vendor silently costs
 *    two extra POST /v1/engine/session round trips plus backoff, and a hung endpoint
 *    costs 3 x 10s + backoff. The numbers below are read out of the vendored package at
 *    test time, so this suite cannot drift away from the SDK it is reasoning about.
 *
 * 2. THE WATCHDOG MUST OUTLAST THE SDK. With the vendor defaults the SDK's worst case
 *    (30.75s) is LONGER than the component's 20s connection watchdog, so on a hung
 *    endpoint the watchdog always won the race and the SDK's real error never reached
 *    the screen. The invariant asserted here is ordering, not a magic number: whatever
 *    policy the component passes, its worst case must elapse strictly inside the
 *    watchdog, so the vendor's own diagnosis is what the viewer sees.
 *
 * 3. THE WATCHDOG MUST NOT INVENT A CAUSE. Its message named "an active session still
 *    holding your concurrency slot" — a diagnosis the client cannot make and which the
 *    reconciliation refuted. A genuine concurrency failure arrives by its own path
 *    (CoreApiRestClient throws ClientError 429 "Concurrency limit reached", which
 *    streamToVideoElement rethrows straight into setJoinError), so the guess was pure
 *    noise pointed at anyone debugging.
 *
 * 4. A PRIME THAT NEVER SETTLES MUST NOT STRAND THE CONNECT.
 *    `await primeVideoElementForAutoplay()` sits directly in front of
 *    streamToVideoElement and awaits audioCtx.resume() and videoEl.play(). Its
 *    try/catch bounds REJECTIONS, not pending-forever promises, and both of those can
 *    stay pending in a throttled/background tab or a UA-suspended audio context. When
 *    that happens the connect is never even attempted and the viewer gets the 20s
 *    watchdog for a session that was never opened.
 *
 * Plus the two things that make every millisecond figure in this audit checkable rather
 * than reasoned: one TLS handshake moved off the connect path, and phase timings joined
 * to the backend's correlationId.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';

// Enable the sim subsystem's existing RUM channel BEFORE anything calls into it —
// lib/simTelemetry caches its gate on first use.
window.history.replaceState({}, '', '/?simdebug=1');

// ── The vendored SDK's own numbers, read from disk ──────────────────────────────
const SDK_CONSTANTS_PATH = (() => {
  const rel = 'node_modules/@anam-ai/js-sdk/dist/module/lib/constants.js';
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`cannot locate the vendored @anam-ai/js-sdk from ${process.cwd()}`);
  }
})();
const SDK_CONSTANTS = readFileSync(SDK_CONSTANTS_PATH, 'utf8');
function vendorNumber(name: string): number {
  const m = SDK_CONSTANTS.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`vendored @anam-ai/js-sdk no longer defines ${name}`);
  return Number(m[1]);
}
function vendorString(name: string): string {
  const m = SDK_CONSTANTS.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
  if (!m) throw new Error(`vendored @anam-ai/js-sdk no longer defines ${name}`);
  return m[1]!;
}
const VENDOR = {
  maxAttempts: vendorNumber('DEFAULT_START_SESSION_MAX_ATTEMPTS'),
  initialBackoffMs: vendorNumber('DEFAULT_START_SESSION_INITIAL_BACKOFF_MS'),
  maxBackoffMs: vendorNumber('DEFAULT_START_SESSION_MAX_BACKOFF_MS'),
  requestTimeoutMs: vendorNumber('DEFAULT_START_SESSION_REQUEST_TIMEOUT_MS'),
  apiBaseUrl: vendorString('DEFAULT_API_BASE_URL'),
};

/**
 * Worst-case wall clock CoreApiRestClient.startSession can burn under `policy`, using
 * the SDK's own arithmetic: every attempt times out, and every backoff lands on the
 * high end of its equal-jitter window (computeBackoffDelay, CoreApiRestClient.js:141).
 */
function worstCaseStartMs(policy: {
  maxAttempts: number; initialBackoffMs: number; maxBackoffMs: number; requestTimeoutMs: number;
}): number {
  const attempts = Math.max(1, Math.floor(policy.maxAttempts));
  let total = attempts * Math.max(0, policy.requestTimeoutMs);
  for (let a = 1; a < attempts; a++) {
    total += Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** (a - 1));
  }
  return total;
}

/** Exactly the slice of @anam-ai/js-sdk's AnamPublicClientOptions these tests read. */
interface CapturedClientOptions {
  voiceDetection?: { endOfSpeechSensitivity?: number };
  api?: {
    retry?: { maxAttempts?: number; initialBackoffMs?: number; maxBackoffMs?: number };
    requestTimeoutMs?: number;
  };
}

// ── SDK double ─────────────────────────────────────────────────────────────────
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
    createCalls: [] as Array<{ token: string; options: CapturedClientOptions | undefined }>,
    listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    streamCalls: [] as string[],
    /** 'resolve' — the SDK reports a live session. 'hang' — it never answers at all. */
    stream: 'resolve' as 'resolve' | 'hang',
  };
  return { AnamEvent, state };
});

vi.mock('@anam-ai/js-sdk', () => ({
  AnamEvent: anam.AnamEvent,
  createClient: (token: string, options?: CapturedClientOptions) => {
    anam.state.createCalls.push({ token, options });
    return {
      addListener: (ev: string, fn: (...a: unknown[]) => void) => {
        const list = anam.state.listeners.get(ev) ?? [];
        list.push(fn);
        anam.state.listeners.set(ev, list);
      },
      streamToVideoElement: (id: string) => {
        anam.state.streamCalls.push(id);
        return anam.state.stream === 'hang' ? new Promise<void>(() => {}) : Promise.resolve();
      },
      stopStreaming: async () => {},
      muteInputAudio: () => {},
      unmuteInputAudio: () => {},
    };
  },
}));

const api = vi.hoisted(() => ({ startCalls: 0, correlationId: 'cid-from-backend' }));
vi.mock('../components/avatar/avatarApi', () => ({
  startAvatarSession: vi.fn(async () => {
    api.startCalls += 1;
    return { provider: 'anam', sessionToken: 'tok', characterId: 'einstein', correlationId: api.correlationId };
  }),
  endAvatarSession: vi.fn(),
  isAbortError: (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError',
  analyzeVisual: vi.fn(async () => ({ type: 'none' })),
  analyzeImage: vi.fn(async () => ({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' })),
  getMemory: vi.fn(async () => ({ token: null, turns: [], profile: {} })),
  saveMemory: vi.fn(),
}));

import { __resetPreconnectForTests } from '../components/avatar/anamConnectPolicy';
import { AvatarConversation } from '../components/avatar/AvatarConversation';
import { AvatarPopup } from '../components/avatar/AvatarPopup';
import { AskAvatarButton } from '../components/avatar/AskAvatarButton';

// ── Environment doubles ────────────────────────────────────────────────────────
/** Never resolves, never rejects — the exact shape B3 is about. */
const forever = <T,>(): Promise<T> => new Promise<T>(() => {});

class FakeAudioContext {
  static resumeHangs = false;
  resume = () => (FakeAudioContext.resumeHangs ? forever<void>() : Promise.resolve());
  createMediaStreamDestination = () => ({ stream: { id: 'silent' } as unknown as MediaStream });
  createOscillator = () => ({ connect: () => {}, start: () => {}, stop: () => {} });
  createGain = () => ({ gain: { setValueAtTime: () => {} }, connect: () => {} });
  close = () => {};
}

const flush = async () => { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };

interface SimEvent { t: number; event: string; cid?: string; sinceOpenMs?: number }
interface SimTelemetryApi { events: SimEvent[]; clear: () => void }
const simApi = (): SimTelemetryApi | undefined =>
  (window as unknown as { __SIM_TELEMETRY__?: SimTelemetryApi }).__SIM_TELEMETRY__;
const avatarEvent = (name: string): SimEvent | undefined =>
  (simApi()?.events ?? []).find((e) => e.event === name);

let playHangs = false;

describe('avatar connect — policy, watchdog, prime bound, instrumentation', () => {
  beforeEach(() => {
    anam.state.createCalls = [];
    anam.state.listeners.clear();
    anam.state.streamCalls = [];
    anam.state.stream = 'resolve';
    api.startCalls = 0;
    FakeAudioContext.resumeHangs = false;
    playHangs = false;
    simApi()?.clear();
    // The handshake is warmed at most once per page; reset the flag so this suite does
    // not depend on which test happened to run first.
    __resetPreconnectForTests();
    document.head.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"]').forEach((n) => n.remove());
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get(this: { __src?: unknown }) { return this.__src ?? null; },
      set(this: { __src?: unknown }, v: unknown) { this.__src = v; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: function (this: HTMLMediaElement) {
        if (playHangs) return forever<void>();
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

  // ── 1. a deliberate session-start policy ────────────────────────────────────
  it('hands the SDK an explicit session-start retry and timeout policy', async () => {
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();

    const opts = anam.state.createCalls[0]?.options;
    expect(opts).toBeTruthy();
    expect(opts?.api).toBeTruthy();
    expect(typeof opts?.api?.requestTimeoutMs).toBe('number');
    expect(typeof opts?.api?.retry?.maxAttempts).toBe('number');
    // The voice policy that was already there must survive.
    expect(opts?.voiceDetection).toBeTruthy();
  });

  it('applies the same policy on the reconnect path', async () => {
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    await act(async () => { anam.state.listeners.get('CONNECTION_CLOSED')!.forEach((fn) => fn()); });
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    await flush();

    expect(anam.state.createCalls.length).toBe(2);
    expect(anam.state.createCalls[1]?.options?.api).toBeTruthy();
  });

  // ── 2. the watchdog must outlast the SDK ────────────────────────────────────
  it("leaves the SDK's worst-case session start room to finish inside the watchdog", async () => {
    // The vendor defaults are the effective policy for anything we do not override.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    anam.state.stream = 'hang';
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();

    const passed = anam.state.createCalls[0]?.options?.api ?? {};
    const effective = {
      maxAttempts: passed.retry?.maxAttempts ?? VENDOR.maxAttempts,
      initialBackoffMs: passed.retry?.initialBackoffMs ?? VENDOR.initialBackoffMs,
      maxBackoffMs: passed.retry?.maxBackoffMs ?? VENDOR.maxBackoffMs,
      requestTimeoutMs: passed.requestTimeoutMs ?? VENDOR.requestTimeoutMs,
    };
    const budget = worstCaseStartMs(effective);

    // Advance to the last instant the SDK could still be legitimately working. If the
    // watchdog has already fired by then, it beat the vendor's own error to the screen
    // and the viewer can never see the real diagnosis.
    await advance(budget);
    expect(screen.queryByText(/could not/i)).toBeNull();
  });

  // ── 3. the watchdog must not invent a cause ─────────────────────────────────
  it('does not blame a concurrency slot, a persona or a WebSocket it cannot see', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    anam.state.stream = 'hang';
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    await advance(25_000);

    const msg = screen.getByText(/could not/i).textContent ?? '';
    expect(msg).not.toMatch(/concurrency/i);
    expect(msg).not.toMatch(/persona/i);
    expect(msg).not.toMatch(/websocket/i);
  });

  it('says which half of the connect stalled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    // The SDK reported a live session, but nothing ever presented a frame.
    anam.state.stream = 'resolve';
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    await advance(25_000);

    expect(screen.getByText(/could not/i).textContent ?? '').toMatch(/no video/i);
  });

  // ── 4. a prime that never settles must not strand the connect ───────────────
  it('connects even when the audio context resume() never settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    FakeAudioContext.resumeHangs = true;
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    await advance(2_000);

    expect(anam.state.streamCalls).toEqual(['anam-avatar-video']);
  });

  it('connects even when the pre-connect play() never settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    playHangs = true;
    render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    await advance(2_000);

    expect(anam.state.streamCalls).toEqual(['anam-avatar-video']);
  });

  // ── the always-paid handshake ───────────────────────────────────────────────
  it('opens the Anam API connection while warming the chunk, not inside the connect', async () => {
    const { getByRole } = render(<AskAvatarButton onClick={() => {}} />);
    fireEvent.mouseEnter(getByRole('button'));
    await flush();

    const origin = new URL(VENDOR.apiBaseUrl).origin;
    const links = Array.from(document.head.querySelectorAll('link[rel="preconnect"]'))
      .filter((l) => (l as HTMLLinkElement).href.replace(/\/$/, '') === origin);
    expect(links.length).toBe(1);
    expect((links[0] as HTMLLinkElement).crossOrigin).toBe('anonymous');
    // Warming a handshake must never reach the billable mint.
    expect(api.startCalls).toBe(0);
  });

  // ── the client half of anam-latency-001 ─────────────────────────────────────
  it('records click-to-first-frame phases and joins them to the backend correlationId', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await flush();
    await act(async () => { anam.state.listeners.get('VIDEO_PLAY_STARTED')!.forEach((fn) => fn()); });
    await flush();

    for (const phase of ['avatar-popup-open', 'avatar-token', 'avatar-sdk-loaded', 'avatar-connect-started', 'avatar-first-frame']) {
      expect(avatarEvent(phase), `missing phase ${phase}`).toBeTruthy();
    }
    expect(avatarEvent('avatar-first-frame')!.cid).toBe('cid-from-backend');
    expect(typeof avatarEvent('avatar-first-frame')!.sinceOpenMs).toBe('number');
    expect(performance.getEntriesByName('anam:first-frame').length).toBeGreaterThan(0);
  });

  it('cannot break or delay playback when the reporting itself throws', async () => {
    const perf = performance as { mark: Performance['mark']; measure: Performance['measure'] };
    const realMark = perf.mark;
    const realMeasure = perf.measure;
    const boom = (() => { throw new Error('User Timing unavailable'); }) as unknown;
    perf.mark = boom as Performance['mark'];
    perf.measure = boom as Performance['measure'];
    try {
      render(<AvatarConversation characterId="einstein" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
      await flush();
      await act(async () => { anam.state.listeners.get('VIDEO_PLAY_STARTED')!.forEach((fn) => fn()); });
      await flush();

      expect(anam.state.streamCalls).toEqual(['anam-avatar-video']);
      expect(screen.queryByText(/could not/i)).toBeNull();
    } finally {
      perf.mark = realMark;
      perf.measure = realMeasure;
    }
  });
});
