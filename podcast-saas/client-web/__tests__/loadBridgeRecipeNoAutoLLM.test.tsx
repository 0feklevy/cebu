/**
 * Loading a bridge that does NOT fit must never spend an LLM call by itself (FIX B).
 *
 * ── THE BUG THIS PINS (owner-reported: "Load bridge blacks the screen") ─────────────────────────
 * A saved script body binds BY NAME to one simulation's DOM ids / label texts / window API. When
 * the preset is loaded onto a DIFFERENT simulation the fit is judged `recipe`, and the editor used
 * to react by AUTOMATICALLY calling the generate-sim-script LLM endpoint — an unrequested spend
 * that regenerates a whole bridge for the wrong simulation from the preset's often-minimal prompt,
 * which is exactly what blacks the section. A live repro caught it: selecting a boids preset on an
 * "angry-bird" section fired one POST to …/generate-sim-script/stream the moment Load was confirmed.
 *
 * The fix: a recipe-path load applies only the MECHANICAL (zero-LLM) parts and keeps the current
 * simulation rendering; regenerating the script is offered as an EXPLICIT, labelled opt-in. So the
 * assertions are: confirming a recipe load hits NO generate endpoint, and generation fires ONLY
 * from the opt-in click — carrying the preset's prompt. A regression that auto-generates on load
 * reddens the first test; one where the opt-in does nothing reddens the second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { TimelineSection, Simulation } from 'shared/src/generated/client-v1';

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { getIdToken: async () => 'tok' } }) }));

const PRESET = {
  id: 'preset-1', label: 'Boids pluck', sim_prompt: 'pluck a boid with one button',
  simple_ui: true, auto_script: false, ui_controls: null,
  has_artifact: true, source_simulation_id: 'sim-src', source_simulation_name: 'boids',
  source_importable: false, created_at: '2026-01-01T00:00:00.000Z',
};

// The judged fit: RECIPE — the saved script does not fit this simulation.
const RECIPE_FIT = {
  path: 'recipe' as const,
  description: 'This simulation does not have #pluck-btn — the saved script will not be applied.',
  verdict: { path: 'recipe', why: 'anchors-missing', missing: [{ kind: 'id', token: '#pluck-btn' }] },
};

const H = vi.hoisted(() => ({
  applyCalled: 0,
  updateCalls: [] as unknown[],
}));

vi.mock('../lib/api', () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === 'listBridgePresets') return async () => ({ presets: [PRESET] });
      if (prop === 'bridgePresetFit') return async () => RECIPE_FIT;
      if (prop === 'applyBridgePreset') {
        // The recipe path must NEVER call the artifact apply. If it does, make it loud.
        return async () => { H.applyCalled++; throw Object.assign(new Error('apply should not run on a recipe fit'), { status: 500 }); };
      }
      if (prop === 'updateSection') return async (_p: string, _s: string, body: Record<string, unknown>) => { H.updateCalls.push(body); return { ...SECTION, ...body }; };
      // Everything else the editor touches on mount is irrelevant here.
      return async () => [];
    },
  }),
}));

import { SectionEditor } from '../components/SectionEditor';

const SECTION = {
  id: 'sec-1', project_id: 'proj-1', video_file_id: 'vid-1', start_sec: 0, end_sec: 10,
  type: 'simulation', track: 'main', label: 'Sim', notes: null, sort_order: 0,
  simulation_url: 'http://localhost:8080/sim-public/simulations/proj-1/sim-1/index.html?section=sec-1&v=h1',
  simulation_served_url: 'http://localhost:8080/sim-public/simulations/proj-1/sim-1/index.html?section=sec-1&v=h1',
  simulation_id: 'sim-1', sim_script: 'main', sim_prompt: null, simple_ui: false, auto_script: true,
  sim_meta: { planVersion: '7', generatedBy: 'llm' },
  global_offset_sec: null, clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as TimelineSection;

const SIM = {
  id: 'sim-1', project_id: 'proj-1', name: 'Angry Bird', storage_prefix: 'simulations/proj-1/sim-1',
  entry_file: 'http://localhost:8080/sim-public/simulations/proj-1/sim-1/index.html', status: 'ready', error: null,
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Simulation;

if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// A generate-sim-script stub that records every call and completes the SSE reader cleanly.
type FetchCall = { url: string; body: Record<string, unknown> | null };
let fetchCalls: FetchCall[] = [];
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> | null;
    try { body = init?.body ? JSON.parse(init.body as string) : null; } catch { body = null; }
    fetchCalls.push({ url: String(url), body });
    const done = `event: done\ndata: ${JSON.stringify({ section: { ...SECTION, sim_meta: { planVersion: '7', generatedBy: 'llm', bridgeHash: 'h2' } } })}\n\n`;
    const bytes = new TextEncoder().encode(done);
    return {
      ok: true,
      body: {
        getReader: () => {
          let sent = false;
          return { read: async () => (sent ? { value: undefined, done: true } : ((sent = true), { value: bytes, done: false })) };
        },
      },
    } as unknown as Response;
  }));
}
const generateCalls = () => fetchCalls.filter((c) => /generate-sim-script/.test(c.url));

function renderEditor() {
  return render(
    <SectionEditor
      section={SECTION}
      projectId="proj-1"
      simulations={[SIM]}
      videos={[]}
      videoUrls={{}}
      onUpdate={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
  );
}

/** Open the Load picker, select the recipe preset, and confirm the load. */
async function loadRecipePreset() {
  fireEvent.click(screen.getByText('Load setup…'));
  const row = await screen.findByText('Boids pluck');
  await act(async () => { fireEvent.click(row.closest('button') as HTMLButtonElement); });
  // The confirm button settles on "Load settings" once the fit resolves (recipe, not "Apply instantly").
  const confirm = await screen.findByText('Load settings');
  await act(async () => { fireEvent.click(confirm.closest('button') as HTMLButtonElement); });
}

