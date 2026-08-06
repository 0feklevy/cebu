import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SimPoolOverlay } from '../components/viewer/SimPoolOverlay';

vi.mock('../lib/assetUrl', () => ({ resolveAssetUrl: (u: string) => u }));

const frames = [{ key: 'k1', src: 'https://cdn.test/a/index.html', bootHide: [] }] as never;
const noop = () => {};

const poster = (c: HTMLElement) => c.querySelector('img.sim-cold-poster') as HTMLImageElement | null;
const spinner = (c: HTMLElement) => c.querySelector('.sim-overlay-spinner');

describe('cold-seek affordance', () => {
  it('shows the captured poster instead of a bare spinner once the poster has PAINTED', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc="https://cdn.test/p.png" registerFrame={noop} onFrameLoad={noop} />);
    const img = poster(container);
    expect(img, 'no poster rendered during the cold wait').not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://cdn.test/p.png');
    // The requirement is "no spinner OVER A VALID POSTER" — which is only true once the poster is
    // actually on screen. Before that the element is an opaque black rectangle.
    fireEvent.load(img!);
    expect(spinner(container), 'spinner stacked over a painted poster').toBeNull();
  });

  // REGRESSION (suppression was keyed on the URL existing, not on the poster painting).
  // Without the fix the spinner is removed the instant a posterSrc exists, so the viewer stares at
  // `.sim-cold-poster`'s opaque `background:#000` with no cue for the whole fetch.
  it('keeps the cue while the poster is still FETCHING, and drops it only on load', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc="https://cdn.test/slow.png" registerFrame={noop} onFrameLoad={noop} />);
    expect(spinner(container), 'no cue while the poster is still downloading — a black box').not.toBeNull();
    fireEvent.load(poster(container)!);
    expect(spinner(container), 'cue outlived the poster it was covering for').toBeNull();
  });

  // REGRESSION (same defect, permanent case): a 404 poster left a black rectangle forever.
  it('drops a poster that FAILED and restores the cue, instead of a permanent black box', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc="https://cdn.test/gone.png" registerFrame={noop} onFrameLoad={noop} />);
    fireEvent.error(poster(container)!);
    expect(poster(container), 'a poster that will never arrive is still painting an opaque box').toBeNull();
    expect(spinner(container), 'no cue at all after the poster failed').not.toBeNull();
    expect(
      container.querySelector('.sim-wait-affordance.has-poster'),
      'still styled as if a poster were present (scrim suppressed) after it failed',
    ).toBeNull();
  });

  // REGRESSION: readiness must be keyed to the SPECIFIC src, or a section change inherits the
  // previous poster's "painted" state and suppresses the cue for a poster that has not loaded.
  it('re-arms the cue when the section changes to a different poster', () => {
    const { container, rerender } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc="https://cdn.test/a.png" registerFrame={noop} onFrameLoad={noop} />);
    fireEvent.load(poster(container)!);
    expect(spinner(container)).toBeNull();
    rerender(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc="https://cdn.test/b.png" registerFrame={noop} onFrameLoad={noop} />);
    expect(spinner(container), 'new poster inherited the previous one’s painted state').not.toBeNull();
  });

  it('keeps the spinner when the section has NO captured poster', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        coldCover posterSrc={null} registerFrame={noop} onFrameLoad={noop} />);
    expect(poster(container)).toBeNull();
    expect(spinner(container)).not.toBeNull();
  });

  it('keeps a motion cue when the sim has genuinely STALLED, so a still frame cannot read as done', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible={false} armGate
        stalled posterSrc="https://cdn.test/p.png" registerFrame={noop} onFrameLoad={noop} />);
    fireEvent.load(poster(container)!);
    expect(poster(container)).not.toBeNull();
    expect(spinner(container), 'the stall cue vanished once the poster painted').not.toBeNull();
  });

  it('shows nothing at all when the sim is neither cold nor stalled', () => {
    const { container } = render(
      <SimPoolOverlay frames={frames} activeKey="k1" visible armGate
        posterSrc="https://cdn.test/p.png" registerFrame={noop} onFrameLoad={noop} />);
    expect(container.querySelector('.sim-wait-affordance')).toBeNull();
  });
});

// The stall cue is a PAINT claim, and jsdom neither applies the real stylesheet nor computes paint
// order — the previous version of this suite asserted DOM presence only, which is exactly why a
// fully occluded spinner passed as "a motion cue is retained". `.sim-cold-poster` is absolutely
// positioned, so it paints in a later stacking layer than a statically-positioned sibling: without
// its own stacking context the spinner sits behind an opaque `background:#000`. This pins the
// stylesheet contract; the browser matrix proves the rendered result.
describe('cold-seek affordance — stacking contract in viewer.css', () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../components/viewer/viewer.css'),
    'utf-8',
  );
  const rule = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    expect(i, `${selector} rule is missing from viewer.css`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('gives the spinner a stacking context so it paints ABOVE the absolutely-positioned poster', () => {
    const spinnerRule = rule('.sim-overlay-spinner');
    expect(spinnerRule, 'spinner is statically positioned — it paints under the poster')
      .toMatch(/position:\s*(relative|absolute|sticky|fixed)/);
    expect(spinnerRule, 'spinner has no z-index — paint order is left to document order')
      .toMatch(/z-index:\s*[1-9]/);
  });

  it('still letterboxes the poster with object-fit: contain, matching the live sim', () => {
    expect(rule('.sim-cold-poster')).toMatch(/object-fit:\s*contain/);
  });
});
