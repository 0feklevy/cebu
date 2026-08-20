/**
 * Audio-visual active-speaker detection.
 *
 * The single hardest problem in podcast cropping is "which of the two visible
 * faces is talking right now". Per-frame motion fails: both people move, trees
 * sway behind them, hands gesture. The robust signal — the one research-grade
 * active-speaker detectors (TalkNet, SyncNet) are built on — is *temporal
 * correlation between a face's motion and the audio envelope*:
 *
 *   • The speaker's mouth/jaw moves in sync with the speech they produce, so
 *     their region's motion rises and falls WITH the audio energy.
 *   • Background motion (trees) is uncorrelated with audio → cancels out.
 *   • The listener's idle motion is uncorrelated with the current speech → cancels.
 *
 * So for each head region we pool its motion into a time series, and for each
 * moment compute the local Pearson correlation of (region motion) vs (audio
 * envelope). The region with the higher, clearly-leading correlation is the
 * active speaker. This needs no face model — just the two head x-positions.
 */

import { PROFILE_COLS } from './sceneAnalyzer.js';

const WINDOW_FRAC = 0.13;   // ± column window (norm.) pooled around each head centre

export interface AVConfig {
  halfWindow: number;       // frames each side of the centre frame for local correlation
  /** "Speaking" bar, in null-distribution standard deviations of r (see nullSigma). */
  minCorrSigma: number;
  /** Lead one region must have over the other, in the same units; below it the frame is ambiguous. */
  marginSigma: number;
  silenceFloorRel: number;  // window audio mean must exceed this × global mean
}

/**
 * Standard deviation of Pearson's r under the null hypothesis for a window of `halfWindow`
 * frames each side — n = 2·halfWindow + 1 samples, SD ≈ 1/√(n−1).
 *
 * The gate's thresholds are expressed as multiples of this rather than as bare correlations
 * because a bare correlation means nothing without the sample count behind it. At the
 * shipped halfWindow of 5 the window holds 11 samples and this SD is 0.32, so the literal
 * 0.12 and 0.06 the file used to carry were a 0.38σ bar and a 0.19σ lead — thresholds that
 * random noise clears constantly. Stating them in σ makes that visible in the source, and
 * makes them still correct if the window size is ever changed.
 */
export function nullSigma(halfWindow: number): number {
  return 1 / Math.sqrt(Math.max(1, 2 * halfWindow));
}

/**
 * The σ multipliers are the sweep's answer, not a guess — `scripts/crop-eval/sweep-av.ts`
 * scores an 80-point grid over halfWindow × minCorr × margin on the eval set, and these
 * reproduce the grid's best mIoU and best subject-out-of-frame rate.
 *
 * The sweep's more important result is negative, and it is recorded here because it changes
 * what the next fix should be: attribution accuracy never exceeds 0.499 at ANY point in the
 * grid, against 0.500 for guessing. Raising the bar only converts wrong answers into
 * abstentions — out-of-frame rises as fast as accuracy does — because the underlying signal,
 * gross frame-difference motion pooled over ±12.5% of frame width at 4 fps, is torso and
 * background, not lips: syllable-rate mouth motion is 3–8 Hz and aliases past the 2 Hz
 * Nyquist this sampling allows. No threshold recovers information the signal never carried.
 * The fix is a spatially specific signal (mouth-ROI lip activity), not a stricter gate.
 */
export const DEFAULT_AV: AVConfig = {
  halfWindow: 5,
  minCorrSigma: 0.38,
  marginSigma: 0.19,
  silenceFloorRel: 0.35,
};

/**
 * Per-column motion energy, gated by how well that column's motion tracks the audio
 * envelope over the shot.
 *
 * This is the only signal in the pipeline that answers "is this person SPEAKING" rather
 * than "is a person HERE". Skin tone and spectral saliency both answer the second
 * question, and at the pipeline's 4 fps raw frame-difference motion is gross head/body
 * movement, not lip sync — so an animated listener outscores a still-headed talker
 * (see PIPELINE.md and the 4 fps limitation recorded in the D-16 investigation).
 * Correlating each column against the speech envelope separates them: a talker's region
 * rises and falls WITH the audio; nodding, gesturing, a swaying plant and a ceiling fan
 * do not.
 *
 * Returned as energy x max(0, r) — magnitude is preserved so a column that barely moves
 * cannot win on a perfect correlation of nothing, and negative correlation is treated as
 * "no evidence", not as evidence against.
 *
 * Zero everywhere when there is no audio, when the track is silent, or when the shot is
 * too short to correlate — callers then fall back to the audio-blind weighting.
 *
 * Cost is O(PROFILE_COLS x frames) per shot: ~1.4M multiply-adds for a 1-hour source,
 * against a measured JS budget of 0.37 CPU-seconds per video-minute. Negligible.
 */
