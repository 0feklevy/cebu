/**
 * The viewer's "processing" spinner is bounded and has a way out (ui-ux-001).
 *
 * Both viewer entry points poll `player-config` every 5 s and show a spinner while any segment is
 * still transcoding. Every OTHER outcome stops the poll — ready, locked, no segments, all-failed,
 * a thrown request — but "still processing" had no bound at all. A job that never reaches `ready`
 * or `failed` (a worker that died mid-transcode, a row stuck in `processing`) spun that placeholder
 * forever, re-fetching every five seconds for as long as the tab stayed open, with no message, no
 * error, and nothing to click. From the viewer's side it is indistinguishable from a slow video.
 *
 * The fix is a bound plus an escape, not a failure: after the bound the poll stops and hands
 * control back with something the viewer can act on. Both files carry the same defect and the same
 * fix, so both are driven here — a bound on one of them is not a bound on "the viewer".
 *
 * Time is driven explicitly and every query is synchronous: Testing Library's `findBy`/`waitFor`
 * poll on real timers, which under `vi.useFakeTimers()` never advance, so an async query here would
 * hang rather than assert.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A STABLE object: ViewerPage's poll effect depends on `getIdToken`, so a hook that returned a
// fresh identity every render would restart the poll on every render and spin the test, not the
// product. The real provider memoises it for the same reason.
const AUTH = { loading: false, user: null, getIdToken: async () => null };
vi.mock('../lib/firebase', () => ({
  useAuth: () => AUTH,
  auth: { currentUser: null },
}));
vi.mock('../components/viewer/HLSPlayerShell', () => ({
  HLSPlayerShell: () => <div data-testid="player" />,
}));
vi.mock('../components/avatar/AskAvatarButton', () => ({ AskAvatarButton: () => null }));
vi.mock('../components/avatar/AvatarPopup', () => ({ AvatarPopup: () => null }));
vi.mock('../components/PaywallOverlay', () => ({ PaywallOverlay: () => null }));

import { ViewerPage } from '../components/viewer/ViewerPage';
import { SharedViewerPage } from '../components/viewer/SharedViewerPage';

/** Longer than any bound this test expects the product to hold. */
const WELL_PAST_ANY_BOUND_MS = 12 * 60 * 1000;
const ESCAPE = /check again|try again|retry/i;

const segment = (status: string) => ({
  id: 'seg-1', hls_status: status, hls_url: null, fallback_url: null, duration_sec: 30,
});

let segmentStatus = 'processing';
let fetchCalls = 0;

/** Advance fake time and let every request/render it triggers settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const escapeButton = () => screen.queryByRole('button', { name: ESCAPE });
const player = () => screen.queryByTestId('player');

const SURFACES = [
  { name: 'ViewerPage', render: () => render(<ViewerPage projectId="p1" />) },
  { name: 'SharedViewerPage', render: () => render(<SharedViewerPage shareToken="tok-1" />) },
];

beforeEach(() => {
  segmentStatus = 'processing';
  fetchCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: 'p1', segments: [segment(segmentStatus)] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }));
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(SURFACES)('$name — stuck processing job', (surface) => {
  it('stops polling and offers a way out instead of spinning forever', async () => {
    surface.render();

    await tick(10_000);
    expect(screen.getByText(/processing/i)).toBeTruthy();
    expect(fetchCalls).toBeGreaterThan(1);
    expect(escapeButton()).toBeNull();

    await tick(WELL_PAST_ANY_BOUND_MS);

    // Something the viewer can act on, not a spinner.
    expect(escapeButton()).toBeTruthy();

    // And the poll really stopped — a bound that keeps fetching is not a bound.
    const pollsAtGiveUp = fetchCalls;
    await tick(60_000);
    expect(fetchCalls).toBe(pollsAtGiveUp);
  });

  it('picks the video up when the viewer asks it to check again', async () => {
    surface.render();
    await tick(WELL_PAST_ANY_BOUND_MS);

    const retry = escapeButton();
    expect(retry).toBeTruthy();
    segmentStatus = 'ready';
    fireEvent.click(retry!);

    await tick(0);
    expect(player()).toBeTruthy();
  });

  it('does not interrupt a job that finishes inside the bound', async () => {
    surface.render();
    await tick(20_000);
    expect(escapeButton()).toBeNull();

    segmentStatus = 'ready';
    await tick(6_000);
    expect(player()).toBeTruthy();

    // Once it is playing, the bound must never fire behind it.
    await tick(WELL_PAST_ANY_BOUND_MS);
    expect(player()).toBeTruthy();
    expect(escapeButton()).toBeNull();
  });
});
