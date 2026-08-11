/**
 * The Duplicate-project affordance, in both places it lives: the `HomeHero` project tiles and the
 * `HomeSidebar` project list.
 *
 * What is actually worth pinning here is not "a button exists" but the three things a user can get
 * wrong information from: that the control sits beside Delete and does not fire Delete; that the
 * copy is confirmed before minutes of media copying start; and that the flow POSTs, polls, and only
 * then shows the copy — because `duplicateProject` returns a JOB id, and a UI that treated it as a
 * project id would navigate to a 404.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

const SOURCE = {
  id: 'proj-1', org_id: 'org-1', title: 'Photosynthesis', topic: 'plants', status: 'ready',
  created_at: new Date().toISOString(), collab_role: 'owner', view_count: 0,
};
const COPY = { ...SOURCE, id: 'proj-2', title: 'Photosynthesis (copy)', status: 'ready' };

const { authState, api, poll } = vi.hoisted(() => {
  const poll = {
    /**
     * Successive responses the status endpoint hands back. Consumed in order, and the LAST one
     * sticks — a real status endpoint keeps reporting the same row until the job moves, and a queue
     * that fell back to a different default would make progress assertions race the poll.
     */
    queue: [] as Array<Record<string, unknown>>,
  };
  const api = {
    listProjects: vi.fn(async () => [SRC()]),
    listPlaylists: vi.fn(async () => []),
    // The sidebar renders its "Recent videos" list only alongside at least one playlist, so an
    // empty playlist is part of the fixture rather than an accident of it.
    listPlaylistsWithItems: vi.fn(async () => [{ id: 'pl-1', title: 'PL', items: [] }]),
    deleteProject: vi.fn(async () => undefined),
    renameProject: vi.fn(async () => undefined),
    duplicateProject: vi.fn(async () => ({ duplication_id: 'dup-1', status: 'queued' })),
    getProjectDuplication: vi.fn(async () => {
      if (poll.queue.length > 1) return poll.queue.shift()!;
      return poll.queue[0] ?? {
        id: 'dup-1', status: 'copying', target_project_id: null,
        objects_total: 4, objects_copied: 1, error: null,
      };
    }),
    getProject: vi.fn(async () => CPY()),
  };
  // Referenced lazily so the hoisted block does not close over module-level consts.
  function SRC(): unknown {
    return {
      id: 'proj-1', org_id: 'org-1', title: 'Photosynthesis', topic: 'plants', status: 'ready',
      created_at: new Date().toISOString(), collab_role: 'owner', view_count: 0,
    };
  }
  function CPY(): unknown {
    return { ...(SRC() as Record<string, unknown>), id: 'proj-2', title: 'Photosynthesis (copy)' };
  }
  const authState = {
    user: { uid: 'u1' }, loading: false, isAnonymous: false,
    getIdToken: async () => 't',
    signInAnonymouslyFn: async () => {}, signInWithGoogle: async () => {},
    signInWithEmail: async () => {}, signUpWithEmail: async () => {}, signOutUser: async () => {},
  };
  return { authState, api, poll };
});

vi.mock('@/lib/firebase', () => ({ useAuth: () => authState, auth: {} }));
vi.mock('@/lib/api', () => ({ api, getApiClient: () => api }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

import { HomeHero } from '../components/HomeHero';
import { HomeSidebar } from '../components/HomeSidebar';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  poll.queue.length = 0;
  localStorage.clear();
  api.listProjects.mockResolvedValue([{ ...SOURCE }]);
  api.duplicateProject.mockResolvedValue({ duplication_id: 'dup-1', status: 'queued' });
  api.getProject.mockResolvedValue({ ...COPY });
});
afterEach(cleanup);

/** The Duplicate control, found the way a user finds it: by its accessible name. */
function duplicateButton(): HTMLElement {
  return screen.getByRole('button', { name: /duplicate project/i });
}

