/**
 * The section's script panel says what the button will do BEFORE it is pressed.
 *
 * One control meant two different things — write a script with AI, or mechanically hide controls —
 * and which one you got depended on whether the prompt happened to be empty. Nothing on screen
 * said so; the label flipped only after you had already typed. The panel now states the outcome in
 * a line above the button, and the button's own words match it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Simulation, TimelineSection } from 'shared/src/generated/client-v1';

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { getIdToken: async () => 't' } }) }));
vi.mock('../lib/api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

import { SectionEditor } from '../components/SectionEditor';

const PREFIX = 'http://localhost:8080/sim-public/simulations/proj-1/sim-1';
const SIM = {
  id: 'sim-1', project_id: 'proj-1', name: 'Lattice', storage_prefix: 'simulations/proj-1/sim-1',
  entry_file: `${PREFIX}/index.html`, bridge_functions: null, status: 'ready', error: null,
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Simulation;

const section = (over: Partial<TimelineSection> = {}): TimelineSection => ({
  id: 'sec-a', project_id: 'proj-1', video_file_id: 'vid-1', start_sec: 0, end_sec: 10,
  type: 'simulation', track: 'main', label: 'A', notes: null, sort_order: 0,
  simulation_url: `${PREFIX}/index.html?section=sec-a&v=h1`, simulation_served_url: null, simulation_id: 'sim-1',
  sim_script: 'main', sim_prompt: null, simple_ui: false, auto_script: true, sim_meta: null,
  global_offset_sec: null, clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
} as unknown as TimelineSection);

function mount(over: Partial<TimelineSection> = {}) {
  return render(
    <SectionEditor
      section={section(over)}
      projectId="proj-1"
      simulations={[SIM]}
      videos={[]}
      videoUrls={{}}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

const promptBox = () => screen.getByPlaceholderText(/lattice-size slider/i);
const applyButton = () => screen.getByRole('button', { name: /Generate with AI|Apply|Nothing to apply yet/ });

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'matchMedia'); });

describe('the script panel says what will happen', () => {
  it('with nothing entered: the button is disabled and the line asks for one of the two things', () => {
    mount();
    expect(screen.getByText(/Describe the moment, or pick the controls to keep/i)).toBeTruthy();
    const button = applyButton() as HTMLButtonElement;
    expect(button.textContent).toContain('Nothing to apply yet');
    expect(button.disabled).toBe(true);
  });

  it('with a prompt: it says AI will write the script, and the button agrees', () => {
    mount();
    fireEvent.change(promptBox(), { target: { value: 'Show the slider and start it running' } });
    expect(screen.getByText(/AI writes the script for this moment/i)).toBeTruthy();
    const button = applyButton() as HTMLButtonElement;
    expect(button.textContent).toContain('Generate with AI');
    expect(button.disabled).toBe(false);
  });

  it('with controls but no prompt: it promises no AI and no cost, and the button says Apply', () => {
    // The third outcome, and the one the panel used to hide completely: pressing the SAME button
    // with an empty prompt does something mechanical and free. A stored selection puts the panel
    // in that state without driving a scan.
    mount({ sim_meta: { uiControls: { controls: [], show: [], hide: ['#speed'] } } as never });
    expect(screen.getByText(/Hides the controls you unchecked\. No AI, no cost\./i)).toBeTruthy();
    const button = applyButton() as HTMLButtonElement;
    expect(button.textContent).toContain('Apply');
    expect(button.textContent).not.toContain('Generate with AI');
    expect(button.disabled).toBe(false);
  });

  it('a prompt on top of the controls says BOTH things happen', () => {
    mount({ sim_meta: { uiControls: { controls: [], show: [], hide: ['#speed'] } } as never });
    fireEvent.change(promptBox(), { target: { value: 'Start it running' } });
    expect(screen.getByText(/AI writes the script for this moment and hides the controls you unchecked/i)).toBeTruthy();
  });

  it('the switches that decide whether any of it applies are step 3, inside the same card', () => {
    // They were the one fragment the redesign left loose: unnumbered furniture under numbered
    // steps, and the only part of the card painted in a hardcoded light-only wash.
    mount();
    expect(screen.getByText(/3 · Apply them/)).toBeTruthy();
    const simpleUi = screen.getByText('Simple UI').closest('button') as HTMLButtonElement;
    expect(simpleUi.style.backgroundColor).not.toBe('rgb(255, 251, 235)');
    expect(simpleUi.style.borderColor === '' || simpleUi.style.border.includes('hsl(var(--border))')).toBe(true);
  });

  it('the two optional steps are numbered and the control picker shows how many are kept', () => {
    mount();
    expect(screen.getByText(/1 · Describe it/)).toBeTruthy();
    expect(screen.getByText(/2 · Choose the controls/)).toBeTruthy();
    const toggle = screen.getByText(/which controls the viewer keeps/i).closest('button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('not scanned');
    // The label does not rename itself when pressed; the state is the chevron and aria-expanded.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('which controls the viewer keeps');
  });

  it('the reuse row is named for what it does, and there is no banner button', () => {
    mount();
    expect(screen.getByText('Reuse this setup')).toBeTruthy();
    expect(screen.getByText('Save setup…')).toBeTruthy();
    expect(screen.getByText('Load setup…')).toBeTruthy();
    expect(screen.queryByText(/Refresh banner/i)).toBeNull();
    expect(screen.queryByLabelText(/Refresh banner/i)).toBeNull();
  });

  it('saving a setup needs something to save', () => {
    const fresh = mount().container;
    expect((screen.getByText('Save setup…').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(fresh).toBeTruthy();
    cleanup();
    mount({ sim_meta: { planVersion: '7', prompt: 'x' } as never });
    expect((screen.getByText('Save setup…').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });
});
