/**
 * P0.8 in the EDITOR — the half that is usually forgotten.
 *
 * A capability floor fixed only in the viewer is a trap: the author opens their own project on the
 * same iPad, the timeline slot mounts the package, the document never evaluates a single module,
 * and the editor's boot cover spins. Then the editor's bounded reveal ceiling fires — it exists
 * precisely for documents that never announce themselves — and composites a blank iframe over the
 * talking head. Nothing in that sequence ever says the browser is the problem, so the author looks
 * for a problem in a package that is fine everywhere else.
 *
 * WHAT IS ASSERTED: the same two-fact verdict the viewer computes, reaching the same cover slot the
 * editor already owns; the endless spinner replaced by the reason; the frame never composited; and
 * — the important half — a capable browser and an unrecorded package left completely alone.
 *
 * The harness mirrors VideoEditor's wiring the way `editorSimResidency.test.tsx` does, and drives
 * the REAL `VideoPlayer`, `EditorSimPool`, `SimSurface` and sim runtime: the properties under test
 * ("the cover says X", "the frame is not composited") exist only in the rendered DOM.
 */
import { createRef, useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayer, type VideoPlayerHandle } from '../components/VideoPlayer';
import { FLOOR_MESSAGES } from '../lib/sim/browserFloor';
import { sectionAtPlayhead } from '../lib/sectionInterval';
import { simOccurrencesOf } from '../lib/simPool';
import { __resetSimulationLeaseForTests } from '../lib/sim/simulationLease';
import type { TimelineSection } from 'shared/src/generated/client-v1';

const ORIGIN = 'http://localhost:8080';
const SERVED = `${ORIGIN}/sim-public/sims/pkg-a/rev/01HA/index.html?section=sec-a1&v=hash1`;

/**
 * A section row as the editor receives it.
 *
 * `requires_import_maps` is attached ADDITIVELY, exactly as `withServedSimulationUrls` attaches it
 * on the wire — the hand-mirrored `TimelineSection` does not declare it, and the floor reads it
 * structurally rather than through the generated type.
 */
const section = (requiresImportMaps: boolean | null | undefined): TimelineSection => {
  const row = {
    id: 'sec-a1', project_id: 'p', video_file_id: 'v1', start_sec: 10, end_sec: 20,
    type: 'simulation', track: 'main', label: null, order_index: 0,
    simulation_url: SERVED, simulation_id: 'sim-a', sim_script: 'main',
    simple_ui: false, auto_script: true, sim_meta: null,
    clip_source_video_id: null, clip_in_sec: null, clip_source_image_id: null,
    clip_source_audio_id: null,
  };
  return (requiresImportMaps === undefined
    ? row
    : { ...row, requires_import_maps: requiresImportMaps }) as unknown as TimelineSection;
};

const CLIPS = [{ id: 'v1', hlsUrl: null, rawUrl: 'blob:v1', duration: 120 }];
const TIMELINE_SEC = 120;

let messageListeners: ((e: MessageEvent) => void)[] = [];
const childWindows = new WeakMap<HTMLIFrameElement, object>();

function EditorHarness({ sections, playerRef }: {
  sections: TimelineSection[];
  playerRef: React.RefObject<VideoPlayerHandle | null>;
}) {
  const [playhead, setPlayhead] = useState(0);
  const simSections = useMemo(
    () => sections.filter((s) => s.type === 'simulation' && !!s.simulation_url),
    [sections],
  );
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

/** Stand in for the host browser. `undefined` removes `supports`, as pre-16.4 WebKit does. */
function browserSupports(importMaps: boolean | undefined): void {
  const Script = HTMLScriptElement as unknown as { supports?: (t: string) => boolean };
  if (importMaps === undefined) { delete Script.supports; return; }
  Script.supports = (type: string) => type === 'importmap' && importMaps;
}

let originalSupports: ((t: string) => boolean) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  messageListeners = [];
  originalSupports = (HTMLScriptElement as unknown as { supports?: (t: string) => boolean }).supports;
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
  const Script = HTMLScriptElement as unknown as { supports?: (t: string) => boolean };
  if (originalSupports) Script.supports = originalSupports; else delete Script.supports;
});

