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
