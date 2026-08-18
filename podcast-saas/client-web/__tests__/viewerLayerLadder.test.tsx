/**
 * OWNER-REPORTED, v0.1.28: "the cc settings is with lower z-index below the video bar" and
 * "the setting is too close to cc (no esthetic)".
 *
 * WHAT A TEST CAN AND CANNOT PROVE HERE.
 *
 * This is CSS. jsdom applies the cascade (it matches selectors and resolves specificity) but it
 * does not lay anything out and it does not paint, so no test in this file can show you the panel
 * on top of the seek bar — only a human eye, or the Playwright matrix, can do that. What it CAN
 * pin is the ORDERING INVARIANT that decides the paint result, and that invariant is where the bug
 * actually lives:
 *
 *   `.viewer-cc-menu` is a positioned descendant of `.viewer-controls-bar`, which is itself a
 *   stacking context (position:absolute + z-index). Per CSS 2.1 Appendix E, positioned descendants
 *   with `z-index: auto` paint in step 8, and positioned descendants with a POSITIVE z-index paint
 *   in step 9 — after them. The progress fill (1), the section markers (1), the progress thumb (2)
 *   and the clip dividers (2) all sit in step 9. The caption-settings panel had no z-index at all,
 *   so the seek bar and its markers painted straight through it. That is the owner's symptom, and
 *   it is decided entirely by the numbers this test reads.
 *
 * Values are asserted as an ORDER, never as literals: a test that pinned "the panel is z-index 3"
 * would go red on a harmless renumbering and would still pass if someone raised the thumb to 4.
 *
 * SPACING (the second report) is likewise asserted as a RELATIONSHIP — the CC/settings pair uses
 * the same rhythm token as the control row around it — not as a pixel count. Whether 14px reads as
 * "enough air" is a judgement only a human eye makes.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { RefObject } from 'react';
import { ControlsBar } from '../components/viewer/ControlsBar';
import type { TimelineSeg } from '../components/viewer/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = resolve(HERE, '../components/viewer');

const readCss = (name: string) => readFileSync(resolve(VIEWER_DIR, name), 'utf-8');

/**
 * jsdom cascades stylesheets but does NOT substitute `var()` — `getComputedStyle` hands back the
 * literal `var(--z-viewer-controls)`. So the token table is parsed out of the ladder file and the
 * substitution done here. That indirection is not a weakening of the test: the selector matching,
 * the cascade and the override order are all still jsdom's, and a token that is missing from the
 * ladder resolves to nothing and fails loudly below.
 */
function tokenTable(css: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    table.set(name, value.trim());
  }
  return table;
}

function resolveVars(value: string, tokens: Map<string, string>): string {
  let out = value.trim();
  for (let i = 0; i < 8 && out.includes('var('); i += 1) {
    out = out.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/gi, (whole, name: string) => {
      const hit = tokens.get(name);
      if (hit === undefined) throw new Error(`layer token ${name} is not declared in the ladder`);
      return hit;
    });
  }
  return out.trim();
}

let tokens: Map<string, string>;

