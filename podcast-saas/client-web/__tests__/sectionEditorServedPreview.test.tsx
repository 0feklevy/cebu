/**
 * The Section Editor's preview mounts the bytes that are LIVE (audit §9.6).
 *
 * A section row carries two URLs and this surface was reading the wrong one. `simulation_url` is
 * what THIS section last published; the simulation's active-revision pointer moves every time ANY
 * section of the same package republishes, and a rollback moves it for everyone. So:
 *
 *     sections A and B share simulation S
 *     generate A → R1 live, A stores R1
 *     generate B → R2 live, B stores R2, R1 retired
 *     regenerate A → R3 live, A stores R3, R2 retired
 *     open B in the section editor → the preview mounted R2
 *
 * R2 was withdrawn two publications ago. Once it falls outside `keepLastN` and
 * `RevisionService.collect` deletes it, the iframe 404s and the author's only view of their own
 * simulation is permanently blank — while the timeline slot beside it, which has resolved the
 * pointer since Stage 0, shows the live revision correctly. This was the last sim surface reading
 * the stored value: `buildPlayerConfig` resolves it for the viewer, `VideoEditor` resolves it for
 * the editor timeline, and the resolved field has been present on the very object this component
 * receives all along.
 *
 * The whole SectionEditor is mounted here rather than mirrored in a harness: which URL reaches the
 * iframe is a property of the rendered DOM, and a mirror of the two-line expression under test
 * would assert only that the mirror was written correctly.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Simulation, TimelineSection } from 'shared/src/generated/client-v1';

// The module graph, not the component: `firebase/auth` initialises on import and `lib/api` reaches
// for a token. Neither is exercised by mounting the preview.
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { getIdToken: async () => 't' } }) }));
vi.mock('../lib/api', () => ({
  api: new Proxy({}, { get: () => vi.fn(async () => []) }),
}));

import { SectionEditor } from '../components/SectionEditor';

const ORIGIN = 'http://localhost:8080';
const PREFIX = `${ORIGIN}/sim-public/simulations/proj-1/sim-1`;
/** What section B stored when it published — retired two publications ago. */
const STORED = `${PREFIX}/revisions/rev-retired/package/index.html?section=sec-b&v=h2`;
/** What the pointer names now. */
const SERVED = `${PREFIX}/revisions/rev-live/package/index.html?section=sec-b&v=h2`;
/** A second package the picker can diverge to. */
const OTHER_ENTRY = `${ORIGIN}/sim-public/simulations/proj-1/sim-2/index.html`;

const section = (over: Partial<TimelineSection> = {}): TimelineSection => ({
  id: 'sec-b', project_id: 'proj-1', video_file_id: 'vid-1', start_sec: 0, end_sec: 10,
  type: 'simulation', track: 'main', label: 'B', notes: null, sort_order: 0,
  simulation_url: STORED, simulation_served_url: SERVED, simulation_id: 'sim-1',
  sim_script: 'main', sim_prompt: null, simple_ui: false, auto_script: true, sim_meta: null,
  global_offset_sec: null, clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
} as unknown as TimelineSection);

const sim = (over: Partial<Simulation> = {}): Simulation => ({
  id: 'sim-1', project_id: 'proj-1', name: 'S', storage_prefix: 'simulations/proj-1/sim-1',
  entry_file: `${PREFIX}/index.html`, bridge_functions: null, status: 'ready', error: null,
  created_at: '2026-01-01T00:00:00.000Z', ...over,
} as unknown as Simulation);

