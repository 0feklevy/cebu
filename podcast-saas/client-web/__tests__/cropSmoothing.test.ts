/**
 * WHAT THE VIEWER ACTUALLY SEES when the backend commits a speaker switch.
 *
 * The backend crop work was verified against its own keyframe JSON, and an adversarial review
 * pointed out that the JSON is not what anyone watches: `useCropOverlay` applies its own smoothing
 * on top, and that smoothing had two defects which between them undid the backend fix.
 *
 *   1. It was per-ANIMATION-FRAME (`x += (target - x) * 0.06`), so the pan took ~0.85s at 60Hz and
 *      ~1.70s at 30Hz — the same video framed differently on different hardware.
 *   2. It EASED ACROSS CUTS, turning the backend's deliberate step back into the slow drift that
 *      leaves the viewer on the previous speaker for most of a short turn.
 *
 * The reviewer measured a 235px miss at 30Hz for a 1.5s turn and said plainly that "the entire
 * viewer-visible gap is untested by construction". This file is that test.
 *
 * IT EXERCISES THE SHIPPED FUNCTION. A first draft reimplemented the smoothing law here and
 * consequently stayed green when the cut-snap was deleted from the hook — the mutation check
 * caught it, which is exactly the "reimplemented law" trap. `nextCropX` is now exported and this
 * suite drives it directly, so a change to the hook cannot pass unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextCropX, sourceCropXToRenderedX } from '../components/viewer/useCropOverlay';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../components/viewer/useCropOverlay.ts'), 'utf-8');
const TAU = Number(/const SMOOTH_TAU_MS = (\d+)/.exec(SRC)?.[1]);

/** Run the SHIPPED law over a run of frames at a given refresh rate. */
function simulate(target: number, from: number | null, hz: number, ms: number): number {
  const dt = 1000 / hz;
  let x: number | null = from;
  for (let t = 0; t < ms; t += dt) x = nextCropX(x, target, t === 0 && from === null ? 0 : dt);
  return x as number;
}

describe('the crop the viewer sees', () => {
  it('reads its time constant from the shipped hook', () => {
    expect(Number.isFinite(TAU)).toBe(true);
  });

  it('adopts a CUT outright instead of easing across it', () => {
    // The mutation that slipped past the first draft: delete the snap branch and this must fail.
    const oneFrameAt60 = nextCropX(0.295, 0.705, 1000 / 60);
    expect(oneFrameAt60).toBe(0.705);
  });

  it('lands on the new speaker at 30Hz and 60Hz alike — the frame-rate defect', () => {
    // A two-shot switch: 0.295 -> 0.705, which is far beyond SNAP_THRESHOLD.
    const at60 = simulate(0.705, 0.295, 60, 500);
    const at30 = simulate(0.705, 0.295, 30, 500);
    expect(at60).toBeCloseTo(0.705, 5);
    expect(at30).toBeCloseTo(0.705, 5);
    // The old per-frame law differed by ~2x between these two; the new one must not differ at all.
    expect(Math.abs(at60 - at30)).toBeLessThan(1e-9);
  });

  it('follows a 1.5s turn instead of spending it in transit', () => {
    // The reviewer's measurement: at 30Hz the viewer was off the speaker for 89% of a 1.5s turn.
    // A cut is now adopted, so the viewer is on the speaker for essentially all of it.
    const x = simulate(0.705, 0.295, 30, 1500);
    const missFraction = Math.abs(0.705 - x);
    expect(missFraction).toBeLessThan(0.01);
  });

  it('still EASES an ordinary pan, so a walking presenter is not jerky', () => {
    // A small drift stays smoothed: after one tau it has covered ~63%, not 100%.
    const drift = simulate(0.55, 0.50, 60, TAU);
    expect(drift).toBeGreaterThan(0.50);
    expect(drift).toBeLessThan(0.55);
    expect(drift - 0.50).toBeCloseTo(0.05 * (1 - Math.exp(-1)), 2);
  });

  it('adopts the first keyframe of a segment rather than panning in from centre', () => {
    // BEHAVIOUR first — a source-text assertion alone let a mutation returning 0.5 survive.
    // A segment whose speaker is at 0.8 must START at 0.8, not slide there from mid-frame.
    expect(nextCropX(null, 0.8, 0)).toBe(0.8);
    expect(nextCropX(null, 0.2, 16)).toBe(0.2);

    // `smoothX` starts null and the first tick takes its target outright. Pinned on the source so
    // a future edit cannot quietly restore `smoothX.current = 0.5` on segment change.
    expect(SRC).toMatch(/smoothX\s*=\s*useRef<number \| null>\(null\)/);
    expect(SRC).toMatch(/smoothX\.current\s*=\s*null;/);
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/smoothX\.current\s*=\s*0\.5/);
  });

  it('uses elapsed time, not a per-frame constant — asserted by BEHAVIOUR', () => {
    // Two ticks of 8ms must move exactly as far as one tick of 16ms. A per-frame factor cannot
    // satisfy this; only a time-based one can. Behaviour, not spelling — the first draft asserted
    // the source text and broke when a parameter was renamed, which pins nothing that matters.
    const oneBig = nextCropX(0.50, 0.55, 16);
    const twoSmall = nextCropX(nextCropX(0.50, 0.55, 8), 0.55, 8);
    expect(twoSmall).toBeCloseTo(oneBig, 12);

    // And the old constant is genuinely gone from live code (comments quote it deliberately).
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\*\s*0\.06/);
  });
});

describe('the crop lands on the subject for a NON-16:9 source (D-16)', () => {
  // Crop analysis runs on the ORIGINAL upload; the player shows a 16:9 HLS tier, so a 4:3 source
  // is pillarboxed and every crop fraction is measured in a different coordinate space from the
  // one it is applied in. Nothing reconciled them, so the crop landed left of the subject on any
  // non-16:9 video — the common Zoom/webcam case. Codex's D-16 ruling names the exact number.
  it('maps 0.2 in a 4:3 source to 0.275 in the padded 16:9 frame', () => {
    expect(sourceCropXToRenderedX(0.2, 1440, 1080, 1920, 1080)).toBeCloseTo(0.275, 6);
  });

  it('keeps the frame centre at the centre', () => {
    expect(sourceCropXToRenderedX(0.5, 1440, 1080, 1920, 1080)).toBeCloseTo(0.5, 6);
  });

  it('maps the source edges to the pillar edges, never outside them', () => {
    expect(sourceCropXToRenderedX(0, 1440, 1080, 1920, 1080)).toBeCloseTo(0.125, 6);
    expect(sourceCropXToRenderedX(1, 1440, 1080, 1920, 1080)).toBeCloseTo(0.875, 6);
  });

  it('leaves a matching 16:9 source untouched — the common path must not move', () => {
    for (const x of [0, 0.2, 0.5, 0.8, 1]) {
      expect(sourceCropXToRenderedX(x, 1920, 1080, 1920, 1080)).toBe(x);
    }
  });

  it('degrades to today behaviour when the source dimensions are unknown', () => {
    // An older crop artifact without width/height must not produce a WRONG number.
    expect(sourceCropXToRenderedX(0.2, undefined, undefined, 1920, 1080)).toBe(0.2);
  });

  it('does not shift x for a source that is letterboxed rather than pillarboxed', () => {
    // A source WIDER than the tile gets bars top and bottom; nothing moves horizontally.
    expect(sourceCropXToRenderedX(0.2, 2560, 1080, 1920, 1080)).toBe(0.2);
  });
});
