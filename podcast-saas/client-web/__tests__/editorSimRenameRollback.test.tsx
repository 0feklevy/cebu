/**
 * A failed simulation rename is rolled back and reported (frontend-editor-002).
 *
 * `commitRenameSim` writes the new name into local state first, then PATCHes:
 *
 *     setSimulations(prev => prev.map(s => s.id === id ? { ...s, name } : s)); // optimistic
 *     try { … } catch { /* revert on next list refresh *\/ }
 *
 * There is no "next list refresh" in an editor session — `loadData` runs on mount and on an
 * explicit reload, so a rejected PATCH left the Library showing a name the server never accepted,
 * indefinitely and silently. The user believes they renamed it; the viewer, the exports and every
 * other tab disagree.
 *
 * Both halves are asserted: the label goes back to what the server still holds, AND the failure is
 * on screen. Asserting only the rollback would pass for a fix that quietly undid the user's typing
 * with no explanation, which is its own bug.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Simulation } from 'shared/src/generated/client-v1';

const { updateSimulation } = vi.hoisted(() => ({ updateSimulation: vi.fn() }));

vi.mock('../lib/firebase', () => ({
  useAuth: () => ({ loading: false, user: { uid: 'u1' } }),
  auth: { currentUser: null },
}));

const SIM = {
  id: 'sim-1', project_id: 'p1', name: 'Pendulum', status: 'ready',
  bridge_functions: [], created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Simulation;

vi.mock('../lib/api', () => ({
  api: {
    getEditorState: vi.fn(async () => ({
      videos: [], sections: [], simulations: [SIM], brollJobs: [], images: [], audioFiles: [],
    })),
    listMarkers: vi.fn(async () => []),
    updateSimulation,
  },
}));

vi.mock('../components/avatar/avatarApi', () => ({
  getAvatarCircles: vi.fn(async () => ({ config: null })),
  saveAvatarCircles: vi.fn(async () => ({ config: null })),
}));

import { VideoEditor } from '../components/VideoEditor';

/** Open the rename input on the one simulation card and type a new name. */
async function typeNewName(next: string): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole('button', { name: /Rename simulation/i }));
  const input = await screen.findByLabelText<HTMLInputElement>('Simulation name');
  fireEvent.change(input, { target: { value: next } });
  return input;
}

beforeEach(() => {
  updateSimulation.mockReset();
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  // jsdom implements neither; the editor's tour and rename input both reach for them.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  HTMLElement.prototype.focus ??= function focus() {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('editor — simulation rename', () => {
  it('rolls the name back and tells the user when the write is rejected', async () => {
    updateSimulation.mockRejectedValue(new Error('403 you are not the owner'));

    render(<VideoEditor projectId="p1" />);
    const input = await typeNewName('Double pendulum');
    fireEvent.blur(input);

    await waitFor(() => { expect(updateSimulation).toHaveBeenCalledTimes(1); });

    // The card shows what the SERVER holds, not what the user typed.
    await waitFor(() => { expect(screen.getByText('Pendulum')).toBeTruthy(); });
    expect(screen.queryByText('Double pendulum')).toBeNull();

    // …and the reason is on screen, not only in the console.
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/rename/i);
    expect(notice.textContent).toMatch(/403 you are not the owner/);
  });

  it('keeps the server’s version of the name when the write succeeds', async () => {
    // Reconciliation, not just "leave the guess in place": the server may normalise what it stored.
    updateSimulation.mockResolvedValue({ ...SIM, name: 'Double Pendulum' });

    render(<VideoEditor projectId="p1" />);
    const input = await typeNewName('  Double pendulum  ');
    fireEvent.blur(input);

    await waitFor(() => { expect(screen.getByText('Double Pendulum')).toBeTruthy(); });
    expect(updateSimulation).toHaveBeenCalledWith('p1', 'sim-1', { name: 'Double pendulum' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