function mountEditor(over: Partial<TimelineSection> = {}, simulations: Simulation[] = [sim()]) {
  const { container } = render(
    <SectionEditor
      section={section(over)}
      projectId="proj-1"
      simulations={simulations}
      videos={[]}
      videoUrls={{}}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return container;
}

/** The preview iframe's resolved src (SimSurface adds device hints + the #simboot fragment). */
const previewSrc = (c: HTMLElement): string => {
  const el = c.querySelector('iframe');
  expect(el, 'the simulation preview iframe was not rendered at all').not.toBeNull();
  return el!.getAttribute('src') ?? '';
};

// ── driving one generation through the real SSE reader ────────────────────────────────────────

type Sent = { type?: string; script?: string };
let sent: Sent[] = [];
let messageListeners: ((e: MessageEvent) => void)[] = [];

/** Give the preview frame a controllable child, fire its load, and complete the handshake. */
function bootPreview(c: HTMLElement): object {
  const el = c.querySelector('iframe') as HTMLIFrameElement;
  const win = { postMessage: (msg: Sent) => { sent.push(msg); } };
  Object.defineProperty(el, 'contentWindow', { configurable: true, value: win });
  act(() => { fireEvent.load(el); });
  const ev = { source: win, data: { type: 'SIM_READY', dispatch: 'dynamic' } } as unknown as MessageEvent;
  act(() => { for (const l of [...messageListeners]) l(ev); });
  return win;
}

/** One SSE `done` frame carrying `payload`, served through the real fetch-body reader. */
function stubGeneration(payload: Record<string, unknown>): void {
  const body = `event: done\ndata: ${JSON.stringify({ section: payload })}\n\n`;
  const bytes = new TextEncoder().encode(body);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => (done ? { value: undefined, done: true } : ((done = true), { value: bytes, done: false })),
        };
      },
    },
  })));
}

const startScriptsSent = () => sent.filter((s) => s.type === 'startScript');

beforeEach(() => {
  sent = [];
  messageListeners = [];
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'message' && typeof fn === 'function') messageListeners.push(fn as (e: MessageEvent) => void);
    return origAdd(type, fn as EventListener, opts as AddEventListenerOptions);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'message') messageListeners = messageListeners.filter((l) => l !== fn);
    return origRemove(type, fn as EventListener, opts as EventListenerOptions);
  });
  // jsdom has no matchMedia; the modal's compact-layout effect asks for one on mount.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the preview follows the revision pointer', () => {
  it('mounts the SERVED revision, not the one this section published', () => {
    const src = previewSrc(mountEditor());
    expect(src, 'the preview mounted a revision retired two publications ago').toContain('rev-live');
    expect(src).not.toContain('rev-retired');
  });

  it('keeps the section query, so the bridge still dispatches this section', () => {
    // The served URL is the pointer's entry key with the STORED query appended verbatim. Losing
    // `?section=` would run the package's default sub-simulation under this section's name.
    expect(previewSrc(mountEditor())).toContain('section=sec-b');
  });

  it('falls back to the stored url when no pointer was resolved', () => {
    // A legacy (un-revisioned) package, a locally constructed row, or an older backend. This is the
    // behaviour every package had before migration 050 and it must be byte-identical.
    const src = previewSrc(mountEditor({ simulation_served_url: null }));
    expect(src).toContain('rev-retired');
  });

  it('falls back to the stored url when the field is absent entirely', () => {
    const { simulation_served_url: _omitted, ...withoutField } = section();
    const src = previewSrc(render(
      <SectionEditor
        section={withoutField as TimelineSection}
        projectId="proj-1" simulations={[sim()]} videos={[]} videoUrls={{}}
        onUpdate={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()}
      />,
    ).container);
    expect(src).toContain('rev-retired');
  });

  it('still shows the package entry for a section that has never published', () => {
    const src = previewSrc(mountEditor({ simulation_url: null, simulation_served_url: null }));
    expect(src).toContain('/simulations/proj-1/sim-1/index.html');
  });
});

/**
 * `remountCovers` asks the SAME question the mount answered.
 *
 * When a generation lands, the editor pushes the new toggles into the live document only if the
 * keyed iframe is NOT about to remount — a remount brings its own SIM_READY and the handshake
 * effect activates with the state just synced, so pushing as well would be a second, conflicting
 * activation. "About to remount" is `the document I will mount !== the document I have mounted`,
 * and the mounted one is now the SERVED url. Comparing the STORED url against it answers "yes,
 * remounting" for every revisioned package — the two are different strings by construction — so on
 * the canReuse / mechanical path, where no reload and no fresh SIM_READY ever happen, the new
 * toggles reached the live document from nowhere at all.
 */
