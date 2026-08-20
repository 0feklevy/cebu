/**
 * Labelled clips for the crop eval harness — synthetic, deterministic, in-repo.
 *
 * WHAT THIS IS NOT. These are not real podcast frames. They are flat-shaded discs and
 * rectangles on a flat background, so the absolute mIoU they produce is NOT a prediction of
 * the number a hand-labelled catalogue clip would give. Nobody should quote a score from
 * this file as "the crop is N% accurate".
 *
 * WHAT IT IS. Every fixture encodes one specific, cited failure mechanism from the
 * vertical-crop diagnosis, with ground truth that is exact by construction rather than
 * annotated. Real clips cannot be committed (licensing, size, and the catalogue is
 * customer footage), and a harness that needs media the repo does not contain is a harness
 * that never runs. So the measurement this gives up is "how good is the crop on real
 * video"; what it keeps is "does this change move the mechanism it claims to move, and did
 * it break another one" — which is the question every task in the upgrade plan actually
 * asks, and the one a regression gate has to answer on every run.
 *
 * The signals are built to be genuinely discriminating rather than trivially solvable:
 *
 *   • a talker's mouth opens and closes WITH the speech envelope; a listener nods on its
 *     own clock. Frame-difference motion therefore separates them only by correlation
 *     against the audio, which is exactly the property the pipeline claims to use.
 *   • skin tones span the Kovač RGB rule's blind spot, and warm set decor is bright enough
 *     to beat a deep-skinned face on that rule — the D1 mechanism, reproduced.
 *   • pitch carries real information on the mixed-gender fixture and NONE on the
 *     same-gender one, which is what makes the gender gap-fill's damage measurable.
 *
 * There is deliberately NO synthetic film grain. Two versions of it were tried and both
 * produced artefacts that measured as algorithm behaviour: a per-frame global brightness
 * offset turns a flat background into a histogram that jumps a whole bin at once, so the shot
 * detector reads a cut on a static title card; and a pre-drawn noise field read at a
 * frame-dependent offset scrolls, which is coherent motion, not noise. Frames are therefore
 * clean, and the only thing that moves is what the scene says moves. That is a real limitation
 * — nothing here exercises noise robustness — and it is the honest one, because the
 * alternative was measuring the fixture generator instead of the pipeline.
 *
 * Determinism: all randomness comes from a per-clip LCG seeded from the fixture id, so two
 * runs of the harness produce byte-identical frames, audio and scores.
 */

import { CROP_ASPECT } from '../cropProcessor.js';

export const ANALYSIS_W = 320;
export const ANALYSIS_H = 180;
export const SAMPLE_FPS = 4;
export const AUDIO_SR = 16_000;
/** Source dimensions every fixture reports — the 9:16 window is then 0.3164 of frame width. */
export const SOURCE_W = 1920;
export const SOURCE_H = 1080;

type Rgb = [number, number, number];

/** Normalised [x, y, w, h] face box in frame coordinates. */
export type Box = [number, number, number, number];

export interface FrameLabel {
  t: number;
  /** Every subject visible this frame, left-to-right at clip build time. */
  boxes: Box[];
  /** Index into `boxes` of whoever holds the floor, or null (silence / no subject). */
  activeIdx: number | null;
}

export interface EvalClip {
  id: string;
  category: string;
  /** One line saying which diagnosed defect this clip is here to measure. */
  measures: string;
  width: number;
  height: number;
  durationSec: number;
  sampleFps: number;
  hasAudio: boolean;
  /** Ground-truth cut times, for scoring shot detection directly. */
  cuts: number[];
  labels: FrameLabel[];
  frame(index: number): Uint8Array;
  audio(): Float32Array;
}

// ── scene description ─────────────────────────────────────────────────────────

interface Subject {
  /** Face centre x at t=0 (normalised). */
  x: number;
  /** Face centre x at the end of the clip, when the subject moves (D8's walk-on). */
  xEnd?: number;
  /** Face centre y (normalised) and radius in analysis pixels. */
  y: number;
  r: number;
  skin: Rgb;
  /** Fundamental this subject speaks at — what the pitch labeller sees. */
  f0: number;
  /** [start, end) seconds during which this subject holds the floor. */
  turns: Array<[number, number]>;
  /** Listener head-nod amplitude in analysis pixels. Large amplitudes are the D2a trap. */
  nod: number;
}

interface Decor {
  /** Rectangle in normalised frame coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  rgb: Rgb;
}

interface Scene {
  id: string;
  category: string;
  measures: string;
  durationSec: number;
  bg: Rgb;
  subjects: Subject[];
  decor?: Decor[];
  /**
   * Cut times. At each cut every subject's x is mirrored about frame centre, which is what a
   * reverse-angle camera in the same room does to the framing while leaving the global
   * luminance histogram almost untouched — the D6 mechanism.
   */
  cuts?: number[];
  silent?: boolean;
}

