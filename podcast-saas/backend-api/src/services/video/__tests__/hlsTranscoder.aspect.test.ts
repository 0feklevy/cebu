/**
 * media-002 — the HLS tier filter chain and ANAMORPHIC sources (SAR ≠ 1:1).
 *
 * HLS is what every viewer actually streams, so the geometry the tier chain produces IS
 * the geometry the product has. The export path already squares the pixels before it fits
 * (`ffmpegGraph.videoNormChain`, and its header comment names this module as the place the
 * same fix was missing); this file is the pinned proof that the tier chain does it too.
 *
 * NO ENCODER RUNS HERE. Instead the `-vf` string that `buildTierArgs` emits is evaluated by
 * a small, deliberately narrow model of ffmpeg's own scale/pad/setsar geometry:
 *
 *   scale — `force_original_aspect_ratio` fits against the CODED dimensions
 *           (libavfilter/vf_scale.c: `tmp_w = av_rescale(h, inlink->w, inlink->h)`,
 *           `tmp_h = av_rescale(w, inlink->h, inlink->w)`, then FFMIN for `decrease`),
 *           and the output SAR is rewritten to preserve the input's display aspect:
 *           `sar_out = (h_out·w_in)/(w_out·h_in) · sar_in`.
 *           That last line is the whole bug: a non-unity input SAR SURVIVES the scale.
 *   pad   — changes the coded frame, leaves SAR (and the content) alone.
 *   setsar— pins SAR outright.
 *
 * The model throws on any filter or option it has not been taught, so it can never
 * silently "pass" a chain it did not actually model.
 */

import { describe, it, expect } from 'vitest';
import { TIERS, buildTierArgs, type QualityTier, type TierEncodeContext } from '../HLSTranscoder.js';

// ---------------------------------------------------------------------------
// A narrow model of ffmpeg's scale/pad/setsar geometry
// ---------------------------------------------------------------------------

interface Geom {
  /** Coded (storage) frame. */
  w: number;
  h: number;
  /** Sample aspect ratio, as a fraction. */
  sarN: number;
  sarD: number;
  /** The picture inside the coded frame, and where padding put it. */
  contentW: number;
  contentH: number;
  padLeft: number;
  padTop: number;
}

/** ffmpeg's av_rescale: a·b/c, rounded to nearest, halves away from zero. */
const rescale = (a: number, b: number, c: number): number => Math.round((a * b) / c);

/** Displayed aspect of the whole coded frame. */
const frameDar = (g: Geom): number => (g.w * g.sarN) / (g.h * g.sarD);
/** Displayed aspect of the picture inside it (ignoring any bars). */
const contentDar = (g: Geom): number => (g.contentW * g.sarN) / (g.contentH * g.sarD);

function evalScaleDim(expr: string, g: Geom): number {
  if (/^\d+$/.test(expr)) return Number(expr);
  if (expr === 'iw') return g.w;
  if (expr === 'ih') return g.h;
  // the "square the pixels" prefix, spelled exactly as the export path spells it
  if (expr === 'trunc(iw*sar/2)*2') return Math.trunc((g.w * g.sarN) / g.sarD / 2) * 2;
  throw new Error(`geometry model: unmodelled scale expression "${expr}"`);
}

function applyScale(args: string[], g: Geom): Geom {
  const [wExpr, hExpr, ...rest] = args;
  if (wExpr === undefined || hExpr === undefined) throw new Error('geometry model: scale needs w:h');
  let w = evalScaleDim(wExpr, g);
  let h = evalScaleDim(hExpr, g);

  let force: string | null = null;
  for (const opt of rest) {
    const [k, v] = opt.split('=');
    if (k === 'force_original_aspect_ratio') force = v ?? null;
    else throw new Error(`geometry model: unmodelled scale option "${opt}"`);
  }
  if (force !== null) {
    if (force !== 'decrease') throw new Error(`geometry model: unmodelled force_original_aspect_ratio=${force}`);
    // vf_scale.c: both candidates are computed from the CODED dimensions, then FFMIN'd.
    const tmpW = rescale(h, g.w, g.h);
    const tmpH = rescale(w, g.h, g.w);
    w = Math.min(tmpW, w);
    h = Math.min(tmpH, h);
  }

  // vf_scale.c config_props: the output SAR is rewritten so the DISPLAY aspect survives
  // the resample. A non-unity input SAR therefore comes out the other side.
  const sarN = h * g.w * g.sarN;
  const sarD = w * g.h * g.sarD;
  return { w, h, sarN, sarD, contentW: w, contentH: h, padLeft: 0, padTop: 0 };
}

