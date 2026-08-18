/**
 * "Building the studio audio…" is bounded and has a way out (ui-ux-002).
 *
 * The studio renders a full-panel spinner for as long as `mix.status === 'generating'` and polls
 * every 2.5 s. Nothing else in that branch can end it: there is no timeout, no cancel, and the only
 * escape is `status` flipping to `ready` or `failed` — which is exactly what does NOT happen when
 * the build worker dies mid-run and leaves the row on `generating`. The panel then spins, and
 * re-fetches, for as long as the tab is open. The Rebuild button that would fix it is rendered by
 * the *other* branch, so it is unreachable from the state that needs it.
 *
 * The bound is on PROGRESS, not on total elapsed time: synthesising one clip per line legitimately
 * takes many minutes on a long episode, and a flat timeout would interrupt healthy builds. A build
 * whose clip counter has not moved in minutes is stuck; a build whose counter is moving is not.
 * Both of those are asserted, because a bound that also kills working builds is not an improvement.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getPodcastStudio: vi.fn(),
    generatePodcastStudio: vi.fn(),
    savePodcastMixTimeline: vi.fn(),
    getPodcastRender: vi.fn(),
    exportPodcastMix: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api: apiMock }));

import { AudioStudio } from '../components/podcast/studio/AudioStudio';

const EMPTY_TIMELINE = { version: 1, clips: [] };
const WELL_PAST_ANY_BOUND_MS = 15 * 60 * 1000;
const ESCAPE = /try again|rebuild|check again/i;

function studio(over: Record<string, unknown> = {}) {
  return {
    clips: [],
    snapshots: [],
    latest_script_hash: 'h1',
    latest_script_version: 1,
    mix: {
      status: 'generating', rev: 0, script_hash: 'h1',
      timeline: EMPTY_TIMELINE, progress: { done: 2, total: 10 },
    },
    ...over,
  } as never;
}

const escapeButton = () => screen.queryByRole('button', { name: ESCAPE });
const spinnerText = () => screen.queryByText(/Building the studio audio/i);

async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function renderStudio(initial = studio()) {
  return render(
    <AudioStudio showId="show-1" episodeId="ep-1" initial={initial} turns={[]} onReloadScript={() => {}} />,
  );
}

/**
 * jsdom implements no Web Audio at all, and the studio opens a decode context on mount regardless
 * of which branch it renders. Nothing here decodes anything (there are no clips), so the fake only
 * has to exist.
 */
class FakeAudioContext {
  state = 'running';
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  decodeAudioData() { return Promise.reject(new Error('no clips in this fixture')); }
  close() { return Promise.resolve(); }
  resume() { return Promise.resolve(); }
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeAudioContext);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('podcast studio — stuck build', () => {
  it('stops polling and offers a rebuild when the clip counter stops moving', async () => {
    // The worker died at 2/10 and the row will say `generating` forever.
    apiMock.getPodcastStudio.mockResolvedValue(studio());

    renderStudio();
    expect(spinnerText()).toBeTruthy();

    await tick(30_000);
    expect(escapeButton()).toBeNull();
    expect(apiMock.getPodcastStudio.mock.calls.length).toBeGreaterThan(1);

    await tick(WELL_PAST_ANY_BOUND_MS);

    // Something to read and something to press, in the branch that was previously spinner-only.
    expect(spinnerText()).toBeNull();
    expect(escapeButton()).toBeTruthy();

    // And the poll really stopped.
    const pollsAtGiveUp = apiMock.getPodcastStudio.mock.calls.length;
    await tick(60_000);
    expect(apiMock.getPodcastStudio.mock.calls.length).toBe(pollsAtGiveUp);
  });

  it('rebuilds when the escape is used', async () => {
    apiMock.getPodcastStudio.mockResolvedValue(studio());
    renderStudio();
    await tick(WELL_PAST_ANY_BOUND_MS);

    const retry = escapeButton();
    expect(retry).toBeTruthy();
    apiMock.generatePodcastStudio.mockResolvedValue({ ok: true });
    apiMock.getPodcastStudio.mockResolvedValue(studio({
      mix: { status: 'generating', rev: 0, script_hash: 'h1', timeline: EMPTY_TIMELINE, progress: { done: 0, total: 10 } },
    }));
    fireEvent.click(retry!);
    await tick(0);

    expect(apiMock.generatePodcastStudio).toHaveBeenCalledWith('show-1', 'ep-1');
    // A fresh build gets a fresh spinner and a fresh clock, not the dead-end screen.
    expect(spinnerText()).toBeTruthy();
    expect(escapeButton()).toBeNull();
  });

  it('never interrupts a long build whose clip counter is still moving', async () => {
    let done = 2;
    apiMock.getPodcastStudio.mockImplementation(async () => studio({
      mix: { status: 'generating', rev: 0, script_hash: 'h1', timeline: EMPTY_TIMELINE, progress: { done: done++, total: 400 } },
    }));

    renderStudio();
    await tick(WELL_PAST_ANY_BOUND_MS);

    expect(spinnerText()).toBeTruthy();
    expect(escapeButton()).toBeNull();
  });

  it('leaves the spinner the moment the build really finishes', async () => {
    apiMock.getPodcastStudio.mockResolvedValue(studio({
      mix: { status: 'ready', rev: 1, script_hash: 'h1', timeline: EMPTY_TIMELINE, progress: { done: 10, total: 10 } },
    }));

    renderStudio();
    await tick(3_000);

    expect(spinnerText()).toBeNull();
    expect(screen.getByText(/Open the editor/i)).toBeTruthy();
  });
});
