/**
 * Pricing a transcription — the one estimator whose QUANTITY is not a guess.
 *
 * Groq's `verbose_json` reports the duration it processed, which is what the invoice is computed
 * from. So the usual worry, whether the number being multiplied is even right, does not apply. What
 * these tests pin instead is the distinction the caller depends on: a duration the vendor did not
 * report is UNKNOWN, and unknown must never be rendered as zero.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateSttCost,
  usdPerAudioHourFromEnv,
  reportedDurationSec,
  DEFAULT_USD_PER_AUDIO_HOUR,
} from '../sttCost.js';

describe('pricing', () => {
  it('charges by the hour of audio', () => {
    const c = estimateSttCost({ durationSec: 3600, usdPerHour: 0.12 });
    expect(c.usd).toBeCloseTo(0.12, 10);
    expect(c.seconds).toBe(3600);
  });

  it('puts a realistic file in a range a person can sanity-check', () => {
    // A 45-minute lecture. If this drifts into dollars or into millionths, the rate is wrong and
    // every total built on it is wrong too.
    const c = estimateSttCost({ durationSec: 45 * 60 });
    expect(c.usd).toBeGreaterThan(0.01);
    expect(c.usd).toBeLessThan(1);
  });

  it('keeps a short clip off zero', () => {
    expect(estimateSttCost({ durationSec: 3 }).costCents).toBeGreaterThan(0);
  });

  it('errs high on the default rate', () => {
    // An estimate under the invoice is a bug; over it is a pleasant surprise.
    expect(DEFAULT_USD_PER_AUDIO_HOUR).toBeGreaterThan(0.1);
  });

  it('prices nonsense as zero rather than throwing', () => {
    // Runs after the money is spent; a throw here would fail an ingest that already succeeded.
    for (const d of [0, -1, NaN, Infinity]) {
      expect(() => estimateSttCost({ durationSec: d })).not.toThrow();
      expect(estimateSttCost({ durationSec: d }).usd).toBe(0);
    }
  });

  it('refuses a zero or malformed configured rate', () => {
    for (const raw of ['0', '-1', 'free', '', 'NaN']) {
      expect(usdPerAudioHourFromEnv({ GROQ_USD_PER_AUDIO_HOUR: raw }), raw)
        .toBe(DEFAULT_USD_PER_AUDIO_HOUR);
    }
    expect(usdPerAudioHourFromEnv({ GROQ_USD_PER_AUDIO_HOUR: '0.111' })).toBeCloseTo(0.111, 12);
  });
});

describe('reading the duration the vendor reported', () => {
  it('takes a number', () => {
    expect(reportedDurationSec({ duration: 128.4 })).toBe(128.4);
  });

  it('takes a numeric string, because some response shapes send one', () => {
    expect(reportedDurationSec({ duration: '92' })).toBe(92);
  });

  it('returns NULL when there is no duration — not zero', () => {
    // The distinction the whole recorder depends on. Zero would mean "this transcription was
    // free", and a per-day total built from that is confidently wrong — which is worse than a
    // visible gap, because a number gets believed.
    expect(reportedDurationSec({})).toBeNull();
    expect(reportedDurationSec(null)).toBeNull();
    expect(reportedDurationSec(undefined)).toBeNull();
    expect(reportedDurationSec({ duration: 'unknown' })).toBeNull();
    expect(reportedDurationSec({ duration: NaN })).toBeNull();
    expect(reportedDurationSec({ duration: -3 })).toBeNull();
  });

  it('accepts a genuine zero-length response as zero, not as unknown', () => {
    // An empty audio file really did cost nothing. That is a measurement, not an absence.
    expect(reportedDurationSec({ duration: 0 })).toBe(0);
  });
});
