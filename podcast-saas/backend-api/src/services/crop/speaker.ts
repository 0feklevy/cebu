/**
 * Speaker detection via pitch (autocorrelation F0) — TypeScript port of the
 * Python speaker_detector, with one substantive improvement:
 *
 *   The reference hard-codes a 160 Hz male/female split. Real podcasts vary
 *   (deep male + alto female can both sit near 150 Hz). Here we *self-calibrate*
 *   the threshold from the F0 distribution of the actual video: confident F0
 *   samples are clustered into two groups (1-D k-means) and the split is placed
 *   at the valley between them. This removes the single biggest source of
 *   gender-misclassification. We fall back to 160 Hz when the two voices are not
 *   cleanly separable (e.g. same-gender hosts).
 */

import { autocorrF0 } from './dsp.js';

export const SAMPLE_RATE = 16_000;
const SILENCE_RMS = 0.005;
const MIN_CONF = 0.30;
const DEFAULT_THRESH_HZ = 160;
const GRAY_ZONE_HZ = 10;
const CAL_MIN_CONF = 0.35;
const TWO_SHOT_MIN = 5;

export type SpeakerLabel = 'male' | 'female' | 'silence' | 'unclear';

export interface ChunkPitch { rms: number; f0: number; conf: number; }

/** Raw per-window pitch features (no gender decision yet). */
export function analyzeChunk(chunk: Float32Array, sr = SAMPLE_RATE): ChunkPitch {
  if (chunk.length === 0) return { rms: 0, f0: 0, conf: 0 };
  let sumSq = 0;
  for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
  const rms = Math.sqrt(sumSq / chunk.length);
  if (rms < SILENCE_RMS) return { rms, f0: 0, conf: 0 };
  const { f0, confidence } = autocorrF0(chunk, sr);
  return { rms, f0, conf: confidence };
}

/** Apply a (possibly calibrated) threshold to raw pitch features. */
export function labelFromPitch(p: ChunkPitch, threshHz: number): { label: SpeakerLabel; conf: number } {
  if (p.rms < SILENCE_RMS) return { label: 'silence', conf: 1 };
  if (p.conf < MIN_CONF || p.f0 === 0) return { label: 'unclear', conf: 0 };
  const lo = threshHz - GRAY_ZONE_HZ;
  const hi = threshHz + GRAY_ZONE_HZ;
  if (p.f0 >= hi) return { label: 'female', conf: p.conf };
  if (p.f0 < lo) return { label: 'male', conf: p.conf };
  return { label: 'unclear', conf: p.conf * 0.4 }; // gray zone
}

/**
 * Self-calibrate the male/female F0 threshold from the confident pitch samples.
 * 1-D k-means (k=2). Returns the valley (midpoint of cluster means) when the two
 * clusters are well separated, else DEFAULT_THRESH_HZ.
 */
export function calibratePitchThreshold(pitches: ChunkPitch[]): number {
  const f0s = pitches.filter((p) => p.conf >= MIN_CONF && p.f0 >= 70 && p.f0 <= 350).map((p) => p.f0);
  if (f0s.length < 8) return DEFAULT_THRESH_HZ;

  // Init centroids at the 25th/75th percentiles.
  const sorted = [...f0s].sort((a, b) => a - b);
  let cLo = sorted[Math.floor(sorted.length * 0.25)];
  let cHi = sorted[Math.floor(sorted.length * 0.75)];
  if (cHi - cLo < 1) return DEFAULT_THRESH_HZ;

  for (let iter = 0; iter < 25; iter++) {
    let sumLo = 0, nLo = 0, sumHi = 0, nHi = 0;
    for (const f of f0s) {
      if (Math.abs(f - cLo) <= Math.abs(f - cHi)) { sumLo += f; nLo++; }
      else { sumHi += f; nHi++; }
    }
    const nLoC = nLo ? sumLo / nLo : cLo;
    const nHiC = nHi ? sumHi / nHi : cHi;
    if (Math.abs(nLoC - cLo) < 0.1 && Math.abs(nHiC - cHi) < 0.1) { cLo = nLoC; cHi = nHiC; break; }
    cLo = nLoC; cHi = nHiC;
  }

  // Require clear separation and that the split lands in a sane vocal range.
  const mid = (cLo + cHi) / 2;
  if (cHi - cLo >= 35 && mid >= 120 && mid <= 220) return mid;
  return DEFAULT_THRESH_HZ;
}

