/**
 * The EDITOR's simulation residency (audit §9.3, Stages 1–4).
 *
 * THE DEFECT THESE PIN. The editor had no residency at all: one iframe, created at the section
 * boundary, whose src was that section's own URL — and a reuse test (`live.documentKey === newUrl`)
 * that compared FULL URLs, so it was false at every sim→sim boundary, including between two
 * sections of the SAME package. Fetch, parse, module evaluation, WebGL context creation, shader
 * compile and first paint therefore all began at the instant the playhead crossed in, with nothing
 * on screen but the talking head and an 800 ms blank force-reveal at the end of it.
 *
 * WHAT IS ASSERTED, AND WHY IN THIS ORDER. Residency first, cover second: a spinner over a wait of
 * the same length is not a fix, so the load-bearing assertions here are about DOCUMENTS — which one
 * is mounted, whether its src changed, and when it started booting. The cover is asserted last, and
 * only as an explanation of a wait that residency could not remove.
 *
 * The pure rules are driven directly; the surface tests drive the REAL `VideoPlayer` through a
 * harness that mirrors VideoEditor's wiring (the same `sectionAtPlayhead` predicate, the same
 * served URLs, the same memoised occurrence list), because the properties under test — "the src did
 * not change", "no second iframe exists" — only exist in the rendered DOM.
 */
import { createRef, useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayer, type VideoPlayerHandle } from '../components/VideoPlayer';
import { EDITOR_WARM_LEASE_ID } from '../components/EditorSimPool';
import { sectionAtPlayhead } from '../lib/sectionInterval';
import {
  EDITOR_SIM_RESIDENT_CAP, EDITOR_WARM_LEAD_SEC,
  collectSimPackages, dynamicScriptFor, packageKeyOf, planEditorResidency,
  simDocumentSwitch, simOccurrencesOf, simScriptFor,
} from '../lib/simPool';
import {
  __resetSimulationLeaseForTests, acquireSimulationLease, heldSimulationLeases,
  simulationLeaseAllows, timelineActionOnLeaseFree,
} from '../lib/sim/simulationLease';
import { variantKeyFor } from 'shared/src/sim/simIdentity';
import type { TimelineSection } from 'shared/src/generated/client-v1';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
// Two sections of ONE package and one section of another, shaped exactly as the server serves them
// after P0.4: the package path is the ACTIVE REVISION's entry key, and the per-section identity is
// the query the resolver appends verbatim (`?section=<id>&v=<bridgeHash>`).

const ORIGIN = 'http://localhost:8080';
const REV_A1 = `${ORIGIN}/sim-public/sims/pkg-a/rev/01HA/index.html`;
const REV_A2 = `${ORIGIN}/sim-public/sims/pkg-a/rev/02HB/index.html`;   // pkg A, REGENERATED
const REV_B1 = `${ORIGIN}/sim-public/sims/pkg-b/rev/01HB/index.html`;

const servedA1 = `${REV_A1}?section=sec-a1&v=hash1`;
const servedA2 = `${REV_A1}?section=sec-a2&v=hash1`;   // sibling section, SAME revision path
const servedB1 = `${REV_B1}?section=sec-b1&v=hash2`;
const regenA1  = `${REV_A2}?section=sec-a1&v=hash9`;   // same section after a regenerate

const section = (over: Partial<TimelineSection>): TimelineSection => ({
  id: 'sec', project_id: 'p', video_file_id: 'v1', start_sec: 0, end_sec: 1,
  type: 'simulation', track: 'main', label: null, order_index: 0,
  simulation_url: null, simulation_id: 'sim-a', sim_script: 'main',
  simple_ui: false, auto_script: true, sim_meta: null,
  clip_source_video_id: null, clip_in_sec: null, clip_source_image_id: null,
  clip_source_audio_id: null,
  ...over,
} as unknown as TimelineSection);

// ── PART A: the pure rules ────────────────────────────────────────────────────────────────────

