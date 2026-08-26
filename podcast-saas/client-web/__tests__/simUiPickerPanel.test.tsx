/**
 * The Minimal-UI control picker panel.
 *
 * ── WHAT THE OWNER REPORTED, AND WHAT EACH TEST PINS ──────────────────────────────────────────
 *
 * "Not scanned yet" and "No controls detected", together, on a simulation that has controls. Three
 * causes, all covered here:
 *
 *   1. the header and the body were rendered from DIFFERENT state, so they could disagree — now
 *      one discriminated union feeds both, and the contradiction is unrepresentable;
 *   2. the scan raced the preview's load and never retried — now it re-runs when the authoring
 *      channel comes live and when the frame loads;
 *   3. Minimal UI hid the very controls the author was trying to pick — now the mechanical hide is
 *      suspended while the panel is open.
 *
 * `SimAuthoringClient` is module-mocked. The real script is proven against a real document in
 * backend-api's `simAuthoringScript.test.ts`, and the badge GEOMETRY — which jsdom cannot lay out
 * at all — is proven in a browser by `e2e/sim-authoring.spec.ts`. What is left for this file is
 * the editor's own logic: what it shows, what it sends, and what it refuses to do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { SectionEditor } from '../components/SectionEditor';
import type { TimelineSection, Simulation } from 'shared/src/generated/client-v1';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('tok') } },
}));

/** The fake session the editor talks to. Each test decides how it behaves. */
const session = {
  sid: 'sid-test',
  scan: vi.fn(),
  setMarks: vi.fn(),
  observe: vi.fn(),
  on: vi.fn(),
  dispose: vi.fn(),
};
const connectSimAuthoring = vi.fn();
vi.mock('../lib/sim/SimAuthoringClient', () => ({
  connectSimAuthoring: (...a: unknown[]) => connectSimAuthoring(...a),
}));

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
  simulation_id: 'sim-1', simulation_url: 'https://api.test/sim-public/simulations/p1/sim-1/index.html',
  sim_meta: { planVersion: '7', generatedBy: 'llm' },
  simple_ui: true, auto_script: true, track: 'main',
} as unknown as TimelineSection;

const SIM = {
  id: 'sim-1', name: 'Boids', status: 'ready', project_id: 'p1',
  entry_file: 'https://api.test/sim-public/simulations/p1/sim-1/index.html',
} as unknown as Simulation;

const CONTROLS = [
  { selector: '#speed', kind: 'slider', label: 'Speed' },
  { selector: '#trails', kind: 'toggle', label: 'Show trails' },
  { selector: '#reset', kind: 'button', label: 'Reset' },
];

/**
 * One fetch stub that answers each endpoint in ITS OWN SHAPE.
 *
 * A blanket `{presets: []}` for every request looked harmless and was not: the editor also asks
 * for the simulation's file list, got an object where it expected an array, and threw
 * `simFiles.find is not a function` — as an UNHANDLED error, which vitest reports beside the
 * summary rather than inside it. Eleven tests "passed" while the suite exited non-zero.
 */
function routedResponse(url: string): Response {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/bridge-presets')) return json({ presets: [] });
  if (url.includes('/ui-controls')) return json({ controls: [] });
  if (url.includes('/files')) return json([]);
  return json([]);
}

/** Whatever the editor registered for a given authoring event. */
const handlerFor = (event: string): ((...a: unknown[]) => void) | undefined =>
  session.on.mock.calls.find((c) => c[0] === event)?.[1] as ((...a: unknown[]) => void) | undefined;

beforeEach(() => {
  session.scan.mockReset();
  session.setMarks.mockReset();
  session.observe.mockReset();
  session.on.mockReset();
  session.dispose.mockReset();
  connectSimAuthoring.mockReset();
  connectSimAuthoring.mockResolvedValue(session);
  session.scan.mockResolvedValue({
    scanned: true, requestId: 'r1', sid: 'sid-test', controls: CONTROLS, truncated: false,
  });
  globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => routedResponse(String(u))) as unknown as typeof fetch;
});

afterEach(cleanup);

function renderEditor() {
  return render(
    <SectionEditor
      section={SECTION} projectId="p1" simulations={[SIM]} videos={[]} videoUrls={{}}
      onUpdate={() => {}} onDelete={() => {}} onClose={() => {}}
    />,
  );
}

/** Open the picker and wait for the first scan to land. */
async function openPicker(): Promise<void> {
  renderEditor();
  fireEvent.click(screen.getByText(/UI controls/i));
  await waitFor(() => expect(screen.getByText('Speed')).toBeTruthy());
}

const rowFor = (label: string): HTMLElement =>
  screen.getByText(label).closest('label') as HTMLElement;

