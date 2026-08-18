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
  minCorr: number;          // a correlation must clear this to count as "speaking"
  margin: number;           // |corrL − corrR| must exceed this, else ambiguous (null)
  silenceFloorRel: number;  // window audio mean must exceed this × global mean
}

export const DEFAULT_AV: AVConfig = {
  halfWindow: 5,
  minCorr: 0.12,
  margin: 0.06,
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
  const cols = PROFILE_COLS;
  const c = Math.round(headX * (cols - 1));
  const win = Math.max(1, Math.floor(WINDOW_FRAC * cols));
  const lo = Math.max(0, c - win), hi = Math.min(cols - 1, c + win);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const m = motionPerFrame[i];
    for (let x = lo; x <= hi; x++) s += m[x];
    out[i] = s;
  }
  return out;
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
    if (best < cfg.minCorr) continue;            // nobody's motion tracks audio
    if (Math.abs(cL - cR) < cfg.margin) continue; // too close to call → hold

    out[i] = cL > cR ? 0 : 1;
  }
  return out;
}

/**
 * Calibrate gender → head region from how each region's motion RISES while that gender
 * holds the floor, measured over every confidently-pitched frame in the shot.
 *
 * Why this exists, and why it runs before the AV-vote version below.
 *
 * `calibrateGenderRegion` learns the map from `avActive` alone — the frames where the
 * ±1.25 s local correlation was confident enough to name a region. On real footage that is
 * a small minority of frames, and the map it trains then drives the *majority* of them
 * through the gap-filler. Measured end-to-end on the two-shot in `cropProcessor.test.ts`:
 * 45 of 240 frames were decided by direct AV correlation and 195 (81%) by this map — and
 * the map was INVERTED, so the crop sat on the listening man for the whole take while the
 * woman talked. That is the owner-reported D-16 symptom, and it survives correct head
 * localization: nothing downstream re-checks the map against the audio.
 *
 * The inversion has a mechanical cause. At 4 fps the "motion" being correlated is gross
 * head/body movement, not lip sync, so a listener who nods steadily produces far more
 * motion energy than a talker whose head is still — and over an 11-sample window two
 * oscillators correlate spuriously often enough to carry a sparse vote.
 *
 * So compare each region against ITS OWN average rather than against the other region.
 * A constantly-nodding listener has a high baseline and barely rises when the other person
 * speaks; a talker's region rises specifically while they hold the floor. Normalising by
 * the region's own mean is what removes the nodder's advantage, and using every
 * confidently-pitched frame rather than only the AV-confident ones is what makes the
 * estimate stable.
 *
 * Returns null — leaving the AV-vote calibration in charge — when the evidence is thin or
 * the two genders do not separate by `minMargin`. Same-gender hosts land there by design:
 * the pitch labels carry no information then, and a coin-flip map applied to 80% of frames
 * is exactly the failure this is meant to prevent.
 */
export function calibrateGenderRegionByActivity(
  labels: Array<{ label: string; conf: number }>,
  motionL: Float64Array,
  motionR: Float64Array,
  minConf = 0.30,
  minMargin = 0.08,
  minFrames = 8,
): { male: 0 | 1; female: 0 | 1 } | null {
  const n = Math.min(labels.length, motionL.length, motionR.length);
  if (n < minFrames) return null;

  let meanL = 0, meanR = 0;
  for (let i = 0; i < n; i++) { meanL += motionL[i]; meanR += motionR[i]; }
  meanL /= n; meanR /= n;
  if (meanL < 1e-9 || meanR < 1e-9) return null;   // a region with no motion at all → no opinion

  const acc = { male: { l: 0, r: 0, w: 0 }, female: { l: 0, r: 0, w: 0 } };
  for (let i = 0; i < n; i++) {
    const { label, conf } = labels[i];
    if (conf < minConf) continue;
    const a = label === 'male' ? acc.male : label === 'female' ? acc.female : null;
    if (a === null) continue;
    a.l += (motionL[i] / meanL) * conf;
    a.r += (motionR[i] / meanR) * conf;
    a.w += conf;
  }
  if (acc.male.w <= 0 || acc.female.w <= 0) return null;

  // "How much more does the RIGHT region rise than the LEFT one while this gender speaks."
  const mScore = (acc.male.r - acc.male.l) / acc.male.w;
  const fScore = (acc.female.r - acc.female.l) / acc.female.w;
  if (fScore - mScore >= minMargin) return { male: 0, female: 1 };
  if (mScore - fScore >= minMargin) return { male: 1, female: 0 };
  return null;                                      // too close to call
}

/**
 * Calibrate gender → head region from the AV-active series. For each confident
 * gendered frame, vote for whichever region the AV detector flagged as speaking.
 * Far cleaner than raw motion argmax because avActive already rejects background
 * and listener motion.
 */
export function calibrateGenderRegion(
  labels: Array<{ label: string; conf: number }>,
  avActive: Array<0 | 1 | null>,
  minConf = 0.30,
): { male: 0 | 1 | null; female: 0 | 1 | null } {
  const male = [0, 0], female = [0, 0];
  for (let i = 0; i < labels.length; i++) {
    const a = avActive[i];
    if (a === null) continue;
    const { label, conf } = labels[i];
    if (conf < minConf) continue;
    if (label === 'male') male[a] += conf;
    else if (label === 'female') female[a] += conf;
  }
  const mHas = male[0] + male[1] > 0;
  const fHas = female[0] + female[1] > 0;
  const mBest = (male[0] >= male[1] ? 0 : 1) as 0 | 1;
  const fBest = (female[0] >= female[1] ? 0 : 1) as 0 | 1;

  if (!mHas && !fHas) return { male: null, female: null };
  if (mHas && fHas && mBest === fBest) {
    // Both genders voted the same region — give it to the stronger, other to loser.
    const contested = mBest;
    const other = (1 - contested) as 0 | 1;
    return male[contested] >= female[contested]
      ? { male: contested, female: other }
      : { male: other, female: contested };
  }
  return {
    male: mHas ? mBest : ((fHas ? 1 - fBest : null) as 0 | 1 | null),
    female: fHas ? fBest : ((mHas ? 1 - mBest : null) as 0 | 1 | null),
  };
}
