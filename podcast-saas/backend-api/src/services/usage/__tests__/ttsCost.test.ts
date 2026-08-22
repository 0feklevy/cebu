/**
 * What a synthesis costs, and the two ways an estimator like this goes wrong quietly.
 *
 * It must not price things as FREE — a zero total is the one wrong answer that looks like good
 * news and therefore never gets questioned. And it must not THROW: it runs on the path that
 * records a call already made and already paid for, so a calculator that can fail would turn a
 * metering bug into a failed render.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateTtsCost,
  usdPerCreditFromEnv,
  charactersIn,
  DEFAULT_USD_PER_CREDIT,
  CREDITS_PER_CHARACTER,
} from '../ttsCost.js';

describe('pricing a synthesis', () => {
  it('charges per character, one credit each', () => {
    const c = estimateTtsCost({ characters: 1_000 });
    expect(c.characters).toBe(1_000);
    expect(c.credits).toBe(1_000 * CREDITS_PER_CHARACTER);
    expect(c.usd).toBeCloseTo(1_000 * DEFAULT_USD_PER_CREDIT, 10);
  });

  it('defaults to the WORST per-credit rate, not a flattering one', () => {
    // An estimate under the invoice is a bug; over it is a pleasant surprise. The Creator tier —
    // $22 per 100,000 credits — is the least favourable paid rate and therefore the right default
    // for an account nobody has configured.
    expect(DEFAULT_USD_PER_CREDIT).toBeCloseTo(22 / 100_000, 12);
  });

  it('puts a real episode in a range a person can sanity-check', () => {
    // ~40 minutes of dialogue is on the order of 36,000 characters. If this drifts into cents or
    // into hundreds of dollars, the rate is wrong and the whole surface is wrong with it.
    const c = estimateTtsCost({ characters: 36_000 });
    expect(c.usd).toBeGreaterThan(1);
    expect(c.usd).toBeLessThan(50);
  });

  it('keeps sub-cent calls off zero', () => {
    // `cost_cents` is double precision precisely so a short utterance does not round to free and
    // vanish from every sum built on it.
    const c = estimateTtsCost({ characters: 12 });
    expect(c.costCents).toBeGreaterThan(0);
  });

  it('honours the account rate once it is known', () => {
    const cheap = estimateTtsCost({ characters: 1_000, usdPerCredit: 0.00001 });
    expect(cheap.usd).toBeCloseTo(0.01, 10);
  });

  it('prices nonsense as zero instead of throwing', () => {
    // It runs after the money is already spent. Failing here would fail the render.
    for (const n of [0, -5, NaN, Infinity, -Infinity]) {
      expect(() => estimateTtsCost({ characters: n })).not.toThrow();
      expect(estimateTtsCost({ characters: n }).usd).toBe(0);
    }
  });
});

describe('the configured rate', () => {
  it('falls back to the headline when unset', () => {
    expect(usdPerCreditFromEnv({})).toBe(DEFAULT_USD_PER_CREDIT);
  });

  it('takes a real value', () => {
    expect(usdPerCreditFromEnv({ ELEVENLABS_USD_PER_CREDIT: '0.00005' })).toBeCloseTo(0.00005, 12);
  });

  it('refuses zero and nonsense — a zero rate prices the whole account as free', () => {
    // The failure mode that matters: everything reads $0.00, which looks like good news and so
    // nobody investigates. Falling back to the headline is loud by comparison.
    for (const raw of ['0', '-1', 'free', '', 'NaN']) {
      expect(usdPerCreditFromEnv({ ELEVENLABS_USD_PER_CREDIT: raw }), raw).toBe(DEFAULT_USD_PER_CREDIT);
    }
  });
});

describe('counting what was actually sent', () => {
  it('sums every input in the request', () => {
    expect(charactersIn([{ text: 'hello' }, { text: 'world!' }])).toBe(11);
  });

  it('counts audio tags too, because the vendor bills for them', () => {
    // `[laughs]` is part of the payload. Excluding it would under-report, and this number exists
    // to be reconciled against an invoice rather than to flatter anybody.
    expect(charactersIn([{ text: '[laughs] right' }])).toBe('[laughs] right'.length);
  });

  it('survives a missing or null text without throwing', () => {
    expect(charactersIn([{ text: null }, {}, { text: 'ok' }])).toBe(2);
  });

  it('is zero for an empty request', () => {
    expect(charactersIn([])).toBe(0);
  });
});
