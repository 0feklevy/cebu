import { describe, it, expect } from 'vitest';
import { isSimilarMedia, parsePeaks } from '../mediaSimilarity.js';

const peaks = (fill: number, len = 200) => Array.from({ length: len }, () => fill);

describe('parsePeaks', () => {
  it('parses a valid numeric array', () => {
    expect(parsePeaks('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });
  it('returns null for null/empty/malformed/non-array', () => {
    expect(parsePeaks(null)).toBeNull();
    expect(parsePeaks(undefined)).toBeNull();
    expect(parsePeaks('not json')).toBeNull();
    expect(parsePeaks('{"a":1}')).toBeNull();
    expect(parsePeaks('["a","b"]')).toBeNull();
  });
});

describe('isSimilarMedia', () => {
  it('is NOT similar when there is no prior media (first upload → process fresh)', () => {
    expect(isSimilarMedia(null, null, 30, peaks(0.5))).toBe(false);
    expect(isSimilarMedia(30, null, 30, peaks(0.5))).toBe(false);
    expect(isSimilarMedia(30, [], 30, peaks(0.5))).toBe(false);
  });

  it('is similar for identical duration + identical waveform', () => {
    expect(isSimilarMedia(30, peaks(0.5), 30, peaks(0.5))).toBe(true);
  });

  it('is similar within the duration tolerance + near-identical audio', () => {
    // 30s old vs 30.3s new (within ±0.6s = 2%), tiny waveform drift
    const old = peaks(0.5);
    const next = old.map((v, i) => (i % 50 === 0 ? v + 0.05 : v)); // small drift on a few buckets
    expect(isSimilarMedia(30, old, 30.3, next)).toBe(true);
  });

  it('is NOT similar when the duration differs beyond tolerance', () => {
    expect(isSimilarMedia(30, peaks(0.5), 45, peaks(0.5))).toBe(false);
  });

  it('is NOT similar when the audio waveform differs a lot (different content)', () => {
    expect(isSimilarMedia(30, peaks(0.2), 30, peaks(0.85))).toBe(false);
  });

  it('is NOT similar when waveform lengths mismatch', () => {
    expect(isSimilarMedia(30, peaks(0.5, 200), 30, peaks(0.5, 100))).toBe(false);
  });
});