describe('document identity is the PACKAGE (Stage 2)', () => {
  /** The comparison the editor used to make: `live.documentKey === newUrl`. */
  const oldReuseTest = (mounted: string, next: string): boolean => mounted === next;

  it('two sections of one package share a key — the reuse test that could never hit', () => {
    expect(packageKeyOf(servedA1)).toBe(packageKeyOf(servedA2));
    // …and the old rule really could not, which is why the editor rebooted at every boundary.
    expect(oldReuseTest(servedA1, servedA2)).toBe(false);
  });

  it('a REGENERATE mints a new revision path, so identity legitimately changes', () => {
    expect(packageKeyOf(regenA1)).not.toBe(packageKeyOf(servedA1));
  });

  it('two different packages never collapse', () => {
    expect(packageKeyOf(servedA1)).not.toBe(packageKeyOf(servedB1));
  });
});

describe('simDocumentSwitch — when the frame may be reused and when it must navigate', () => {
  const dyn = (mounted: string | null, next: string) =>
    simDocumentSwitch({ mounted, mountedDynamic: true, next });

  it('nothing mounted → navigate', () => {
    expect(dyn(null, servedA1)).toBe('navigate');
  });
  it('same package, different section, dynamic → reuse (the boundary becomes a postMessage)', () => {
    expect(dyn(servedA1, servedA2)).toBe('reuse');
  });
  it('same URL → reuse', () => {
    expect(dyn(servedA1, servedA1)).toBe('reuse');
  });
  it('different package → navigate', () => {
    expect(dyn(servedA1, servedB1)).toBe('navigate');
  });
  it('a REGENERATE forces a fresh document, dynamic or not', () => {
    expect(dyn(servedA1, regenA1)).toBe('navigate');
    expect(simDocumentSwitch({ mounted: servedA1, mountedDynamic: false, next: regenA1 })).toBe('navigate');
  });
  it('a LEGACY document navigates for a section change — postMessage cannot move it', () => {
    // Its SCRIPTS.main is the LOADED document's ?section default, so dispatching would silently
    // run the wrong sub-simulation. Unknown (null) capability takes the same safe branch.
    expect(simDocumentSwitch({ mounted: servedA1, mountedDynamic: false, next: servedA2 })).toBe('navigate');
    expect(simDocumentSwitch({ mounted: servedA1, mountedDynamic: null, next: servedA2 })).toBe('navigate');
  });
});

describe('simScriptFor — the name a document is addressed by', () => {
  const secA2 = section({ id: 'row-a2', simulation_url: servedA2, sim_script: 'main' });

  it('a dynamic bridge is addressed by the shared variant key, not the stored sim_script', () => {
    expect(simScriptFor(secA2, true)).toBe(variantKeyFor(secA2));
    expect(simScriptFor(secA2, true)).toBe('sec-a2');
    // The delegation is what stops a second implementation drifting from the backend's poster key.
    expect(dynamicScriptFor(secA2)).toBe(variantKeyFor(secA2));
  });

  it('a legacy or unclassified document keeps the stored entry-point name', () => {
    expect(simScriptFor(secA2, false)).toBe('main');
    expect(simScriptFor(secA2, null)).toBe('main');
    expect(simScriptFor(section({ id: 'r', simulation_url: null, sim_script: null }), false)).toBe('main');
  });
});

describe('planEditorResidency — ONE timeline document', () => {
  const A = { key: 'pkg-a', src: servedA1, bootHide: null };
  const B = { key: 'pkg-b', src: servedB1, bootHide: null };

  it('the cap is one, and it is the editor that is capped harder than the viewer', () => {
    expect(EDITOR_SIM_RESIDENT_CAP).toBe(1);
  });

  it('an active section always owns the slot — the next package is NOT also kept', () => {
    const plan = planEditorResidency({ active: A, next: B, resident: 'pkg-a' });
    expect(plan).toEqual({ ...A, role: 'active' });
  });

  it('with no active section, the lead-bounded next package warms', () => {
    expect(planEditorResidency({ active: null, next: B, resident: 'pkg-a' }))
      .toEqual({ ...B, role: 'warm' });
  });

  it('with nothing due, the resident is released to the destroy grace', () => {
    expect(planEditorResidency({ active: null, next: null, resident: 'pkg-a' }))
      .toEqual({ key: 'pkg-a', src: null, bootHide: null, role: 'release' });
  });

  it('the warm target being the resident package IS retention (Stage 3)', () => {
    const plan = planEditorResidency({ active: null, next: A, resident: 'pkg-a' });
    expect(plan.role).toBe('warm');
    expect(plan.key).toBe('pkg-a');   // the caller cancels the destroy instead of re-mounting
  });
});

