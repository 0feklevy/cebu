/**
 * The editor timeline honours the page-wide simulation lease on EVERY path (audit P1.1c).
 *
 * The lease exists so that at most one simulation surface is doing real work on screen. The
 * timeline player consulted it on the reuse path and on SIM_READY — and NOT on the branch that does
 * the most expensive thing this surface can do: `switchTo === 'navigate'`, which mounts a different
 * document. Two consequences, both reachable while the section editor's preview is running:
 *
 *   1. `mountResident` → `attach()` clears every per-document flag, INCLUDING the `phase:
 *      'suspended'` the lease-driven `suspend()` had just set. So a regeneration, a rollback or a
 *      save (each of which rewrites `simulation_url`, a deliberate dependency of the boundary
 *      effect) booted a SECOND WebGL document underneath the preview and un-suspended the timeline.
 *
 *   2. Nothing then refused to REVEAL it. The ready effect correctly records the desire instead of
 *      activating, so no `startScript` is ever posted — but the runtime's `holding` flag is set only
 *      by a gated ACTIVATION, so the first paint runs `onPainted → maybeReveal → reveal(false)` and
 *      the slot composited the package's boot scene (or its default sub-simulation) as the
 *      section's content, with no body dispatched into it. It self-repaired only when the preview
 *      closed.
 *
 * Both halves are asserted against the REAL `VideoPlayer`, `EditorSimPool`, `SimSurface`, sim
 * runtime and lease broker: "a second document was mounted" and "a frame was composited" are
 * properties of the rendered DOM, and a harness that stubbed any of that could not see either.
 */
import { createRef, useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayer, type VideoPlayerHandle } from '../components/VideoPlayer';
import { sectionAtPlayhead } from '../lib/sectionInterval';
import { simOccurrencesOf } from '../lib/simPool';
import {
  __resetSimulationLeaseForTests, acquireSimulationLease, type SimulationLease,
} from '../lib/sim/simulationLease';
import type { TimelineSection } from 'shared/src/generated/client-v1';

const ORIGIN = 'http://localhost:8080';
/** Two DIFFERENT packages — `packageKeyOf` is origin+path, so the paths must differ. */
const URL_A = `${ORIGIN}/sim-public/sims/sim-1/revisions/rev-aaaa/package/index.html?section=sec-1&v=h1`;
const URL_B = `${ORIGIN}/sim-public/sims/sim-1/revisions/rev-bbbb/package/index.html?section=sec-1&v=h2`;

const CLIPS = [{ id: 'v1', hlsUrl: null, rawUrl: 'blob:v1', duration: 120 }];
const TIMELINE_SEC = 120;

const section = (url: string, over: Partial<TimelineSection> = {}): TimelineSection => ({
  id: 'sec-1', project_id: 'p', video_file_id: 'v1', start_sec: 10, end_sec: 40,
  type: 'simulation', track: 'main', label: null, notes: null, sort_order: 0,
  simulation_url: url, simulation_id: 'sim-1', sim_script: 'main', sim_prompt: null,
  simple_ui: false, auto_script: true, sim_meta: null, global_offset_sec: null,
  clip_source_video_id: null, clip_in_sec: null, broll_volume: 1,
  clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
  // Proven-silent, so the apply gate has no acknowledgement to wait for and the only thing that
  // can hold the reveal in these tests is the lease itself.
  bridge_ack_capable: false,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
} as unknown as TimelineSection);

let messageListeners: ((e: MessageEvent) => void)[] = [];
const childWindows = new WeakMap<HTMLIFrameElement, object>();
/** Everything this surface posts INTO the resident document, in order. */
let sent: Array<{ type?: string }> = [];