describe('the status line and the body can no longer contradict each other', () => {
  it('reports a successful scan with its count and where it came from', async () => {
    await openPicker();
    expect(screen.getByText(/3 controls · from the live preview/)).toBeTruthy();
    // The old panel's two messages must not be reachable at the same time as a populated list.
    expect(screen.queryByText(/Not scanned yet/)).toBeNull();
    expect(screen.queryByText(/No controls detected/)).toBeNull();
  });

  it('says the simulation HAS none when a layer answered with an empty list', async () => {
    session.scan.mockResolvedValue({
      scanned: true, requestId: 'r1', sid: 'sid-test', controls: [], truncated: false,
    });
    renderEditor();
    fireEvent.click(screen.getByText(/UI controls/i));
    await waitFor(() => expect(screen.getByText(/No controls to choose from/)).toBeTruthy());
    // A DIFFERENT sentence from the unreachable case — that distinction is the whole fix.
    expect(screen.getByText(/no buttons or sliders/i)).toBeTruthy();
  });

  it('says the scanner did not answer when nothing answered', async () => {
    connectSimAuthoring.mockRejectedValue(new Error('timeout'));
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => (
      String(u).includes('ui-controls') ? new Response('', { status: 404 }) : routedResponse(String(u))
    )) as unknown as typeof fetch;
    renderEditor();
    fireEvent.click(screen.getByText(/UI controls/i));
    // This path genuinely waits out the old gate's 2s timeout before it can honestly say nothing
    // answered — the delay is the evidence, not an inefficiency to hide.
    await waitFor(() => expect(screen.getByText(/did not answer/i)).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByText(/still be loading/i)).toBeTruthy();
  });
});

describe('picking', () => {
  it('a row toggle flips its state and pushes the new mark set to the document', async () => {
    await openPicker();
    session.setMarks.mockClear();

    fireEvent.click(within(rowFor('Speed')).getByRole('checkbox'));

    await waitFor(() => expect(within(rowFor('Speed')).getByText('✕ Hide')).toBeTruthy());
    // Pushed wholesale, so a badge can never render a state its row disagrees with.
    await waitFor(() => {
      const last = session.setMarks.mock.calls.at(-1)?.[0] as { selector: string; mark: string }[];
      expect(last.find((m) => m.selector === '#speed')?.mark).toBe('hide');
    });
  });

  it('a BADGE click does exactly what the checkbox does', async () => {
    // Same handler, same state — the two affordances are one decision seen twice.
    await openPicker();
    const onToggle = handlerFor('markToggled')!;
    expect(onToggle).toBeTruthy();

    onToggle('#trails');

    await waitFor(() => expect(within(rowFor('Show trails')).getByText('✕ Hide')).toBeTruthy());
  });

  it('Undo reverts the last change', async () => {
    await openPicker();
    fireEvent.click(within(rowFor('Speed')).getByRole('checkbox'));
    await waitFor(() => expect(within(rowFor('Speed')).getByText('✕ Hide')).toBeTruthy());

    fireEvent.click(screen.getByText(/Undo/));

    await waitFor(() => expect(within(rowFor('Speed')).getByText('✓ Keep')).toBeTruthy());
  });

  it('every row carries an icon and a word, not just a colour', async () => {
    // ADR D10: colour is the fast read, the glyph and the word are what survive a colour-blind
    // reader and a screenshot.
    await openPicker();
    for (const label of ['Speed', 'Show trails', 'Reset']) {
      expect(within(rowFor(label)).getByText('✓ Keep')).toBeTruthy();
    }
  });
});

describe('the Auto Script suggestion is a suggestion', () => {
  it('marks the controls it saw and offers to keep only those', async () => {
    await openPicker();
    handlerFor('scriptTouched')!(['#speed']);

    await waitFor(() => expect(within(rowFor('Speed')).getByText('script?')).toBeTruthy());
    fireEvent.click(screen.getByText(/Keep only those/));

    await waitFor(() => {
      expect(within(rowFor('Speed')).getByText('✓ Keep')).toBeTruthy();
      expect(within(rowFor('Show trails')).getByText('✕ Hide')).toBeTruthy();
    });
  });

  it('REFUSES to act on a capped scan — it would hide controls it never saw', async () => {
    session.scan.mockResolvedValue({
      scanned: true, requestId: 'r1', sid: 'sid-test', controls: CONTROLS, truncated: true,
    });
    await openPicker();
    handlerFor('scriptTouched')!(['#speed']);

    await waitFor(() => expect(screen.getByText(/Keep only those/)).toBeTruthy());
    const btn = screen.getByText(/Keep only those/).closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/list is capped/)).toBeTruthy();
  });
});

describe('the preview has to be usable while picking', () => {
  it('opening the picker brings the preview forward', async () => {
    // The badges are drawn in that frame. A picker whose visual half is behind another tab is
    // the feature not working.
    renderEditor();
    fireEvent.click(screen.getByText(/Files/i));
    fireEvent.click(screen.getByText(/UI controls/i));
    await waitFor(() => expect(connectSimAuthoring).toHaveBeenCalled());
  });

  it('disposes the session when the panel closes', async () => {
    await openPicker();
    fireEvent.click(screen.getByText(/UI controls/i));
    await waitFor(() => expect(session.dispose).toHaveBeenCalled());
  });
});