describe('collectSimPackages — the viewer\'s collector, generalised to a section list', () => {
  it('dedupes by package, preserves first-appearance order and honours the cap', () => {
    const rows = [
      { simulation_url: servedA1, bootHide: ['#a'] },
      { simulation_url: servedA2, bootHide: ['#b'] },   // same package — collapsed
      { simulation_url: null, bootHide: null },
      { simulation_url: servedB1, bootHide: null },
    ];
    expect(collectSimPackages(rows, 4)).toEqual([
      { key: packageKeyOf(servedA1), src: servedA1, bootHide: ['#a'] },
      { key: packageKeyOf(servedB1), src: servedB1, bootHide: null },
    ]);
    expect(collectSimPackages(rows, 1)).toHaveLength(1);
  });
});

// ── PART B: the surface ───────────────────────────────────────────────────────────────────────

interface Sent { type: string; [k: string]: unknown }

/** Every `message` listener the runtime registers, so a child can be simulated without jsdom. */
let messageListeners: ((e: MessageEvent) => void)[] = [];
/** What the parent posted into the mounted frame, in order. */
let sent: Sent[] = [];
/** The fake child window installed on each mounted iframe. */
const childWindows = new WeakMap<HTMLIFrameElement, object>();

function fromChild(win: object, data: unknown): void {
  const ev = { source: win, data } as unknown as MessageEvent;
  act(() => { for (const l of [...messageListeners]) l(ev); });
}

const CLIPS = [{ id: 'v1', hlsUrl: null, rawUrl: 'blob:v1', duration: 120 }];
const TIMELINE_SEC = 120;

interface HarnessProps {
  sections: TimelineSection[];
  /** The imperative seek handle — how these tests move the playhead. */
  playerRef: React.RefObject<VideoPlayerHandle | null>;
}

/**
 * VideoEditor's wiring, reduced to the parts that decide residency: the tolerant playhead
 * predicate, the served-URL rewrite (already applied in these fixtures) and the memoised
 * occurrence list. Mounting the real 1,900-line VideoEditor would need the whole app shell.
 */
