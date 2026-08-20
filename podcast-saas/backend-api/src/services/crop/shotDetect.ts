/**
 * Shot-boundary detection for the crop pipeline.
 *
 * Every per-shot stage downstream — head localization, the active-speaker decision, the
 * smoother's hard resets — is scoped to a shot, so a missed cut does not degrade gracefully:
 * it merges two incompatible framings into one segment, averages their head positions, and
 * lets the smoother pan across a cut the viewer can see.
 *
 * What this replaces failed in two specific ways, both of them structural rather than
 * badly-tuned:
 *
 *   • ONE GLOBAL HISTOGRAM. A 32-bin grey histogram of the whole frame is blind to
 *     rearrangement. Two matched-exposure cameras pointed at the same room — the standard
 *     two-camera podcast setup — produce nearly identical global histograms, so the reverse
 *     angle scores near zero however the threshold is set. Comparing per-block histograms
 *     restores the spatial information the global one throws away: the same pixels in
 *     different places is exactly what a cut is.
 *
 *   • A FIXED THRESHOLD. 0.30 of Bhattacharyya distance means something different in a
 *     locked-off interview than in handheld footage. A cut is not an absolute amount of
 *     change, it is change that is anomalous FOR THIS FOOTAGE, so the test here is a ratio
 *     against the local average — PySceneDetect's AdaptiveDetector logic, which measures
 *     F1 91.59 on the BBC Planet Earth hard-cut set where fixed thresholds do far worse.
 *
 * An absolute floor is kept alongside the ratio, because the ratio alone fires on the first
 * flicker of a locked-off shot where the local average is essentially zero.
 */

import { bhattacharyya } from './dsp.js';

/** 4×3 grid of 16-bin histograms: enough spatial resolution to see a reframe, cheap to compare. */
export const BLOCKS_X = 4;
export const BLOCKS_Y = 3;
export const BLOCK_BINS = 16;

/**
 * How many of the most-changed blocks the distance is averaged over.
 *
 * Averaging all twelve dilutes exactly the case this detector exists for. A reverse angle
 * that keeps the background and moves the subject changes two or three blocks completely and
 * leaves the rest alone: measured on a mirrored subject, the twelve-block mean reads 0.149
 * while the top four read 0.447. Taking a few blocks rather than one keeps a single noisy
 * block from being able to declare a cut on its own.
 */
const TOP_BLOCKS = 4;
/** Change must exceed this multiple of the local average to count as a cut. */
const ADAPTIVE_RATIO = 2.6;
/** ...and must clear this absolute distance, so still footage cannot self-trigger. */
const MIN_DISTANCE = 0.18;
/** Frames each side used to establish "normal" change for this stretch of footage. */
const LOCAL_RADIUS = 3;
/** Two boundaries closer than this collapse to one — a shot is never shorter than this. */
const MIN_GAP_SEC = 0.5;

/**
 * Per-block grey histograms, L1-normalised within each block so a block's distance measures
 * its distribution rather than its share of the frame.
 */
export function blockHistogram(gray: Uint8Array, width: number, height: number): Float64Array {
  const out = new Float64Array(BLOCKS_X * BLOCKS_Y * BLOCK_BINS);
  const counts = new Float64Array(BLOCKS_X * BLOCKS_Y);
  for (let y = 0; y < height; y++) {
    const by = Math.min(BLOCKS_Y - 1, Math.floor((y * BLOCKS_Y) / height));
    for (let x = 0; x < width; x++) {
      const bx = Math.min(BLOCKS_X - 1, Math.floor((x * BLOCKS_X) / width));
      const block = by * BLOCKS_X + bx;
      out[block * BLOCK_BINS + ((gray[y * width + x] * BLOCK_BINS) >> 8)]++;
      counts[block]++;
    }
  }
  for (let b = 0; b < counts.length; b++) {
    if (counts[b] <= 0) continue;
    for (let k = 0; k < BLOCK_BINS; k++) out[b * BLOCK_BINS + k] /= counts[b];
  }
  return out;
}

/** Distance between two block histograms: the mean over the TOP_BLOCKS most-changed blocks. */
export function blockDistance(a: Float64Array, b: Float64Array): number {
  const blocks = BLOCKS_X * BLOCKS_Y;
  const d: number[] = [];
  for (let i = 0; i < blocks; i++) {
    d.push(bhattacharyya(
      a.subarray(i * BLOCK_BINS, (i + 1) * BLOCK_BINS),
      b.subarray(i * BLOCK_BINS, (i + 1) * BLOCK_BINS),
    ));
  }
  d.sort((p, q) => q - p);
  let sum = 0;
  for (let i = 0; i < TOP_BLOCKS; i++) sum += d[i];
  return sum / TOP_BLOCKS;
}

/**
 * Frame indices where a cut begins, from the per-frame distance series. `scores[i]` is the
 * distance between frame i and frame i−1; `scores[0]` is ignored.
 *
 * Detection runs after the decode rather than inside it so the local average can be
 * two-sided. A one-sided average makes the frame after a cut look anomalous too — the
 * classic double-fire — and costs a real boundary whenever a cut lands inside the warm-up
 * of the window.
 */
export function detectShotBoundaries(scores: number[], sampleInterval: number): number[] {
  const cuts: number[] = [];
  let lastCutFrame = -Infinity;
  const minGapFrames = Math.max(1, Math.round(MIN_GAP_SEC / sampleInterval));

  for (let i = 1; i < scores.length; i++) {
    if (scores[i] < MIN_DISTANCE) continue;
    if (i - lastCutFrame < minGapFrames) continue;

    let sum = 0, n = 0;
    for (let j = Math.max(1, i - LOCAL_RADIUS); j <= Math.min(scores.length - 1, i + LOCAL_RADIUS); j++) {
      if (j === i) continue;
      sum += scores[j]; n++;
    }
    const local = n > 0 ? sum / n : 0;
    // With no local motion to compare against, the absolute floor above is the whole test.
    if (local > 1e-6 && scores[i] < local * ADAPTIVE_RATIO) continue;

    cuts.push(i);
    lastCutFrame = i;
  }
  return cuts;
}