function EditorHarness({ url, playerRef, over }: {
  url: string;
  playerRef: React.RefObject<VideoPlayerHandle | null>;
  /** Section fields the test moves between renders (the P1.2 toggles). */
  over?: Partial<TimelineSection>;
}) {
  const [playhead, setPlayhead] = useState(0);
  const overKey = JSON.stringify(over ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const simSections = useMemo(() => [section(url, over)], [url, overKey]);
  const bounds = (s: TimelineSection) => ({ start: s.start_sec, end: s.end_sec });
  const active = sectionAtPlayhead(simSections, playhead, bounds, TIMELINE_SEC);
  const occurrences = useMemo(
    () => simOccurrencesOf(simSections.map((s) => ({
      simulation_url: s.simulation_url, bootHide: null,
      absStartSec: s.start_sec, absEndSec: s.end_sec,
    }))),
    [simSections],
  );
  return (
    <VideoPlayer
      ref={playerRef}
      clips={CLIPS}
      timelineDuration={TIMELINE_SEC}
      currentTime={playhead}
      onTimeUpdate={setPlayhead}
      activeSimSection={active}
      simOccurrences={occurrences}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  messageListeners = [];
  sent = [];
  __resetSimulationLeaseForTests();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetSimulationLeaseForTests();
});

function mountEditor(url: string) {
  const playerRef = createRef<VideoPlayerHandle>();
  const view = render(<EditorHarness url={url} playerRef={playerRef} />);
  return {
    container: view.container,
    seek: (t: number) => { act(() => { playerRef.current?.seek(t); }); },
    /** The author regenerates / rolls back / saves: the row's simulation_url moves. */
    republish: (next: string) => {
      act(() => { view.rerender(<EditorHarness url={next} playerRef={playerRef} />); });
    },
    /** The author saves a toggle in the section editor: the row's policy fields move. */
    retoggle: (over: Partial<TimelineSection>) => {
      act(() => { view.rerender(<EditorHarness url={url} playerRef={playerRef} over={over} />); });
    },
  };
}

const frames = (c: HTMLElement) => [...c.querySelectorAll('iframe')] as HTMLIFrameElement[];
const frame = (c: HTMLElement) => frames(c)[0];

/** Give the mounted frame a controllable child and fire its native load. */
function bootFrame(el: HTMLIFrameElement): object {
  let win = childWindows.get(el);
  if (!win) {
    win = { postMessage: (msg: { type?: string }) => { sent.push(msg); } };
    Object.defineProperty(el, 'contentWindow', { configurable: true, value: win });
    childWindows.set(el, win);
  }
  act(() => { fireEvent.load(el); });
  return win;
}

function fromChild(win: object, data: unknown): void {
  const ev = { source: win, data } as unknown as MessageEvent;
  act(() => { for (const l of [...messageListeners]) l(ev); });
}

/** The section editor's preview starting to RUN — the only holder of 'preview-visible'. */
function startPreview(): SimulationLease {
  let lease!: SimulationLease;
  act(() => { lease = acquireSimulationLease({ id: 'section-editor-preview', priority: 'preview-visible' }); });
  return lease;
}

/**
 * Boot the timeline document all the way to composited, with no preview in the way.
 *
 * `policy` is what the bridge advertises in SIM_READY. Omitted, the document reads as a package
 * published before the policy handlers existed — the honest reading of that silence is `[]`, and
 * every policy request for it falls back to a full re-activation.
 */
function runTimelineSim(container: HTMLElement, policy?: string[]): object {
  const win = bootFrame(frame(container));
  fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic', ...(policy ? { policy } : {}) });
  fromChild(win, { type: 'SIM_PAINTED' });
  return win;
}

// ── 1. the navigate path asks the broker like every other path ────────────────────────────────

describe('a document change while the preview holds the page', () => {
  it('does not boot a second document — the mount waits for the lease', () => {
    const { container, seek, republish } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container);
    expect(frame(container).style.opacity, 'setup: the timeline sim should be on screen').toBe('1');

    const lease = startPreview();
    republish(URL_B);

    expect(frames(container), 'a second simulation document was mounted under the preview').toHaveLength(1);
    expect(frame(container).src).toContain('rev-aaaa');
    expect(frame(container).src, 'the frame navigated to the new revision while blocked').not.toContain('rev-bbbb');
    // …and the frame the preview suspended is not left composited over the video either: the
    // section it was showing is not the section the timeline is now in.
    expect(frame(container).style.opacity).toBe('0');
    lease.release();
  });

  it('performs the deferred mount the moment the lease frees', () => {
    // The desire is not dropped — it is replayed. Dropping it would leave the timeline pointing at
    // a revision it never navigated to for the rest of the session.
    const { container, seek, republish } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container);
    const lease = startPreview();
    republish(URL_B);

    act(() => { lease.release(); });

    expect(frame(container).src).toContain('rev-bbbb');
    expect(frames(container), 'the replay must SWAP the resident document, not add one').toHaveLength(1);
  });

  it('withdraws the deferred mount when the playhead leaves the section', () => {
    // Same rule the deferred ACTIVATION already followed: leaving the sim section during a preview
    // must not mount anything when the lease frees.
    const { container, seek, republish } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container);
    const lease = startPreview();
    republish(URL_B);
    seek(60);                       // out of the section entirely

    act(() => { lease.release(); });

    expect(frames(container).some((f) => f.src.includes('rev-bbbb')),
      'a mount was replayed for a section the playhead had already left').toBe(false);
  });
});

// ── 2. nothing is composited until the activation was actually granted ────────────────────────