function mountEditor(requiresImportMaps: boolean | null | undefined) {
  const playerRef = createRef<VideoPlayerHandle>();
  const { container } = render(<EditorHarness sections={[section(requiresImportMaps)]} playerRef={playerRef} />);
  const seek = (t: number) => { act(() => { playerRef.current?.seek(t); }); };
  return { container, seek };
}

const cover = (c: HTMLElement) => c.querySelector('[data-testid="editor-sim-cover"]');
const frame = (c: HTMLElement) => c.querySelector('iframe') as HTMLIFrameElement;

/** Give the mounted frame a controllable child and fire its native load. */
function bootFrame(el: HTMLIFrameElement): object {
  let win = childWindows.get(el);
  if (!win) {
    win = { postMessage: () => {} };
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

// ── the package this browser cannot run ───────────────────────────────────────────────────────

describe('an unrunnable package is explained, not spun over', () => {
  it('replaces the boot spinner with the reason', () => {
    browserSupports(undefined);
    const { container, seek } = mountEditor(true);
    seek(12);

    const el = cover(container);
    expect(el, 'no cover at all over a section that will never paint').not.toBeNull();
    expect(el!.textContent).toContain(FLOOR_MESSAGES['import-maps']);
    expect(el!.textContent).not.toContain('Loading simulation');
    // The spinner is a promise that something is arriving. Nothing is.
    expect(el!.querySelector('.animate-spin')).toBeNull();
    // Diagnosable by capability name, in the DOM, without a debug flag.
    expect(el!.getAttribute('data-floor-missing')).toBe('import-maps');
  });

  it('never composites the frame, even past the runtime\'s reveal ceiling', () => {
    // THE DEFECT. The editor's ceiling exists for documents that cannot announce a paint, so a
    // package whose modules never evaluate hits it on schedule — and without the floor the author
    // gets a blank iframe over the video and no reason for it.
    browserSupports(undefined);
    const { container, seek } = mountEditor(true);
    seek(12);
    bootFrame(frame(container));

    act(() => { vi.advanceTimersByTime(20_000); });

    expect(frame(container).style.opacity, 'a blank frame was composited over the video').toBe('0');
    expect(cover(container), 'the cover gave up before the section did').not.toBeNull();
  });

  it('holds the cue for the whole section, even if the document claims it painted', () => {
    // A package can paint SOMETHING (a background, an error box) without its modules ever running.
    // The floor is a statement about what this browser can do with the package, so no message from
    // the document may talk it out of the cover.
    browserSupports(undefined);
    const { container, seek } = mountEditor(true);
    seek(12);
    const win = bootFrame(frame(container));
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_PAINTED' });

    expect(frame(container).style.opacity).toBe('0');
    expect(cover(container)!.textContent).toContain(FLOOR_MESSAGES['import-maps']);
  });
});

// ── everything else is untouched ──────────────────────────────────────────────────────────────

describe('the editor floor never fires on a guess', () => {
  const spinnerCase = (requires: boolean | null | undefined, supports: boolean | undefined) => {
    browserSupports(supports);
    const { container, seek } = mountEditor(requires);
    seek(12);
    const el = cover(container);
    // The ordinary boot cover, unchanged: a spinner and the loading line, no floor attribute.
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('Loading simulation');
    expect(el!.querySelector('.animate-spin')).not.toBeNull();
    expect(el!.getAttribute('data-floor-missing')).toBeNull();
    return container;
  };

  it('a capable browser is completely unaffected, import map or not', () => {
    spinnerCase(true, true);
  });

  it('a package recorded as NOT needing import maps runs on a browser without them', () => {
    spinnerCase(false, undefined);
  });

  it('an UNKNOWN requirement is not a requirement', () => {
    spinnerCase(null, undefined);
    cleanup();
    spinnerCase(undefined, undefined);   // field absent entirely, e.g. an older backend
  });

  it('a capable browser still reveals the document normally', () => {
    // The proof that the gate added to `shown` did not simply disable the editor's reveal path.
    browserSupports(true);
    const { container, seek } = mountEditor(true);
    seek(12);
    const win = bootFrame(frame(container));
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_PAINTED' });

    expect(frame(container).style.opacity).toBe('1');
    expect(cover(container), 'the cover outlived the reveal').toBeNull();
  });
});