beforeAll(() => {
  const viewerCss = readCss('viewer.css');
  const simCss = readCss('simLayers.css');

  // The ladder must be ONE file that both stylesheets pull in — if viewer.css stops importing it,
  // every `var(--z-*)` in it silently becomes an invalid z-index (i.e. `auto`) in the real build.
  // Parsing the import rather than hard-coding the filename is what makes that failure visible.
  const importMatch = /@import\s+(?:url\()?['"]\.\/([\w.-]+\.css)['"]\)?/.exec(viewerCss);
  expect(importMatch, 'viewer.css does not @import the layer ladder').not.toBeNull();
  const ladderFile = importMatch![1];
  expect(simCss, `simLayers.css does not @import ./${ladderFile}`).toContain(ladderFile);

  const ladderCss = readCss(ladderFile);
  // The ladder owns every `--z-*` rung; `--viewer-ctrl-gap` is declared beside the controls it
  // paces, so the table is built from all three sheets in cascade order.
  tokens = tokenTable(`${ladderCss}\n${viewerCss}\n${simCss}`);

  for (const css of [ladderCss, viewerCss, simCss]) {
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }
});

afterEach(cleanup);

const noop = () => {};
const ref = <T,>() => ({ current: null }) as RefObject<T | null>;

const TIMELINE: TimelineSeg[] = [
  { id: 'a', duration: 30, offset: 0 },
  { id: 'b', duration: 30, offset: 30 },
];

function renderControls() {
  return render(
    <div className="viewer-root controls-visible">
      <ControlsBar
        playing
        started
        timeline={TIMELINE}
        totalDuration={60}
        simMarkers={[]}
        videoMarkers={[]}
        brollMarkers={[]}
        progressFillRef={ref<HTMLDivElement>()}
        progressThumbRef={ref<HTMLDivElement>()}
        progressBufRef={ref<HTMLDivElement>()}
        progressTrackRef={ref<HTMLDivElement>()}
        progressWrapRef={ref<HTMLDivElement>()}
        curTimeRef={ref<HTMLSpanElement>()}
        totTimeRef={ref<HTMLSpanElement>()}
        onTogglePlay={noop}
        volume={0.7}
        muted={false}
        onVolumeChange={noop}
        onToggleMute={noop}
        captionsAvailable
        captionsEnabled
        captionStatus="ready"
        captionStyle={{ fontSize: 22, backgroundColor: '#000000', backgroundOpacity: 70, textOpacity: 100 }}
        onToggleCaptions={noop}
        onCaptionStyleChange={noop}
      />
    </div>,
  );
}

/** Effective stacking index of a rendered element, with the ladder's tokens substituted. */
function stackIndex(el: Element, label: string): number {
  const raw = resolveVars(getComputedStyle(el as HTMLElement).zIndex || '', tokens);
  const n = Number.parseInt(raw, 10);
  expect(Number.isFinite(n), `${label} has no numeric z-index (got ${JSON.stringify(raw)})`).toBe(true);
  return n;
}

function openCaptionSettings(container: HTMLElement): HTMLElement {
  fireEvent.click(screen.getByLabelText('Caption settings'));
  const panel = container.querySelector('.viewer-cc-menu');
  expect(panel, 'caption-settings panel did not open').not.toBeNull();
  return panel as HTMLElement;
}

describe('caption-settings panel vs. the seek bar (owner report 1)', () => {
  it('paints ABOVE every positioned part of the progress bar it overlaps', () => {
    const { container } = renderControls();
    const panel = openCaptionSettings(container);

    // Same stacking context (`.viewer-controls-bar`), so these numbers are directly comparable.
    const bar = container.querySelector('.viewer-controls-bar')!;
    expect(panel.closest('.viewer-controls-bar')).toBe(bar);

    const panelZ = stackIndex(panel, '.viewer-cc-menu');

    const occluders: Array<[string, Element]> = [
      ['.viewer-progress-fill', container.querySelector('.viewer-progress-fill')!],
      ['.viewer-seg-markers', container.querySelector('.viewer-seg-markers')!],
      ['.viewer-progress-thumb', container.querySelector('.viewer-progress-thumb')!],
      ['.viewer-timeline-dividers', container.querySelector('.viewer-timeline-dividers')!],
    ];

    for (const [name, el] of occluders) {
      expect(el, `${name} is not rendered`).not.toBeNull();
      expect(
        panelZ,
        `${name} paints over the caption-settings panel — the panel's box starts at the top of the seek bar, so the owner sees the bar cutting through it`,
      ).toBeGreaterThan(stackIndex(el, name));
    }
  });

  it('is positioned, so its z-index participates in the stack at all', () => {
    const { container } = renderControls();
    const panel = openCaptionSettings(container);
    expect(getComputedStyle(panel).position).toBe('absolute');
  });
});

describe('the viewer layer ladder', () => {
  it('orders the named global layers: sim < captions < controls < floating < top < modal', () => {
    const order = [
      '--z-viewer-sim',
      '--z-viewer-guidance',
      '--z-viewer-captions',
      '--z-viewer-sim-hover',
      '--z-viewer-controls',
      '--z-viewer-floating',
      '--z-viewer-top',
      '--z-viewer-modal',
    ];
    const values = order.map((name) => {
      const raw = tokens.get(name);
      expect(raw, `${name} is missing from the ladder`).toBeDefined();
      return Number.parseInt(resolveVars(raw!, tokens), 10);
    });
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `${order[i]} must sit above ${order[i - 1]}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it('keeps the sim recovery surface BELOW the controls bar, so a failed section stays seekable', () => {
    const simTop = Number.parseInt(resolveVars(tokens.get('--z-viewer-sim-surface')!, tokens), 10);
    const hover = Number.parseInt(resolveVars(tokens.get('--z-viewer-sim-hover')!, tokens), 10);
    const controls = Number.parseInt(resolveVars(tokens.get('--z-viewer-controls')!, tokens), 10);
    expect(simTop).toBeLessThan(hover);
    expect(hover).toBeLessThan(controls);
  });
});

describe('CC / settings spacing (owner report 2)', () => {
  it('separates the CC button from the settings button using the control row\'s own rhythm', () => {
    const { container } = renderControls();
    const row = container.querySelector('.viewer-ctrl-row')!;
    const wrap = container.querySelector('.viewer-caption-wrap')!;

    const rowGap = getComputedStyle(row as HTMLElement).gap;
    const wrapGap = getComputedStyle(wrap as HTMLElement).gap;

    expect(rowGap, 'the control row lost its gap').not.toBe('');
    expect(
      wrapGap,
      'the CC button and the caption-settings button are flush against each other — the wrap declares no gap',
    ).not.toBe('');
    expect(
      resolveVars(wrapGap, tokens),
      'the CC/settings pair must use the same rhythm as the rest of the control row, not a value of its own',
    ).toBe(resolveVars(rowGap, tokens));
  });
});
