/**
 * The two pending-segment regressions that no pure test can reach, asserted on the RENDERED
 * viewer: what the gate actually does with a real poll, and whether the give-up notice is
 * reachable at the moment it matters.
 *
 * REGRESSION 1, end to end. `playable.length > 0` opened the gate as soon as ANY segment was
 * ready. Because transcodes run concurrently a later video can finish first, and the player
 * always attaches index 0 — so the viewer dismissed its spinner and showed a dead player.
 *
 * REGRESSION 4. `setStalled(true)` fired on the branch where a config already exists, but the
 * stalled markup lived inside `if (!config)`. It set state that nothing rendered: the viewer was
 * left at a boundary with no message and no button — the silent freeze the whole change exists to
 * remove, moved one step later. A source-text test cannot see this; only rendering can.
 *
 * `HLSPlayerShell` is doubled because jsdom cannot run hls.js or a media element; everything that
 * decides — the poll, the gate, the timeout, the render branches — is the real ViewerPage.
 */
import { render, screen, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({
  useAuth: () => ({ loading: false, getIdToken: async () => null }),
  auth: {},
}));
vi.mock('../components/viewer/HLSPlayerShell', () => ({
  HLSPlayerShell: () => <div data-testid="player" />,
}));
vi.mock('../components/avatar/AskAvatarButton', () => ({ AskAvatarButton: () => null }));
vi.mock('../components/avatar/AvatarPopup', () => ({ AvatarPopup: () => null }));
vi.mock('../components/PaywallOverlay', () => ({ PaywallOverlay: () => null }));

import { ViewerPage } from '../components/viewer/ViewerPage';

const segment = (id: string, status: string, url: string | null) => ({
  id, hls_status: status, hls_url: url, fallback_url: null,
  label: '', duration_sec: 10, simulations: [],
});

/**
 * The body the endpoint currently returns. Deliberately NOT a per-call queue: React invokes
 * effects twice in development, so a call-counting mock silently serves the next state on the
 * first render and the test then measures the wrong thing.
 */
let body: unknown = null;
const serve = (b: unknown) => { body = b; };

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => (
    { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response
  )));
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => { vi.useFakeTimers(); stubFetch(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('REGRESSION 1 — a ready LATER segment must not open the gate', () => {
  it('keeps the spinner when segment 0 is still transcoding, even though segment 1 is ready', async () => {
    serve({ segments: [segment('a', 'processing', null), segment('b', 'ready', 'https://cdn/b.m3u8')] });
    render(<ViewerPage projectId="p1" />);
    await flush();

    // The shipped bug rendered the player here, with nothing to play.
    expect(screen.queryByTestId('player')).toBeNull();
    expect(screen.getByText(/Video is processing/i)).toBeTruthy();
  });

  it('hands over the config as soon as segment 0 becomes ready on a later poll', async () => {
    serve({ segments: [segment('a', 'processing', null), segment('b', 'ready', 'https://cdn/b.m3u8')] });
    render(<ViewerPage projectId="p1" />);
    await flush();
    expect(screen.queryByTestId('player')).toBeNull();

    // segment 0 finishes transcoding; the next poll must deliver it.
    serve({ segments: [segment('a', 'ready', 'https://cdn/a.m3u8'), segment('b', 'ready', 'https://cdn/b.m3u8')] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(screen.getByTestId('player')).toBeTruthy();
  });
});

describe('REGRESSION 4 — the give-up notice must be reachable once a config exists', () => {
  it('shows the notice AND keeps the video playing when a later segment never resolves', async () => {
    serve({ segments: [segment('a', 'ready', 'https://cdn/a.m3u8'), segment('b', 'processing', null)] });
    render(<ViewerPage projectId="p1" />);
    await flush();

    // Playing, and polling for segment b.
    expect(screen.getByTestId('player')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();

    // Past the bound: the viewer must be TOLD, without losing the video it is watching.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5_000); });
    await flush();

    expect(screen.getByText(/still processing/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /check again/i })).toBeTruthy();
    expect(screen.getByTestId('player')).toBeTruthy();   // an overlay, never a replacement
  });
});