function EditorHarness({ sections, playerRef }: HarnessProps) {
  const [playhead, setPlayhead] = useState(0);
  const simSections = useMemo(
    () => sections.filter((s) => s.type === 'simulation' && !!s.simulation_url),
    [sections],
  );
  const bounds = (s: TimelineSection) => ({ start: s.start_sec, end: s.end_sec });
  const active = sectionAtPlayhead(simSections, playhead, bounds, TIMELINE_SEC);
  const occurrences = useMemo(
    () => simOccurrencesOf(simSections.map((s) => ({
      simulation_url: s.simulation_url,
      bootHide: null,
      absStartSec: s.start_sec,
      absEndSec: s.end_sec,
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

const SECTIONS: TimelineSection[] = [
  section({ id: 'sec-a1', simulation_url: servedA1, start_sec: 10, end_sec: 20 }),
  section({ id: 'sec-a2', simulation_url: servedA2, start_sec: 20, end_sec: 30 }),
  section({ id: 'sec-b1', simulation_url: servedB1, start_sec: 60, end_sec: 70 }),
];

const frames = (c: HTMLElement): HTMLIFrameElement[] => Array.from(c.querySelectorAll('iframe'));
const theFrame = (c: HTMLElement): HTMLIFrameElement => {
  const all = frames(c);
  // THE CAP, asserted on every single lookup rather than in one test: a second timeline document
  // is the failure mode this whole design is bounded against.
  expect(all.length, `expected at most ${EDITOR_SIM_RESIDENT_CAP} resident document`).toBeLessThanOrEqual(1);
  expect(all.length, 'no simulation document is mounted').toBe(1);
  return all[0];
};

/** Give a freshly mounted frame a controllable child, then run its native `load`. */
function bootFrame(el: HTMLIFrameElement): object {
  let win = childWindows.get(el);
  if (!win) {
    win = { postMessage: (msg: Sent) => { sent.push(msg); } };
    Object.defineProperty(el, 'contentWindow', { configurable: true, value: win });
    childWindows.set(el, win);
  }
  act(() => { fireEvent.load(el); });
  return win;
}

/** Bring the mounted frame all the way to a painted, dynamic-capable document. */
function bootReadyPainted(container: HTMLElement): { el: HTMLIFrameElement; win: object } {
  const el = theFrame(container);
  const win = bootFrame(el);
  fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
  fromChild(win, { type: 'SIM_PAINTED' });
  return { el, win };
}

const scriptsSent = (): string[] => sent.filter((s) => s.type === 'startScript').map((s) => String(s.script));

beforeEach(() => {
  vi.useFakeTimers();
  messageListeners = [];
  sent = [];
  __resetSimulationLeaseForTests();
  // jsdom implements neither, and the editor's playback engine calls both. Nothing here is about
  // media playback; without the stubs every render prints a "Not implemented" page of noise.
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

function mountEditor(sections: TimelineSection[] = SECTIONS) {
  const playerRef = createRef<VideoPlayerHandle>();
  const { container } = render(<EditorHarness sections={sections} playerRef={playerRef} />);
  const seek = (t: number) => { act(() => { playerRef.current?.seek(t); }); };
  return { container, seek };
}

describe('Stage 2 — a same-package hop is a postMessage, not a navigation', () => {
  it('leaves the iframe src UNCHANGED and dispatches the second section\'s variant key', () => {
    const { container, seek } = mountEditor();

    seek(12);                                   // inside sec-a1
    const { el } = bootReadyPainted(container);
    const srcInA1 = el.getAttribute('src');
    expect(srcInA1).toContain('section=sec-a1');
    expect(scriptsSent()).toEqual(['sec-a1']);   // the variant key, never the stored 'main'

    seek(25);                                   // inside sec-a2 — SAME package

    // The document itself: same element, same src. A changed src is a navigation, and a navigation
    // is the reload this stage exists to remove.
    expect(theFrame(container)).toBe(el);
    expect(theFrame(container).getAttribute('src')).toBe(srcInA1);
    // …and the switch happened, on the wire, addressed by the section's own variant key.
    expect(scriptsSent()).toEqual(['sec-a1', 'sec-a2']);
  });

  it('an A → B → A cycle inside one package never reloads the document', () => {
    const { container, seek } = mountEditor();
    seek(12);
    const { el } = bootReadyPainted(container);
    const src = el.getAttribute('src');

    seek(25);
    seek(12);

    expect(theFrame(container)).toBe(el);
    expect(theFrame(container).getAttribute('src')).toBe(src);
    expect(scriptsSent()).toEqual(['sec-a1', 'sec-a2', 'sec-a1']);
  });

  it('a REGENERATE forces a fresh document rather than dispatching onto the resident one', () => {
    // P1.1's authoring behaviour: the section's URL now names a new revision, and the resident
    // document is serving bytes that no longer exist. §9.4 item 4 — do not optimise this away.
    const rows = [section({ id: 'sec-a1', simulation_url: servedA1, start_sec: 10, end_sec: 20 })];
    const playerRef = createRef<VideoPlayerHandle>();
    const { container, rerender } = render(<EditorHarness sections={rows} playerRef={playerRef} />);
    act(() => { playerRef.current?.seek(12); });
    const { el } = bootReadyPainted(container);
    expect(el.getAttribute('src')).toContain('rev/01HA');

    act(() => {
      rerender(
        <EditorHarness
          sections={[section({ id: 'sec-a1', simulation_url: regenA1, start_sec: 10, end_sec: 20 })]}
          playerRef={playerRef}
        />,
      );
    });

    expect(theFrame(container).getAttribute('src')).toContain('rev/02HB');
    expect(theFrame(container).getAttribute('src')).not.toBe(el.getAttribute('src'));
  });

  it('a canReuse regeneration (same URL, new toggles) re-applies to the LIVE document', () => {
    // The other half of §9.4 item 4: authoring must invalidate, but only as far as it has to. A
    // regeneration the backend could serve from the same bytes changes the section's toggles, not
    // its URL — re-mounting for that would throw away a document that is still correct.
    const at = (over: Partial<TimelineSection>) => [section({
      id: 'sec-a1', simulation_url: servedA1, start_sec: 10, end_sec: 20, ...over,
    })];
    const playerRef = createRef<VideoPlayerHandle>();
    const { container, rerender } = render(<EditorHarness sections={at({})} playerRef={playerRef} />);
    act(() => { playerRef.current?.seek(12); });
    const { el } = bootReadyPainted(container);

    act(() => { rerender(<EditorHarness sections={at({ simple_ui: true })} playerRef={playerRef} />); });

    expect(theFrame(container), 'a toggle change re-mounted the document').toBe(el);
    expect(scriptsSent()).toEqual(['sec-a1', 'sec-a1']);
    expect(sent.filter((s) => s.type === 'startScript').at(-1))
      .toMatchObject({ params: { simpleUi: true } });
  });

  it('a DIFFERENT package navigates, and only one document is ever mounted', () => {
    const { container, seek } = mountEditor();
    seek(12);
    bootReadyPainted(container);
    const a = theFrame(container).getAttribute('src');

    seek(65);   // sec-b1 — a different package

    const b = theFrame(container).getAttribute('src');
    expect(b).not.toBe(a);
    expect(b).toContain('section=sec-b1');
    expect(frames(container)).toHaveLength(EDITOR_SIM_RESIDENT_CAP);
  });
});

describe('Stage 4 — the next package is booting before its section starts', () => {
  it('mounts it hidden, holds the page lease at warm, and never composites it', () => {
    const { container, seek } = mountEditor();

    seek(55);   // 5 s before sec-b1 at 60 — inside the lead, and no section is active
    expect(frames(container), 'nothing is mounted until the settle elapses').toHaveLength(0);
    act(() => { vi.advanceTimersByTime(400); });

    const el = theFrame(container);
    expect(el.getAttribute('src'), 'the NEXT package is the one booting').toContain('pkg-b');
    // Hidden, and out of the accessibility tree and the tab order with it.
    expect(el.style.opacity).toBe('0');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.getAttribute('tabindex')).toBe('-1');
    // Held at 'warm' — outranked by both visible priorities, so this cannot block anything.
    expect(heldSimulationLeases()).toEqual([{ id: EDITOR_WARM_LEASE_ID, priority: 'warm' }]);

    // A warm document reveals ITSELF the moment it paints. It still must not reach the screen.
    bootReadyPainted(container);
    expect(theFrame(container).style.opacity).toBe('0');
    expect(scriptsSent(), 'warming installs no section body').toEqual([]);
  });

  it('does not warm while the section editor\'s preview holds the page', () => {
    const lease = acquireSimulationLease({ id: 'section-editor-preview', priority: 'preview-visible' });
    const { container, seek } = mountEditor();

    seek(55);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(frames(container), 'a background boot started under the preview').toHaveLength(0);

    // …and it is reconsidered the moment the preview lets go.
    act(() => { lease.release(); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(theFrame(container).getAttribute('src')).toContain('pkg-b');
  });

  it('a seek away cancels the warm before anything is mounted', () => {
    const { container, seek } = mountEditor();
    seek(55);
    seek(35);   // scrubbed away inside the settle window; nothing is due within the lead from here
    act(() => { vi.advanceTimersByTime(2000); });
    expect(frames(container), 'a cancelled warm still mounted a document').toHaveLength(0);
    expect(heldSimulationLeases()).toEqual([]);
    // Cancelling really is one timer — the warm re-arms the moment the lead opens again.
    seek(55);
    act(() => { vi.advanceTimersByTime(400); });
    expect(frames(container)).toHaveLength(1);
  });

  it('the warm document becomes the section\'s document with no navigation at the boundary', () => {
    const { container, seek } = mountEditor();
    seek(55);
    act(() => { vi.advanceTimersByTime(400); });
    const { el, win } = bootReadyPainted(container);
    const warmSrc = el.getAttribute('src');

    seek(62);   // the section starts

    expect(theFrame(container), 'the boundary remounted the document it had already warmed').toBe(el);
    expect(theFrame(container).getAttribute('src')).toBe(warmSrc);
    expect(scriptsSent()).toEqual(['sec-b1']);
    // The lease is released the moment the document stops being background work.
    expect(heldSimulationLeases()).toEqual([]);
    // …and the entry is an ACKNOWLEDGED opacity swap of an already-painted document: nothing loads
    // at the boundary. (The apply gate holds a painted-but-unacknowledged document precisely
    // because its warm boot scene is the wrong sub-simulation — see simApplyGate.)
    expect(theFrame(container).style.opacity, 'a warm boot scene was revealed before its ack').toBe('0');
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'sec-b1' });
    expect(theFrame(container).style.opacity).toBe('1');
  });
});

describe('Stage 3 — retention across a sim → video → sim excursion', () => {
  // The 700 ms grace (touch / low-memory) is the honest test: on the 45 s desktop grace a short
  // excursion survives by accident. Retention has to be a decision, not a long enough timer.
  const touchDevice = () => {
    // Defined, not spied: this jsdom build ships no `matchMedia` at all, which is also why
    // `simDestroyGraceMs` reads 45 s by default here.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({
        matches: q.includes('coarse'), media: q, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      } as unknown as MediaQueryList),
    });
  };
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  const GAPPED = [
    section({ id: 'sec-a1', simulation_url: servedA1, start_sec: 10, end_sec: 20 }),
    section({ id: 'sec-a2', simulation_url: servedA2, start_sec: 25, end_sec: 35 }),
  ];

  it('keeps the document mounted when the same package is coming back', () => {
    touchDevice();
    const { container, seek } = mountEditor(GAPPED);
    seek(15);
    const { el } = bootReadyPainted(container);

    seek(21);                                    // into the 5 s video gap
    act(() => { vi.advanceTimersByTime(1500); }); // well past the 700 ms grace

    expect(theFrame(container), 'the excursion destroyed a document that is about to be used').toBe(el);
    seek(27);
    expect(theFrame(container)).toBe(el);
    expect(scriptsSent()).toEqual(['sec-a1', 'sec-a2']);
  });

  it('still frees the context when nothing is coming back', () => {
    touchDevice();
    const far = [
      section({ id: 'sec-a1', simulation_url: servedA1, start_sec: 10, end_sec: 20 }),
      section({ id: 'sec-b1', simulation_url: servedB1, start_sec: 100, end_sec: 110 }),
    ];
    const { container, seek } = mountEditor(far);
    seek(15);
    bootReadyPainted(container);

    seek(21);                                    // nothing due within the warm lead
    act(() => { vi.advanceTimersByTime(1500); });

    expect(frames(container), 'the destroy grace no longer frees the WebGL context').toHaveLength(0);
  });
});

describe('Stage 1 — the wait is explained, and never force-revealed blank', () => {
  it('covers the frame while the section\'s own document has not been presented', () => {
    const { container, seek } = mountEditor();
    seek(12);
    // Mounted, booting, nothing on screen: this is the window the user experiences as a blank.
    expect(container.querySelector('[data-testid="editor-sim-cover"]')).not.toBeNull();

    bootReadyPainted(container);
    expect(container.querySelector('[data-testid="editor-sim-cover"]'),
      'the cover outlived the reveal').toBeNull();
  });

  it('does NOT cover for a warm document — nothing is due, so nothing is waiting', () => {
    const { container, seek } = mountEditor();
    seek(55);
    act(() => { vi.advanceTimersByTime(400); });
    expect(frames(container)).toHaveLength(1);
    expect(container.querySelector('[data-testid="editor-sim-cover"]')).toBeNull();
  });

  it('never force-reveals an unpainted document at the runtime\'s 800 ms default', () => {
    const { container, seek } = mountEditor();
    seek(12);
    bootFrame(theFrame(container));
    // A document that says nothing at all. The runtime's own ceiling would have composited it here.
    act(() => { vi.advanceTimersByTime(900); });
    expect(theFrame(container).style.opacity).toBe('0');
    expect(container.querySelector('[data-testid="editor-sim-cover"]')).not.toBeNull();

    // …and the editor's ceiling is not "never": once the paint poll has exhausted every ping, a
    // package that can never emit SIM_PAINTED is still displayable.
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(theFrame(container).style.opacity).toBe('1');
  });
});

// ── the cross-surface invariant ───────────────────────────────────────────────────────────────

describe('property: a held preview-visible lease means nothing else is running', () => {
  /**
   * The editor is the ONE surface that hosts two simulations, so "at most one is doing real work"
   * cannot be a structural property — it is a discipline, and this drives that discipline against
   * the real broker over random operation sequences.
   *
   * The three rules under test are the shipping ones: the timeline queries
   * `simulationLeaseAllows('timeline-visible')` before driving its document and re-derives through
   * `timelineActionOnLeaseFree` when the lease frees; the warm slot queries
   * `simulationLeaseAllows('warm')` before booting anything.
   */
  const OPS = ['previewOpen', 'previewClose', 'enterSection', 'leaveSection', 'warmDue', 'seekAway'] as const;

  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  it('holds over 200 random sequences', () => {
    for (let s = 1; s <= 200; s++) {
      __resetSimulationLeaseForTests();
      const rand = rng(s);
      let preview: { release(): void } | null = null;
      let warm: { release(): void } | null = null;
      let timelineRunning = false;
      let warmRunning = false;
      let wantsSim = false;
      let pendingActivation = false;

      for (let i = 0; i < 24; i++) {
        const op = OPS[Math.floor(rand() * OPS.length)];
        switch (op) {
          case 'previewOpen':
            if (!preview) {
              preview = acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });
              // The pact: the timeline suspends for exactly this window, and warming stops.
              if (!simulationLeaseAllows('timeline-visible')) timelineRunning = false;
              if (!simulationLeaseAllows('warm')) warmRunning = false;
            }
            break;
          case 'previewClose':
            if (preview) {
              preview.release();
              preview = null;
              const action = timelineActionOnLeaseFree({ wantsSim, pendingActivation, ready: true });
              pendingActivation = false;
              if (action !== 'none') timelineRunning = true;
            }
            break;
          case 'enterSection':
            wantsSim = true;
            if (simulationLeaseAllows('timeline-visible')) timelineRunning = true;
            else pendingActivation = true;
            // Entering a section ends any background warm: the slot is spoken for.
            warmRunning = false;
            warm?.release();
            warm = null;
            break;
          case 'leaveSection':
            wantsSim = false;
            pendingActivation = false;
            timelineRunning = false;
            break;
          case 'warmDue':
            if (!wantsSim && !warmRunning && simulationLeaseAllows('warm')) {
              warm = acquireSimulationLease({ id: EDITOR_WARM_LEASE_ID, priority: 'warm' });
              warmRunning = true;
            }
            break;
          case 'seekAway':
            warmRunning = false;
            warm?.release();
            warm = null;
            break;
        }

        const previewHeld = heldSimulationLeases().some((h) => h.priority === 'preview-visible');
        if (previewHeld) {
          expect(timelineRunning, `seed ${s} op ${i} (${op}): timeline ran under the preview`).toBe(false);
          expect(warmRunning, `seed ${s} op ${i} (${op}): a warm boot ran under the preview`).toBe(false);
        }
        // And in every state, the editor is running at most one timeline document's worth of work.
        expect(Number(timelineRunning) + Number(warmRunning)).toBeLessThanOrEqual(EDITOR_SIM_RESIDENT_CAP);
      }
    }
  });

  it('the warm rank really is outranked by both visible priorities (not vacuous)', () => {
    __resetSimulationLeaseForTests();
    const p = acquireSimulationLease({ id: 'p', priority: 'preview-visible' });
    expect(simulationLeaseAllows('warm')).toBe(false);
    p.release();
    expect(simulationLeaseAllows('warm')).toBe(true);
    // A held warm lease blocks nobody — that is why holding it is safe.
    const w = acquireSimulationLease({ id: EDITOR_WARM_LEASE_ID, priority: 'warm' });
    expect(simulationLeaseAllows('timeline-visible')).toBe(true);
    expect(simulationLeaseAllows('preview-visible')).toBe(true);
    w.release();
  });

  it('the warm lead is bounded, and far shorter than the viewer\'s linear-playback lead', () => {
    // §9.4 item 3: editor users seek constantly, so a long lead mostly warms sections nobody
    // reaches. Pinned as a number because "bounded" is the property, not the exact value.
    expect(EDITOR_WARM_LEAD_SEC).toBeGreaterThan(0);
    expect(EDITOR_WARM_LEAD_SEC).toBeLessThanOrEqual(15);
  });
});

// ── The editor learns what publication recorded about the package (audit P0.5) ────────────────
//
// `bridge_ack_capable` reached the VIEWER through PlayerConfig from the day migration 055 landed,
// and reached the EDITOR through nothing at all: nobody called `setPackageAckCapable`, and the
// field was not in either editor bootstrap read. So the editor's apply gate answered UNKNOWN for
// every package BY CONSTRUCTION — on the same warm-then-dispatch slot the test above exercises,
// where the document has already painted its boot scene by the time the section is entered. A
// warm document is `painted`, so `activateDesired` also skips `startPaintRecovery` and no ceiling
// is armed: `EditorSimPool`'s `covered = active && !shown` spinner ran for the whole section.

describe('the editor asks the apply gate the same question the viewer does', () => {
  /** One warm package, entered at its boundary — the exact case the record exists to answer. */
  const only = (over: Partial<TimelineSection>) => [
    section({ id: 'sec-b1', simulation_url: servedB1, start_sec: 60, end_sec: 70, ...over }),
  ];
  /** Warm the document, paint it, then cross into its section. */
  const enterWarmed = (sections: TimelineSection[]) => {
    const { container, seek } = mountEditor(sections);
    seek(55);
    act(() => { vi.advanceTimersByTime(400); });
    const { el, win } = bootReadyPainted(container);
    seek(62);
    return { container, el, win };
  };
  const coverUp = (c: HTMLElement) => c.querySelector('[data-testid="editor-sim-cover"]') !== null;

  it('reveals a package RECORDED as silent instead of covering it for the whole section', () => {
    // Nothing will ever acknowledge, so a hold here is a wait on silence. Before the record
    // reached the editor this was indistinguishable from UNKNOWN, and the spinner never resolved.
    const { container, el } = enterWarmed(only({ bridge_ack_capable: false } as Partial<TimelineSection>));
    expect(el.style.opacity, 'a package proven unable to acknowledge was held anyway').toBe('1');
    expect(coverUp(container), 'the editor covered a document it had already revealed').toBe(false);
  });

  it('still HOLDS a package with no record — unknown is a state, not a "no"', () => {
    const { container, el } = enterWarmed(only({}));
    expect(el.style.opacity, "an unverified warm boot scene was revealed as the section's frame").toBe('0');
    expect(coverUp(container)).toBe(true);
  });

  it('holds a package RECORDED as acking until its own SCRIPT_APPLIED, and no timer', () => {
    const { container, el, win } = enterWarmed(only({ bridge_ack_capable: true } as Partial<TimelineSection>));
    expect(el.style.opacity).toBe('0');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(el.style.opacity, 'a timer revealed what only an acknowledgement may').toBe('0');

    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'sec-b1' });
    expect(el.style.opacity).toBe('1');
    expect(coverUp(container)).toBe(false);
  });
});
