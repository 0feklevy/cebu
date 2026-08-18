/**
 * Temporal smoothing of the crop-x keyframe series.
 *
 *   • Within one continuously-held framing: median prefilter (kills single-frame
 *     outliers from a mis-detected speaker) followed by Gaussian smoothing
 *     (removes jitter while preserving intentional slow pans).
 *   • At a shot boundary: hard reset — never blend across a cut.
 *   • At a committed SPEAKER SWITCH: hard reset as well, then a bounded fast slew.
 *
 * Why the switch reset exists (D-16, owner-reported after v0.1.28: "if the woman
 * talks and there are 2 people in the frame, it shows the man and not the woman"):
 *
 * The Gaussian alone is zero-phase and σ = 1.2 s wide, so a *committed* switch was
 * never actually delivered. Measured on the real debounce + smoother, heads at
 * 0.30 / 0.70 on 1920×1080 (9:16 half-window = 304 px):
 *
 *     turn 1.5 s -> peak x 0.487, a 409 px miss  -> the new speaker never enters frame
 *     turn 2.0 s -> peak x 0.538, a 312 px miss  -> the new speaker never enters frame
 *     step response: 17.4% travelled 1.2 s BEFORE the switch, 54.1% at it, 98.7% at +2.4 s
 *
 * Two visible defects in one: the crop drifts off the person who *is* talking
 * before the next one opens their mouth, and for the 1.5–2.5 s turns that a
 * two-host podcast is made of it arrives on *neither* face and goes back. So the
 * decision layer was ordering a move that the filter layer could not complete.
 *
 * The fix is not "smooth less" — the σ is large because the detector under it is
 * noisy, and shrinking it whip-pans on jitter. Instead a committed switch is
 * treated as a discontinuity, exactly like a shot cut: the run before and the run
 * after are smoothed independently and never blended, so the move lands inside
 * SWITCH_TRANSITION_SEC and jitter suppression inside each hold is untouched.
 *
 * A "switch" is deliberately narrow — a jump of at least SWITCH_STEP that is
 * *held* on both sides for SWITCH_HOLD_SEC. A slow pan, a drifting interest
 * centroid, and detector jitter all fail that test and keep exactly the old
 * behaviour, which bounds what this can regress.
 *
 * Measured on the adversarial inputs in `speakerTurn.test.ts`: at ±0.02 and ±0.05 of
 * frame-width noise, and on slow pans, fast pans and a ±0.08 wobble, this produces zero
 * spurious snaps and still crushes jitter. Known limit: a detector noisy enough to hold a
 * false level for SWITCH_HOLD_SEC on both sides of a SWITCH_STEP jump will snap where the
 * old filter blurred. Nothing in the pipeline is known to be that noisy, but a future
 * change that degrades head localization would surface here as visible ticking rather than
 * as a smoothly wrong answer — which is arguably the better failure to have.
 */

import { gaussian1d, median1d } from './dsp.js';

export interface Keyframe { t: number; x: number; }

/**
 * |Δx| between adjacent samples (frame-width units) that reads as a switch rather than a
 * pan. This is the load-bearing safety bound, so it is set from geometry, not by eye.
 *
 * Floor: a two-shot switch travels at least MIN_SEPARATION = 0.20 of frame width
 * (headLocator.ts:21), and the 9:16 clamp in `interestToCropX` cannot compress that below
 * 0.20 for any source at or wider than 1:1 — the two head bands are [0.10,0.46] and
 * [0.54,0.90], and the clamp only pulls values in from the edges. So 0.12 keeps 1.67× of
 * margin under the smallest real switch.
 *
 * Ceiling: it must exceed the peak-to-peak excursion of detector noise, because a jump
 * smaller than this can never be tested at all — which turns "does not snap on noise" from
 * a probability into a guarantee for any noise band under ±0.06. That matters: at 0.06 the
 * detector DID fire spuriously on ±0.05 uniform noise (snaps up to 0.058 = 111 px on 1920,
 * on 2 of 3 seeds), because the median-3 prefilter manufactures short plateaus that look
 * "held". Scaling the hold tolerance alone did not fix it; raising this bound does.
 *
 * A genuine relocation smaller than this — the interest-centroid path drifting to a new
 * spot — keeps exactly the old eased behaviour, which is the conservative direction.
 */
const SWITCH_STEP = 0.12;

/**
 * The framing must be held this long on *both* sides of the jump. The debounce
 * already requires 0.8 s of continuous speech before it commits (debounce.ts:13),
 * so a real switch clears this easily while a one- or two-sample detector glitch
 * cannot — a glitch that survived the median-3 would otherwise become a snap out
 * and straight back, which is worse than the lag being fixed here.
 */
const SWITCH_HOLD_SEC = 0.75;

