/**
 * The import gallery — search, categorise, multi-select, and what happens when one import fails.
 *
 * ── WHY THESE ARE THE ASSERTIONS ──────────────────────────────────────────────────────────────
 *
 * The dialog was rebuilt from a two-step text list into a gallery, and the parts worth pinning are
 * not the layout (jsdom cannot see it) but the behaviour a redesign can silently lose:
 *
 *   • it aggregates across ALL other projects rather than making the author pick one first;
 *   • a project that fails to list does not take the whole dialog down with it;
 *   • search matches the PROJECT name too, not only the simulation name;
 *   • selection is multiple, and Import sends every selected id;
 *   • a partial failure keeps the survivors selected and the dialog OPEN.
 *
 * That last one is the one a re-write is most likely to get wrong, and the most expensive: closing
 * on a partial result reports success for work that did not happen and strands the retry.
 *
 * `SimSurface` is stubbed. It renders a real <iframe> whose src the CSP would reject in jsdom, and
 * nothing here is about the frame — the previews are covered where frames are covered, in the
 * browser suites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ImportSimulationDialog } from '../components/ImportSimulationDialog';
import type { Simulation } from 'shared/src/generated/client-v1';

const listProjects = vi.fn();
const listSimulations = vi.fn();
const importSimulation = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listProjects: (...a: unknown[]) => listProjects(...a),
    listSimulations: (...a: unknown[]) => listSimulations(...a),
    importSimulation: (...a: unknown[]) => importSimulation(...a),
  },
}));

// A frame in jsdom loads nothing and the CSP would refuse the URL anyway; the previews belong to
// the browser suites. The stub keeps the src observable so a test could still assert on it.
vi.mock('../lib/sim/SimSurface', () => ({
  SimSurface: ({ src, title }: { src?: string | null; title?: string }) =>
    React.createElement('div', { 'data-simsurface': src ?? '', 'data-title': title }),
}));

// jsdom ships no IntersectionObserver, and the lazy previews mount through one.
class FakeIO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe() { this.cb([{ isIntersecting: true }]); }
  disconnect() {}
  unobserve() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;

const sim = (id: string, name: string, created = '2026-01-01T00:00:00Z'): Simulation => ({
  id, project_id: 'p', name,
  storage_prefix: `simulations/p/${id}`, entry_file: `https://api.test/sim-public/simulations/p/${id}/index.html`,
  bridge_functions: null, status: 'ready', error: null, created_at: created,
} as Simulation);

const DEST = 'dest-project';

beforeEach(() => {
  listProjects.mockReset();
  listSimulations.mockReset();
  importSimulation.mockReset();
  listProjects.mockResolvedValue([
    { id: DEST, title: 'Destination' },
    { id: 'p1', title: 'Orbital Mechanics' },
    { id: 'p2', title: 'Wave Optics' },
  ]);
  listSimulations.mockImplementation(async (pid: string) => {
    if (pid === 'p1') return [sim('s1', 'Kepler orbits', '2026-03-01T00:00:00Z'), sim('s2', 'Lagrange points')];
    if (pid === 'p2') return [sim('s3', 'Double slit', '2026-02-01T00:00:00Z')];
    return [];
  });
  importSimulation.mockImplementation(async (_dest: string, id: string) => sim(id, `imported-${id}`));
});

afterEach(cleanup);

function open(overrides: Partial<React.ComponentProps<typeof ImportSimulationDialog>> = {}) {
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(<ImportSimulationDialog projectId={DEST} onImported={onImported} onClose={onClose} {...overrides} />);
  return { onImported, onClose };
}

const card = (name: string): HTMLElement => screen.getByText(name).closest('.avatar-gc') as HTMLElement;
const checkboxIn = (name: string): HTMLInputElement =>
  card(name).querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('it gathers every other project, in one view', () => {
  it('shows simulations from ALL other projects without making you pick one first', async () => {
    open();
    await screen.findByText('Kepler orbits');
    expect(screen.getByText('Lagrange points')).toBeTruthy();
    expect(screen.getByText('Double slit')).toBeTruthy();
  });

  it('never offers the destination project as a source', async () => {
    open();
    await screen.findByText('Kepler orbits');
    expect(listSimulations).not.toHaveBeenCalledWith(DEST);
    expect(screen.queryByText('Destination')).toBeNull();
  });

  it('skips simulations that are not ready', async () => {
    listSimulations.mockImplementation(async (pid: string) =>
      pid === 'p1' ? [sim('s1', 'Kepler orbits'), { ...sim('s9', 'Still building'), status: 'processing' }] : []);
    open();
    await screen.findByText('Kepler orbits');
    expect(screen.queryByText('Still building')).toBeNull();
  });

  it('one unreadable project does not take the whole dialog down', async () => {
    // Promise.allSettled, not Promise.all. With `all`, a single failing project hides every other
    // project's work behind an error — the dialog would be empty for a reason unrelated to it.
    listSimulations.mockImplementation(async (pid: string) => {
      if (pid === 'p1') throw new Error('403');
      return [sim('s3', 'Double slit')];
    });
    open();
    await screen.findByText('Double slit');
  });
});

describe('search and categorise', () => {
  it('filters by simulation name', async () => {
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.change(screen.getByPlaceholderText('Search simulations…'), { target: { value: 'kepler' } });
    expect(screen.getByText('Kepler orbits')).toBeTruthy();
    expect(screen.queryByText('Double slit')).toBeNull();
  });

  it('ALSO filters by project name — an author may be reaching for either', async () => {
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.change(screen.getByPlaceholderText('Search simulations…'), { target: { value: 'optics' } });
    expect(screen.getByText('Double slit')).toBeTruthy();
    expect(screen.queryByText('Kepler orbits')).toBeNull();
  });

  it('a project pill narrows to that project, and All restores', async () => {
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(screen.getByRole('button', { name: /Wave Optics/ }));
    expect(screen.queryByText('Kepler orbits')).toBeNull();
    expect(screen.getByText('Double slit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /All projects/ }));
    expect(screen.getByText('Kepler orbits')).toBeTruthy();
  });

  it('only offers pills for projects that actually contributed something', async () => {
    // A category with nothing in it is a dead end the author has to discover by clicking.
    listSimulations.mockImplementation(async (pid: string) => (pid === 'p1' ? [sim('s1', 'Kepler orbits')] : []));
    open();
    await screen.findByText('Kepler orbits');
    expect(screen.queryByRole('button', { name: /Wave Optics/ })).toBeNull();
  });
});

describe('multi-select', () => {
  it('imports EVERY selected simulation, not just one', async () => {
    const { onImported, onClose } = open();
    await screen.findByText('Kepler orbits');

    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(checkboxIn('Double slit'));
    expect(screen.getByRole('button', { name: 'Import 2' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));

    await waitFor(() => expect(importSimulation).toHaveBeenCalledTimes(2));
    expect(importSimulation.mock.calls.map((c) => c[1]).sort()).toEqual(['s1', 's3']);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported.mock.calls[0][0]).toHaveLength(2);
    // A clean sweep closes; a partial one does not (see below).
    expect(onClose).toHaveBeenCalled();
  });

  it('the Import button is inert until something is selected', async () => {
    open();
    await screen.findByText('Kepler orbits');
    const go = screen.getByRole('button', { name: 'Select simulations' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
  });

  it('unticking removes it from the selection', async () => {
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(checkboxIn('Kepler orbits'));
    expect(screen.getByRole('button', { name: 'Select simulations' })).toBeTruthy();
  });
});

describe('a partial failure', () => {
  it('keeps what landed, keeps the rest SELECTED, and does not close', async () => {
    // The expensive mistake a rewrite makes: reporting success for a partial result and closing,
    // so the retry is unreachable and the author believes all four arrived.
    importSimulation.mockImplementation(async (_d: string, id: string) => {
      if (id === 's3') throw new Error('Source is still processing');
      return sim(id, `imported-${id}`);
    });
    const { onImported, onClose } = open();
    await screen.findByText('Kepler orbits');

    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(checkboxIn('Double slit'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));

    // The message sits beside an icon, so the text node is split — assert through the role the
    // element already carries rather than reaching for an exact-match text node.
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Source is still processing'));
    // The one that worked is reported…
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0][0]).toHaveLength(1);
    // …the failure is still selected, so Import retries only it…
    expect(screen.getByRole('button', { name: 'Import 1' })).toBeTruthy();
    // …and the dialog stays open.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces the server\'s own message rather than a generic one', async () => {
    importSimulation.mockRejectedValue(new Error('Source is private'));
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Source is private'));
  });
});

describe('empty and loading states', () => {
  it('says so when there is nothing to import', async () => {
    listSimulations.mockResolvedValue([]);
    open();
    await screen.findByText('No ready simulations in your other projects yet.');
  });

  it('distinguishes "nothing here" from "nothing matches your search"', async () => {
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.change(screen.getByPlaceholderText('Search simulations…'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('reports a failure to load projects instead of showing an empty gallery', async () => {
    listProjects.mockRejectedValue(new Error('offline'));
    open();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
  });
});

describe('the full-screen preview', () => {
  it('opens portaled to body, above the gallery', async () => {
    // Same class of bug as the preset dialogs: rendered inline it would open BEHIND the gallery's
    // own fixed overlay, and every state assertion would still pass.
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(screen.getByLabelText('Preview Kepler orbits full screen'));
    const fs = await screen.findByRole('dialog', { name: 'Kepler orbits preview' });
    expect(fs.parentElement).toBe(document.body);
  });
});