// ── position calibration (speaker gender → x) ──────────────────────────────────

export interface CalFrame {
  shotType: 'two_shot' | 'single' | 'no_face';
  headXs: number[];
  speaker: SpeakerLabel;
  speakerConf: number;
  activeX: number | null;
}

export class SpeakerCalibration {
  femaleX: number | null = null;
  maleX: number | null = null;
  valid = false;
  nFemale = 0;
  nMale = 0;

  /** Resolve the active-speaker head x in a two-shot, given the detected gender. */
  speakerFaceX(speaker: SpeakerLabel, headXs: number[]): number | null {
    if (!headXs.length || (speaker !== 'male' && speaker !== 'female')) return null;
    const ref = speaker === 'female' ? this.femaleX : this.maleX;
    if (ref === null) return null;
    let best = headXs[0], bestD = Infinity;
    for (const h of headXs) { const d = Math.abs(h - ref); if (d < bestD) { bestD = d; best = h; } }
    return best;
  }

  summary(): string {
    const f = this.femaleX !== null ? `${this.femaleX.toFixed(3)} (${this.nFemale})` : 'n/a';
    const m = this.maleX !== null ? `${this.maleX.toFixed(3)} (${this.nMale})` : 'n/a';
    return `female_x=${f} male_x=${m} valid=${this.valid}`;
  }
}

function weightedMean(samples: Array<[number, number]>): number | null {
  let wsum = 0, vsum = 0;
  for (const [v, w] of samples) { const ww = Math.max(0, w); wsum += ww; vsum += v * ww; }
  if (wsum < 1e-6) {
    if (!samples.length) return null;
    const vals = samples.map((s) => s[0]).sort((a, b) => a - b);
    return vals[vals.length >> 1]; // median fallback
  }
  return vsum / wsum;
}

/**
 * Learn female_x / male_x from two-shot frames (active head + pitch) with a
 * single-speaker fallback. Self-calibrating: never assumes who sits where.
 */
export function calibrate(frames: CalFrame[]): SpeakerCalibration {
  const femaleTwo: Array<[number, number]> = [];
  const maleTwo: Array<[number, number]> = [];
  const femaleSingle: Array<[number, number]> = [];
  const maleSingle: Array<[number, number]> = [];

  for (const f of frames) {
    if ((f.speaker !== 'male' && f.speaker !== 'female') || f.speakerConf < CAL_MIN_CONF) continue;
    if (f.shotType === 'two_shot' && f.headXs.length >= 2 && f.activeX !== null) {
      (f.speaker === 'female' ? femaleTwo : maleTwo).push([f.activeX, f.speakerConf]);
    } else if (f.shotType === 'single' && f.headXs.length) {
      (f.speaker === 'female' ? femaleSingle : maleSingle).push([f.headXs[0], f.speakerConf]);
    }
  }

  const cal = new SpeakerCalibration();
  const female = femaleTwo.length >= TWO_SHOT_MIN ? femaleTwo : femaleSingle;
  const male = maleTwo.length >= TWO_SHOT_MIN ? maleTwo : maleSingle;
  cal.nFemale = female.length;
  cal.nMale = male.length;
  cal.femaleX = female.length ? weightedMean(female) : null;
  cal.maleX = male.length ? weightedMean(male) : null;
  cal.valid = cal.femaleX !== null && cal.maleX !== null;
  return cal;
}