const SKIN_LIGHT: Rgb = [205, 145, 118];
const SKIN_MID: Rgb = [150, 100, 78];
const SKIN_DEEP: Rgb = [82, 54, 41];
const WOOD: Rgb = [152, 96, 60];
const BG_STUDIO: Rgb = [34, 39, 49];
const BG_SLIDE: Rgb = [18, 18, 22];
const TEXT: Rgb = [232, 232, 236];

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Syllabic speech amplitude — the envelope both the audio and the talker's mouth follow. */
function speechAmp(i: number): number {
  return 0.05 + 0.045 * Math.abs(Math.sin(i * 1.9));
}

/** How many times the scene has cut by time `t`; odd counts are mirrored framings. */
function cutIndex(scene: Scene, t: number): number {
  let n = 0;
  for (const c of scene.cuts ?? []) if (t >= c) n++;
  return n;
}

/** Subject centre x at time `t`, after walk-on drift and any camera reversal. */
function subjectX(scene: Scene, s: Subject, t: number): number {
  const u = scene.durationSec > 0 ? Math.min(1, Math.max(0, t / scene.durationSec)) : 0;
  const base = s.xEnd === undefined ? s.x : s.x + (s.xEnd - s.x) * u;
  return cutIndex(scene, t) % 2 === 1 ? 1 - base : base;
}

function activeIndex(scene: Scene, t: number): number | null {
  for (let k = 0; k < scene.subjects.length; k++) {
    for (const [a, b] of scene.subjects[k].turns) if (t >= a && t < b) return k;
  }
  return null;
}

// ── rasterisation ─────────────────────────────────────────────────────────────

function fill(frame: Uint8Array, rgb: Rgb): void {
  for (let p = 0; p < frame.length; p += 3) { frame[p] = rgb[0]; frame[p + 1] = rgb[1]; frame[p + 2] = rgb[2]; }
}

function rect(frame: Uint8Array, x0: number, y0: number, x1: number, y1: number, rgb: Rgb): void {
  for (let y = Math.max(0, y0); y < Math.min(ANALYSIS_H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(ANALYSIS_W, x1); x++) {
      const p = (y * ANALYSIS_W + x) * 3;
      frame[p] = rgb[0]; frame[p + 1] = rgb[1]; frame[p + 2] = rgb[2];
    }
  }
}

function disc(frame: Uint8Array, cx: number, cy: number, r: number, rgb: Rgb): void {
  for (let y = Math.max(0, cy - r); y < Math.min(ANALYSIS_H, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(ANALYSIS_W, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const p = (y * ANALYSIS_W + x) * 3;
      frame[p] = rgb[0]; frame[p + 1] = rgb[1]; frame[p + 2] = rgb[2];
    }
  }
}

/** A slightly darker shade of `rgb`, used for the mouth block inside a face. */
function shade(rgb: Rgb, k: number): Rgb {
  return [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)];
}

// ── clip construction ─────────────────────────────────────────────────────────

function buildClip(scene: Scene): EvalClip {
  const nFrames = Math.round(scene.durationSec * SAMPLE_FPS);

  const labels: FrameLabel[] = [];
  for (let i = 0; i < nFrames; i++) {
    const t = i / SAMPLE_FPS;
    labels.push({
      t: Number(t.toFixed(3)),
      boxes: scene.subjects.map((s) => boxOf(scene, s, t)),
      activeIdx: scene.silent ? null : activeIndex(scene, t),
    });
  }

  return {
    id: scene.id,
    category: scene.category,
    measures: scene.measures,
    width: SOURCE_W,
    height: SOURCE_H,
    durationSec: scene.durationSec,
    sampleFps: SAMPLE_FPS,
    hasAudio: !scene.silent,
    cuts: [...(scene.cuts ?? [])],
    labels,
    frame: (i: number) => renderFrame(scene, i),
    audio: () => renderAudio(scene),
  };
}

function boxOf(scene: Scene, s: Subject, t: number): Box {
  const cx = subjectX(scene, s, t);
  const w = (2 * s.r) / ANALYSIS_W;
  const h = (2 * s.r) / ANALYSIS_H;
  return [cx - w / 2, s.y - h / 2, w, h];
}