/**
 * How far the framing may wander, as a fraction of the jump itself, and still count as
 * "held" on either side of it. Scaling with the jump rather than using a fixed tolerance
 * is what separates a switch from noise: a real 0.40-wide switch tolerates 0.10 of jitter
 * on each level, while a marginal 0.07 excursion is only granted 0.017 — which uniform
 * detector noise does not reliably produce three samples in a row.
 *
 * Measured: with a FIXED tolerance of SWITCH_STEP/2, ±0.05 of frame-width uniform noise
 * produced spurious snaps of up to 0.058 (111 px on 1920) on 2 of 3 seeds. With this
 * scaled tolerance the same series produce none.
 */
const SWITCH_HOLD_TOLERANCE = 0.25;

/**
 * A committed switch completes within this. At the pipeline's 4 fps this rounds to
 * a single keyframe (a snap), which is the most authority the backend track can
 * carry; a higher analysis rate gets a real short slew instead.
 */
const SWITCH_TRANSITION_SEC = 0.3;

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
  const holdSamples = Math.max(1, Math.round(SWITCH_HOLD_SEC / sampleInterval));
  const rampSamples = Math.max(0, Math.round(SWITCH_TRANSITION_SEC / sampleInterval) - 1);
  const out = xs.slice();

  const bounds = Array.from(new Set(shotTimes)).sort((a, b) => a - b);
  const totalDur = times[times.length - 1] + sampleInterval;
  const segments = toSegments(bounds, totalDur);

  for (const [start, end] of segments) {
    const idx: number[] = [];
    for (let i = 0; i < times.length; i++) if (times[i] >= start && times[i] < end) idx.push(i);
    if (idx.length < 2) continue;
    const med = median1d(idx.map((i) => xs[i]), 3);
    const filtered = smoothRuns(med, findSwitches(med, holdSamples), sigmaSamples, rampSamples);
    idx.forEach((i, k) => { out[i] = filtered[k]; });
  }

  return keyframes.map((k, i) => ({ t: Number(k.t.toFixed(3)), x: Number(out[i].toFixed(4)) }));
}

/**
 * Indices where the framing jumps to a new, held position — i.e. a committed
 * speaker switch. Returns [] for a series that only pans or jitters, in which case
 * `smoothRuns` degenerates to the plain Gaussian this file has always applied.
 */
function findSwitches(med: number[], holdSamples: number): number[] {
  const cuts: number[] = [];
  let prev = 0;                                   // start of the current run
  for (let i = 1; i < med.length; i++) {
    const jump = Math.abs(med[i] - med[i - 1]);
    if (jump < SWITCH_STEP) continue;
    if (med.length - i < holdSamples) continue;   // too close to the end to be delivered
    const tol = jump * SWITCH_HOLD_TOLERANCE;
    if (!held(med, Math.max(prev, i - holdSamples), i, med[i - 1], tol)) continue;
    if (!held(med, i, i + holdSamples, med[i], tol)) continue;
    cuts.push(i);
    prev = i;
  }
  return cuts;
}

/** True if med[lo..hi) all sit within `tol` of `level` (an empty range is not "held"). */
function held(med: number[], lo: number, hi: number, level: number, tol: number): boolean {
  if (hi <= lo) return false;
  for (let j = lo; j < hi; j++) if (Math.abs(med[j] - level) > tol) return false;
  return true;
}

/**
 * Gaussian-smooth each run between switches independently — the same treatment
 * shot boundaries already get — then fast-slew across each junction so the move is
 * bounded rather than eased. With no switches this is exactly `gaussian1d(med, σ)`.
 */
function smoothRuns(med: number[], cuts: number[], sigmaSamples: number, rampSamples: number): number[] {
  const out = new Array<number>(med.length);
  const edges = [0, ...cuts, med.length];
  for (let e = 0; e + 1 < edges.length; e++) {
    const a = edges[e], b = edges[e + 1];
    const run = gaussian1d(med.slice(a, b), sigmaSamples);
    for (let i = a; i < b; i++) out[i] = run[i - a];

    if (e === 0 || rampSamples <= 0) continue;
    const n = Math.min(rampSamples, b - a - 1);   // never run past this run's own end
    if (n <= 0) continue;
    const from = out[a - 1], to = run[n];
    for (let k = 0; k < n; k++) {
      const u = (k + 1) / (n + 1);
      out[a + k] = from + (to - from) * (u * u * (3 - 2 * u));   // smoothstep, no overshoot
    }
  }
  return out;
}

function toSegments(boundaries: number[], totalDur: number): Array<[number, number]> {
  const segs: Array<[number, number]> = [];
  for (let i = 0; i < boundaries.length; i++) {
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : totalDur;
    segs.push([boundaries[i], end]);
  }
  return segs;
}
