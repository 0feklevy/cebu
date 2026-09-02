/**
 * The editor renders every anchor the surface ledger claims for it. Deleting one
 * `{...tourAnchor('…')}` spread from `VideoEditor` fails here — before this file, it failed nowhere.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Simulation } from 'shared/src/generated/client-v1';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

vi.mock('../lib/firebase', () => ({
  useAuth: () => ({ loading: false, user: { uid: 'u1' } }),
  auth: { currentUser: null },
}));

const SIM = {
  id: 'sim-1', project_id: 'p1', name: 'Pendulum', status: 'ready',
  bridge_functions: [], created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Simulation;

const getEditorState = vi.fn(async () => ({
  videos: [], sections: [], simulations: [SIM], brollJobs: [], images: [], audioFiles: [],
}));

vi.mock('../lib/api', () => ({
  api: {
    getEditorState: (...a: unknown[]) => getEditorState(...(a as [])),
    listMarkers: vi.fn(async () => []),
    updateSimulation: vi.fn(),
  },
}));
vi.mock('../components/avatar/avatarApi', () => ({
  getAvatarCircles: vi.fn(async () => ({ config: null })),
  saveAvatarCircles: vi.fn(async () => ({ config: null })),
}));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { VideoEditor } from '../components/VideoEditor';

beforeEach(() => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('tour anchors — the editor', () => {
  it.each(SURFACE_ANCHORS.editor)('renders %s', async (anchor) => {
    const { container } = render(<VideoEditor projectId="p1" />);
    await waitFor(() => expect(getEditorState).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(anchorSelector(anchor))).not.toBeNull());
  });
});
