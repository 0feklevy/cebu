/**
 * Per-frame analysis — produces the 1-D signals the crop pipeline reasons over.
 *
 * Unlike the Python reference (which decided face positions per frame via
 * BlazeFace), this analyzer is deliberately "dumb" per frame: it returns raw
 * column profiles — motion, spectral-residual saliency, and skin-tone — plus a
 * derived grayscale frame. The *global head localization* and active-speaker
 * decision happen once, across the whole video, in cropProcessor (a static
 * podcast camera makes global localization far more stable than per-frame peak
 * picking).
 *
 * Working from one RGB stream (decoded once by ffmpeg) we derive grayscale in
 * JS, so the whole pass costs a single video decode + one audio decode.
 */

import { spectralResidualColumns, resample1d } from './dsp.js';

export const PROFILE_COLS = 96;   // resolution of the compact per-frame profiles
const SAL_SIZE = 64;              // power-of-two square for the saliency FFT
const MOTION_THRESH = 5;          // per-pixel abs-diff noise floor (lower = catches lip/micro movements)
// Heads live in the upper-centre band of a podcast frame; ignore motion/skin
// outside it (hands, lower-thirds, gesturing torsos) when locating speakers.
const BAND_TOP = 0.08;
const BAND_BOT = 0.78;

export interface FrameProfiles {
  interestX: number;            // interest-map centroid fallback (0..1)
  motion: Float64Array;         // length PROFILE_COLS, face-band motion energy
  saliency: Float64Array;       // length PROFILE_COLS, normalised
  skin: Float64Array;           // length PROFILE_COLS, skin-pixel count
  gray: Uint8Array;             // derived gray8 frame (for shot detection)
}

/** Optional precise face detector. Returns normalised face-centre x's (0..1). */
export type FaceHook = (rgbFrame: Uint8Array, width: number, height: number) => number[];

export interface SceneAnalyzerOptions {
  faceHook?: FaceHook;
  centerWeight?: number;
  skinWeight?: number;
  motionWeight?: number;
  saliencyWeight?: number;
}

export class SceneAnalyzer {
  private readonly W: number;
  private readonly H: number;
  private readonly opts: Required<Omit<SceneAnalyzerOptions, 'faceHook'>> & { faceHook?: FaceHook };
  private readonly centerBias: Float64Array; // length PROFILE_COLS

  constructor(width: number, height: number, options: SceneAnalyzerOptions = {}) {
    this.W = width;
    this.H = height;
    this.opts = {
      faceHook: options.faceHook,
      centerWeight: options.centerWeight ?? 0.5,
      skinWeight: options.skinWeight ?? 1.5,
      motionWeight: options.motionWeight ?? 0.6,
      saliencyWeight: options.saliencyWeight ?? 0.4,
    };

    const cb = new Float64Array(PROFILE_COLS);
    let sum = 0;
    for (let x = 0; x < PROFILE_COLS; x++) {
      const nx = x / (PROFILE_COLS - 1);
      cb[x] = Math.exp(-0.5 * ((nx - 0.5) ** 2) / (0.35 ** 2));
      sum += cb[x];
    }
    if (sum > 0) for (let x = 0; x < PROFILE_COLS; x++) cb[x] /= sum;
    this.centerBias = cb;
  }

  /** Convert an RGB24 frame to gray8 (BT.601 luma). */
  toGray(rgb: Uint8Array): Uint8Array {
    const { W, H } = this;
    const gray = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 3) {
      gray[i] = (rgb[p] * 77 + rgb[p + 1] * 150 + rgb[p + 2] * 29) >> 8;
    }
    return gray;
  }

  analyze(rgb: Uint8Array, gray: Uint8Array, prevGray: Uint8Array | null): FrameProfiles {
    const { W, H } = this;
    const bandTop = Math.floor(H * BAND_TOP);
    const bandBot = Math.floor(H * BAND_BOT);

    // ── motion (face-band only), projected to PROFILE_COLS ──
    const motionFull = new Float64Array(W);
    if (prevGray) {
      for (let y = bandTop; y < bandBot; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const d = Math.abs(gray[row + x] - prevGray[row + x]);
          if (d >= MOTION_THRESH) motionFull[x] += d;
        }
      }
    }
    const motion = resample1d(motionFull, PROFILE_COLS);

    // ── skin tone (face-band only), projected to PROFILE_COLS ──
    const skinFull = new Float64Array(W);
    for (let y = bandTop; y < bandBot; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const p = (row + x) * 3;
        if (isSkin(rgb[p], rgb[p + 1], rgb[p + 2])) skinFull[x]++;
      }
    }
    const skin = resample1d(skinFull, PROFILE_COLS);

    // ── saliency ──
    const salSmall = downsampleGray(gray, W, H, SAL_SIZE, SAL_SIZE);
    const salColsSmall = spectralResidualColumns(salSmall, SAL_SIZE, SAL_SIZE, SAL_SIZE);
    const saliency = resample1d(salColsSmall, PROFILE_COLS);
    normalize(saliency);

    // ── interest map (centroid fallback for non-two-shot) ──
    const motionN = normalized(motion);
    const skinN = normalized(skin);
    const faceXs = this.opts.faceHook ? this.opts.faceHook(rgb, W, H) : [];

    const interest = new Float64Array(PROFILE_COLS);
    for (let x = 0; x < PROFILE_COLS; x++) {
      interest[x] =
        this.centerBias[x] * this.opts.centerWeight +
        skinN[x] * this.opts.skinWeight +
        motionN[x] * this.opts.motionWeight +
        saliency[x] * this.opts.saliencyWeight;
    }
    for (const fx of faceXs) addColumnGaussian(interest, fx, 0.12, 2.0);

    let total = 0, weighted = 0;
    for (let x = 0; x < PROFILE_COLS; x++) { total += interest[x]; weighted += interest[x] * x; }
    const interestX = total < 1e-9 ? 0.5 : weighted / (total * (PROFILE_COLS - 1));

    return { interestX, motion, saliency, skin, gray };
  }
}

// ── skin test (Kovač et al. RGB rule — cheap, no colour-space conversion) ───────

function isSkin(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return (
    r > 95 && g > 40 && b > 20 &&
    mx - mn > 15 &&
    Math.abs(r - g) > 15 &&
    r > g && r > b
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

function addColumnGaussian(interest: Float64Array, cx: number, sigma: number, weight: number): void {
  const n = interest.length;
  for (let x = 0; x < n; x++) {
    const nx = x / (n - 1);
    interest[x] += Math.exp(-0.5 * ((nx - cx) ** 2) / (sigma ** 2)) * weight;
  }
}

function maxOf(a: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

function normalize(a: Float64Array): void {
  const m = maxOf(a);
  if (m > 1e-9) for (let i = 0; i < a.length; i++) a[i] /= m;
}

function normalized(a: Float64Array): Float64Array {
  const out = a.slice();
  normalize(out);
  return out;
}

function downsampleGray(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Float64Array {
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / dh) * sh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / dw) * sw));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}
