/**
 * Hand-labelled clips: the file `scripts/crop-eval/annotate.html` writes, and the loader that
 * turns one into something `scoreClip` can score.
 *
 * WHY THE LABEL IS A CROP-X AND NOT A FACE BOX. The upgrade plan's first sketch of this schema
 * asked for the active speaker's face box every sixth frame, the LIVE-YT VC protocol. The
 * footage spec that superseded it (R-16) asks for a crop-x marker at 2 fps instead, and that is
 * the right call for this product: the crop contract is x-only and full-height, so a face box
 * carries three numbers the scorer immediately throws away, and the fourth — the box centre —
 * is not actually the answer the labeller wants to give. "Where should the 9:16 window sit"
 * and "where is the speaker's face" differ whenever headroom, a second subject worth keeping,
 * or a lower-third caption should pull the window off the face. Labelling the window directly
 * is both faster and closer to the thing being measured.
 *
 * WHAT THAT COSTS, STATED PLAINLY. Two metrics in `metrics.ts` degrade on these labels and the
 * loader is built so that they degrade VISIBLY rather than silently:
 *
 *   • `out_of_frame` becomes a MARKER-outside-window rate, not a face-box-outside-window rate.
 *     A crop can contain the labelled point and still slice the speaker's ear off, so this
 *     number is a strictly weaker lower bound than the published metric of the same name. It
 *     is honest — it never reports zero for a crop that is plainly wrong — but it must not be
 *     quoted as the LIVE-YT VC / RetargetVid out-of-frame figure.
 *   • `attribution` is not measurable at all: it asks which of several faces the crop chose,
 *     and a crop-x label does not enumerate faces. Rather than emit a plausible-looking
 *     number, a loaded clip produces exactly one marker per frame, so `scoreClip` counts zero
 *     attribution frames and reports `attribution: null` — the "not measurable" signal the
 *     score type already carries.
 *
 * mIoU, IoU@0.5, jitter, travel, clamp-pinning and centre-share are unaffected: all of them
 * are functions of the window centre, which is precisely what was labelled.
 *
 * THE THREE SUBJECT STATES map one-to-one onto the three branches `targetX` already has, which
 * is why this is a translation and not a new scoring convention:
 *
 *   subject   → one marker, active   → target is the labelled x            (scored)
 *   none      → no boxes at all      → target is frame centre, 0.5         (scored)
 *   ambiguous → one marker, inactive → no defensible target; stability only (excluded)
 *
 * The clips themselves are never committed (licensing, size, customer footage). `source.sha256`
 * is what lets a later eval run prove it scored the same media the labels were made against.
 */

import { cropHalfWidth, type Box, type FrameLabel } from './fixtures.js';

/** Bumped only when a change would make an older file score differently. */
export const LABEL_SCHEMA = 'flowvid.crop-labels/1';

/** The cadence R-16 fixes for hand labelling. Not the pipeline's analysis fps. */
export const LABEL_SAMPLE_FPS = 2;

/**
 * What the labeller said was on screen.
 *
 * `ambiguous` is not a synonym for "hard": it is reserved for frames where two framings are
 * genuinely equally defensible, and it removes the frame from mIoU. Overusing it launders a
 * bad crop into an unscored one, so the README asks labellers to justify every use.
 */
export type LabelSubject = 'subject' | 'none' | 'ambiguous';

const SUBJECTS: readonly LabelSubject[] = ['subject', 'none', 'ambiguous'];

/** One sampled frame, exactly as it appears in the JSON file. */
export interface RawFrameLabel {
  frame_idx: number;
  t: number;
  /** Centre of the 9:16 window in frame-width units, clamped to what the window can reach. */
  crop_x: number;
  subject: LabelSubject;
  /** True when a human had this frame on screen with this value showing. */
  confirmed: boolean;
}

/** The on-disk file. Snake case throughout, matching every other JSON this harness reads. */
export interface RawLabelFile {
  schema: string;
  clip_id: string;
  category: string;
  source: { file: string; sha256: string | null; bytes: number };
  width: number;
  height: number;
  duration_sec: number;
  sample_fps: number;
  crop_aspect: number;
  labelled_at: string;
  labeller: string;
  /** Ground-truth cut times, in seconds — the cut set P1.6's detector is scored against. */
  cuts: number[];
  labels: RawFrameLabel[];
}

/**
 * A loaded clip. Structurally the label half of an `EvalClip`: `scoreClip` reads `id`,
 * `category`, `durationSec` and `labels` and nothing else, so this scores through the real
 * scorer with no shim and no second code path.
 */
export interface LabelledClip {
  id: string;
  category: string;
  width: number;
  height: number;
  durationSec: number;
  sampleFps: number;
  cuts: number[];
  labels: FrameLabel[];
  source: { file: string; sha256: string | null; bytes: number };
  /** How many of `labels` a human actually looked at. Below `labels.length` means unfinished. */
  confirmedFrames: number;
}

/**
 * Half-width of the 9:16 window, in frame-width units — the harness's own arithmetic, plus a
 * clamp the synthetic set never needs.
 *
 * Every fixture is 1920x1080, so `cropHalfWidth` is free to return a value above 0.5. Real
 * footage is not: a source already at or past 9:16 wants a window wider than the frame, and
 * without the clamp every crop-x on such a clip would validate as out of range.
 */
export function labelHalfWidth(width: number, height: number): number {
  return Math.min(0.5, cropHalfWidth(width, height));
}

/** How many frames a clip of this length carries at this cadence. The tool uses the same rule. */
export function frameCount(durationSec: number, sampleFps: number): number {
  return Math.max(1, Math.round(durationSec * sampleFps));
}

