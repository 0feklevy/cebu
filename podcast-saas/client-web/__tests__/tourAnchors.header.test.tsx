/**
 * The project header renders the preview, share and export anchors the editor tour points at.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

const { api } = vi.hoisted(() => {
  const PROJECT = {
    id: 'proj-1', org_id: 'org-1', title: 'Photosynthesis', topic: 'plants', status: 'ready',
    visibility: 'private', created_at: '2026-01-01T00:00:00.000Z', collab_role: 'owner', view_count: 0,
  };
  const known: Record<string, unknown> = {
    getProject: async () => PROJECT,
    listVideos: async () => [{ id: 'v1', is_broll: false, width: 1920, height: 1080 }],
    getProjectExport: async () => null,
    startProjectExport: async () => ({ export_id: 'exp-1', status: 'queued' }),
    cancelProjectExport: async () => null,
    // The share popover's public tab reads the permalink; the shape is what the editor destructures.
    getProjectPermalink: async () => ({ slug: null, permalinkUrl: null, suggestedSlug: 'photosynthesis', baseUrl: 'https://flowvid.example' }),
    listProjectCollaborators: async () => ({ collaborators: [] }),
  };
  // Anything the header (or a child) reaches for beyond the known reads resolves to an empty list.
  return { api: new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : async () => []) }) };
});

vi.mock('@/lib/firebase', () => ({ useAuth: () => ({ loading: false, user: { uid: 'u1', isAnonymous: false } }), auth: {} }));
vi.mock('@/lib/api', () => ({
  api,
  getApiClient: () => api,
  createShareToken: vi.fn(),
  // A project that already has a private link: the Share button opens the popover directly.
  getShareToken: vi.fn(async () => ({ shareToken: 'tok', shareUrl: 'https://flowvid.example/s/tok' })),
  revokeShareToken: vi.fn(),
  startProjectExport: vi.fn(),
  isDegradedOnlyRefusal: () => false,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { ProjectHeader } from '../components/ProjectHeader';

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

describe('tour anchors — the project header', () => {
  it.each(SURFACE_ANCHORS.header)('renders %s', async (anchor) => {
    render(<ProjectHeader projectId="proj-1" />);
    if (anchor === 'share') {
      // The share anchor lives inside the share popover (a portal), on its public tab.
      const button = await screen.findByRole('button', { name: /^share$/i });
      fireEvent.click(button);
    }
    await waitFor(() => expect(document.querySelector(anchorSelector(anchor))).not.toBeNull());
  });
});
