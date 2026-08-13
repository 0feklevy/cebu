/**
 * The rendering sanity gate (§0.3). The two load-bearing cases the plan names explicitly:
 *   • a black canvas under a Minimal-UI control FAILS — "the exact hole the plan names" (a
 *     non-uniform *screenshot* is not enough; the *canvas* is dead), and
 *   • a real animated sim PASSES.
 *
 * Mutation target: if `isFrameUniform` is broken to accept a uniform canvas (or the gate stops
 * requiring intra-frame non-uniformity), the black-canvas test flips to a pass and fails here.
 */

import { describe, it, expect } from 'vitest';

import {
  evaluateSanityGate,
  isFrameUniform,
  frameSignature,
  type FrameSample,
  type WebglRecord,
} from '../sanityGate.js';

const N = 8;

/** A flat canvas — every pixel the same colour. What a dead/black WebGL canvas looks like. */
function solid(r: number, g: number, b: number, a: number): FrameSample {
  const rgba: number[] = [];
  for (let i = 0; i < N * N; i++) rgba.push(r, g, b, a);
  return { width: N, height: N, rgba };
}

/** A non-uniform, animated frame — a gradient shifted by `offset`. */
function gradient(offset: number): FrameSample {
  const rgba: number[] = [];
  for (let i = 0; i < N * N; i++) {
    rgba.push((i * 7 + offset) % 256, (i * 3) % 256, offset % 256, 255);
  }
  return { width: N, height: N, rgba };
}

const WEBGL_OK: WebglRecord = { attempted: true, ok: true, renderer: 'ANGLE (Apple, Metal)' };
const WEBGL_DEAD: WebglRecord = { attempted: true, ok: false, renderer: '' };
const WEBGL_NONE: WebglRecord = { attempted: false, ok: false, renderer: '' };

describe('isFrameUniform', () => {
  it('is true for a flat canvas and false for a gradient', () => {
    expect(isFrameUniform(solid(0, 0, 0, 255))).toBe(true);
    expect(isFrameUniform(solid(0, 0, 0, 0))).toBe(true);
    expect(isFrameUniform(gradient(0))).toBe(false);
  });

  it('tolerates tiny noise but rejects real content', () => {
    const nearlyFlat: FrameSample = { width: 2, height: 2, rgba: [10, 10, 10, 255, 12, 11, 13, 255, 10, 10, 10, 255, 11, 12, 10, 255] };
    expect(isFrameUniform(nearlyFlat, 6)).toBe(true);
    expect(isFrameUniform(nearlyFlat, 0)).toBe(false);
  });
});

describe('frameSignature', () => {
  it('is stable for identical pixels and differs when they change', () => {
    expect(frameSignature(gradient(0))).toBe(frameSignature(gradient(0)));
    expect(frameSignature(gradient(0))).not.toBe(frameSignature(gradient(50)));
  });
});

describe('evaluateSanityGate', () => {
  it('FAILS a black canvas under the UI (the hole the plan names)', () => {
    const result = evaluateSanityGate({
      simPainted: true, // the sim even claims it painted…
      webgl: WEBGL_DEAD, // …but the WebGL context is dead (M144), and…
      frames: [solid(0, 0, 0, 255), solid(0, 0, 0, 255), solid(0, 0, 0, 255)], // …the canvas is flat black
    });
    expect(result.gate).toBe('failed');
    expect(result.checks.intraFrameNonUniform).toBe(false);
    expect(result.checks.webglLive).toBe(false);
    expect(result.reason).toMatch(/uniform/i);
  });

  it('FAILS a canvas that only FLASHES flat colours (isolates the uniformity check)', () => {
    // Each frame is a single flat colour, but the colour CHANGES frame to frame — so SIM_PAINTED,
    // a live WebGL context, and inter-frame delta all pass. The ONLY thing wrong is that no frame is
    // non-uniform. This is the case that turns green if `isFrameUniform` is mutated to accept a flat
    // canvas — the named mutation ("accept a uniform canvas ⇒ the black-canvas test fails").
    const result = evaluateSanityGate({
      simPainted: true,
      webgl: WEBGL_OK,
      frames: [solid(0, 0, 0, 255), solid(255, 255, 255, 255), solid(0, 0, 0, 255)],
    });
    expect(result.checks.interFrameDelta).toBe(true);
    expect(result.checks.webglLive).toBe(true);
    expect(result.checks.intraFrameNonUniform).toBe(false);
    expect(result.gate).toBe('failed');
  });

  it('PASSES a real animated WebGL sim', () => {
    const result = evaluateSanityGate({
      simPainted: true,
      webgl: WEBGL_OK,
      frames: [gradient(0), gradient(40), gradient(90)],
    });
    expect(result.gate).toBe('passed');
    expect(result.rendererString).toBe('ANGLE (Apple, Metal)');
    expect(result.distinctFrames).toBe(3);
  });

  it('PASSES a 2D-canvas sim that never touched WebGL (attempted:false is not the trap)', () => {
    const result = evaluateSanityGate({
      simPainted: true,
      webgl: WEBGL_NONE,
      frames: [gradient(0), gradient(30)],
    });
    expect(result.gate).toBe('passed');
    expect(result.checks.webglLive).toBe(true);
  });

  it('FAILS when SIM_PAINTED never fired', () => {
    const result = evaluateSanityGate({ simPainted: false, webgl: WEBGL_OK, frames: [gradient(0), gradient(50)] });
    expect(result.gate).toBe('failed');
    expect(result.reason).toMatch(/SIM_PAINTED/);
  });

  it('FAILS when the canvas is non-uniform but never changes (nothing animating)', () => {
    const still = gradient(7);
    const result = evaluateSanityGate({ simPainted: true, webgl: WEBGL_OK, frames: [still, still, still] });
    expect(result.gate).toBe('failed');
    expect(result.checks.intraFrameNonUniform).toBe(true);
    expect(result.checks.interFrameDelta).toBe(false);
    expect(result.reason).toMatch(/did not change|animating/i);
  });

  it('FAILS with fewer than two samples (cannot judge animation)', () => {
    const result = evaluateSanityGate({ simPainted: true, webgl: WEBGL_OK, frames: [gradient(0)] });
    expect(result.gate).toBe('failed');
    expect(result.checks.enoughSamples).toBe(false);
  });
});
