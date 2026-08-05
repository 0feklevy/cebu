/**
 * Closed-loop adaptation (Priority 8.10).
 *
 * The input is derived from an UNAUTHENTICATED endpoint, so every test here asks the same question:
 * can someone who controls the measurements change production behaviour in a way they should not?
 * The answer must be that the worst they achieve is nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  decideBudget, MIN_FIELD_SAMPLES, IMPLAUSIBLE_MS, MAX_LAB_DEVIATION, MAX_DROP_RATIO,
} from '../closedLoop.js';
import { MIN_BUDGET_MS, MAX_BUDGET_MS } from '../prepareBudget.js';

const LAB = 800;
const field = (over: Partial<{ samples: number; p50TotalMs: number | null; p90TotalMs: number | null; dropped: number }> = {}) =>
  ({ samples: 100, p50TotalMs: 600, p90TotalMs: 900, dropped: 0, ...over });

describe('the field aggregate is accepted only when it is credible', () => {
  it('adopts a plausible aggregate', () => {
    const d = decideBudget({ canaryMs: LAB, field: field() });
    expect(d.source).toBe('measured');
    expect(d.rejected).toBeUndefined();
  });

  it('keeps the LAB value below the sample floor', () => {
    const d = decideBudget({ canaryMs: LAB, field: field({ samples: MIN_FIELD_SAMPLES - 1 }) });
    expect(d.rejected).toBe('insufficient-samples');
    expect(d.source).toBe('canary');
    expect(d.ms).toBe(LAB);
  });

  it('refuses an implausible magnitude rather than adopting a plausible-looking lie', () => {
    // There is no honest reading of a four-hour transition.
    const d = decideBudget({ canaryMs: LAB, field: field({ p90TotalMs: IMPLAUSIBLE_MS + 1 }) });
    expect(d.rejected).toBe('implausible');
    expect(d.ms).toBe(LAB);
  });

  it('refuses an aggregate whose p90 is below its p50 — arithmetically impossible', () => {
    // Identifies a fabricated aggregate more reliably than any magnitude check.
    const d = decideBudget({ canaryMs: LAB, field: field({ p50TotalMs: 900, p90TotalMs: 500 }) });
    expect(d.rejected).toBe('inverted');
    expect(d.ms).toBe(LAB);
  });

  it('refuses a heavily TRUNCATED feed', () => {
    // A sample whose drops outnumber its events describes what survived the ring, not the session.
    const d = decideBudget({ canaryMs: LAB, field: field({ samples: 100, dropped: 100 * MAX_DROP_RATIO + 1 }) });
    expect(d.rejected).toBe('truncated');
    expect(d.ms).toBe(LAB);
  });

  it('accepts a lightly truncated feed', () => {
    expect(decideBudget({ canaryMs: LAB, field: field({ samples: 100, dropped: 5 }) }).rejected)
      .toBeUndefined();
  });

  it('refuses a missing or nonsensical p90', () => {
    for (const bad of [null, 0, -1, NaN, Infinity]) {
      const d = decideBudget({ canaryMs: LAB, field: field({ p90TotalMs: bad as number }) });
      expect(d.source, `p90 ${String(bad)} was adopted`).toBe('canary');
    }
  });

  it('refuses a nonsensical sample count', () => {
    for (const bad of [NaN, Infinity, -5]) {
      expect(decideBudget({ canaryMs: LAB, field: field({ samples: bad }) }).rejected)
        .toBe('insufficient-samples');
    }
  });

  it('falls back to the FLOOR when there is no lab number either', () => {
    const d = decideBudget({ canaryMs: null, field: null });
    expect(d.source).toBe('floor');
    expect(d.ms).toBe(MIN_BUDGET_MS);
  });
});

describe('a hostile feed cannot move the budget far, or fast', () => {
  it('clamps a wildly high aggregate toward the lab number', () => {
    const d = decideBudget({ canaryMs: LAB, field: field({ p50TotalMs: 100, p90TotalMs: 90_000 }) });
    expect(d.clamped).toBe(true);
    // At most MAX_LAB_DEVIATION x the lab value, before the safety factor and the ceiling.
    expect(d.ms).toBeLessThanOrEqual(Math.round(LAB * MAX_LAB_DEVIATION * 1.25));
  });

  it('clamps a wildly low aggregate too — starving preparation is also an attack', () => {
    const d = decideBudget({ canaryMs: LAB, field: field({ p50TotalMs: 1, p90TotalMs: 2 }) });
    expect(d.clamped).toBe(true);
    expect(d.ms).toBeGreaterThanOrEqual(MIN_BUDGET_MS);
  });

  it('never exceeds the absolute ceiling, whatever is fed in', () => {
    const d = decideBudget({
      canaryMs: MAX_BUDGET_MS, field: field({ p50TotalMs: 1000, p90TotalMs: IMPLAUSIBLE_MS - 1 }),
    });
    expect(d.ms).toBeLessThanOrEqual(MAX_BUDGET_MS);
  });

  it('never returns a budget below the floor', () => {
    const d = decideBudget({ canaryMs: 1, field: field({ p50TotalMs: 1, p90TotalMs: 1 }) });
    expect(d.ms).toBeGreaterThanOrEqual(MIN_BUDGET_MS);
  });

  it('ALWAYS returns a usable budget — no input yields "no budget"', () => {
    const hostile = [
      null,
      field({ samples: 0 }),
      field({ p90TotalMs: NaN }),
      field({ p90TotalMs: 10 ** 12 }),
      field({ dropped: 10 ** 9 }),
      field({ p50TotalMs: 10 ** 9, p90TotalMs: 1 }),
    ];
    for (const f of hostile) {
      const d = decideBudget({ canaryMs: LAB, field: f as never });
      expect(Number.isFinite(d.ms)).toBe(true);
      expect(d.ms).toBeGreaterThanOrEqual(MIN_BUDGET_MS);
      expect(d.ms).toBeLessThanOrEqual(MAX_BUDGET_MS);
    }
  });

  it('a refused aggregate leaves EXACTLY the value the lab alone would have produced', () => {
    // The strongest statement of the boundary: a hostile feed achieves nothing at all.
    const withoutField = decideBudget({ canaryMs: LAB, field: null });
    for (const f of [field({ samples: 1 }), field({ p90TotalMs: IMPLAUSIBLE_MS + 1 }),
      field({ dropped: 99 }), field({ p50TotalMs: 5000, p90TotalMs: 10 })]) {
      const d = decideBudget({ canaryMs: LAB, field: f });
      expect(d.ms, 'a refused aggregate still moved the budget').toBe(withoutField.ms);
    }
  });
});
