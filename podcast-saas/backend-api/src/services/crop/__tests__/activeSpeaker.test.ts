import { describe, it, expect } from 'vitest';
import {
  regionMotionSeries, windowedActiveRegions, speechCorrelatedMotion,
  headSpeechEvidence, headColumns, nullSigma,
} from '../activeSpeaker.js';
import { PROFILE_COLS } from '../sceneAnalyzer.js';

/** Build a synthetic per-frame motion profile with energy concentrated at `headX`. */
function frameWithMotionAt(headX: number, energy: number): Float64Array {
  const m = new Float64Array(PROFILE_COLS);
  const c = Math.round(headX * (PROFILE_COLS - 1));
  for (let x = c - 6; x <= c + 6; x++) if (x >= 0 && x < PROFILE_COLS) m[x] = energy;
  return m;
}

describe('windowedActiveRegions (audio-visual correlation)', () => {
  it('attributes speech to whichever face moves in sync — even at equal pitch', () => {
    // 80 frames: LEFT speaks 0-39, RIGHT speaks 40-79. Both regions also carry
    // independent background motion + a common-mode wobble (must be rejected).
    const N = 80;
    const env = new Float64Array(N);
    const motionL = new Float64Array(N);
    const motionR = new Float64Array(N);
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    for (let i = 0; i < N; i++) {
      const e = 0.04 + 0.03 * Math.abs(Math.sin(i * 1.7)) + 0.01 * rnd();
      env[i] = e;
      const bgL = 0.5 * rnd(), bgR = 0.5 * rnd();
      const common = 0.3 * Math.sin(i * 0.3);
      if (i < 40) { motionL[i] = e * 40 + bgL + common; motionR[i] = bgR + common; }
      else        { motionL[i] = bgL + common;          motionR[i] = e * 40 + bgR + common; }
    }

    const av = windowedActiveRegions(motionL, motionR, env);
    const left  = av.slice(8, 36).filter((x) => x === 0).length;
    const right = av.slice(44, 72).filter((x) => x === 1).length;
    expect(left).toBeGreaterThan(20);
    expect(right).toBeGreaterThan(20);
  });

  it('returns null during silence (no audio energy)', () => {
    const N = 40;
    const env = new Float64Array(N);            // all zero → silence
    const motionL = new Float64Array(N).fill(1);
    const motionR = new Float64Array(N).fill(2);
    const av = windowedActiveRegions(motionL, motionR, env);
    expect(av.every((x) => x === null)).toBe(true);
  });
});

describe('regionMotionSeries', () => {
  it('pools motion energy from the head\'s column window', () => {
    const frames = [frameWithMotionAt(0.3, 10), frameWithMotionAt(0.3, 20)];
    const series = regionMotionSeries(frames, 0.3);
    expect(series[1]).toBeGreaterThan(series[0]);     // more energy → larger value
    const off = regionMotionSeries(frames, 0.8);      // far from the motion
    expect(off[0]).toBe(0);
  });
});

describe('nullSigma', () => {
  it('reports the null SD of r for the window a halfWindow implies', () => {
    // n = 2*hw + 1 samples → SD ≈ 1/√(n−1). The shipped hw of 5 gives 11 samples, SD 0.316,
    // which is why the literal 0.12 minCorr it replaced was a 0.38σ bar on pure noise.
    expect(nullSigma(5)).toBeCloseTo(1 / Math.sqrt(10), 12);
    expect(nullSigma(10)).toBeCloseTo(1 / Math.sqrt(20), 12);
    expect(nullSigma(10)).toBeLessThan(nullSigma(5));
  });
});

describe('headSpeechEvidence', () => {
  it('credits the head whose motion tracks the speech, not the one that moves most', () => {
    // LEFT nods hard on its own clock; RIGHT moves less, but in time with the envelope.
    // This is the D2a trap: raw motion energy names the listener.
    const N = 120;
    const env = new Float64Array(N);
    const frames: Float64Array[] = [];
    for (let i = 0; i < N; i++) {
      const e = 0.04 + 0.03 * Math.abs(Math.sin(i * 1.7));
      env[i] = e;
      const f = new Float64Array(PROFILE_COLS);
      const nod = 6 * (1 + Math.sin(i * 0.41));
      const talk = 2 * e * 20;
      for (let x = 0; x < PROFILE_COLS; x++) {
        const nx = x / (PROFILE_COLS - 1);
        if (Math.abs(nx - 0.3) < 0.06) f[x] = nod;
        if (Math.abs(nx - 0.7) < 0.06) f[x] = talk;
      }
      frames.push(f);
    }
    const speech = speechCorrelatedMotion(frames, env);
    expect(headSpeechEvidence(speech, 0.7)).toBeGreaterThan(headSpeechEvidence(speech, 0.3));
  });

  it('has no opinion when there is no speech-correlated motion anywhere', () => {
    const empty = new Float64Array(PROFILE_COLS);
    expect(headSpeechEvidence(empty, 0.3)).toBe(0);
    expect(headSpeechEvidence(empty, 0.7)).toBe(0);
  });

  it('pools the same columns regionMotionSeries does', () => {
    const [lo, hi] = headColumns(0.5);
    const frame = new Float64Array(PROFILE_COLS);
    for (let x = lo; x <= hi; x++) frame[x] = 1;
    expect(regionMotionSeries([frame], 0.5)[0]).toBe(hi - lo + 1);
    expect(headSpeechEvidence(frame, 0.5)).toBe(hi - lo + 1);
  });
});
