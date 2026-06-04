/**
 * Global head localization for static-camera podcasts.
 *
 * Per-frame peak picking is jittery and tends to collapse both heads toward
 * centre. Two structural priors make face-free localization reliable:
 *
 *   1. Static camera  → the speakers occupy fixed horizontal positions for the
 *      whole take, so we localise once from profiles summed over all frames.
 *   2. Two-shot layout → exactly one speaker sits left-of-centre and one
 *      right-of-centre. We therefore take the strongest "person energy" peak in
 *      each half of the frame, which guarantees two well-separated heads instead
 *      of two peaks piled up near the middle.
 *
 * Person energy = skin (faces) ×2 + saliency ×0.6 + persistent motion ×1.0.
 */

import { PROFILE_COLS } from './sceneAnalyzer.js';

const HEAD_WINDOW = 0.09;       // ± window (norm.) used to pool per-head motion
const SECOND_HEAD_MIN = 0.45;   // 2nd head must reach this fraction of the 1st to count
const MIN_SEPARATION = 0.22;    // two heads must be at least this far apart (norm.)
const VALLEY_RATIO = 0.70;      // dip between heads must fall below this × weaker peak

export interface HeadModel {
  heads: number[];              // 0..2 stable head centres, sorted left→right (0..1)
  isTwoShot: boolean;
}

export function locateHeads(
  skinSum: Float64Array,
  salSum: Float64Array,
  actSum: Float64Array,
): HeadModel {
  const n = PROFILE_COLS;
  const sk = normCopy(skinSum), sa = normCopy(salSum), ac = normCopy(actSum);
  const profile = new Float64Array(n);
  for (let x = 0; x < n; x++) profile[x] = sk[x] * 2.0 + sa[x] * 0.6 + ac[x] * 1.0;
  const smoothed = boxBlur(profile, Math.max(2, Math.floor(n * 0.04)));

  // Strongest peak in each half (exclude the dead-centre column gap).
  const mid = Math.floor(n / 2);
  const left = argmaxRange(smoothed, Math.floor(n * 0.10), Math.floor(n * 0.46));
  const right = argmaxRange(smoothed, Math.ceil(n * 0.54), Math.floor(n * 0.90));

  if (left.idx < 0 && right.idx < 0) return { heads: [], isTwoShot: false };

  const globalMax = Math.max(left.val, right.val);
  const lx = left.idx / (n - 1);
  const rx = right.idx / (n - 1);

  // Genuine two-shot test: both peaks strong, well separated, AND a real valley
  // between them (two people have a gap; a single centred face does not). This
  // gate is what stops animations / single speakers from being split in two.
  const bothStrong = left.val >= globalMax * SECOND_HEAD_MIN && right.val >= globalMax * SECOND_HEAD_MIN;
  const separated = rx - lx >= MIN_SEPARATION;
  let valleyOk = false;
  if (bothStrong && separated) {
    let valley = Infinity;
    for (let x = left.idx + 1; x < right.idx; x++) if (smoothed[x] < valley) valley = smoothed[x];
    valleyOk = valley <= Math.min(left.val, right.val) * VALLEY_RATIO;
  }

  if (bothStrong && separated && valleyOk) {
    return { heads: [lx, rx], isTwoShot: true };
  }

  // Single dominant person → no speaker switching, crop follows the interest map.
  const only = left.val >= right.val ? left.idx : right.idx;
  void mid;
  return { heads: only >= 0 ? [only / (n - 1)] : [], isTwoShot: false };
}

/** Index of the head with the most motion energy in this frame (or null). */
export function activeHeadIndex(motion: Float64Array, heads: number[]): number | null {
  if (heads.length === 0) return null;
  const n = motion.length;
  const win = Math.max(1, Math.floor(HEAD_WINDOW * n));
  let bestIdx = 0, bestE = -1;
  for (let h = 0; h < heads.length; h++) {
    const c = Math.round(heads[h] * (n - 1));
    let e = 0;
    for (let x = Math.max(0, c - win); x <= Math.min(n - 1, c + win); x++) e += motion[x];
    if (e > bestE) { bestE = e; bestIdx = h; }
  }
  return bestE > 1e-6 ? bestIdx : null;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function argmaxRange(a: Float64Array, lo: number, hi: number): { idx: number; val: number } {
  let idx = -1, val = -Infinity;
  for (let x = lo; x <= hi && x < a.length; x++) if (a[x] > val) { val = a[x]; idx = x; }
  return { idx, val: idx >= 0 ? val : 0 };
}

function normCopy(a: Float64Array): Float64Array {
  const out = a.slice();
  let m = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > m) m = out[i];
  if (m > 1e-9) for (let i = 0; i < out.length; i++) out[i] /= m;
  return out;
}

function boxBlur(a: Float64Array, radius: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += a[j]; c++;
    }
    out[i] = s / Math.max(1, c);
  }
  return out;
}