export function speechCorrelatedMotion(
  motionPerFrame: Float64Array[],
  env: Float64Array,
  minFrames = 8,
): Float64Array {
  const n = Math.min(motionPerFrame.length, env.length);
  const out = new Float64Array(PROFILE_COLS);
  if (n < minFrames) return out;

  let envMean = 0;
  for (let i = 0; i < n; i++) envMean += env[i];
  envMean /= n;
  let envVar = 0;
  for (let i = 0; i < n; i++) { const d = env[i] - envMean; envVar += d * d; }
  if (envVar < 1e-12) return out;              // silent or constant audio → no opinion

  for (let x = 0; x < PROFILE_COLS; x++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += motionPerFrame[i][x];
    if (sum <= 0) continue;
    const mean = sum / n;
    let num = 0, motVar = 0;
    for (let i = 0; i < n; i++) {
      const a = motionPerFrame[i][x] - mean, b = env[i] - envMean;
      num += a * b; motVar += a * a;
    }
    const den = Math.sqrt(motVar * envVar);
    const r = den < 1e-12 ? 0 : num / den;
    if (r > 0) out[x] = sum * r;
  }
  return out;
}

/** Pool per-frame motion energy into a time series for one head region. */
export function regionMotionSeries(motionPerFrame: Float64Array[], headX: number): Float64Array {
  const n = motionPerFrame.length;
  const out = new Float64Array(n);
  const [lo, hi] = headColumns(headX);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const m = motionPerFrame[i];
    for (let x = lo; x <= hi; x++) s += m[x];
    out[i] = s;
  }
  return out;
}

/** Column range pooled for one head centre — the single definition of "this head's region". */
export function headColumns(headX: number): [number, number] {
  const c = Math.round(headX * (PROFILE_COLS - 1));
  const win = Math.max(1, Math.floor(WINDOW_FRAC * PROFILE_COLS));
  return [Math.max(0, c - win), Math.min(PROFILE_COLS - 1, c + win)];
}

/**
 * Total shot-level speech-correlated motion sitting under one head.
 *
 * `speechCorrelatedMotion` answers, per column, "does what moves here rise and fall with the
 * speech?" over a whole shot. Summed under a head it becomes that head's share of the
 * evidence that it did the talking during this shot — a slow, high-sample-count statistic,
 * where the windowed per-frame correlation is a fast, 11-sample one that measurement shows
 * lands below chance (see DEFAULT_AV). It is the same quantity `locateHeads` already trusts
 * to find the speaker, read per head instead of per column.
 */
export function headSpeechEvidence(speechSum: Float64Array, headX: number): number {
  const [lo, hi] = headColumns(headX);
  let s = 0;
  for (let x = lo; x <= hi; x++) s += speechSum[x];
  return s;
}

/** Pearson correlation of two slices a[lo..hi], b[lo..hi]. */
function pearson(a: Float64Array, b: Float64Array, lo: number, hi: number): number {
  const n = hi - lo + 1;
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = lo; i <= hi; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = lo; i <= hi; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-9 ? 0 : num / den;
}

/**
 * Per-frame active region (0 = left head, 1 = right head, null = can't tell) from
 * windowed audio-visual correlation. `env` is the per-frame audio RMS.
 */
export function windowedActiveRegions(
  motionL: Float64Array,
  motionR: Float64Array,
  env: Float64Array,
  cfg: AVConfig = DEFAULT_AV,
): Array<0 | 1 | null> {
  const n = env.length;
  const out: Array<0 | 1 | null> = new Array(n).fill(null);
  const sigma = nullSigma(cfg.halfWindow);
  const minCorr = cfg.minCorrSigma * sigma;
  const margin = cfg.marginSigma * sigma;

  // Global audio mean (of non-trivial frames) → relative silence floor.
  let envMean = 0, envCount = 0;
  for (let i = 0; i < n; i++) { if (env[i] > 1e-6) { envMean += env[i]; envCount++; } }
  envMean = envCount > 0 ? envMean / envCount : 0;
  const floor = envMean * cfg.silenceFloorRel;

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - cfg.halfWindow);
    const hi = Math.min(n - 1, i + cfg.halfWindow);

    // Require real speech in the window (energy + variation).
    let wMean = 0;
    for (let k = lo; k <= hi; k++) wMean += env[k];
    wMean /= (hi - lo + 1);
    if (wMean < floor) continue; // silence → leave null

    const cL = pearson(motionL, env, lo, hi);
    const cR = pearson(motionR, env, lo, hi);
    const best = Math.max(cL, cR);
    if (best < minCorr) continue;            // nobody's motion tracks audio
    if (Math.abs(cL - cR) < margin) continue; // too close to call → hold

    out[i] = cL > cR ? 0 : 1;
  }
  return out;
}
