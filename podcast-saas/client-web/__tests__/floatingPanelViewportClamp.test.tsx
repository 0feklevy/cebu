/**
 * Editor popovers must fit the viewport they open on (ui-ux-010).
 *
 * Both popovers are anchored `right: 24` with a FIXED pixel width. `ExportProgressPanel` documents
 * why that is a bug (its rule 7, written after a panel pushed its own consent buttons off-screen):
 * a panel `W` wide anchored `N` from the right edge starts at `100vw - N - W`, which is NEGATIVE —
 * off the left of the screen — on any viewport narrower than `W + N`. At 380px wide the audio
 * popover was clipped on every phone and on a narrow desktop window.
 *
 * jsdom performs no layout, so this suite does the arithmetic a browser would: it reads the width
 * the component actually DECLARES on the element, resolves the CSS against a series of real
 * viewport widths, and asserts the panel's left edge never leaves the screen. That is a geometric
 * outcome, not a string comparison — a clamp with the wrong numbers in it fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../lib/firebase', () => ({ auth: { currentUser: null } }));

import { A2AudioModal } from '../components/A2AudioModal';
import { AudioGainPopover } from '../components/TimelinePanel';
import { clampedPanelWidth, PANEL_EDGE_GAP_PX } from '../lib/floatingPanel';

afterEach(cleanup);

/** Viewports the editor is actually opened on, narrowest first. */
const VIEWPORTS = [320, 360, 375, 414, 430, 768, 1024, 1440];

/**
 * Resolve a declared CSS width to pixels for a given viewport, supporting the subset used here:
 * `<n>px`, `calc(100vw - <n>px)` and `min(...)` over those.
 *
 * The asterisk-stripping replace undoes a jsdom SERIALIZER artifact: cssstyle round-trips
 * `min(380px, calc(100vw - 48px))` as `min(380px * , * calc(100vw - 48px))`. Browsers store the
 * value verbatim; the substitution is a no-op on a correct serialization, so this keeps working if
 * jsdom ever fixes it.
 */
function resolvePx(declared: string, viewportPx: number): number {
  const css = declared.replace(/\s*\*\s*/g, '').trim();
  const min = /^min\((.*)\)$/.exec(css);
  const terms = min ? splitTopLevel(min[1]!) : [css];
  return Math.min(...terms.map((t) => resolveTerm(t.trim(), viewportPx)));
}

function resolveTerm(term: string, viewportPx: number): number {
  const px = /^([\d.]+)px$/.exec(term);
  if (px) return Number(px[1]);
  const calc = /^calc\(\s*100vw\s*-\s*([\d.]+)px\s*\)$/.exec(term);
  if (calc) return viewportPx - Number(calc[1]);
  throw new Error(`unsupported width declaration: ${JSON.stringify(term)}`);
}

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** The floating panel: the one element carrying BOTH an inline right offset and an inline width. */
function panelOf(container: HTMLElement): HTMLElement {
  const hits = [...container.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.style.right !== '' && el.style.width !== '',
  );
  if (hits.length !== 1) throw new Error(`expected exactly one floating panel, found ${hits.length}`);
  return hits[0]!;
}

/**
 * The invariant: the panel keeps AT LEAST as much room on the left as it reserves on the right, at
 * every viewport width.
 *
 * Deliberately stricter than "left edge >= 0". A clamp that subtracts only ONE gap
 * (`calc(100vw - 24px)`) still puts the left edge at exactly 0 — technically on-screen, visually
 * jammed against the bezel with no margin, and asymmetric with the 24px it leaves on the right.
 * That weaker assertion passed with the wrong arithmetic in the helper, which is the whole reason
 * this one is written against `right` instead of zero.
 */
function expectFitsViewport(panel: HTMLElement, label: string) {
  const right = Number(/^([\d.]+)px$/.exec(panel.style.right)?.[1] ?? NaN);
  expect(Number.isFinite(right), `${label}: right offset should be a px value`).toBe(true);

  for (const viewport of VIEWPORTS) {
    const width = resolvePx(panel.style.width, viewport);
    const leftEdge = viewport - right - width;
    expect(
      leftEdge >= right,
      `${label} at ${viewport}px viewport: width resolves to ${width}px, leaving ${leftEdge}px on the left against ${right}px on the right`,
    ).toBe(true);
  }
}

describe('clampedPanelWidth geometry', () => {
  it('never lets a panel exceed the viewport minus both gaps, and never exceeds its preferred size', () => {
    for (const preferred of [320, 380, 560]) {
      const declared = clampedPanelWidth(preferred);
      for (const viewport of VIEWPORTS) {
        const width = resolvePx(declared, viewport);
        expect(width).toBeLessThanOrEqual(preferred);
        // A gap on the left as well as the right — not merely "fits".
        expect(viewport - PANEL_EDGE_GAP_PX - width).toBeGreaterThanOrEqual(PANEL_EDGE_GAP_PX);
      }
    }
  });

  it('still gives the full preferred width on a roomy viewport', () => {
    expect(resolvePx(clampedPanelWidth(380), 1440)).toBe(380);
  });
});

describe('the popovers themselves', () => {
  it('A2 audio popover fits every viewport', () => {
    const { container } = render(
      <A2AudioModal
        projectId="p1"
        videoFileId="v1"
        globalOffsetSec={0}
        audioFiles={[]}
        onInserted={() => {}}
        onAudioFilesChange={() => {}}
        onClose={() => {}}
      />,
    );
    expectFitsViewport(panelOf(container), 'A2AudioModal');
  });

  it('timeline audio-gain popover fits every viewport', () => {
    const section = {
      id: 'sec-1', project_id: 'p1', start_sec: 2, end_sec: 6,
      label: 'Intro sting', broll_volume: 0.8,
    } as never;
    const { container } = render(
      <AudioGainPopover
        projectId="p1"
        section={section}
        onUpdate={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );
    expectFitsViewport(panelOf(container), 'AudioGainPopover');
  });
});
