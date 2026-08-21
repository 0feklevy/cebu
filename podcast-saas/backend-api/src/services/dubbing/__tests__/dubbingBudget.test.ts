/**
 * The dubbing ceiling.
 *
 * Dubbing bills on job creation at ~$2.20 per source-minute per language, and the vendor has no
 * idempotency key — so the only useful place for a limit is BEFORE the call. These tests pin the
 * policy arithmetic and, above all, that a refusal happens without the vendor ever being reached.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUBBING_MONTHLY_BUDGET_CENTS,
  dubbingBudgetExemptUserIds,
  dubbingMonthlyBudgetCents,
  judgeDubbingBudget,
  monthStartUtc,
} from '../budget.js';

const U = 'user-1';

describe('the configured ceiling', () => {
  it('falls back to the default when unset', () => {
    expect(dubbingMonthlyBudgetCents({} as NodeJS.ProcessEnv)).toBe(DEFAULT_DUBBING_MONTHLY_BUDGET_CENTS);
  });

  it('reads a valid override', () => {
    expect(dubbingMonthlyBudgetCents({ DUBBING_MONTHLY_BUDGET_CENTS: '12000' } as NodeJS.ProcessEnv)).toBe(12000);
  });

  it('refuses to let a malformed value disable the product', () => {
    // Zero, negative and non-numeric are configuration mistakes, not an intent to block everyone.
    for (const v of ['0', '-1', 'abc', '']) {
      expect(dubbingMonthlyBudgetCents({ DUBBING_MONTHLY_BUDGET_CENTS: v } as NodeJS.ProcessEnv))
        .toBe(DEFAULT_DUBBING_MONTHLY_BUDGET_CENTS);
    }
  });
});

describe('the exemption list', () => {
  it('is empty when unset, and tolerates whitespace and blanks', () => {
    expect(dubbingBudgetExemptUserIds({} as NodeJS.ProcessEnv).size).toBe(0);
    const s = dubbingBudgetExemptUserIds({ DUBBING_BUDGET_EXEMPT_USER_IDS: ' a , ,b ' } as NodeJS.ProcessEnv);
    expect([...s].sort()).toEqual(['a', 'b']);
  });
});

describe('the verdict', () => {
  const env = { DUBBING_MONTHLY_BUDGET_CENTS: '5000' } as NodeJS.ProcessEnv;

  it('allows a run that fits', () => {
    const v = judgeDubbingBudget({ userId: U, spentCents: 1000, estimateCents: 2000, env });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBeNull();
  });

  it('allows a run that lands exactly on the ceiling', () => {
    expect(judgeDubbingBudget({ userId: U, spentCents: 3000, estimateCents: 2000, env }).allowed).toBe(true);
  });

  it('refuses the run that would cross it, and says what is left', () => {
    const v = judgeDubbingBudget({ userId: U, spentCents: 4500, estimateCents: 2000, env });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('$20.00');   // this run
    expect(v.reason).toContain('$5.00');    // remaining
    expect(v.reason).toContain('$50.00');   // the ceiling
    expect(v.reason).toContain('$45.00');   // already used
  });

  it('refuses a user already over the ceiling even for a free-looking run', () => {
    expect(judgeDubbingBudget({ userId: U, spentCents: 9000, estimateCents: 1, env }).allowed).toBe(false);
  });

  it('never evaluates the ceiling for an exempt user', () => {
    const v = judgeDubbingBudget({
      userId: U,
      spentCents: 999999,
      estimateCents: 999999,
      env: { ...env, DUBBING_BUDGET_EXEMPT_USER_IDS: U } as NodeJS.ProcessEnv,
    });
    expect(v.allowed).toBe(true);
    expect(v.exempt).toBe(true);
  });

  it('treats negative inputs as zero rather than as credit', () => {
    const v = judgeDubbingBudget({ userId: U, spentCents: -100000, estimateCents: -5, env });
    expect(v.spentCents).toBe(0);
    expect(v.estimateCents).toBe(0);
    expect(v.allowed).toBe(true);
  });
});

describe('the accounting window', () => {
  it('is the calendar month in UTC, not a rolling 30 days', () => {
    expect(monthStartUtc(new Date('2026-08-21T23:59:59Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(monthStartUtc(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not drift across a year boundary', () => {
    expect(monthStartUtc(new Date('2026-12-31T12:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
