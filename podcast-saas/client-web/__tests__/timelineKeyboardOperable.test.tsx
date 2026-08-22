/**
 * The editor timeline, operated without a mouse (ui-ux-006 — the last of the a11y group).
 *
 * `timelineKeyboard.test.ts` pins the RULES: what a keypress means, and which keys the component
 * must leave alone. This file pins that the rules are WIRED — that the handles exist in the
 * accessibility tree, that arrows reach them, and that a keypress produces the same write the
 * mouse drag produces. Those are different claims, and only the second is what a person using a
 * keyboard actually gets.
 *
 * It asserts on `api.updateSection`, the real commit both inputs share, rather than on internal
 * state: a keyboard path that computed the right numbers and never saved them would satisfy any
 * assertion made one layer higher up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const updateSection = vi.fn(async (_p: string, id: string, patch: Record<string, number>) => ({
  id, project_id: 'p1', video_file_id: 'v1', type: 'video', track: 'main', label: 'Introduction',
  notes: null, sort_order: 1, simulation_url: null,
  start_sec: patch.start_sec ?? 2, end_sec: patch.end_sec ?? 8,
}));

vi.mock('../lib/api', () => ({
  api: {
    updateSection: (...a: [string, string, Record<string, number>]) => updateSection(...a),
    createSection: vi.fn(),
    deleteSection: vi.fn(),
  },
}));
// Firebase is value-imported down the tree at module load; nothing here authenticates.
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));

import { TimelinePanel } from '../components/TimelinePanel';

const VIDEO = {
  id: 'v1', project_id: 'p1', filename: 'a.mp4', storage_key: 'k', duration_sec: 40,
  file_size: 1, hls_status: 'ready', created_at: '', updated_at: '',
} as never;

const section = (over: Record<string, unknown>) => ({
  project_id: 'p1', video_file_id: 'v1', type: 'video', track: 'main',
  notes: null, simulation_url: null, ...over,
} as never);

/**
 * THREE SECTIONS, and the reason there are three.
 *
 * With a single section on the clip there is nothing to collide with — so a keyboard path that
 * ignored `clampMove`/`clampTrim` entirely and just wrote `value + delta` passed every assertion
 * in this file. A mutation replacing the clamp with raw arithmetic was green. Sharing those
 * helpers with the drag is the whole claim of the implementation, so the fixture has to contain
 * collisions for the claim to be testable at all.
 *
 * `Cold Open` abuts the subject's start at 2 s, so Home on the move handle has nowhere to go.
 * `Chapter Two` sits at 20 s, leaving room to nudge right while still stopping a trim-to-the-end.
 */
const COLD_OPEN = section({ id: 's0', start_sec: 0, end_sec: 2, label: 'Cold Open', sort_order: 0 });
const SUBJECT = section({ id: 's1', start_sec: 2, end_sec: 8, label: 'Introduction', sort_order: 1 });
const CHAPTER_TWO = section({ id: 's2', start_sec: 20, end_sec: 26, label: 'Chapter Two', sort_order: 2 });

function renderTimeline() {
  return render(
    <TimelinePanel
      projectId="p1"
      videos={[VIDEO]}
      sections={[COLD_OPEN, SUBJECT, CHAPTER_TWO]}
      simulations={[]}
      playheadSec={0}
      activeVideoId="v1"
      videoUrls={{}}
      onSeek={() => {}}
      onMeasuredDuration={() => {}}
      onSectionsChange={() => {}}
      toolMode="video"
      showBrollTrack={false}
      showAudioTrack={false}
      onAddVideo={() => {}}
    />,
  );
}

/** Handles are named by job first, so one block's handle is addressable unambiguously. */
const moveHandle = () => screen.getByRole('slider', { name: /^Move VIDEO Introduction/ });
const trimStart = () => screen.getByRole('slider', { name: /^Trim start of VIDEO Introduction/ });
const trimEnd = () => screen.getByRole('slider', { name: /^Trim end of VIDEO Introduction/ });

const settle = () => new Promise((r) => setTimeout(r, 40));

beforeEach(() => { updateSection.mockClear(); });
afterEach(cleanup);

describe('the handles a keyboard user can reach', () => {
  it('exposes move, trim-start and trim-end as three distinct named sliders', () => {
    // Three affordances are drawn; three must exist in the accessibility tree. A single "section"
    // control would be operable and still leave trimming impossible without a mouse.
    renderTimeline();
    expect(moveHandle()).toBeTruthy();
    expect(trimStart()).toBeTruthy();
    expect(trimEnd()).toBeTruthy();
  });

  it('names each handle by its JOB first, then the section', () => {
    // All three sit on the same block. Leading with the section name announces "Introduction"
    // three times and tells a listener nothing about which one they have landed on.
    renderTimeline();
    expect(moveHandle().getAttribute('aria-label')).toMatch(/Introduction/);
    expect(trimStart().getAttribute('aria-label')).toMatch(/Introduction/);
  });

  it('makes every handle reachable by Tab', () => {
    renderTimeline();
    for (const s of screen.getAllByRole('slider')) {
      expect(s.getAttribute('tabindex'), s.getAttribute('aria-label') ?? '').toBe('0');
    }
  });

  it('announces a time a person can picture, not a raw float', () => {
    renderTimeline();
    expect(moveHandle().getAttribute('aria-valuetext')).toBe('0:02.0');
    expect(trimEnd().getAttribute('aria-valuetext')).toBe('0:08.0');
  });
});

