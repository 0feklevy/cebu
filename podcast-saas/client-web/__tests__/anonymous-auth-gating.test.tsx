/**
 * Regression tests for production-audit run 29528323804:
 * anonymous rendering of the homepage components must NOT issue the protected
 * workspace API calls (GET /api/v1/projects, GET /api/v1/playlists) — those
 * endpoints require auth by design and 401 for anonymous visitors.
 *
 * The gate is canLoadPrivateWorkspace(): fetch only after Firebase auth
 * initialization completes AND a signed-in user exists.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canLoadPrivateWorkspace } from '../lib/authGate';

// vitest's jsdom environment does not expose localStorage on the test global —
// the components' cache helpers (and our beforeEach reset) need a working one.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const { authState, apiSpies, apiProxy } = vi.hoisted(() => {
  const authState = {
    user: null as null | { uid: string },
    loading: false,
    isAnonymous: false,
    getIdToken: async () => null as string | null,
    signInAnonymouslyFn: async () => {},
    signInWithGoogle: async () => {},
    signInWithEmail: async () => {},
    signUpWithEmail: async () => {},
    signOutUser: async () => {},
  };
  // Every api.<method>() becomes a spy resolving to []. Lets us assert exactly
  // which endpoints were (not) hit without enumerating the whole client.
  const apiSpies: Record<string, ReturnType<typeof vi.fn>> = {};
  const apiProxy = new Proxy(
    {},
    { get: (_t, prop: string) => (apiSpies[prop] ??= vi.fn(async () => [])) },
  );
  return { authState, apiSpies, apiProxy };
});

vi.mock('@/lib/firebase', () => ({
  useAuth: () => authState,
  auth: {},
}));
vi.mock('@/lib/api', () => ({
  api: apiProxy,
  getApiClient: () => apiProxy,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
// UserSettingsDialog (rendered via UserProfileButton in the sidebar) needs the
// theme context; the tests exercise data loading, not theming.
vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

import { HomeHero } from '../components/HomeHero';
import { HomeSidebar } from '../components/HomeSidebar';
import { PlaylistsPanel } from '../components/PlaylistsPanel';

const WORKSPACE_CALLS = ['listProjects', 'listPlaylists', 'listPlaylistsWithItems'] as const;

const flush = () => new Promise((r) => setTimeout(r, 0));

function callCounts(): Record<string, number> {
  return Object.fromEntries(WORKSPACE_CALLS.map((name) => [name, apiSpies[name]?.mock.calls.length ?? 0]));
}

beforeEach(() => {
  for (const spy of Object.values(apiSpies)) spy.mockClear();
  authState.user = null;
  authState.loading = false;
  localStorage.clear();
});
afterEach(cleanup);

describe('canLoadPrivateWorkspace (the gate itself)', () => {
  it('is false while auth is initializing, false for anonymous, true for a signed-in user', () => {
    expect(canLoadPrivateWorkspace(true, null)).toBe(false);
    expect(canLoadPrivateWorkspace(true, { uid: 'u' })).toBe(false); // never before init completes
    expect(canLoadPrivateWorkspace(false, null)).toBe(false);
    expect(canLoadPrivateWorkspace(false, undefined)).toBe(false);
    expect(canLoadPrivateWorkspace(false, { uid: 'u' })).toBe(true);
  });
});

describe('anonymous rendering issues NO protected workspace calls', () => {
  it('HomeHero (homepage): no /api/v1/projects call for an anonymous visitor', async () => {
    render(<HomeHero />);
    await flush();
    expect(callCounts(), JSON.stringify(callCounts())).toEqual({ listProjects: 0, listPlaylists: 0, listPlaylistsWithItems: 0 });
  });

  it('HomeSidebar: no /api/v1/projects or /api/v1/playlists calls for an anonymous visitor', async () => {
    render(<HomeSidebar />);
    await flush();
    expect(apiSpies['listProjects']?.mock.calls.length ?? 0).toBe(0);
    expect(apiSpies['listPlaylistsWithItems']?.mock.calls.length ?? 0).toBe(0);
  });

  it('PlaylistsPanel: no /api/v1/playlists call for an anonymous visitor', async () => {
    render(<PlaylistsPanel />);
    await flush();
    expect(apiSpies['listPlaylists']?.mock.calls.length ?? 0).toBe(0);
  });

  it('nothing fires while Firebase auth is still initializing', async () => {
    authState.loading = true;
    render(<HomeHero />);
    render(<HomeSidebar />);
    render(<PlaylistsPanel />);
    await flush();
    expect(callCounts()).toEqual({ listProjects: 0, listPlaylists: 0, listPlaylistsWithItems: 0 });
  });
});

describe('signed-in rendering DOES load the workspace (gate does not over-block)', () => {
  it('HomeHero fetches projects once a user exists', async () => {
    authState.user = { uid: 'user-1' };
    render(<HomeHero />);
    await waitFor(() => expect(apiSpies['listProjects'].mock.calls.length).toBe(1));
  });

  it('HomeSidebar fetches projects + playlists once a user exists', async () => {
    authState.user = { uid: 'user-1' };
    render(<HomeSidebar />);
    await waitFor(() => {
      expect(apiSpies['listProjects'].mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(apiSpies['listPlaylistsWithItems'].mock.calls.length).toBe(1);
    });
  });

  it('PlaylistsPanel fetches playlists once a user exists', async () => {
    authState.user = { uid: 'user-1' };
    render(<PlaylistsPanel />);
    await waitFor(() => expect(apiSpies['listPlaylists'].mock.calls.length).toBe(1));
  });
});
