/**
 * D-13 — the viewer's freshness poll, as a mechanism.
 *
 * The ruling names three things that make this testable at all, and they are the three describes
 * below: (a) a new revision arrives within one tick, (b) a `304` leaves the session untouched,
 * (c) a hidden tab does not poll.
 *
 * The fourth — and the one a careless implementation gets wrong — is that the poll must be
 * CONDITIONAL from its very first request. An unconditional GET here would put the whole config
 * back on the wire every minute and, on the share and permalink routes, be counted as another
 * view: one viewer of a one-hour lecture reported as sixty.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';

import { useConfigFreshness } from '../components/viewer/useConfigFreshness';
import { FRESHNESS_INTERVAL_MS } from '../components/viewer/configRevision';
import type { PlayerConfig } from '../components/viewer/types';

const URL_UNDER_TEST = 'https://api.test/api/v1/share/TOKEN';

function payload(brollAt: number): PlayerConfig {
  return {
    project_id: 'proj-1',
    segments: [{ id: 'seg-1', hls_url: 'https://cdn/1.m3u8' }],
    broll_clips: [{ id: 'clip-1', global_offset_sec: brollAt }],
  } as unknown as PlayerConfig;
}

/** One long tick — 75s is the top of the jittered range, so exactly one poll has fired. */
const ONE_TICK_MS = 75_001;

interface ProbeProps {
  enabled?: boolean;
  seedEtag?: string | null;
  onRevision: (c: PlayerConfig) => void;
}

function Probe({ enabled = true, seedEtag = '"v1"', onRevision }: ProbeProps) {
  const etagRef = useRef<string | null>(seedEtag);
  useConfigFreshness({
    url: URL_UNDER_TEST,
    enabled,
    etagRef,
    getToken: async () => 'TOKEN-abc',
    onRevision,
  });
  return null;
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Every `json()` the hook actually read — a `304` legitimately has no body to read. */
const bodyReads: number[] = [];

/** A fetch double that records every request and answers from a scripted queue. */
function stubFetch(responses: Array<{ status: number; etag?: string; body?: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; cache?: string }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      cache: init?.cache,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? r.etag ?? null : null) },
      json: async () => { bodyReads.push(r.status); return r.body; },
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  bodyReads.length = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Advance past one jittered interval and let the awaited fetch chain settle. */
async function advanceOneTick(ms = ONE_TICK_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('(a) a new revision arrives within one tick', () => {
  it('hands the corrected config to onRevision', async () => {
    stubFetch([{ status: 200, etag: '"v2"', body: payload(25) }]);
    const onRevision = vi.fn();
    render(<Probe onRevision={onRevision} />);

    expect(onRevision).not.toHaveBeenCalled();      // nothing fires on mount
    await advanceOneTick();

    expect(onRevision).toHaveBeenCalledTimes(1);
    expect(onRevision.mock.calls[0][0].broll_clips[0].global_offset_sec).toBe(25);
  });

  it('revalidates against the NEW tag on the next tick, not the old one', async () => {
    const calls = stubFetch([
      { status: 200, etag: '"v2"', body: payload(25) },
      { status: 304 },
    ]);
    render(<Probe onRevision={vi.fn()} />);

    await advanceOneTick();
    await advanceOneTick();

    expect(calls).toHaveLength(2);
    expect(calls[0].headers['If-None-Match']).toBe('"v1"');
    // Adopting the delivered tag is what stops the next tick from re-downloading the same bytes.
    expect(calls[1].headers['If-None-Match']).toBe('"v2"');
  });

  it('is CONDITIONAL from the first request, and carries the viewer’s identity', async () => {
    const calls = stubFetch([{ status: 304 }]);
    render(<Probe onRevision={vi.fn()} />);
    await advanceOneTick();

    expect(calls[0].url).toBe(URL_UNDER_TEST);
    expect(calls[0].headers['If-None-Match']).toBe('"v1"');
    // The poll must present the same identity the initial fetch did, or the server builds a
    // different audience's payload and the ETag never matches.
    expect(calls[0].headers.Authorization).toBe('Bearer TOKEN-abc');
    // Our validator, not the browser's.
    expect(calls[0].cache).toBe('no-store');
  });

  it('never fires unconditionally when it has no tag to offer', async () => {
    const calls = stubFetch([{ status: 200, etag: '"v2"', body: payload(25) }]);
    render(<Probe seedEtag={null} onRevision={vi.fn()} />);
    await advanceOneTick();
    await advanceOneTick();
    // An unconditional GET on the share/permalink routes is counted as a new view.
    expect(calls).toHaveLength(0);
  });
});

describe('(b) a 304 leaves the session untouched', () => {
  it('does not call onRevision', async () => {
    stubFetch([{ status: 304 }]);
    const onRevision = vi.fn();
    render(<Probe onRevision={onRevision} />);

    await advanceOneTick();
    await advanceOneTick();
    await advanceOneTick();

    // No setState at all is the point: the caption reset keys on `config.segments` identity, so a
    // "harmless" re-set of an equal payload would wipe the viewer's captions once a minute.
    expect(onRevision).not.toHaveBeenCalled();
    // And it never even reads a body. A 304 legitimately has none, so a hook that parsed first
    // and decided afterwards would be relying on the parse failing — which is not a rule, it is
    // a coincidence that holds until a proxy attaches an error page to the 304.
    expect(bodyReads).toEqual([]);
  });

  it('keeps polling after a 304 rather than treating it as terminal', async () => {
    const calls = stubFetch([{ status: 304 }]);
    render(<Probe onRevision={vi.fn()} />);
    await advanceOneTick();
    await advanceOneTick();
    await advanceOneTick();
    expect(calls).toHaveLength(3);
  });
});

describe('(c) a hidden tab does not poll', () => {
  it('sends nothing while the tab is hidden', async () => {
    visibility = 'hidden';
    const calls = stubFetch([{ status: 304 }]);
    render(<Probe onRevision={vi.fn()} />);

    await advanceOneTick();
    await advanceOneTick();

    // Nobody is watching, so nothing can be stale to them — and the host D-12 named as the
    // scaling constraint pays for every request that is not.
    expect(calls).toHaveLength(0);
  });

  it('revalidates immediately when the viewer comes back', async () => {
    visibility = 'hidden';
    const calls = stubFetch([{ status: 200, etag: '"v2"', body: payload(25) }]);
    const onRevision = vi.fn();
    render(<Probe onRevision={onRevision} />);

    await advanceOneTick();
    expect(calls).toHaveLength(0);

    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });

    // Returning to the tab is the moment a viewer is most likely to be looking at something
    // stale, so it does not wait out the rest of the interval.
    expect(calls).toHaveLength(1);
    expect(onRevision).toHaveBeenCalledTimes(1);
  });
});

