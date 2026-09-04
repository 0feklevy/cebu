/**
 * A simulation a saved setup BRINGS has to arrive in the picker.
 *
 * The feature the owner asked for is "like duplicate, but between projects": load a setup saved on
 * one video onto a section of another, and the simulation it was built against comes with it. The
 * server half worked. The client half handed the new simulation up to `VideoEditor`, which
 * REPLACED a matching entry in its list — and a package this project has never seen matches
 * nothing, so it was dropped on the floor. The section pointed at a simulation the editor's own
 * picker did not list.
 *
 * Two assertions, one per half of the chain, because the halves fail independently:
 *   • the panel hands the brought simulation up (and the 409 path does too — a script that does
 *     not fit still leaves the package attached);
 *   • the list appends what it has never seen instead of silently discarding it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Simulation, TimelineSection } from 'shared/src/generated/client-v1';
import { upsertById } from '../lib/simulationList';

const listBridgePresets = vi.fn();
const bridgePresetFit = vi.fn();
const applyBridgePreset = vi.fn();

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { getIdToken: async () => 't' } }) }));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));
vi.mock('../lib/api', () => ({
  api: new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === 'listBridgePresets') return listBridgePresets;
      if (prop === 'bridgePresetFit') return bridgePresetFit;
      if (prop === 'applyBridgePreset') return applyBridgePreset;
      return vi.fn(async () => []);
    },
  }),
}));

import { SectionEditor } from '../components/SectionEditor';

const BROUGHT = { id: 'sim-copy', project_id: 'proj-1', name: 'Boids', status: 'ready' } as unknown as Simulation;

const PRESET = {
  id: 'preset-1', label: 'Plucking a boid', source_simulation_id: 'sim-source',
  source_project_title: 'Flocking', source_importable: true, created_at: '2026-01-01T00:00:00.000Z',
};

/** A section with NO simulation — the case the whole feature exists for. */
const section = (): TimelineSection => ({
  id: 'sec-a', project_id: 'proj-1', video_file_id: 'vid-1', start_sec: 0, end_sec: 10,
  type: 'simulation', track: 'main', label: 'A', notes: null, sort_order: 0,
  simulation_url: null, simulation_served_url: null, simulation_id: null,
  sim_script: 'main', sim_prompt: null, simple_ui: false, auto_script: true, sim_meta: null,
  global_offset_sec: null, clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as TimelineSection);

function mount(onSimulationUpdate: (s: Simulation) => void) {
  return render(
    <SectionEditor
      section={section()}
      projectId="proj-1"
      simulations={[]}
      videos={[]}
      videoUrls={{}}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      onSimulationUpdate={onSimulationUpdate}
    />,
  );
}

beforeEach(() => {
  listBridgePresets.mockResolvedValue({ presets: [PRESET] });
  bridgePresetFit.mockResolvedValue({
    path: 'recipe',
    verdict: { path: 'recipe', why: 'no-target-simulation' },
    description: 'This section has no simulation of its own.',
    preset: PRESET,
    bring: { needed: true, possible: true, source_name: 'Boids', description: 'Brings “Boids” into this project.' },
  });
  applyBridgePreset.mockResolvedValue({
    path: 'artifact',
    section: { ...section(), simulation_id: 'sim-copy' },
    brought: { imported: true, simulation: BROUGHT },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'matchMedia'); });

/** The "Reuse this setup" card lives behind the collapsed-by-default Advanced disclosure —
 *  deliberately rendered even on a section with NO simulation, which this feature exists for. */
function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: /advanced — controls picker/i }));
}

async function loadTheSetup() {
  openAdvanced();
  fireEvent.click(screen.getByText('Load setup…'));
  await screen.findByText(PRESET.label);
  fireEvent.click(screen.getByText(PRESET.label));
  const confirm = await screen.findByRole('button', { name: /Bring “Boids” and load/i });
  fireEvent.click(confirm);
}

describe('the panel hands a brought simulation upwards', () => {
  it('Load is offered on a section with NO simulation, and says it will bring the package', async () => {
    // Before this ruling the button was disabled here, which is exactly backwards: a section with
    // nothing in it is where a saved setup is worth the most.
    mount(vi.fn());
    openAdvanced();
    const load = screen.getByText('Load setup…').closest('button') as HTMLButtonElement;
    expect(load.disabled).toBe(false);
    fireEvent.click(load);
    await screen.findByText(PRESET.label);
    fireEvent.click(screen.getByText(PRESET.label));
    expect(await screen.findByRole('button', { name: /Bring “Boids” and load/i })).toBeTruthy();
  });

  it('the apply asks for the package and the response’s simulation goes up to the editor', async () => {
    const onSimulationUpdate = vi.fn();
    mount(onSimulationUpdate);
    await loadTheSetup();
    await waitFor(() => expect(applyBridgePreset).toHaveBeenCalled());
    // The fourth argument is the intent: without it the server refuses rather than spending.
    expect(applyBridgePreset).toHaveBeenCalledWith('proj-1', 'sec-a', 'preset-1', true);
    await waitFor(() => expect(onSimulationUpdate).toHaveBeenCalledWith(BROUGHT));
  });

  it('a script that does NOT fit still hands the package up — it is attached either way', async () => {
    applyBridgePreset.mockRejectedValue(Object.assign(new Error('needs regenerating'), {
      status: 409,
      body: { path: 'recipe', brought: { imported: true, simulation: BROUGHT } },
    }));
    const onSimulationUpdate = vi.fn();
    mount(onSimulationUpdate);
    await loadTheSetup();
    await waitFor(() => expect(onSimulationUpdate).toHaveBeenCalledWith(BROUGHT));
  });
});

describe('the editor’s list takes in what it has never seen', () => {
  it('appends an unknown simulation instead of dropping it', () => {
    const before = [{ id: 'sim-a', name: 'Lattice' }];
    expect(upsertById(before, { id: 'sim-copy', name: 'Boids' })).toEqual([
      { id: 'sim-a', name: 'Lattice' },
      { id: 'sim-copy', name: 'Boids' },
    ]);
  });

  it('replaces one it already holds, in place, without duplicating it', () => {
    const before = [{ id: 'sim-a', name: 'Lattice' }, { id: 'sim-b', name: 'Boids' }];
    const after = upsertById(before, { id: 'sim-b', name: 'Boids (guided)' });
    expect(after).toEqual([{ id: 'sim-a', name: 'Lattice' }, { id: 'sim-b', name: 'Boids (guided)' }]);
    expect(after).toHaveLength(2);
  });

  it('does not mutate the list it was given', () => {
    const before = [{ id: 'sim-a', name: 'Lattice' }];
    upsertById(before, { id: 'sim-copy', name: 'Boids' });
    expect(before).toHaveLength(1);
  });
});
