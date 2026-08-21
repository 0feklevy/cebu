/**
 * Scoring for the crop eval harness.
 *
 * The metric set is the one the retargeting literature uses (LIVE-YT VC / RetargetVid for
 * mIoU, out-of-frame and jitter; AVA-ActiveSpeaker for attribution), with one honest
 * simplification: the crop contract is x-only and full-height, so the predicted and
 * ground-truth windows are always the same width and always span the full frame height.
 * Two-dimensional IoU over them degenerates exactly to one-dimensional IoU of their x
 * intervals, and that is what is computed here. Reporting a 2-D number would be the same
 * arithmetic dressed up to look like it measured vertical framing, which it cannot.
 *
 * Frames whose correct answer is genuinely ambiguous are NOT scored, and the count of
 * scored frames is reported alongside every mean so a metric computed over four frames
 * cannot be mistaken for one computed over four hundred. The ambiguous case is a clip with
 * visible subjects and no audio to say which of them holds the floor: framing either face
 * is defensible, so such clips are scored on stability only.
 *
 * Calibrating facts worth remembering when reading the output: a naive centre crop is a
 * strong baseline (55.7 mIoU vs 57.1 for a published smart method on SmartVidCrop), and
 * human inter-annotator agreement is only ~0.50 raw / ~0.67 smoothed — so "beats centre
 * crop" is the bar that matters, not proximity to 1.0.
 */

import type { EvalClip, FrameLabel } from './fixtures.js';

export interface Keyframe { t: number; x: number; }

export interface ClipScore {
  clip_id: string;
  category: string;
  /** Frames with an unambiguous ground-truth window; the denominator for mIoU and friends. */
  scored_frames: number;
  total_frames: number;
  m_iou: number;
  iou_at_50: number;
  out_of_frame: number;
  attribution: number | null;
  attribution_frames: number;
  jitter: number;
  travel_per_sec: number;
  pinned_at_clamp: number;
  near_centre: number;
}

export interface EvalReport {
  algo: string;
  algo_version: string;
  clips: ClipScore[];
  overall: Omit<ClipScore, 'clip_id' | 'category'>;
  by_category: Record<string, Omit<ClipScore, 'clip_id' | 'category'>>;
}

const CENTRE_TOLERANCE = 0.02;
const CLAMP_TOLERANCE = 1e-3;

/** Ground-truth window centre for one labelled frame, or null when no answer is defensible. */
export function targetX(label: FrameLabel, half: number): number | null {
  if (label.activeIdx !== null) {
    const box = label.boxes[label.activeIdx];
    return clamp(box[0] + box[2] / 2, half, 1 - half);
  }
  // Nothing on screen at all: the only non-arbitrary framing is the centre of the frame.
  if (label.boxes.length === 0) return 0.5;
  // Faces on screen but nothing says who is talking — either is right. Stability only.
  return null;
}