describe('what the arrows actually write', () => {
  it('moves the section and keeps its length', async () => {
    // The defining property of a MOVE: both edges travel together. A move that changed the
    // duration would be a trim wearing a move's label.
    renderTimeline();
    fireEvent.keyDown(moveHandle(), { key: 'ArrowRight' });
    await vi.waitFor(() => expect(updateSection).toHaveBeenCalled());

    const patch = updateSection.mock.calls[0]![2];
    expect(patch.start_sec).toBeCloseTo(2.1, 5);
    expect(patch.end_sec! - patch.start_sec!).toBeCloseTo(6, 5);
  });

  it('trims one edge and leaves the other exactly where it was', async () => {
    renderTimeline();
    fireEvent.keyDown(trimEnd(), { key: 'ArrowRight' });
    await vi.waitFor(() => expect(updateSection).toHaveBeenCalled());

    const patch = updateSection.mock.calls[0]![2];
    expect(patch.start_sec).toBeCloseTo(2, 5);
    expect(patch.end_sec).toBeCloseTo(8.1, 5);
  });

  it('takes a bigger step with Shift, in the same direction', async () => {
    renderTimeline();
    fireEvent.keyDown(moveHandle(), { key: 'ArrowRight', shiftKey: true });
    await vi.waitFor(() => expect(updateSection).toHaveBeenCalled());

    expect(updateSection.mock.calls[0]![2].start_sec).toBeCloseTo(3, 5);
  });
});

describe("the collision rules, which are the drag path's own", () => {
  it('writes NOTHING when the clamp leaves the section where it already is', async () => {
    // Home asks for 0. `Cold Open` occupies 0-2, so `clampMove` pushes the request back to exactly
    // where the section already sits and there is nothing to save. Two things are pinned at once:
    // the keyboard really does go through the shared clamp — an unclamped path would write 0 and
    // drop this section on top of Cold Open — and a no-op is never sent, because a PATCH that
    // changes nothing is a wasted round-trip that also puts an empty step in the undo history.
    renderTimeline();
    fireEvent.keyDown(moveHandle(), { key: 'Home' });
    await settle();
    expect(updateSection).not.toHaveBeenCalled();
  });

  it('refuses the blocked direction and allows the free one', async () => {
    // The other half of the same claim: the clamp must not be a blanket refusal. Left is blocked
    // by Cold Open; right has twelve seconds of room.
    renderTimeline();
    fireEvent.keyDown(moveHandle(), { key: 'ArrowLeft' });
    await settle();
    expect(updateSection, 'moved left into Cold Open').not.toHaveBeenCalled();

    fireEvent.keyDown(moveHandle(), { key: 'ArrowRight' });
    await vi.waitFor(() => expect(updateSection).toHaveBeenCalled());
  });

  it('will not trim an edge past the neighbour', async () => {
    // `End` on the trim-end handle asks for the clip's full 40 s. `clampTrim` stops at the next
    // section's start, 20 s. Overlapping sections render on top of each other and export
    // ambiguously, so an unclamped path writing 40 here is a real defect, not a cosmetic one.
    renderTimeline();
    fireEvent.keyDown(trimEnd(), { key: 'End' });
    await vi.waitFor(() => expect(updateSection).toHaveBeenCalled());

    const patch = updateSection.mock.calls[0]![2];
    expect(patch.end_sec, 'the section was trimmed over its neighbour').toBeCloseTo(20, 5);
    expect(patch.start_sec).toBeCloseTo(2, 5);
  });
});

describe('the keys it must not steal', () => {
  it('leaves Ctrl/Meta/Alt arrows to the browser', async () => {
    // Cmd+Left is "beginning of line"; Alt+Left is BACK on Windows and Linux. Swallowing either
    // breaks the surrounding page, and losing the editor to a mistimed Alt+Left loses the work.
    renderTimeline();
    const move = moveHandle();
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      fireEvent.keyDown(move, { key: 'ArrowRight', ...mods });
    }
    await settle();
    expect(updateSection).not.toHaveBeenCalled();
  });

  it('leaves Tab alone, so focus can still move on', async () => {
    renderTimeline();
    fireEvent.keyDown(moveHandle(), { key: 'Tab' });
    await settle();
    expect(updateSection).not.toHaveBeenCalled();
  });
});
