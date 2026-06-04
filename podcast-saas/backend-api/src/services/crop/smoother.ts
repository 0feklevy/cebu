/**
 * Temporal smoothing of the crop-x keyframe series.
 *
 *   • Within each shot: median prefilter (kills single-frame outliers from a
 *     mis-detected speaker) followed by Gaussian smoothing (removes jitter while
 *     preserving intentional slow pans).
 *   • At shot boundaries: hard reset — never blend across a cut.
 *
 * The median prefilter is an improvement over the reference, which fed raw
 * values straight into the Gaussian and could smear a one-frame glitch into a
 * visible wobble.
 */

import { gaussian1d, median1d } from './dsp.js';

export interface Keyframe { t: number; x: number; }

export function smoothKeyframes(
  keyframes: Keyframe[],
  shotTimes: number[],
  sigmaSec = 1.5,
  sampleInterval = 1.0,
): Keyframe[] {
  if (keyframes.length < 2) return keyframes;

  const times = keyframes.map((k) => k.t);
  const xs = keyframes.map((k) => k.x);
  const sigmaSamples = Math.max(0.5, sigmaSec / sampleInterval);
  const out = xs.slice();

  const bounds = Array.from(new Set(shotTimes)).sort((a, b) => a - b);
  const totalDur = times[times.length - 1] + sampleInterval;
  const segments = toSegments(bounds, totalDur);

  for (const [start, end] of segments) {
    const idx: number[] = [];
    for (let i = 0; i < times.length; i++) if (times[i] >= start && times[i] < end) idx.push(i);
    if (idx.length < 2) continue;
    const seg = idx.map((i) => xs[i]);
    const filtered = gaussian1d(median1d(seg, 3), sigmaSamples);
    idx.forEach((i, k) => { out[i] = filtered[k]; });
  }

  return keyframes.map((k, i) => ({ t: Number(k.t.toFixed(3)), x: Number(out[i].toFixed(4)) }));
}

function toSegments(boundaries: number[], totalDur: number): Array<[number, number]> {
  const segs: Array<[number, number]> = [];
  for (let i = 0; i < boundaries.length; i++) {
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : totalDur;
    segs.push([boundaries[i], end]);
  }
  return segs;
}