function renderFrame(scene: Scene, i: number): Uint8Array {
  const t = i / SAMPLE_FPS;
  const frame = new Uint8Array(ANALYSIS_W * ANALYSIS_H * 3);
  fill(frame, scene.bg);

  for (const d of scene.decor ?? []) {
    const mirrored = cutIndex(scene, t) % 2 === 1;
    const x = mirrored ? 1 - d.x - d.w : d.x;
    rect(frame,
      Math.round(x * ANALYSIS_W), Math.round(d.y * ANALYSIS_H),
      Math.round((x + d.w) * ANALYSIS_W), Math.round((d.y + d.h) * ANALYSIS_H), d.rgb);
  }

  const active = scene.silent ? null : activeIndex(scene, t);
  for (let k = 0; k < scene.subjects.length; k++) {
    const s = scene.subjects[k];
    const cx = Math.round(subjectX(scene, s, t) * ANALYSIS_W);
    // A listener nods on its own clock; the talker's head is comparatively still. The nod
    // frequency is deliberately incommensurate with the syllable rate so no windowed
    // correlation can pick it up by luck.
    const nod = k === active ? 0 : Math.round(s.nod * Math.sin(i * 0.41 + k));
    const cy = Math.round(s.y * ANALYSIS_H) + nod;
    disc(frame, cx, cy, s.r, s.skin);
    // Mouth block: it opens with the speech envelope only while this subject holds the floor.
    const open = k === active ? Math.round(2 + speechAmp(i) * 80) : 2;
    disc(frame, cx, cy + Math.round(s.r * 0.55), Math.max(2, Math.min(s.r, open)), shade(s.skin, 0.45));
  }
  return frame;
}

function renderAudio(scene: Scene): Float32Array {
  const n = Math.round(scene.durationSec * AUDIO_SR);
  const out = new Float32Array(n);
  if (scene.silent) return out;
  const rnd = lcg(seedOf(scene.id) ^ 0x5f5f);
  let phase = 0;
  for (let sIdx = 0; sIdx < n; sIdx++) {
    const t = sIdx / AUDIO_SR;
    const i = Math.floor(t * SAMPLE_FPS);
    const k = activeIndex(scene, t);
    if (k === null) { out[sIdx] = 0.0008 * (rnd() - 0.5); continue; }
    const f0 = scene.subjects[k].f0;
    const amp = speechAmp(i);
    phase += (2 * Math.PI * f0) / AUDIO_SR;
    // Harmonics so the autocorrelation F0 estimator has a real peak to lock onto.
    out[sIdx] = amp * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase))
      + 0.002 * (rnd() - 0.5);
  }
  return out;
}

/** Alternating turns of `len` seconds for `k` subjects over `dur` seconds. */
function alternate(k: number, dur: number, len: number): Array<Array<[number, number]>> {
  const turns: Array<Array<[number, number]>> = Array.from({ length: k }, () => []);
  for (let t = 0, n = 0; t < dur; t += len, n++) turns[n % k].push([t, Math.min(dur, t + len)]);
  return turns;
}

// ── the set ───────────────────────────────────────────────────────────────────