/**
 * Every structural problem with `input`, in file order. Empty means the file is loadable.
 *
 * It collects rather than throws on the first fault because the caller is usually a person
 * fixing a label file by hand, and one error per run is a bad way to spend an annotation
 * session.
 */
export function labelFileIssues(input: unknown): string[] {
  const issues: string[] = [];
  const push = (m: string) => { if (issues.length < 50) issues.push(m); };

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['not a JSON object'];
  }
  const f = input as Partial<RawLabelFile>;

  if (f.schema !== LABEL_SCHEMA) push(`schema: expected ${LABEL_SCHEMA}, got ${String(f.schema)}`);
  if (!isNonEmptyString(f.clip_id)) push('clip_id: missing or empty');
  if (!isNonEmptyString(f.category)) push('category: missing or empty');
  if (!isPositive(f.width) || !isPositive(f.height)) push('width/height: must be positive numbers');
  if (!isPositive(f.duration_sec)) push('duration_sec: must be a positive number');
  if (!isPositive(f.sample_fps)) push('sample_fps: must be a positive number');

  const src = f.source;
  if (typeof src !== 'object' || src === null) push('source: missing');
  else {
    if (!isNonEmptyString(src.file)) push('source.file: missing or empty');
    if (src.sha256 !== null && !/^[0-9a-f]{64}$/.test(String(src.sha256))) {
      push('source.sha256: must be 64 lowercase hex chars, or null when the browser could not hash');
    }
  }

  if (!Array.isArray(f.labels)) {
    push('labels: missing or not an array');
    return issues;
  }
  if (issues.length > 0) return issues;

  const width = f.width as number;
  const height = f.height as number;
  const fps = f.sample_fps as number;
  const expected = frameCount(f.duration_sec as number, fps);
  if (f.labels.length !== expected) {
    push(`labels: ${f.labels.length} entries, but ${f.duration_sec}s at ${fps} fps needs ${expected}`);
  }

  const half = labelHalfWidth(width, height);
  for (let i = 0; i < f.labels.length; i++) {
    const l = f.labels[i] as Partial<RawFrameLabel> | undefined;
    const at = `labels[${i}]`;
    if (typeof l !== 'object' || l === null) { push(`${at}: not an object`); continue; }
    if (l.frame_idx !== i) push(`${at}.frame_idx: expected ${i}, got ${String(l.frame_idx)}`);
    if (!isNum(l.t) || Math.abs((l.t as number) - i / fps) > 1e-6) {
      push(`${at}.t: expected ${i / fps}, got ${String(l.t)}`);
    }
    if (!SUBJECTS.includes(l.subject as LabelSubject)) {
      push(`${at}.subject: expected one of ${SUBJECTS.join('|')}, got ${String(l.subject)}`);
    }
    if (typeof l.confirmed !== 'boolean') push(`${at}.confirmed: expected a boolean`);
    if (!isNum(l.crop_x)) push(`${at}.crop_x: expected a number, got ${String(l.crop_x)}`);
    else if ((l.crop_x as number) < half - 1e-6 || (l.crop_x as number) > 1 - half + 1e-6) {
      push(`${at}.crop_x: ${l.crop_x} is outside [${round6(half)}, ${round6(1 - half)}], the range a 9:16 window can reach`);
    }
  }

  if (!Array.isArray(f.cuts)) push('cuts: missing or not an array');
  else {
    for (let i = 0; i < f.cuts.length; i++) {
      const c = f.cuts[i];
      if (!isNum(c)) { push(`cuts[${i}]: expected a number, got ${String(c)}`); continue; }
      if (c <= 0 || c >= (f.duration_sec as number)) push(`cuts[${i}]: ${c} is outside (0, ${f.duration_sec})`);
      if (Math.abs(c * fps - Math.round(c * fps)) > 1e-6) push(`cuts[${i}]: ${c} is not a sampled time at ${fps} fps`);
      if (i > 0 && c <= (f.cuts[i - 1] as number)) push(`cuts[${i}]: ${c} does not come after ${f.cuts[i - 1]}`);
    }
  }

  return issues;
}

/**
 * Load one label file, or throw with every problem listed.
 *
 * The conversion to `FrameLabel` is where the crop-x convention meets the scorer: a labelled
 * subject becomes a ZERO-WIDTH marker box, never a face-sized one. Inventing a plausible face
 * width here would make `out_of_frame` look like the published metric while measuring a number
 * nobody labelled, which is the precise failure this harness exists to prevent.
 */
export function parseLabelFile(input: unknown): LabelledClip {
  const issues = labelFileIssues(input);
  if (issues.length > 0) {
    throw new Error(`invalid crop label file:\n  - ${issues.join('\n  - ')}`);
  }
  const f = input as RawLabelFile;

  return {
    id: f.clip_id,
    category: f.category,
    width: f.width,
    height: f.height,
    durationSec: f.duration_sec,
    sampleFps: f.sample_fps,
    cuts: [...f.cuts],
    labels: f.labels.map(toFrameLabel),
    source: { ...f.source },
    confirmedFrames: f.labels.reduce((n, l) => n + (l.confirmed ? 1 : 0), 0),
  };
}

/** One raw label as the scorer sees it. See the module header for why the box has no width. */
export function toFrameLabel(l: RawFrameLabel): FrameLabel {
  if (l.subject === 'none') return { t: l.t, boxes: [], activeIdx: null };
  const marker: Box = [l.crop_x, 0, 0, 1];
  return { t: l.t, boxes: [marker], activeIdx: l.subject === 'subject' ? 0 : null };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNum(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