describe('the poll is not a takedown mechanism', () => {
  it.each([
    ['a paywall stub', { status: 200, etag: '"v2"', body: { locked: true, content_id: 'p', title: 't', price_cents: 1, currency: 'usd' } }],
    ['a 404',          { status: 404 }],
    ['a 500',          { status: 500 }],
    ['an unparseable body', { status: 200, etag: '"v2"', body: 'not-a-config' }],
  ])('ignores %s and leaves playback exactly as it was', async (_label, response) => {
    stubFetch([response]);
    const onRevision = vi.fn();
    render(<Probe onRevision={onRevision} />);
    await advanceOneTick();
    // Production HLS is served from a public bucket (security-001), so this poll could not revoke
    // anything even if it tried. Taking a working video away from a mid-watch viewer on the
    // strength of one odd response would be a worse bug than the staleness D-13 fixes.
    expect(onRevision).not.toHaveBeenCalled();
  });

  it('does not adopt the tag of a response it refused', async () => {
    const calls = stubFetch([
      { status: 200, etag: '"rejected"', body: 'not-a-config' },
      { status: 304 },
    ]);
    render(<Probe onRevision={vi.fn()} />);
    await advanceOneTick();
    await advanceOneTick();
    expect(calls[1].headers['If-None-Match']).toBe('"v1"');
  });
});

describe('lifecycle', () => {
  it('does not poll until a player session exists', async () => {
    const calls = stubFetch([{ status: 304 }]);
    render(<Probe enabled={false} onRevision={vi.fn()} />);
    await advanceOneTick();
    await advanceOneTick();
    expect(calls).toHaveLength(0);
  });

  it('stops on unmount', async () => {
    const calls = stubFetch([{ status: 304 }]);
    const view = render(<Probe onRevision={vi.fn()} />);
    await advanceOneTick();
    expect(calls).toHaveLength(1);

    view.unmount();
    await advanceOneTick();
    await advanceOneTick();
    expect(calls).toHaveLength(1);
  });

  it('polls at roughly a minute, never at the readiness poll’s 5s', async () => {
    const calls = stubFetch([{ status: 304 }]);
    render(<Probe onRevision={vi.fn()} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(44_000); });
    expect(calls).toHaveLength(0);          // below the bottom of the jitter range

    await act(async () => { await vi.advanceTimersByTimeAsync(31_001); });
    expect(calls).toHaveLength(1);          // and inside the top of it

    // A 60-minute lecture at this rate is ~60 requests, not the ~720 a 5s poll would cost.
    expect(FRESHNESS_INTERVAL_MS).toBe(60_000);
  });
});