function applyPad(args: string[], g: Geom): Geom {
  const [wRaw, hRaw, xRaw, yRaw] = args;
  if (wRaw === undefined || hRaw === undefined) throw new Error('geometry model: pad needs w:h');
  if (!/^\d+$/.test(wRaw) || !/^\d+$/.test(hRaw)) {
    throw new Error(`geometry model: unmodelled pad size "${wRaw}:${hRaw}"`);
  }
  if (xRaw !== '(ow-iw)/2' || yRaw !== '(oh-ih)/2') {
    throw new Error(`geometry model: unmodelled pad placement "${xRaw}:${yRaw}"`);
  }
  const w = Number(wRaw);
  const h = Number(hRaw);
  // pad enlarges the coded frame and centres the picture; SAR is untouched.
  return {
    w,
    h,
    sarN: g.sarN,
    sarD: g.sarD,
    contentW: g.contentW,
    contentH: g.contentH,
    padLeft: Math.trunc((w - g.contentW) / 2),
    padTop: Math.trunc((h - g.contentH) / 2),
  };
}

/** Run a `-vf` chain over a source geometry. Throws on anything it has not been taught. */
export function evalVideoFilterChain(chain: string, src: Geom): Geom {
  let g = src;
  for (const step of chain.split(',')) {
    const eq = step.indexOf('=');
    const name = eq === -1 ? step : step.slice(0, eq);
    const args = eq === -1 ? [] : step.slice(eq + 1).split(':');
    switch (name) {
      case 'scale':
        g = applyScale(args, g);
        break;
      case 'pad':
        g = applyPad(args, g);
        break;
      case 'setsar': {
        const v = args[0];
        if (v !== '1') throw new Error(`geometry model: unmodelled setsar=${v}`);
        g = { ...g, sarN: 1, sarD: 1 };
        break;
      }
      default:
        throw new Error(`geometry model: unmodelled filter "${name}" in chain "${chain}"`);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const source = (w: number, h: number, sarN: number, sarD: number): Geom => ({
  w, h, sarN, sarD, contentW: w, contentH: h, padLeft: 0, padTop: 0,
});

/** 1440x1080 with SAR 4:3 → DAR 16:9. Ordinary HDV / broadcast / camcorder shape. */
const ANAMORPHIC_16_9 = source(1440, 1080, 4, 3);
/** 960x720 square pixels → a genuine 4:3 picture (Zoom/webcam). */
const SQUARE_4_3 = source(960, 720, 1, 1);

const ctx = (tier: QualityTier): TierEncodeContext => ({
  fps: 30,
  segmentSec: 4,
  inputPath: '/work/source.mp4',
  segmentPattern: `/work/${tier.name}/seg_%03d.ts`,
  playlistPath: `/work/${tier.name}/index.m3u8`,
});

const vfOf = (tier: QualityTier): string => {
  const args = buildTierArgs(tier, ctx(tier));
  const i = args.indexOf('-vf');
  expect(i, 'buildTierArgs must emit a -vf chain').toBeGreaterThanOrEqual(0);
  return args[i + 1]!;
};

// ---------------------------------------------------------------------------
// The model, checked against numbers that can be reasoned about by hand
// ---------------------------------------------------------------------------

describe('the geometry model itself', () => {
  it('reproduces the audited chain on the anamorphic source: 1280x720, SAR 4:3, DAR 64:27', () => {
    const audited =
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
    const out = evalVideoFilterChain(audited, ANAMORPHIC_16_9);
    expect([out.w, out.h]).toEqual([1280, 720]);
    expect(out.sarN / out.sarD).toBeCloseTo(4 / 3, 9);   // the input SAR survived the scale
    expect(frameDar(out)).toBeCloseTo(64 / 27, 9);        // …so the player stretches by 4/3
    expect(out.padLeft).toBe(160);                        // …on top of 160px bars each side
  });

  it('refuses to model a filter it has not been taught', () => {
    expect(() => evalVideoFilterChain('hue=s=0', ANAMORPHIC_16_9)).toThrow(/unmodelled filter/);
    expect(() => evalVideoFilterChain('scale=iw/2:ih', ANAMORPHIC_16_9)).toThrow(/unmodelled scale expression/);
  });
});

// ---------------------------------------------------------------------------
// media-002
// ---------------------------------------------------------------------------

describe('buildTierArgs geometry (media-002)', () => {
  it('preserves the DISPLAYED aspect of an anamorphic source in every tier', () => {
    for (const tier of TIERS) {
      const out = evalVideoFilterChain(vfOf(tier), ANAMORPHIC_16_9);
      const srcDar = frameDar(ANAMORPHIC_16_9); // 16:9
      // The whole coded frame is the tier's box…
      expect([out.w, out.h], tier.name).toEqual([tier.width, tier.height]);
      // …the pixels are square, so a player renders it at its coded size…
      expect(out.sarN / out.sarD, `${tier.name} SAR`).toBeCloseTo(1, 9);
      // …and what it shows is the source's own display aspect, not a stretched one.
      // (854x480 is not exactly 16:9; 0.5% covers that tier's own rounding.)
      expect(contentDar(out) / srcDar, `${tier.name} displayed aspect`).toBeCloseTo(1, 2);
    }
  });

  it('leaves no pillars on a 16:9-displaying anamorphic source (the frame is filled)', () => {
    for (const tier of TIERS) {
      const out = evalVideoFilterChain(vfOf(tier), ANAMORPHIC_16_9);
      // At most the tier's own odd-width rounding (854x480), never a quarter of the frame.
      expect(out.padLeft, `${tier.name} pillar width`).toBeLessThanOrEqual(1);
      expect(out.padTop, `${tier.name} letterbox height`).toBeLessThanOrEqual(1);
    }
  });

  it('still pillarboxes a genuine 4:3 source — square pixels, correct aspect, real bars', () => {
    // Not a bug: the tier matrix is 16:9, so a 4:3 picture MUST get bars. What matters is
    // that the picture inside them keeps its 4:3 shape and the pixels stay square.
    const tier = TIERS[2]!; // 720p
    const out = evalVideoFilterChain(vfOf(tier), SQUARE_4_3);
    expect([out.w, out.h]).toEqual([1280, 720]);
    expect(out.sarN / out.sarD).toBeCloseTo(1, 9);
    expect([out.contentW, out.contentH]).toEqual([960, 720]);
    expect(out.padLeft).toBe(160);
    expect(contentDar(out)).toBeCloseTo(4 / 3, 9);
  });

  it('fills the frame with square pixels for an ordinary 1080p upload', () => {
    // The common case. Not literally a no-op: on the 854x480 tier the old chain emitted
    // SAR 1.00039 (854/480 is not exactly 16:9, so the fit lands on 853x480 and the scale
    // filter compensated in SAR). The trailing setsar=1 pins that to square pixels and
    // absorbs the 0.04% into the 1px pad instead — an HLS variant whose EXT-X-STREAM-INF
    // advertises RESOLUTION=854x480 should not also carry a non-unity SAR.
    const hd = source(1920, 1080, 1, 1);
    for (const tier of TIERS) {
      const out = evalVideoFilterChain(vfOf(tier), hd);
      expect([out.w, out.h], tier.name).toEqual([tier.width, tier.height]);
      expect(out.sarN / out.sarD, tier.name).toBeCloseTo(1, 9);
      expect(out.padLeft, tier.name).toBeLessThanOrEqual(1);
      expect(out.padTop, tier.name).toBeLessThanOrEqual(1);
    }
  });
});
