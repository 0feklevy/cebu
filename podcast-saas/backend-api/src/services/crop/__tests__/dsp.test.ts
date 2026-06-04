import { describe, it, expect } from 'vitest';
import {
  fftRadix2, autocorrF0, spectralResidualColumns, gaussian1d, median1d, bhattacharyya,
} from '../dsp.js';
import { interestToCropX } from '../cropProcessor.js';
import { calibratePitchThreshold } from '../speaker.js';

describe('fftRadix2', () => {
  it('round-trips (IFFT∘FFT = N·identity)', () => {
    const re = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const im = new Float64Array(8);
    const orig = re.slice();
    fftRadix2(re, im, false);
    fftRadix2(re, im, true);
    for (let i = 0; i < 8; i++) expect(re[i] / 8).toBeCloseTo(orig[i], 9);
  });
  it('rejects non-power-of-two lengths', () => {
    expect(() => fftRadix2(new Float64Array(6), new Float64Array(6))).toThrow();
  });
});

describe('autocorrF0', () => {
  const sr = 16000;
  const tone = (f: number, n = sr) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = Math.sin((2 * Math.PI * f * i) / sr)
        + 0.4 * Math.sin((2 * Math.PI * 2 * f * i) / sr)
        + 0.2 * Math.sin((2 * Math.PI * 3 * f * i) / sr);
    }
    return x;
  };

  it('recovers fundamentals across the vocal range (no octave errors)', () => {
    for (const f of [90, 120, 160, 200, 240, 300]) {
      const { f0, confidence } = autocorrF0(tone(f), sr);
      expect(Math.abs(f0 - f)).toBeLessThan(5);
      expect(confidence).toBeGreaterThan(0.8);
    }
  });

  it('reports low confidence for white noise', () => {
    const noise = new Float32Array(sr);
    for (let i = 0; i < sr; i++) noise[i] = Math.random() * 2 - 1;
    expect(autocorrF0(noise, sr).confidence).toBeLessThan(0.5);
  });
});

describe('spectralResidualColumns', () => {
  it('peaks over a bright off-centre blob', () => {
    const w = 64, h = 64;
    const g = new Float64Array(w * h);
    for (let y = 20; y < 44; y++) for (let x = 8; x < 24; x++) g[y * w + x] = 255;
    const sal = spectralResidualColumns(g, w, h, 32);
    let ai = 0, amax = 0;
    for (let i = 0; i < 32; i++) if (sal[i] > amax) { amax = sal[i]; ai = i; }
    expect(ai).toBeLessThan(16); // blob is in the left half
  });
});

describe('1-D filters', () => {
  it('median removes single-sample spikes', () => {
    expect(median1d([1, 1, 99, 1, 1], 3)).toEqual([1, 1, 1, 1, 1]);
  });
  it('gaussian preserves the mean of a symmetric impulse', () => {
    const out = gaussian1d([0, 0, 10, 0, 0], 1);
    expect(out[2]).toBeGreaterThan(out[1]);
    expect(out[1]).toBeCloseTo(out[3], 6);
  });
  it('bhattacharyya is 0 for identical histograms', () => {
    expect(bhattacharyya(new Float64Array([1, 2, 3]), new Float64Array([1, 2, 3]))).toBeCloseTo(0, 6);
  });
});

describe('interestToCropX', () => {
  it('clamps the 9:16 window inside a 1920×1080 frame', () => {
    const half = (1080 * (9 / 16)) / 1920 / 2; // ≈ 0.158
    expect(interestToCropX(0.0, 1920, 1080)).toBeCloseTo(half, 4);
    expect(interestToCropX(1.0, 1920, 1080)).toBeCloseTo(1 - half, 4);
    expect(interestToCropX(0.5, 1920, 1080)).toBeCloseTo(0.5, 4);
  });
});

describe('calibratePitchThreshold', () => {
  it('finds the valley between two well-separated voice clusters', () => {
    const samples = [
      ...Array.from({ length: 20 }, () => ({ rms: 0.1, f0: 115 + Math.random() * 10, conf: 0.9 })),
      ...Array.from({ length: 20 }, () => ({ rms: 0.1, f0: 210 + Math.random() * 10, conf: 0.9 })),
    ];
    const thr = calibratePitchThreshold(samples);
    expect(thr).toBeGreaterThan(140);
    expect(thr).toBeLessThan(190);
  });
  it('falls back to 160 Hz for same-gender (unseparated) voices', () => {
    const samples = Array.from({ length: 30 }, () => ({ rms: 0.1, f0: 150 + Math.random() * 8, conf: 0.9 }));
    expect(calibratePitchThreshold(samples)).toBe(160);
  });
});
