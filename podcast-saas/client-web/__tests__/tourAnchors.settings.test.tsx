/**
 * Project settings render every anchor the settings tour points at — for a landscape project,
 * which is the one that shows the Smart Crop card (a portrait project is never cropped, §3).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from 'shared/src/generated/client-v1';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

const PROJECT = {
  id: 'proj-1', org_id: 'org-1', title: 'Photosynthesis', topic: 'plants', status: 'ready',
  visibility: 'private', created_at: '2026-01-01T00:00:00.000Z', collab_role: 'owner', view_count: 0,
} as unknown as Project;
const { api } = vi.hoisted(() => {
  const known: Record<string, unknown> = {
    getProject: async () => ({ id: 'proj-1', title: 'Photosynthesis', status: 'ready', visibility: 'private', collab_role: 'owner' }),
    listVideos: async () => [{ id: 'v1', is_broll: false, width: 1920, height: 1080, created_at: '2026-01-01T00:00:00.000Z' }],
    listProjectCollaborators: async () => ({ collaborators: [] }),
  };
  return { api: new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : async () => []) }) };
});

vi.mock('@/lib/firebase', () => ({ useAuth: () => ({ loading: false, user: { uid: 'u1', isAnonymous: false } }), auth: {} }));
vi.mock('@/lib/api', () => ({ api, getApiClient: () => api }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));
vi.mock('../components/avatar/avatarApi', () => ({
  getAvatarCircles: vi.fn(async () => ({ config: null })),
  saveAvatarCircles: vi.fn(async () => ({ config: null })),
  getAvatarConfig: vi.fn(async () => ({ config: {} })),
  saveAvatarConfig: vi.fn(async () => ({ config: {} })),
  getByokStatus: vi.fn(async () => ({})),
  listAnamResources: vi.fn(async () => ({ data: [] })),
  listAvatarTools: vi.fn(async () => ({ tools: [] })),
  listKnowledgeDocs: vi.fn(async () => ({ data: [] })),
  uploadKnowledgeDoc: vi.fn(), deleteKnowledgeDoc: vi.fn(),
}));

import { ProjectSettingsPanel } from '../components/ProjectSettingsPanel';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'matchMedia'); });

describe('tour anchors — project settings', () => {
  it.each(SURFACE_ANCHORS.settings)('renders %s', async (anchor) => {
    render(<ProjectSettingsPanel projectId="proj-1" project={PROJECT} onProjectChange={() => {}} />);
    // The panel is a drawer (a portal) behind its own trigger button.
    fireEvent.click(screen.getAllByRole('button', { name: /settings/i })[0]!);
    await waitFor(() => expect(document.querySelector(anchorSelector(anchor))).not.toBeNull());
  });
});
