/**
 * Shot detection — the stage every per-shot decision below it inherits.
 *
 * The case that matters is the one the previous detector could not see at all: two
 * matched-exposure cameras in the same room. Their global grey histograms are nearly
 * identical, so a global-histogram detector scores the reverse angle near zero at any
 * threshold, merges the two framings into one segment, and lets every downstream stage
 * average across a cut. That clip is in the eval set, and its cut times are ground truth.
 */

import { describe, it, expect } from 'vitest';
import {
  blockHistogram, blockDistance, detectShotBoundaries, BLOCKS_X, BLOCKS_Y, BLOCK_BINS,
} from '../shotDetect.js';
import { bhattacharyya } from '../dsp.js';
import { evalClips, ANALYSIS_W, ANALYSIS_H, SAMPLE_FPS } from '../eval/fixtures.js';
import { SceneAnalyzer } from '../sceneAnalyzer.js';

/** A grey frame with a bright block at normalised (cx, cy) on a dark field. */
function framed(cx: number, cy: number): Uint8Array {
  const g = new Uint8Array(ANALYSIS_W * ANALYSIS_H).fill(30);
  const x0 = Math.round((cx - 0.1) * ANALYSIS_W), x1 = Math.round((cx + 0.1) * ANALYSIS_W);
  const y0 = Math.round((cy - 0.15) * ANALYSIS_H), y1 = Math.round((cy + 0.15) * ANALYSIS_H);
  for (let y = Math.max(0, y0); y < Math.min(ANALYSIS_H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(ANALYSIS_W, x1); x++) g[y * ANALYSIS_W + x] = 220;
  }
  return g;
}

describe('blockHistogram', () => {
  it('normalises each block independently', () => {
    const h = blockHistogram(framed(0.3, 0.5), ANALYSIS_W, ANALYSIS_H);
    expect(h.length).toBe(BLOCKS_X * BLOCKS_Y * BLOCK_BINS);
    for (let b = 0; b < BLOCKS_X * BLOCKS_Y; b++) {
      let sum = 0;
      for (let k = 0; k < BLOCK_BINS; k++) sum += h[b * BLOCK_BINS + k];
      expect(sum).toBeCloseTo(1, 9);
    }
  });

  it('sees a reframe that a global histogram is blind to', () => {
    // The same pixels in a different place — a same-room reverse angle in its purest form,
    // and the exact case the 0.30 global-Bhattacharyya threshold could never reach.
    const a = framed(0.25, 0.5);
    const b = framed(0.75, 0.5);
    const globalHist = (g: Uint8Array) => {
      const h = new Float64Array(32);
      for (let i = 0; i < g.length; i++) h[(g[i] * 32) >> 8]++;
      return h;
    };
    expect(bhattacharyya(globalHist(a), globalHist(b))).toBeLessThan(0.05);
    expect(blockDistance(
      blockHistogram(a, ANALYSIS_W, ANALYSIS_H),
      blockHistogram(b, ANALYSIS_W, ANALYSIS_H),
    )).toBeGreaterThan(0.3);
  });
});

describe('detectShotBoundaries', () => {
  it('finds an isolated spike and ignores steady change', () => {
    const steady = new Array(40).fill(0.02);
    expect(detectShotBoundaries(steady, 0.25)).toEqual([]);
    const withCut = [...steady];
    withCut[20] = 0.5;
    expect(detectShotBoundaries(withCut, 0.25)).toEqual([20]);
  });

  it('does not fire on footage that is uniformly busy', () => {
    // Handheld: large change everywhere. A fixed absolute threshold cuts constantly here;
    // the ratio against the local average is what makes it a non-event.
    const busy = Array.from({ length: 60 }, (_, i) => 0.25 + 0.02 * Math.sin(i));
    expect(detectShotBoundaries(busy, 0.25)).toEqual([]);
  });

  it('enforces the minimum shot length', () => {
    const scores = new Array(40).fill(0.01);
    scores[10] = 0.6; scores[11] = 0.6;
    expect(detectShotBoundaries(scores, 0.25)).toEqual([10]);
  });
});

describe('cut detection on the multicam fixture', () => {
  it('recovers every same-room reverse-angle cut, within one frame', () => {
    const clip = evalClips().find((c) => c.id === 'multicam-same-room')!;
    expect(clip.cuts.length).toBeGreaterThan(0);

    const analyzer = new SceneAnalyzer(ANALYSIS_W, ANALYSIS_H);
    const scores: number[] = [];
    let prev: Float64Array | null = null;
    const n = Math.round(clip.durationSec * clip.sampleFps);
    for (let i = 0; i < n; i++) {
      const hist = blockHistogram(analyzer.toGray(clip.frame(i)), ANALYSIS_W, ANALYSIS_H);
      scores.push(prev ? blockDistance(prev, hist) : 0);
      prev = hist;
    }

    const found = detectShotBoundaries(scores, 1 / SAMPLE_FPS).map((i) => i / SAMPLE_FPS);
    const matched = clip.cuts.filter((t) => found.some((f) => Math.abs(f - t) <= 1 / SAMPLE_FPS));
    const recall = matched.length / clip.cuts.length;
    const precision = found.length ? matched.length / found.length : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    expect(recall, `found cuts at [${found.join(', ')}], truth [${clip.cuts.join(', ')}]`).toBe(1);
    expect(f1, `precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}`).toBeGreaterThanOrEqual(0.9);
  });
});
