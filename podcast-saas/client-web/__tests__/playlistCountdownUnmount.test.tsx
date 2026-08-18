/**
 * The playlist auto-advance countdown dies with the component that started it (frontend-003).
 *
 * `handleProjectComplete` starts a 1 Hz `setInterval` that ticks the "Up next in N…" card and, at
 * zero, advances `currentPos`. Every OTHER path out of the countdown cleared it — `clearCountdown`
 * is called by cancel, by picking an item, by going back to the lobby — but the component had no
 * unmount cleanup at all. Navigating away in the six seconds between one video ending and the next
 * one starting (the exact window in which the card is on screen, so the exact window in which a
 * viewer decides to leave) left a live interval calling `setCountdown` / `setCurrentPos` on a
 * torn-down tree, once a second, for as long as the tab stayed open.
 *
 * The assertion tracks the specific interval by its 1000 ms period rather than counting pending
 * timers, so neither Testing Library's own polling intervals nor an unrelated timer elsewhere in
 * the tree can satisfy it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaylistPlayConfig } from '../components/viewer/playlist/shared';

vi.mock('../lib/firebase', () => ({
  useAuth: () => ({ loading: false, user: null, getIdToken: async () => null }),
  auth: { currentUser: null },
}));

// The real shell boots hls.js and a sim runtime; neither is what this file is about. The mock keeps
// the ONE wire that matters — the completion callback that starts the countdown.
vi.mock('../components/viewer/HLSPlayerShell', () => ({
  HLSPlayerShell: ({ onProjectComplete }: { onProjectComplete?: () => void }) => (
    <button onClick={() => onProjectComplete?.()}>end of item</button>
  ),
}));
vi.mock('../components/avatar/AskAvatarButton', () => ({ AskAvatarButton: () => null }));
vi.mock('../components/avatar/AvatarPopup', () => ({ AvatarPopup: () => null }));

import { PlaylistViewer } from '../components/viewer/playlist/PlaylistViewer';

const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

/** The countdown interval ticks once a second; Testing Library's own polling does not. */
const COUNTDOWN_PERIOD_MS = 1000;

let created: Array<{ id: unknown; ms: number | undefined }> = [];
let cleared: unknown[] = [];

/** Countdown intervals this tree started and has not given back. */
const liveCountdowns = () =>
  created.filter((t) => t.ms === COUNTDOWN_PERIOD_MS && !cleared.includes(t.id)).map((t) => t.id);

function playConfig(): PlaylistPlayConfig {
  const item = (id: string, title: string) => ({
    project_id: id, title, description: null, thumbnail_url: null,
    config: { segments: [{ hls_status: 'ready', duration_sec: 30, fallback_url: null }] },
  });
  return {
    id: 'pl-1', title: 'A playlist', description: null,
    autoplay: true, show_sidebar: false, allow_shuffle: false,
    banner_url: null, banner_prompt: null, banner_provider: null,
    items: [item('p1', 'First'), item('p2', 'Second')],
  } as unknown as PlaylistPlayConfig;
}

/** Play the first item, then end it — leaving the up-next card counting down. */
async function startCountdown(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Play all/i }));
  fireEvent.click(await screen.findByRole('button', { name: /end of item/i }));
  await waitFor(() => { expect(screen.getByText('6')).toBeTruthy(); });
}

beforeEach(() => {
  created = [];
  cleared = [];
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const id = realSetInterval(handler, ms, ...rest);
    created.push({ id, ms });
    return id;
  }) as typeof globalThis.setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id?: unknown) => {
    if (id != null) cleared.push(id);
    realClearInterval(id as ReturnType<typeof setInterval>);
  }) as typeof globalThis.clearInterval);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(playConfig()), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })));
});

afterEach(() => {
  cleanup();
  // Anything the tree left running would otherwise tick into the next test.
  for (const t of created) if (!cleared.includes(t.id)) realClearInterval(t.id as ReturnType<typeof setInterval>);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('playlist auto-advance countdown', () => {
  it('clears the countdown interval when the viewer unmounts mid-countdown', async () => {
    const { unmount } = render(<PlaylistViewer playlistId="pl-1" />);
    await startCountdown();

    const [countdownId, ...extra] = liveCountdowns();
    expect(countdownId).toBeDefined();
    expect(extra).toEqual([]);

    unmount();

    expect(cleared).toContain(countdownId);
    expect(liveCountdowns()).toEqual([]);
  });

  it('still clears the countdown when the viewer cancels it', async () => {
    // The path that already worked, kept honest: the unmount fix must not replace it.
    render(<PlaylistViewer playlistId="pl-1" />);
    await startCountdown();

    const [countdownId] = liveCountdowns();
    expect(countdownId).toBeDefined();

    fireEvent.click(screen.getByTitle(/Cancel autoplay/i));

    expect(cleared).toContain(countdownId);
    expect(liveCountdowns()).toEqual([]);
  });
});