describe('a document that owes an activation is not revealed', () => {
  it('refuses to composite a document that was never told what to run', () => {
    // THE DEFECT. The ready effect defers the activation (correctly), so no startScript is posted —
    // but `holding` is only ever set by a gated activation, so the first paint reveals. What lands
    // on screen is the package's boot scene, presented as this section's content.
    const { container, seek } = mountEditor(URL_A);
    seek(12);
    const lease = startPreview();

    const win = bootFrame(frame(container));
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_PAINTED' });

    expect(frame(container).style.opacity,
      'a document with no section dispatched into it was composited over the video').toBe('0');
    lease.release();
  });

  it('stays uncomposited even past the bounded reveal ceiling', () => {
    // The editor's 12 s ceiling exists for documents that cannot announce a paint. It must not
    // become a way around the lease.
    const { container, seek } = mountEditor(URL_A);
    seek(12);
    const lease = startPreview();
    bootFrame(frame(container));

    act(() => { vi.advanceTimersByTime(20_000); });

    expect(frame(container).style.opacity).toBe('0');
    lease.release();
  });

  it('reveals as soon as the lease frees and the activation is granted', () => {
    // The proof the gate is a DEFERRAL and not an off switch.
    const { container, seek } = mountEditor(URL_A);
    seek(12);
    const lease = startPreview();
    const win = bootFrame(frame(container));
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_PAINTED' });

    act(() => { lease.release(); });
    act(() => { vi.advanceTimersByTime(1_000); });

    expect(frame(container).style.opacity).toBe('1');
  });

  it('leaves an ordinary un-leased boot completely alone', () => {
    // The regression guard: with no preview on the page nothing about the reveal path changes.
    const { container, seek } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container);
    expect(frame(container).style.opacity).toBe('1');
  });
});

// ── 3. P1.2 reaches the editor timeline too ───────────────────────────────────────────────────

/**
 * A CHROME OR AUTOMATION CHANGE MUST NOT RESET THE SECTION — on this surface as well.
 *
 * `setPolicy` was wired into the section editor's preview only. The timeline's boundary effect
 * lists `simple_ui`, `auto_script` and `sim_meta` among its dependencies (deliberately: a canReuse
 * regeneration keeps the URL and must still show up live) and answered every one of them with a
 * full `activate()`. On v2 that falls through the bridge's `stopScript` — cleanup runs, every
 * tracked timer dies, the body re-runs — so saving a Minimal-UI toggle threw away wherever the
 * timeline's simulation had got to.
 *
 * The reason given for leaving it was that the timeline is suspended behind the preview's lease
 * while the modal is open. It is not: the lease is held only while the preview is RUNNING, and the
 * toggles reach the row on Save (preview stopped, or never started) and on an undo/redo restore
 * with no modal open at all — which is how these tests reach it.
 */
describe('a policy change on the running section', () => {
  const startScripts = () => sent.filter((s) => s.type === 'startScript');
  const policyPosts = () => sent.filter((s) => s.type === 'uiPolicy' || s.type === 'autoPolicy');

  it('is delivered as policy, not as a re-activation', () => {
    const { container, seek, retoggle } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container, ['ui', 'automation']);
    expect(startScripts(), 'setup: the section should have been activated once').toHaveLength(1);
    sent = [];

    retoggle({ simple_ui: true });

    expect(startScripts(), 'a Minimal-UI toggle restarted the section').toHaveLength(0);
    expect(policyPosts(), 'the toggle never reached the document at all').toHaveLength(1);
  });

  it('delivers an automation change the same way', () => {
    const { container, seek, retoggle } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container, ['ui', 'automation']);
    sent = [];

    retoggle({ auto_script: false });

    expect(startScripts()).toHaveLength(0);
    expect(policyPosts().map((s) => s.type)).toEqual(['autoPolicy']);
  });

  it('still RE-ACTIVATES for a package whose bridge predates the policy handlers', () => {
    // The fallback belongs to the runtime, and it is loud rather than silent. A package that
    // advertises no policy support gets the old behaviour exactly — the toggle has to take effect
    // somehow, and a restart is the only way it can.
    const { container, seek, retoggle } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container);              // no `policy` in SIM_READY → advertises nothing
    sent = [];

    retoggle({ simple_ui: true });

    expect(startScripts(), 'an old package silently ignored the toggle').toHaveLength(1);
  });

  it('still ACTIVATES when the section itself changes', () => {
    // The other half: a real move is not policy. Guarding against the fix turning every boundary
    // crossing into a no-op.
    const { container, seek, republish } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container, ['ui', 'automation']);
    sent = [];

    republish(URL_B);                        // a different package: navigate + fresh handshake
    runTimelineSim(container, ['ui', 'automation']);

    expect(startScripts(), 'a document change was answered with a policy message').toHaveLength(1);
  });

  it('re-activates on RE-ENTRY, even though nothing about the policy moved', () => {
    // Leaving the section stops its script. Coming back inside the destroy grace looks exactly like
    // a policy change — same section, same URL, same toggles — and `setPolicy` would answer
    // 'unchanged' and send nothing, leaving the section permanently stopped.
    const { container, seek } = mountEditor(URL_A);
    seek(12);
    runTimelineSim(container, ['ui', 'automation']);
    seek(60);                                 // out of the section
    sent = [];
    seek(12);                                 // and back in, inside the destroy grace

    expect(startScripts(), 'a re-entered section was never restarted').toHaveLength(1);
  });
});
