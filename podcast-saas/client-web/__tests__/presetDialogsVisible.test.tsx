/**
 * The preset dialogs must actually APPEAR when their buttons are clicked.
 *
 * ── THE BUG THIS PINS (owner-reported: "Save setup… / Load setup… do nothing") ──────────────
 * The overlays were rendered inline inside the editor modal's DOM tree at zIndex 70, while the
 * modal itself sits at zIndex 800/801. The click WORKED — state flipped, the dialog mounted — and
 * it opened BEHIND the modal, invisible. Every existing test passed, because every existing test
 * asserted state or queried the virtual DOM, and the dialog WAS in the DOM. It was just unseeable.
 *
 * jsdom cannot see paint order either, so the honest assertions here are the structural facts
 * that make visibility true in a browser:
 *   1. the dialog is a child of document.body (portaled OUT of the modal's stacking context);
 *   2. its z-index exceeds the editor modal's 801.
 * Those two properties are exactly what the fix consists of, and losing either re-breaks it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { SectionEditor } from '../components/SectionEditor';
import type { TimelineSection, Simulation } from 'shared/src/generated/client-v1';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('tok') } },
}));

// jsdom ships no matchMedia; the editor reads it for reduced-motion. A stub, not a behaviour.
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const SECTION = {
  id: 'sec-1', project_id: 'p1', video_file_id: 'v1',
  start_sec: 0, end_sec: 10, type: 'simulation', label: 'Sim',
  simulation_id: 'sim-1', sim_meta: { planVersion: '7', generatedBy: 'llm' },
  simple_ui: false, auto_script: true, track: 'main',
} as unknown as TimelineSection;

const SIM = { id: 'sim-1', name: 'Boids', status: 'ready', project_id: 'p1' } as unknown as Simulation;

const EDITOR_MODAL_Z = 801;

function renderEditor() {
  // listBridgePresets resolves empty — the picker's loading state is enough for visibility.
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ presets: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

  return render(
    <SectionEditor
      section={SECTION}
      projectId="p1"
      simulations={[SIM]}
      videos={[]}
      videoUrls={{}}
      onUpdate={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
  );
}

/** The "Reuse this setup" card lives behind the collapsed-by-default Advanced disclosure. */
function openAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: /advanced — controls picker/i }));
}

const dialogFacts = (label: string) => {
  const dialog = screen.getByRole('dialog', { name: label });
  // Portaled out of the modal tree: its parent must be document.body itself.
  const portaled = dialog.parentElement === document.body;
  const z = Number((dialog as HTMLElement).style.zIndex);
  return { dialog, portaled, z };
};

describe('the preset dialogs are actually visible when opened', () => {
  // Sections with sim_meta log their last-generation diagnostics via console.warn by design.
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('Save setup… opens ABOVE the editor modal, portaled to body', () => {
    renderEditor();
    openAdvanced();
    fireEvent.click(screen.getByText('Save setup…'));

    const { portaled, z } = dialogFacts('Save setup');
    expect(portaled, 'the dialog renders inside the modal tree — it opens BEHIND the modal').toBe(true);
    expect(z, `z-index ${z} does not clear the editor modal at ${EDITOR_MODAL_Z}`).toBeGreaterThan(EDITOR_MODAL_Z);
  });

  it('Load setup… opens ABOVE the editor modal, portaled to body', async () => {
    renderEditor();
    openAdvanced();
    fireEvent.click(screen.getByText('Load setup…'));

    const { portaled, z } = dialogFacts('Load setup');
    expect(portaled, 'the dialog renders inside the modal tree — it opens BEHIND the modal').toBe(true);
    expect(z).toBeGreaterThan(EDITOR_MODAL_Z);
  });

  it('the Save button is enabled when the section HAS a generated setup', () => {
    // The second half of the report: if sim_meta were missing the button is disabled by design —
    // this fixture has it, so a dead-looking button here is a real regression, not the guard.
    renderEditor();
    openAdvanced();
    const btn = screen.getByText('Save setup…').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
