/**
 * Pricing a generated sound effect, where the rate is the LEAST certain thing in the module.
 *
 * These tests are deliberately about the properties that survive not knowing the exact
 * credits-per-second figure: that the measured quantity is right, that an unknown is overstated
 * rather than understated, and that nothing ever prices as free. Whatever the real rate turns out
 * to be, a row with correct seconds can be re-priced; a row with a guessed quantity cannot.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateSfxCost,
  usdPerSfxSecondFromEnv,
  DEFAULT_USD_PER_SFX_SECOND,
  UNSPECIFIED_SFX_SECONDS,
} from '../sfxCost.js';

describe('the quantity, which is the half that is actually known', () => {
  it('uses the requested duration exactly', () => {
    expect(estimateSfxCost({ durationSeconds: 4.5 }).seconds).toBe(4.5);
    expect(estimateSfxCost({ durationSeconds: 4.5 }).assumedDuration).toBe(false);
  });

  it('assumes the API CEILING when no duration was asked for', () => {
    // The request schema makes the length optional, and unspecified means the vendor chooses.
    // Pricing that at zero would make the laziest call shape free — which is precisely the shape
    // a script would use in a loop.
    const c = estimateSfxCost({});
    expect(c.seconds).toBe(UNSPECIFIED_SFX_SECONDS);
    expect(c.assumedDuration).toBe(true);
  });

  it('flags the assumption, so a total built from it can be read with suspicion', () => {
    expect(estimateSfxCost({ durationSeconds: null }).assumedDuration).toBe(true);
    expect(estimateSfxCost({ durationSeconds: 3 }).assumedDuration).toBe(false);
  });

  it('treats nonsense as unspecified rather than as zero', () => {
    for (const d of [0, -3, NaN, Infinity]) {
      const c = estimateSfxCost({ durationSeconds: d });
      expect(c.seconds, String(d)).toBe(UNSPECIFIED_SFX_SECONDS);
      expect(c.usd).toBeGreaterThan(0);
    }
  });
});

describe('the rate, which is the half that is not', () => {
  it('never prices a generation at zero', () => {
    // The one wrong answer that looks like good news, so nobody investigates it.
    expect(estimateSfxCost({ durationSeconds: 0.5 }).costCents).toBeGreaterThan(0);
    expect(estimateSfxCost({}).costCents).toBeGreaterThan(0);
  });

  it('errs HIGH — an estimate under the invoice is a bug', () => {
    // A few seconds of audio; a generous rate overstates one generation by pennies, while an
    // optimistic one lets a loop of them look free.
    expect(DEFAULT_USD_PER_SFX_SECOND).toBeGreaterThan(0.001);
  });

  it('honours the account rate once it is known', () => {
    expect(estimateSfxCost({ durationSeconds: 10, usdPerSecond: 0.002 }).usd).toBeCloseTo(0.02, 10);
  });

  it('refuses a zero or malformed configured rate', () => {
    for (const raw of ['0', '-1', 'free', '', 'NaN']) {
      expect(usdPerSfxSecondFromEnv({ ELEVENLABS_USD_PER_SFX_SECOND: raw }), raw)
        .toBe(DEFAULT_USD_PER_SFX_SECOND);
    }
  });

  it('takes a real configured rate', () => {
    expect(usdPerSfxSecondFromEnv({ ELEVENLABS_USD_PER_SFX_SECOND: '0.004' })).toBeCloseTo(0.004, 12);
  });

  it('falls back when unset', () => {
    expect(usdPerSfxSecondFromEnv({})).toBe(DEFAULT_USD_PER_SFX_SECOND);
  });
});
