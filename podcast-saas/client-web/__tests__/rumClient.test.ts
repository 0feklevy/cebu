/**
 * RUM client transport (Priority 8.9).
 *
 * Every claim is about not hurting the viewer. Collection is off unless explicitly enabled, a
 * failing transport gives up rather than retrying into a congested network, and no throw anywhere
 * can escape into the player. Losing measurements is free; costing a viewer a frame is not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRumRecorder, RUM_FLUSH_AT } from '../lib/sim/rumClient.js';
import { SIM_RUM_VERSION } from 'shared/src/sim/rumEvents';

const ENDPOINT = 'https://api.test/sim-rum';

let beacon: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * What actually went on the wire.
 *
 * Reads the FETCH calls, because keepalive fetch is the primary transport: sendBeacon's credentials
 * mode is fixed at `include`, and the ingest endpoint answers `Access-Control-Allow-Origin: *`,
 * which the Fetch CORS check rejects for a credentialed request. Beacons therefore failed that
 * check in every real browser while the rows still arrived, so the suite could not see it.
 */
const sent = (): Record<string, unknown>[] =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as { body?: string }).body ?? '{}')));

beforeEach(() => {
  vi.useFakeTimers();
  beacon = vi.fn(() => true);
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('Blob', class {
    __body: string;
    constructor(parts: string[]) { this.__body = parts.join(''); }
  } as never);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const r of live) { try { r.dispose(); } catch { /* already disposed */ } }
  live.length = 0;
  try { window.localStorage?.clear(); } catch { /* jsdom without storage */ }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const live: { dispose(): void }[] = [];
/** Every recorder is disposed after the test: an undisposed one keeps a `pagehide` listener on the
 *  shared jsdom window, so a later test's dispatch would flush recorders it never created. */
const rec = (over: Record<string, unknown> = {}) => {
  const r = createRumRecorder({ endpoint: ENDPOINT, sampleRate: 1, roll: () => 0, poolTier: 'all', ...over });
  live.push(r);
  return r;
};

const EV = { kind: 'transition' as const, packageRevision: 'pkg-abc' };

describe('collection is off unless explicitly enabled', () => {
  it('is inert at sample rate 0', () => {
    const r = rec({ sampleRate: 0 });
    expect(r.active).toBe(false);
    r.record(EV); r.flush('manual');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is inert for an unparseable rate', () => {
    for (const bad of [undefined, null, 'abc', NaN, -1]) {
      expect(rec({ sampleRate: bad }).active).toBe(false);
    }
  });

  it('does not even consult the sampler at rate 0', () => {
    // The rate check is not redundant with shouldSample: it must short-circuit BEFORE any work,
    // including evaluating the caller's roll. A roll that throws is the cheapest way to prove no
    // work happens — and a sampler consulted at rate 0 is a sampler that could one day be made to
    // return true.
    const boom = () => { throw new Error('the sampler must not be consulted'); };
    expect(() => createRumRecorder({ endpoint: ENDPOINT, sampleRate: 0, roll: boom })).not.toThrow();
    expect(() => createRumRecorder({ endpoint: ENDPOINT, sampleRate: 'nonsense', roll: boom })).not.toThrow();
  });

  it('is inert without an endpoint', () => {
    expect(rec({ endpoint: '' }).active).toBe(false);
  });

  it('samples ONCE for the whole session, not per event', () => {
    const rolls = [0.9, 0.0, 0.0, 0.0];
    let i = 0;
    const r = createRumRecorder({
      endpoint: ENDPOINT, sampleRate: 0.5, roll: () => rolls[i++] ?? 0,
    });
    expect(r.active).toBe(false);
    r.record(EV); r.flush('manual');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collects when the session wins its roll', () => {
    expect(createRumRecorder({ endpoint: ENDPOINT, sampleRate: 0.5, roll: () => 0.1 }).active).toBe(true);
  });
});

describe('transport', () => {
  it('prefers keepalive fetch, and never sends credentials', () => {
    // sendBeacon's credentials mode is fixed at `include`, and the endpoint answers
    // `Access-Control-Allow-Origin: *`. The Fetch CORS check rejects a credentialed request against
    // a wildcard origin, so every beacon failed that check in a real browser — the rows still
    // arrived, which is why it looked like it worked. keepalive fetch survives page unload the same
    // way and can omit credentials, which the wildcard does allow.
    const r = rec(); r.record(EV); r.flush('manual');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(beacon).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');
  });

  it('falls back to sendBeacon only where fetch does not exist', () => {
    vi.stubGlobal('fetch', undefined);
    const r = rec(); r.record(EV); r.flush('manual');
    expect(beacon).toHaveBeenCalledOnce();
  });

  it('sends a well-formed batch', () => {
    const r = rec(); r.record(EV); r.flush('manual');
    const b = sent()[0]!;
    expect(b.v).toBe(SIM_RUM_VERSION);
    expect(String(b.sessionId).length).toBeGreaterThanOrEqual(8);
    expect((b.events as unknown[]).length).toBe(1);
    expect((b.device as { poolTier: string }).poolTier).toBe('all');
  });

  it('stamps every event with an offset from session start, never a wall clock', () => {
    const r = rec({ now: () => 1234 }); r.record(EV); r.flush('manual');
    expect((sent()[0]!.events as { t: number }[])[0]!.t).toBe(1234);
  });

  it('falls back to keepalive fetch without credentials when sendBeacon is absent', () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
    const r = rec(); r.record(EV); r.flush('manual');
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');
  });

  it('DROPS a batch sendBeacon refuses rather than double-sending it — and COUNTS the loss', () => {
    // Sending twice silently biases a percentile, so the batch is dropped. But the ring had already
    // been drained, so without counting it the next batch reported `dropped: 0` and a truncated
    // sample was indistinguishable from a complete one — the exact invariant the column exists for.
    vi.stubGlobal('fetch', undefined);
    beacon.mockReturnValue(false);
    const r = rec(); r.record(EV); r.flush('manual');
    expect(beacon).toHaveBeenCalledOnce();

    beacon.mockReturnValue(true);
    r.record(EV); r.flush('manual');
    const body = JSON.parse((beacon.mock.calls[1]![1] as { __body?: string }).__body ?? '{}');
    expect(body.dropped, 'a refused batch vanished without a trace').toBeGreaterThan(0);
  });

  it('DISABLES on a 4xx, which resolves rather than rejecting', async () => {
    // Only a network-level failure rejects, so a `.catch` alone left the client posting into an
    // endpoint that was refusing every batch.
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const r = rec(); r.record(EV); r.flush('manual');
    await vi.waitFor(() => expect(r.active).toBe(false));
  });

  it('stays alive on a 429, which is the endpoint working as intended', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    const r = rec(); r.record(EV); r.flush('manual');
    await Promise.resolve(); await Promise.resolve();
    expect(r.active).toBe(true);
  });

  it('sends nothing when there is nothing buffered', () => {
    rec().flush('manual');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an idle flush leaves a carried drop count intact for the next real batch', async () => {
    // A 429 counts the refused batch back into the ring's tally without disabling — leaving the
    // ring EMPTY but the tally at 1. `drain()` zeroes the tally as it empties, so an idle flush
    // that drains before checking for emptiness destroys the only record that a batch was ever
    // lost. The guard must check BEFORE draining; the next real batch still says `dropped: 1`.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const r = rec();
    r.record(EV); r.flush('manual');
    await Promise.resolve(); await Promise.resolve();   // let the 429 .then run noteDropped

    r.flush('interval');                                // idle: ring empty, tally carried
    expect(fetchMock, 'an idle flush must not send an empty batch').toHaveBeenCalledOnce();

    r.record(EV); r.flush('manual');
    const body = sent().at(-1)!;
    expect(body.dropped, 'the idle flush destroyed the carried drop count').toBe(1);
  });

  it('flushes on an interval', () => {
    const r = rec({ flushIntervalMs: 5000 });
    r.record(EV);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('flushes early once the ring is half full', () => {
    const r = rec();
    for (let i = 0; i < RUM_FLUSH_AT; i += 1) r.record(EV);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('flushes on pagehide — the last batch is the most valuable one', () => {
    const r = rec(); r.record(EV);
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledOnce();
    // And a second pagehide sends nothing, because the ring is now empty.
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledOnce();
    void r;
  });
});

describe('failure isolation', () => {
  it('DISABLES the session when the transport throws, rather than retrying', () => {
    fetchMock.mockImplementation(() => { throw new Error('nope'); });
    const r = rec(); r.record(EV); r.flush('manual');
    expect(r.active).toBe(false);
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    r.record(EV); r.flush('manual');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('disables on a rejected fetch', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const r = rec(); r.record(EV); r.flush('manual');
    await vi.runAllTimersAsync();
    expect(r.active).toBe(false);
  });

  // These two used to inject their fault into `navigator.sendBeacon`. `send` returns inside the
  // `typeof fetch === 'function'` branch and never reaches the beacon fallback, so the fault landed
  // in an unreachable transport: both tests ran an entirely happy path and passed regardless of
  // what the code did. The faults now go into the transport the code actually takes.

  it('never lets a throw escape into the caller', () => {
    // 1. The transport throws SYNCHRONOUSLY — reaches the try/catch in `send`.
    fetchMock.mockImplementation(() => { throw new Error('boom'); });
    const r = rec();
    expect(() => { r.record(EV); r.flush('manual'); r.dispose(); }).not.toThrow();

    // 2. Serialising the batch throws — a BigInt makes JSON.stringify throw inside `send`.
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    const r2 = rec();
    expect(() => {
      // BigInt(1), not a `1n` literal: the tsconfig target predates BigInt literals.
      r2.record({ ...EV, durations: { totalMs: BigInt(1) as unknown as number } } as never);
      r2.flush('manual');
    }).not.toThrow();

    // 3. Building the event throws — a throwing getter makes the spread inside `record` throw,
    //    which is the only externally reachable way into that catch.
    const r3 = rec();
    expect(() => {
      r3.record({ get kind(): never { throw new Error('getter'); } } as never);
    }).not.toThrow();
    expect(r3.active, 'a throw inside record must disable the session, not vanish silently')
      .toBe(false);
  });

  it('stops its timer when disabled, so a dead session costs nothing', async () => {
    // The interval must be proven to WORK first, or "no further sends" proves nothing at all.
    const live = rec({ flushIntervalMs: 1000 });
    live.record(EV);
    vi.advanceTimersByTime(1000);
    expect(fetchMock.mock.calls.length, 'the interval never fired even while enabled').toBe(1);
    live.dispose();
    fetchMock.mockClear();

    // Now disable through the REAL transport: a rejected fetch runs `.catch(... disable())`.
    fetchMock.mockRejectedValue(new Error('offline'));
    const r = rec({ flushIntervalMs: 1000 });
    r.record(EV); r.flush('manual');
    await vi.runAllTimersAsync();
    expect(r.active, 'the recorder never actually disabled — the rest of this test would be vacuous')
      .toBe(false);

    const after = fetchMock.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(fetchMock.mock.calls.length, 'a disabled session kept its interval alive').toBe(after);
    // And not merely because the ring is empty: recording again must not resurrect the session.
    r.record(EV);
    vi.advanceTimersByTime(60_000);
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it('dispose flushes what remains and never throws', () => {
    const r = rec(); r.record(EV);
    expect(() => r.dispose()).not.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('privacy', () => {
  it('sends no URL, title or identifier', () => {
    const r = rec(); r.record(EV); r.flush('manual');
    const raw = JSON.stringify(sent()[0]);
    for (const f of ['http://', 'https://api.test', 'localhost', 'title', 'userId', 'email']) {
      expect(raw).not.toContain(f);
    }
  });

  it('sends only coarse device buckets', () => {
    const r = rec(); r.record(EV); r.flush('manual');
    const d = sent()[0]!.device as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(
      ['coarsePointer', 'cores', 'dpr', 'memoryGb', 'poolTier', 'saveData'].sort());
  });

  it('does not persist the session id', () => {
    const r = rec(); r.record(EV); r.flush('manual');
    // jsdom does not always expose localStorage; the claim is that WE never wrote to it.
    expect(window.localStorage?.length ?? 0).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('mints a different session id per recorder', () => {
    const a = rec(); a.record(EV); a.flush('manual');
    const b = rec(); b.record(EV); b.flush('manual');
    const ids = sent().map((x) => x.sessionId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ── Review findings ──────────────────────────────────────────────────────────────────────────────

describe('disposal is complete', () => {
  it('removes the visibilitychange listener, not only pagehide', () => {
    // An anonymous listener leaked on every mount: this viewer mounts per navigation, so each
    // disposed recorder kept a closure over its ring alive for the document lifetime.
    const r = rec();
    r.record(EV);
    r.dispose();
    fetchMock.mockClear(); beacon.mockClear();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a disposed recorder is DONE and records nothing further', () => {
    const r = rec();
    r.dispose();
    fetchMock.mockClear(); beacon.mockClear();
    r.record(EV);
    r.flush('manual');
    expect(r.active).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flushes on visibilitychange while alive', () => {
    const r = rec();
    r.record(EV);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledOnce();
    void r;
  });
});
