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
// The power tools — the control picker, "Reuse this setup" and "Guided Simulation" — live behind a
// collapsed-by-default Advanced disclosure (owner direction 2026-09-04).
const openAdvanced = () =>
  fireEvent.click(screen.getByRole('button', { name: /advanced — controls picker/i }));

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Sections with sim_meta log their last-generation diagnostics via console.warn by design.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    // The line says what the BUTTON cannot: what pressing it costs. Repeating "AI writes the
    // script" directly above a button reading "Generate with AI" spent a line on nothing.
    expect(screen.getByText(/Uses AI, and counts against your generation limit/i)).toBeTruthy();
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
    expect(screen.getByText(/Uses AI, and counts against your generation limit\. Also hides the controls you unchecked/i)).toBeTruthy();
  });

  it('the switches that decide whether any of it applies are step 2, inside the same card', () => {
    // They were the one fragment the redesign left loose: unnumbered furniture under numbered
    // steps, and the only part of the card painted in a hardcoded light-only wash.
    mount();
    expect(screen.getByText(/2 · How it behaves/)).toBeTruthy();
    const simpleUi = screen.getByText('Simple UI').closest('button') as HTMLButtonElement;
    expect(simpleUi.style.backgroundColor).not.toBe('rgb(255, 251, 235)');
    expect(simpleUi.style.borderColor === '' || simpleUi.style.border.includes('hsl(var(--border))')).toBe(true);
  });

  it('the steps are numbered, and the control picker sits behind Advanced with no number', () => {
    mount();
    expect(screen.getByText(/1 · Describe it/)).toBeTruthy();
    // The picker moved behind the Advanced disclosure (owner direction 2026-09-04): collapsed by
    // default, and no longer a numbered step of the card.
    expect(screen.queryByText(/which controls the viewer keeps/i)).toBeNull();
    openAdvanced();
    expect(screen.getByText(/Choose the controls/)).toBeTruthy();
    expect(screen.queryByText(/\d · Choose the controls/)).toBeNull();
    const toggle = screen.getByText(/which controls the viewer keeps/i).closest('button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('not scanned');
    // The label does not rename itself when pressed; the state is the chevron and aria-expanded.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('which controls the viewer keeps');
  });

  it('Escape closes the open setup dialog, NOT the whole section editor', () => {
    // Both dialogs are portaled to <body>, so the editor's window-level Escape listener hears
    // their keystrokes too. Backing out of "name this setup" used to shut the editor behind it.
    const onClose = vi.fn();
    render(
      <SectionEditor
        section={section({ sim_meta: { planVersion: '7', prompt: 'x' } as never })}
        projectId="proj-1" simulations={[SIM]} videos={[]} videoUrls={{}}
        onUpdate={vi.fn()} onDelete={vi.fn()} onClose={onClose}
      />,
    );
    openAdvanced();
    fireEvent.click(screen.getByText('Save setup…'));
    expect(screen.getByRole('dialog', { name: /save setup/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // A second Escape, with nothing open, closes the editor as it always did.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the two switches announce their state, and the setting has ONE name', () => {
    mount();
    const simpleUi = screen.getByText('Simple UI').closest('button') as HTMLButtonElement;
    expect(simpleUi.getAttribute('role')).toBe('switch');
    expect(simpleUi.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(simpleUi);
    expect(simpleUi.getAttribute('aria-checked')).toBe('true');
    // "Minimal UI" and "Simple UI" named the same toggle four lines apart in this card.
    expect(screen.queryByText(/Minimal UI/i)).toBeNull();
    // Including the picker's own empty/unopened states, which the default view never renders and
    // where the last "Minimal UI" survived the first rename. The picker lives behind Advanced now.
    openAdvanced();
    expect(screen.queryByText(/Minimal UI/i)).toBeNull();
    fireEvent.click(screen.getByText(/which controls the viewer keeps/i).closest('button') as HTMLButtonElement);
    expect(screen.queryByText(/Minimal UI/i)).toBeNull();
  });

  it('closing a setup dialog puts the keyboard back on the button that opened it', () => {
    // Both dialogs are portaled to <body>. Without this the caret lands on <body> and the next
    // Tab restarts at the top of the page, a long way from where the author was working.
    mount({ sim_meta: { planVersion: '7', prompt: 'x' } as never });
    openAdvanced();
    const save = screen.getByText('Save setup…').closest('button') as HTMLButtonElement;
    save.focus();
    expect(document.activeElement).toBe(save);

    fireEvent.click(save);
    expect(screen.getByRole('dialog', { name: /save setup/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /save setup/i })).toBeNull();
    expect(document.activeElement).toBe(save);
  });

  it('the reuse row is named for what it does, and there is no banner button', () => {
    mount();
    openAdvanced();
    expect(screen.getByText('Reuse this setup')).toBeTruthy();
    expect(screen.getByText('Save setup…')).toBeTruthy();
    expect(screen.getByText('Load setup…')).toBeTruthy();
    expect(screen.queryByText(/Refresh banner/i)).toBeNull();
    expect(screen.queryByLabelText(/Refresh banner/i)).toBeNull();
  });

  it('saving a setup needs something to save', () => {
    const fresh = mount().container;
    openAdvanced();
    expect((screen.getByText('Save setup…').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(fresh).toBeTruthy();
    cleanup();
    mount({ sim_meta: { planVersion: '7', prompt: 'x' } as never });
    openAdvanced();
    expect((screen.getByText('Save setup…').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });
});