describe('a recipe-fit load never spends an LLM call by itself', () => {
  beforeEach(() => { fetchCalls = []; H.applyCalled = 0; H.updateCalls = []; stubFetch(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('confirming the load hits NO generate endpoint and keeps the current simulation', async () => {
    renderEditor();
    await loadRecipePreset();

    await waitFor(() => expect(screen.getByText(/Regenerate for this simulation \(uses AI\)/i)).toBeTruthy());

    // The heart of FIX B: the confirm did not fire the LLM.
    expect(generateCalls(), 'a recipe-fit load auto-called the generate/LLM endpoint').toEqual([]);
    // Nor did it take the artifact apply path.
    expect(H.applyCalled).toBe(0);
    // The mechanical (zero-LLM) settings persist DID happen (no ui_controls ⇒ plain section update).
    expect(H.updateCalls.length, 'the mechanical settings persist did not run').toBeGreaterThan(0);
  });

  it('generation fires ONLY from the explicit opt-in, and carries the preset prompt', async () => {
    renderEditor();
    await loadRecipePreset();

    const optIn = await screen.findByText(/Regenerate for this simulation \(uses AI\)/i);
    expect(generateCalls()).toEqual([]);   // still nothing before the click

    await act(async () => { fireEvent.click(optIn.closest('button') as HTMLButtonElement); });

    await waitFor(() => expect(generateCalls().length).toBe(1));
    const call = generateCalls()[0]!;
    expect(call.url).toMatch(/\/projects\/proj-1\/sections\/sec-1\/generate-sim-script\/stream$/);
    expect(call.body?.prompt, 'the opt-in regeneration did not carry the preset prompt').toBe('pluck a boid with one button');
  });

  it('dismissing the opt-in with "Not now" leaves the simulation untouched and spends nothing', async () => {
    renderEditor();
    await loadRecipePreset();

    const notNow = await screen.findByText('Not now');
    await act(async () => { fireEvent.click(notNow.closest('button') as HTMLButtonElement); });

    expect(screen.queryByText(/Regenerate for this simulation \(uses AI\)/i)).toBeNull();
    expect(generateCalls()).toEqual([]);
  });
});
