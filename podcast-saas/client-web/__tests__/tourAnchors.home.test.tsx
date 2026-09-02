/**
 * The home page renders the anchors its walkthrough points at — the projects grid and the
 * playlists panel — and carries the button that opens it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_ANCHORS, anchorSelector } from './helpers/tourSurfaces';

const { api } = vi.hoisted(() => {
  const known: Record<string, unknown> = { listProjects: async () => [], listPlaylists: async () => [] };
  return { api: new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : async () => []) }) };
});

vi.mock('@/lib/firebase', () => ({ useAuth: () => ({ loading: false, user: { uid: 'u1', isAnonymous: false } }), auth: {} }));
vi.mock('@/lib/api', () => ({ api, getApiClient: () => api }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { HomeHero } from '../components/HomeHero';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('tour anchors — the home page', () => {
  it.each(SURFACE_ANCHORS.home)('renders %s', async (anchor) => {
    const { container } = render(<HomeHero />);
    await waitFor(() => expect(container.querySelector(anchorSelector(anchor))).not.toBeNull());
  });

  it('offers the walkthrough', () => {
    render(<HomeHero />);
    expect(screen.getByRole('button', { name: /walk me through/i })).toBeTruthy();
  });
});
