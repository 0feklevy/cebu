/**
 * A malformed guidance-stream payload ends the run instead of stranding it (frontend-002).
 *
 * The Guided-Simulation panel drives generate/publish over an `EventSource`. Every handler did
 * `JSON.parse(e.data)` as its FIRST statement, unguarded:
 *
 *     es.addEventListener('done', (e) => {
 *       const data = JSON.parse(e.data);      // ← throws on a non-JSON frame
 *       applyGuidanceSim(data.simulation);
 *       setGuidanceBusy(false);               // ← never runs
 *       es.close();                           // ← never runs
 *     });
 *
 * A listener that throws does not propagate to the emitter — the browser reports it as an uncaught
 * error and moves on — so the throw silently skipped the two lines that end the run. The panel sat
 * on "Analyzing…" with its buttons disabled, and the EventSource stayed open, reconnecting on its
 * own schedule, until the tab was closed. The `error` frame was worse: it sets `handled = true`
 * BEFORE parsing, so a malformed error frame also disarmed the `onerror` fallback that would
 * otherwise have rescued the UI.
 *
 * Non-JSON frames on a long-lived SSE stream are not exotic: any proxy, ingress or auth layer that
 * decides to answer mid-stream writes HTML or plain text into it.
 *
 * The fake EventSource below reproduces the browser's contract exactly — a throwing listener is
 * swallowed and recorded, never surfaced to the caller — because a fake that let the throw escape
 * would turn this into a test about exceptions rather than about the stranded UI.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineSection } from 'shared/src/generated/client-v1';

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: { getIdToken: async () => 'test-id-token' } }),
}));

vi.mock('../lib/api', () => ({
  api: {
    listSimFiles: vi.fn(async () => []),
    getSimFileContent: vi.fn(async () => ''),
    updateSection: vi.fn(async () => ({})),
    deleteSection: vi.fn(async () => ({})),
    getBrollJob: vi.fn(async () => ({})),
    generateBroll: vi.fn(async () => ({})),
    downloadSimZip: vi.fn(async () => new Blob()),
  },
}));

import { SectionEditor } from '../components/SectionEditor';

/** Errors a listener threw — the browser's window.onerror, in miniature. */
let uncaught: unknown[] = [];

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close(): void { this.closed = true; }

  /** Deliver a server frame. A throwing listener is reported, not propagated — as in a browser. */
  emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) {
      try { fn(new MessageEvent(type, { data })); } catch (err) { uncaught.push(err); }
    }
  }
  /** The transport-level failure EventSource raises on its own (no `data`). */
  fail(): void {
    try { this.onerror?.(new Event('error')); } catch (err) { uncaught.push(err); }
  }
}

const SECTION = {
  id: 'sec-1', project_id: 'p1', video_file_id: 'v1', start_sec: 0, end_sec: 30,
  type: 'simulation', track: 'main', label: null, notes: null, sort_order: 0,
  simulation_url: 'http://localhost:8080/sim-public/s/index.html',
  simulation_id: 'sim-1', sim_script: 'main', sim_prompt: null,
  simple_ui: false, auto_script: true, sim_meta: null, global_offset_sec: null,
  clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as TimelineSection;

const SIMULATIONS = [{
  id: 'sim-1', project_id: 'p1', name: 'Pendulum', status: 'ready',
  guidance: null, guidance_status: 'none', guidance_meta: null,
  bridge_functions: [], created_at: '2026-01-01T00:00:00.000Z',
}] as unknown as Parameters<typeof SectionEditor>[0]['simulations'];

function renderEditor() {
  return render(
    <SectionEditor
      section={SECTION}
      projectId="p1"
      simulations={SIMULATIONS}
      videos={[]}
      videoUrls={{}}
      onUpdate={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
  );
}

/** jest-dom is not installed here, so button state is read off the element itself. */
function analyzeButton(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

/** Click "Analyze & draft" and hand back the EventSource it opened. */
async function startAnalysis(): Promise<FakeEventSource> {
  fireEvent.click(screen.getByRole('button', { name: /Analyze & draft/ }));
  await waitFor(() => { expect(FakeEventSource.instances).toHaveLength(1); });
  // The panel is busy: the button now shows the stream's status line.
  await screen.findByText(/Starting analysis/);
  return FakeEventSource.instances[0];
}

beforeEach(() => {
  uncaught = [];
  FakeEventSource.instances = [];
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  // jsdom ships no matchMedia; the editor's compact-modal effect calls it on mount.
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('guided-simulation stream — malformed payloads', () => {
  it('ends the run and tells the user when the terminal frame is not JSON', async () => {
    renderEditor();
    const es = await startAnalysis();

    // What a gateway writes into an open stream when it decides to answer instead of the app.
    await act(async () => { es.emit('done', '<html><body>502 Bad Gateway</body></html>'); });

    expect(uncaught).toEqual([]);
    // The stream is closed, not left reconnecting for the life of the tab.
    expect(es.closed).toBe(true);
    // The panel is usable again…
    await waitFor(() => { expect(analyzeButton(/Analyze & draft/).disabled).toBe(false); });
    expect(screen.queryByText(/Starting analysis/)).toBeNull();
    // …and the failure is on screen rather than only in the console.
    expect(await screen.findByText(/Guidance generation failed|unreadable|Please try again/i)).toBeTruthy();
  });

  it('ends the run and tells the user when the error frame is not JSON', async () => {
    renderEditor();
    const es = await startAnalysis();

    // The `error` handler marks the run handled BEFORE parsing, so a throw here also disarms the
    // onerror fallback — the UI has nothing left that can rescue it.
    await act(async () => { es.emit('error', 'upstream connect error or disconnect/reset'); });

    expect(uncaught).toEqual([]);
    expect(es.closed).toBe(true);
    await waitFor(() => { expect(analyzeButton(/Analyze & draft/).disabled).toBe(false); });
    expect(screen.queryByText(/Starting analysis/)).toBeNull();
  });

  it('keeps the run alive when only a progress frame is malformed', async () => {
    renderEditor();
    const es = await startAnalysis();

    // A junk status line is not a reason to abandon a run that is still going.
    await act(async () => { es.emit('status', 'not json at all'); });

    expect(uncaught).toEqual([]);
    expect(es.closed).toBe(false);
    expect(screen.queryByRole('button', { name: /Analyze & draft/ })).toBeNull();

    // …and the real terminal frame still completes it.
    await act(async () => {
      es.emit('done', JSON.stringify({
        simulation: { ...SIMULATIONS[0], guidance: [], guidance_status: 'ready' },
      }));
    });
    expect(es.closed).toBe(true);
    await waitFor(() => { expect(analyzeButton(/Analyze & draft|Re-analyze/).disabled).toBe(false); });
  });
});