describe.each([
  ['HomeHero', () => render(<HomeHero />)],
  ['HomeSidebar', () => render(<HomeSidebar />)],
] as const)('%s', (_name, mount) => {
  it('offers Duplicate next to Delete, and clicking it deletes nothing', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));

    const dup = duplicateButton();
    expect(dup).toBeTruthy();
    fireEvent.click(dup);
    await flush();

    // A confirm step first — the copy is minutes of media, not an undoable toggle.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(api.duplicateProject).not.toHaveBeenCalled();
    expect(api.deleteProject).not.toHaveBeenCalled();
  });

  it('POSTs on confirm, polls the job, and surfaces the copy only when it is ready', async () => {
    poll.queue.push(
      { id: 'dup-1', status: 'copying', target_project_id: null, objects_total: 4, objects_copied: 2, error: null },
      { id: 'dup-1', status: 'ready', target_project_id: 'proj-2', objects_total: 4, objects_copied: 4, error: null },
    );
    mount();
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));

    fireEvent.click(duplicateButton());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(api.duplicateProject).toHaveBeenCalledWith('proj-1'));
    // The POST hands back a JOB id; the copy is fetched only after the poll says ready.
    await waitFor(() => expect(api.getProject).toHaveBeenCalledWith('proj-2'));
    await waitFor(() => expect(screen.getByText(/Photosynthesis \(copy\)/)).toBeTruthy());
    expect(api.getProjectDuplication).toHaveBeenCalledWith('proj-1', 'dup-1');
  });

  it('reports progress while the copy runs', async () => {
    poll.queue.push({
      id: 'dup-1', status: 'copying', target_project_id: null,
      objects_total: 4, objects_copied: 1, error: null,
    });
    mount();
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));
    fireEvent.click(duplicateButton());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(screen.getByText(/Copying 25%/)).toBeTruthy());
    // The control renames itself to the progress, so it is no longer "Duplicate project" — and it
    // is disabled, because a second POST would be refused anyway and offering it invites the
    // double-click.
    expect(screen.queryByRole('button', { name: /duplicate project/i })).toBeNull();
    const running = screen.getByRole('button', { name: /Copying 25%/ });
    expect(running.hasAttribute('disabled')).toBe(true);
  });

  it('states a refusal in place instead of leaving a spinner', async () => {
    api.duplicateProject.mockRejectedValueOnce(
      new Error('This project stores about 120 GB of media, which is over the 50 GB duplication limit.'));
    mount();
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));
    fireEvent.click(duplicateButton());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(screen.getByText(/over the 50 GB duplication limit/)).toBeTruthy());
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it('reports a mid-copy failure and adds no project', async () => {
    poll.queue.push({
      id: 'dup-1', status: 'failed', target_project_id: null,
      objects_total: 4, objects_copied: 2, error: 'Duplication failed. Nothing was created; you can try again.',
    });
    mount();
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));
    fireEvent.click(duplicateButton());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(screen.getByText(/Nothing was created/)).toBeTruthy());
    expect(api.getProject).not.toHaveBeenCalled();
    expect(screen.queryByText(/Photosynthesis \(copy\)/)).toBeNull();
  });

  /**
   * The confirm dialog is dismissed on EVERY terminal outcome, not only success.
   *
   * Success closes it because `onReady` does; a failure has no such callback, so the modal stays up
   * — sitting on top of the "Copy failed" message it is meant to hand the user, offering a Duplicate
   * button that is no longer busy and a Cancel that reads like the only way out of a run that has
   * already ended.
   */
  it.each([
    ['a mid-copy failure', /Nothing was created/, () => {
      poll.queue.push({
        id: 'dup-1', status: 'failed', target_project_id: null,
        objects_total: 4, objects_copied: 2, error: 'Duplication failed. Nothing was created; you can try again.',
      });
    }],
    ['a refusal at the POST', /over the 50 GB duplication limit/, () => {
      api.duplicateProject.mockRejectedValueOnce(
        new Error('This project stores about 120 GB of media, which is over the 50 GB duplication limit.'));
    }],
  ])('closes the confirm dialog after %s', async (_case, shown, arrange) => {
    arrange();
    mount();
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));
    fireEvent.click(duplicateButton());
    await flush();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    // The outcome reaches the surface…
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(shown));
    // …and is not left sitting behind a modal that no longer has anything to confirm.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The control is offered again, so the user can act on what they were just told.
    expect(screen.getByRole('button', { name: /Copy failed/i }).hasAttribute('disabled')).toBe(false);
  });
});

describe('HomeHero specifics', () => {
  it('hides Duplicate on a project shared with you, exactly as it hides Delete', async () => {
    api.listProjects.mockResolvedValue([{ ...SOURCE, collab_role: 'collaborator' }]);
    render(<HomeHero />);
    await waitFor(() => expect(screen.getByText('Photosynthesis')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /duplicate project/i })).toBeNull();
    expect(screen.queryByTitle('Delete project')).toBeNull();
  });

  it('writes the copy through to the localStorage cache so it survives a remount', async () => {
    poll.queue.push({
      id: 'dup-1', status: 'ready', target_project_id: 'proj-2',
      objects_total: 1, objects_copied: 1, error: null,
    });
    render(<HomeHero />);
    await waitFor(() => expect(screen.getAllByTitle('Delete project').length).toBeGreaterThan(0));
    fireEvent.click(duplicateButton());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(screen.getByText(/Photosynthesis \(copy\)/)).toBeTruthy());
    await waitFor(() => {
      const cached = JSON.parse(localStorage.getItem('hero_projects_v1') ?? '[]') as Array<{ id: string }>;
      expect(cached.some((p) => p.id === 'proj-2')).toBe(true);
    });
  });
});