describe('a landing generation pushes to the live document exactly when it will not remount', () => {
  const generateWith = async (done: Record<string, unknown>) => {
    const container = mountEditor({ sim_prompt: 'make it interactive' });
    bootPreview(container);
    sent = [];                                   // drop the handshake's own auto-run
    stubGeneration(done);
    const button = screen.getByRole('button', { name: /Generate with AI/ });
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await Promise.resolve(); });
    return container;
  };

  it('pushes when the served document is unchanged (canReuse — no reload happens)', async () => {
    // The bridge was reused: same revision, same URL. Nothing remounts, so this push is the only
    // way the regenerated section reaches the running document.
    //
    // The `done` payload deliberately changes NO toggle: `applyDone` syncs `simple_ui` /
    // `auto_script` into state first, and a change there fires the P1.2 policy effect, whose own
    // `'no-activation'` fallback also posts a startScript. Leaving them alone makes the push
    // asserted here unambiguously `applyDone`'s.
    await generateWith({ ...section(), sim_script: 'main' });
    expect(startScriptsSent(), 'the canReuse path left the live document un-updated').toHaveLength(1);
  });

  it('stays silent when the served document really did move (a fresh revision remounts)', async () => {
    await generateWith({
      ...section(),
      simulation_url: `${PREFIX}/revisions/rev-next/package/index.html?section=sec-b&v=h3`,
      simulation_served_url: `${PREFIX}/revisions/rev-next/package/index.html?section=sec-b&v=h3`,
    });
    expect(startScriptsSent(), 'a second, conflicting activation was posted over a remount').toHaveLength(0);
  });
});

/**
 * THE DIVERGENT-PICKER BRANCH — assessed, and left as it is.
 *
 * When the picker names a DIFFERENT simulation than the section stores, the preview mounts that
 * package's raw `entry_file`: the legacy mutable prefix, with no `?section=` and no `?v=`. That
 * looks like the same defect as the one above and is not, on three counts:
 *
 *   • THERE IS NO POINTER TO FOLLOW FOR THIS PAIR. `simulation_served_url` resolves the section's
 *     OWN simulation. Nothing has ever been published for (this section, that package) — no bridge
 *     has been generated against the pair — so the section's pointer says nothing about it, and no
 *     `?section=` exists to preserve. `previewScript` already falls back to `'main'` for exactly
 *     this reason, and has since P1.1b.
 *   • IT IS WHAT THE COMMIT WILL STORE. Committing the choice PATCHes `simulation_id`, and
 *     `sections.controller` denormalises that to `resolveSimEntryUrl(sim.entry_file)` — this very
 *     URL. A preview that resolved something else would disagree with the row it is about to write.
 *   • THE BYTES ARE STILL THERE. Immutable publication COPIES into `<prefix>/revisions/<id>/`;
 *     `RevisionService.collect` prunes revision prefixes only, never the package prefix the upload
 *     wrote. So this is the package's own entry, not a retired revision awaiting collection.
 *
 * Reaching the picked package's ACTIVE revision would need a served entry URL on the `Simulation`
 * wire shape, which `GET /simulations` and `GET /editor-state` would both have to grow together —
 * and the PATCH above would have to store it, which would put a resolved revision key into a column
 * whose meaning is "what this section published". That is a change to the write contract, not a
 * fix to this expression.
 */
describe('a divergent picker choice previews the picked package', () => {
  it('mounts the picked simulation\'s raw entry, not the section\'s served revision', () => {
    const container = mountEditor(
      {},
      [sim(), sim({ id: 'sim-2', name: 'Other', entry_file: OTHER_ENTRY })],
    );
    expect(previewSrc(container)).toContain('rev-live');

    const picker = screen.getByDisplayValue('S') as HTMLSelectElement;
    act(() => { fireEvent.change(picker, { target: { value: 'sim-2' } }); });

    const src = previewSrc(container);
    expect(src).toContain('/simulations/proj-1/sim-2/index.html');
    expect(src, 'the picked package must not be shown through the OTHER package\'s pointer')
      .not.toContain('rev-live');
  });
});