/** IoU of two equal-width, full-height windows centred at `a` and `b`. */
export function windowIou(a: number, b: number, width: number): number {
  const overlap = Math.max(0, width - Math.abs(a - b));
  const union = 2 * width - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/** Resolve the crop track at each labelled time by piecewise-linear interpolation. */
export function sampleTrack(keyframes: Keyframe[], times: number[]): number[] {
  if (keyframes.length === 0) return times.map(() => 0.5);
  const out: number[] = [];
  let k = 0;
  for (const t of times) {
    while (k + 1 < keyframes.length && keyframes[k + 1].t <= t) k++;
    const a = keyframes[k];
    const b = keyframes[Math.min(k + 1, keyframes.length - 1)];
    if (b === a || b.t <= a.t) { out.push(a.x); continue; }
    const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    out.push(a.x + (b.x - a.x) * u);
  }
  return out;
}

/**
 * Everything scoring actually reads off a clip.
 *
 * Named because a hand-labelled clip (`labels.ts`) has no frames and no audio to offer — the
 * media stays out of the repo — and there is no reason it should need them to be scored. Stating
 * the real dependency here lets synthetic fixtures and hand labels run through this one scorer
 * instead of growing a second copy that drifts.
 */
export type ScorableClip = Pick<EvalClip, 'id' | 'category' | 'durationSec' | 'labels'>;

export function scoreClip(clip: ScorableClip, keyframes: Keyframe[], half: number): ClipScore {
  const width = half * 2;
  const xs = sampleTrack(keyframes, clip.labels.map((l) => l.t));

  let iouSum = 0, iouHits = 0, scored = 0, outOfFrame = 0;
  let attrHits = 0, attrFrames = 0;
  let pinned = 0, nearCentre = 0;

  for (let i = 0; i < clip.labels.length; i++) {
    const label = clip.labels[i];
    const x = xs[i];
    if (Math.abs(x - half) < CLAMP_TOLERANCE || Math.abs(x - (1 - half)) < CLAMP_TOLERANCE) pinned++;
    if (Math.abs(x - 0.5) < CENTRE_TOLERANCE) nearCentre++;

    const gt = targetX(label, half);
    if (gt !== null) {
      const iou = windowIou(x, gt, width);
      iouSum += iou;
      if (iou >= 0.5) iouHits++;
      scored++;
      if (label.activeIdx !== null && !boxInside(label.boxes[label.activeIdx], x, half)) outOfFrame++;
    }

    // Attribution is only a question when there is more than one face to choose between.
    if (label.activeIdx !== null && label.boxes.length > 1) {
      attrFrames++;
      if (nearestBox(label, x) === label.activeIdx) attrHits++;
    }
  }

  return {
    clip_id: clip.id,
    category: clip.category,
    scored_frames: scored,
    total_frames: clip.labels.length,
    m_iou: round(scored ? iouSum / scored : 0),
    iou_at_50: round(scored ? iouHits / scored : 0),
    out_of_frame: round(scored ? outOfFrame / scored : 0),
    attribution: attrFrames ? round(attrHits / attrFrames) : null,
    attribution_frames: attrFrames,
    jitter: round(jitter(xs), 6),
    travel_per_sec: round(travel(xs) / Math.max(1e-6, clip.durationSec), 5),
    pinned_at_clamp: round(clip.labels.length ? pinned / clip.labels.length : 0),
    near_centre: round(clip.labels.length ? nearCentre / clip.labels.length : 0),
  };
}

/** Mean |second difference| of the crop track — the standard retargeting jitter/jerk term. */
export function jitter(xs: number[]): number {
  if (xs.length < 3) return 0;
  let sum = 0;
  for (let i = 1; i + 1 < xs.length; i++) sum += Math.abs(xs[i + 1] - 2 * xs[i] + xs[i - 1]);
  return sum / (xs.length - 2);
}

/** Total consecutive-centre distance travelled by the crop window. */
export function travel(xs: number[]): number {
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += Math.abs(xs[i] - xs[i - 1]);
  return sum;
}

export function aggregate(scores: ClipScore[]): Omit<ClipScore, 'clip_id' | 'category'> {
  const scoredTotal = scores.reduce((a, s) => a + s.scored_frames, 0);
  const attrTotal = scores.reduce((a, s) => a + s.attribution_frames, 0);
  // Frame-weighted, so a 24-second title card cannot outvote a 60-second two-shot.
  const byFrame = (pick: (s: ClipScore) => number) =>
    scoredTotal ? scores.reduce((a, s) => a + pick(s) * s.scored_frames, 0) / scoredTotal : 0;
  const byClip = (pick: (s: ClipScore) => number) =>
    scores.length ? scores.reduce((a, s) => a + pick(s), 0) / scores.length : 0;

  return {
    scored_frames: scoredTotal,
    total_frames: scores.reduce((a, s) => a + s.total_frames, 0),
    m_iou: round(byFrame((s) => s.m_iou)),
    iou_at_50: round(byFrame((s) => s.iou_at_50)),
    out_of_frame: round(byFrame((s) => s.out_of_frame)),
    attribution: attrTotal
      ? round(scores.reduce((a, s) => a + (s.attribution ?? 0) * s.attribution_frames, 0) / attrTotal)
      : null,
    attribution_frames: attrTotal,
    jitter: round(byClip((s) => s.jitter), 6),
    travel_per_sec: round(byClip((s) => s.travel_per_sec), 5),
    pinned_at_clamp: round(byClip((s) => s.pinned_at_clamp)),
    near_centre: round(byClip((s) => s.near_centre)),
  };
}

export function byCategory(scores: ClipScore[]): Record<string, Omit<ClipScore, 'clip_id' | 'category'>> {
  const groups = new Map<string, ClipScore[]>();
  for (const s of scores) {
    const g = groups.get(s.category);
    if (g) g.push(s); else groups.set(s.category, [s]);
  }
  const out: Record<string, Omit<ClipScore, 'clip_id' | 'category'>> = {};
  for (const key of [...groups.keys()].sort()) out[key] = aggregate(groups.get(key)!);
  return out;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function boxInside(box: [number, number, number, number], x: number, half: number): boolean {
  return box[0] >= x - half - 1e-9 && box[0] + box[2] <= x + half + 1e-9;
}

function nearestBox(label: FrameLabel, x: number): number {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < label.boxes.length; k++) {
    const d = Math.abs(label.boxes[k][0] + label.boxes[k][2] / 2 - x);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