function scenes(): Scene[] {
  const out: Scene[] = [];

  {
    // D1 + D2a: the owner-reported symptom. The listener is the one the skin rule loves.
    const turns = alternate(2, 60, 5);
    out.push({
      id: 'two-shot-mixed-gender',
      category: 'two_shot',
      measures: 'D1 skin-rule bias / D2a AV attribution — deep-skinned talker vs well-lit listener',
      durationSec: 60,
      bg: BG_STUDIO,
      subjects: [
        { x: 0.30, y: 0.36, r: 27, skin: SKIN_LIGHT, f0: 108, turns: turns[0], nod: 5 },
        { x: 0.70, y: 0.36, r: 23, skin: SKIN_DEEP, f0: 205, turns: turns[1], nod: 4 },
      ],
    });
  }

  {
    // D2b: pitch carries NO information here, so the gender→region gap-fill is a coin flip
    // applied to the majority of frames. This is the dominant podcast format.
    const turns = alternate(2, 60, 5);
    out.push({
      id: 'two-shot-same-gender',
      category: 'same_gender',
      measures: 'D2b gender gap-fill inversion — two same-pitch hosts',
      durationSec: 60,
      bg: BG_STUDIO,
      subjects: [
        { x: 0.28, y: 0.36, r: 26, skin: SKIN_LIGHT, f0: 112, turns: turns[0], nod: 6 },
        { x: 0.72, y: 0.36, r: 26, skin: SKIN_MID, f0: 118, turns: turns[1], nod: 6 },
      ],
    });
  }

  {
    const turns = alternate(2, 48, 4);
    out.push({
      id: 'two-shot-dark-skin',
      category: 'dark_skin',
      measures: 'D1 — both speakers below the Kovač r>95 floor',
      durationSec: 48,
      bg: BG_STUDIO,
      subjects: [
        { x: 0.29, y: 0.36, r: 25, skin: SKIN_DEEP, f0: 110, turns: turns[0], nod: 5 },
        { x: 0.71, y: 0.36, r: 25, skin: SKIN_DEEP, f0: 198, turns: turns[1], nod: 5 },
      ],
    });
  }

  out.push({
    id: 'warm-wood-set',
    category: 'warm_set',
    measures: 'D1 — wooden panelling passes the skin rule and outweighs the real face',
    durationSec: 40,
    bg: BG_STUDIO,
    subjects: [{ x: 0.32, y: 0.36, r: 24, skin: SKIN_DEEP, f0: 130, turns: [[0, 40]], nod: 3 }],
    decor: [{ x: 0.62, y: 0.10, w: 0.30, h: 0.70, rgb: WOOD }],
  });

  out.push({
    id: 'title-card',
    category: 'no_subject',
    measures: 'D5 — no person anywhere; the null hypothesis the head locator does not have',
    durationSec: 24,
    bg: BG_SLIDE,
    silent: true,
    subjects: [],
    decor: [
      { x: 0.14, y: 0.34, w: 0.30, h: 0.10, rgb: TEXT },
      { x: 0.14, y: 0.50, w: 0.44, h: 0.06, rgb: TEXT },
    ],
  });

  out.push({
    id: 'screen-share',
    category: 'no_subject',
    measures: 'D5/D10 — bright static slide with a small presenter inset',
    durationSec: 32,
    bg: BG_SLIDE,
    subjects: [{ x: 0.86, y: 0.72, r: 12, skin: SKIN_LIGHT, f0: 125, turns: [[0, 32]], nod: 2 }],
    decor: [
      { x: 0.06, y: 0.14, w: 0.56, h: 0.08, rgb: TEXT },
      { x: 0.06, y: 0.30, w: 0.48, h: 0.06, rgb: TEXT },
      { x: 0.06, y: 0.44, w: 0.52, h: 0.06, rgb: TEXT },
    ],
  });

  {
    // D6: matched-exposure reverse angles. The global grey histogram barely moves across
    // these cuts, so a fixed Bhattacharyya threshold cannot see them — and the per-shot
    // stages then average two incompatible framings together.
    const turns = alternate(2, 48, 4);
    out.push({
      id: 'multicam-same-room',
      category: 'multicam',
      measures: 'D6 — same-room reverse-angle cuts a global histogram cannot detect',
      durationSec: 48,
      bg: BG_STUDIO,
      cuts: [8, 16, 24, 32, 40],
      subjects: [
        { x: 0.27, y: 0.36, r: 26, skin: SKIN_LIGHT, f0: 106, turns: turns[0], nod: 5 },
        { x: 0.73, y: 0.36, r: 26, skin: SKIN_MID, f0: 202, turns: turns[1], nod: 5 },
      ],
    });
  }

  out.push({
    id: 'walk-on',
    category: 'moving_subject',
    measures: 'D8 — a single speaker who crosses the frame during one shot',
    durationSec: 40,
    bg: BG_STUDIO,
    subjects: [{ x: 0.24, y: 0.38, r: 25, skin: SKIN_MID, f0: 140, turns: [[0, 40]], xEnd: 0.76, nod: 2 }],
  });

  {
    const turns = alternate(2, 40, 5);
    out.push({
      id: 'no-audio-two-shot',
      category: 'no_audio',
      measures: 'perf-011 degrade — two faces, undecodable audio; must stay static, not wander',
      durationSec: 40,
      bg: BG_STUDIO,
      silent: true,
      subjects: [
        { x: 0.30, y: 0.36, r: 26, skin: SKIN_LIGHT, f0: 110, turns: turns[0], nod: 5 },
        { x: 0.70, y: 0.36, r: 26, skin: SKIN_MID, f0: 115, turns: turns[1], nod: 5 },
      ],
    });
  }

  out.push({
    id: 'single-speaker-centre',
    category: 'single',
    measures: 'regression guard — one centred speaker, where a centre crop is already correct',
    durationSec: 32,
    bg: BG_STUDIO,
    subjects: [{ x: 0.50, y: 0.36, r: 28, skin: SKIN_LIGHT, f0: 122, turns: [[0, 32]], nod: 2 }],
  });

  out.push({
    id: 'single-speaker-offset',
    category: 'single',
    measures: 'D7 — one speaker well off centre, where a centre crop is wrong',
    durationSec: 32,
    bg: BG_STUDIO,
    subjects: [{ x: 0.74, y: 0.36, r: 26, skin: SKIN_MID, f0: 118, turns: [[0, 32]], nod: 2 }],
  });

  return out;
}

/** Every fixture in the eval set, built fresh (frames are generated on demand, not cached). */
export function evalClips(): EvalClip[] {
  return scenes().map(buildClip);
}

/** Half-width of the 9:16 window on a `width`×`height` source, in frame-width units. */
export function cropHalfWidth(width: number, height: number): number {
  return (height * CROP_ASPECT) / width / 2;
}
