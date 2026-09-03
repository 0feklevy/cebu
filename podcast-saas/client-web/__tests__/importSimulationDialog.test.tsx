/**
 * The import gallery — one request, stills first, multi-select, and what happens when one
 * import fails (night run 2026-09-03 §6).
 *
 * The parts worth pinning are the behaviours a redesign can silently lose:
 *   • ONE request lists every importable simulation (no per-project fan-out);
 *   • a simulation with a poster renders a STILL, not a live frame; "Play" mounts the frame;
 *   • search matches the PROJECT name too; project pills narrow the grid;
 *   • selection is multiple, and Import sends every selected id;
 *   • a partial failure keeps the survivors selected and the dialog OPEN;
 *   • the concurrency helper never runs more than its limit at once and reports the first failure.
 *
 * `SimSurface` is stubbed: a frame in jsdom loads nothing and the CSP would refuse the URL anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ImportSimulationDialog, runWithLimit } from '../components/ImportSimulationDialog';
import type { ImportableSimulation } from 'shared/src/generated/client-v1';

const listImportableSimulations = vi.fn();
const importSimulation = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listImportableSimulations: (...a: unknown[]) => listImportableSimulations(...a),
    importSimulation: (...a: unknown[]) => importSimulation(...a),
  },
}));

vi.mock('../lib/sim/SimSurface', () => ({
  SimSurface: ({ src, title }: { src?: string | null; title?: string }) =>
    React.createElement('div', { 'data-simsurface': src ?? '', 'data-title': title }),
}));

class FakeIO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe() { this.cb([{ isIntersecting: true }]); }
  disconnect() {}
  unobserve() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;

const sim = (id: string, name: string, project: { id: string; title: string }, extra: Partial<ImportableSimulation> = {}): ImportableSimulation => ({
  id, project_id: project.id, project_title: project.title, name,
  storage_prefix: `simulations/${project.id}/${id}`,
  entry_file: `https://api.test/sim-public/simulations/${project.id}/${id}/index.html`,
  bridge_functions: null, status: 'ready', error: null, created_at: '2026-01-01T00:00:00Z',
  poster_url: null,
  ...extra,
} as ImportableSimulation);

const P1 = { id: 'p1', title: 'Orbital Mechanics' };
const P2 = { id: 'p2', title: 'Wave Optics' };
const DEST = 'dest-project';

beforeEach(() => {
  listImportableSimulations.mockReset();
  importSimulation.mockReset();
  listImportableSimulations.mockResolvedValue([
    sim('s1', 'Kepler orbits', P1, { created_at: '2026-03-01T00:00:00Z', poster_url: 'https://cdn.test/posters/s1/compact.png' }),
    sim('s2', 'Lagrange points', P1),
    sim('s3', 'Double slit', P2, { created_at: '2026-02-01T00:00:00Z' }),
  ]);
  importSimulation.mockImplementation(async (_dest: string, id: string) => ({ id, name: `imported-${id}` }));
});
afterEach(cleanup);

function open() {
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(<ImportSimulationDialog projectId={DEST} onImported={onImported} onClose={onClose} />);
  return { onImported, onClose };
}

const card = (name: string): HTMLElement => screen.getByText(name).closest('.import-sim-card') as HTMLElement;
const checkboxIn = (name: string): HTMLInputElement => card(name).querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('the gallery is a bounded panel on a backdrop, and the backdrop is a way out', () => {
  it('the panel is NOT the fixed surface — the overlay behind it is', async () => {
    // v0.3.0 shipped the dialog as its own `position:fixed;inset:0` element, so it filled the
    // screen and any ancestor transform could trap it. The overlay is the fixed layer now; the
    // panel is a bounded box inside it (~90%), the way Video settings has always been.
    open();
    await screen.findByText('Kepler orbits');
    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('import-sim');
    expect(panel.parentElement?.className).toBe('import-sim__overlay');
  });

  it('clicking the backdrop closes it; clicking inside the panel does not', async () => {
    const { onClose } = open();
    await screen.findByText('Kepler orbits');
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a click on the backdrop MID-IMPORT is ignored — closing would strand the copy in flight', async () => {
    let release: (v: unknown) => void = () => {};
    importSimulation.mockImplementation(() => new Promise(r => { release = r; }));
    const { onClose } = open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(screen.getByRole('button', { name: /^import/i }));

    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    await waitFor(() => expect(importSimulation).toHaveBeenCalled());
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();

    // Escape is refused for the same reason.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // Let the import finish inside act so the unmount does not race a state update.
    await act(async () => { release({ id: 's1', name: 'imported-s1' }); });
  });
});

describe('one request, every project', () => {
  it('lists every importable simulation from ONE request that excludes the destination', async () => {
    open();
    expect(await screen.findByText('Kepler orbits')).toBeTruthy();
    expect(screen.getByText('Lagrange points')).toBeTruthy();
    expect(screen.getByText('Double slit')).toBeTruthy();
    expect(listImportableSimulations).toHaveBeenCalledTimes(1);
    expect(listImportableSimulations).toHaveBeenCalledWith(DEST);
  });

  it('renders a STILL for a simulation with a poster and a live frame only after Play; no poster means a live frame', async () => {
    open();
    await screen.findByText('Kepler orbits');
    const withPoster = card('Kepler orbits');
    expect(withPoster.querySelector('img.import-sim-card__still')?.getAttribute('src')).toBe('https://cdn.test/posters/s1/compact.png');
    expect(withPoster.querySelector('[data-simsurface]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /play kepler orbits preview/i }));
    expect(withPoster.querySelector('[data-simsurface]')).not.toBeNull();

    const without = card('Lagrange points');
    expect(without.querySelector('img.import-sim-card__still')).toBeNull();
    expect(without.querySelector('[data-simsurface]')).not.toBeNull();
  });

  it('is a full-screen dialog, not a panel', async () => {
    open();
    await screen.findByText('Kepler orbits');
    const dialog = screen.getByRole('dialog', { name: /import simulations/i });
    expect(dialog.className).toContain('import-sim');
    expect(dialog.querySelector('.avatar-gallery__panel')).toBeNull();
  });
});

describe('search and project pills', () => {
  it('matches the project name too, and a pill narrows to one project', async () => {
    open();
    await screen.findByText('Kepler orbits');
    fireEvent.change(screen.getByLabelText(/search simulations/i), { target: { value: 'optics' } });
    expect(screen.queryByText('Kepler orbits')).toBeNull();
    expect(screen.getByText('Double slit')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/search simulations/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Orbital Mechanics/ }));
    expect(screen.getByText('Kepler orbits')).toBeTruthy();
    expect(screen.queryByText('Double slit')).toBeNull();
  });
});

describe('multi-select and import', () => {
  it('imports every selected simulation, reports them, and closes on a clean sweep', async () => {
    const { onImported, onClose } = open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(checkboxIn('Double slit'));
    fireEvent.click(screen.getByRole('button', { name: /^import 2$/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(importSimulation.mock.calls.map((c) => c[1]).sort()).toEqual(['s1', 's3']);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0][0]).toHaveLength(2);
  });

  it('a partial failure keeps the survivors selected, shows the error, and stays OPEN', async () => {
    importSimulation.mockImplementation(async (_d: string, id: string) => {
      if (id === 's3') throw new Error('409 that simulation is still processing');
      return { id, name: `imported-${id}` };
    });
    const { onImported, onClose } = open();
    await screen.findByText('Kepler orbits');
    fireEvent.click(checkboxIn('Kepler orbits'));
    fireEvent.click(checkboxIn('Double slit'));
    fireEvent.click(screen.getByRole('button', { name: /^import 2$/i }));
    await screen.findByRole('alert');
    expect(onClose).not.toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(checkboxIn('Kepler orbits').checked).toBe(false);   // landed
    expect(checkboxIn('Double slit').checked).toBe(true);      // still selected for retry
  });
});

describe('runWithLimit', () => {
  it('never exceeds the limit, keeps result order, and surfaces the first failure', async () => {
    let inFlight = 0, peak = 0;
    const task = (v: number, fail = false) => async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (fail) throw new Error(`boom ${v}`);
      return v;
    };
    expect(await runWithLimit([task(1), task(2), task(3), task(4), task(5)], 2)).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    await expect(runWithLimit([task(1), task(2, true), task(3)], 3)).rejects.toThrow('boom 2');
  });
});
