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
