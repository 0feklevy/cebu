/**
 * The preparation budget (Priority 8.7).
 *
 * The claim under test throughout is that a lead time is never a compiled-in constant pretending to
 * be evidence: it comes from this session's measurements, or failing that from the package's own
 * publish-time canary, and the caller can always tell which.
 */

import { describe, it, expect } from 'vitest';
import {
  BUDGET_STEPS, MIN_BUDGET_MS, MAX_BUDGET_MS,
  canaryPrepareMs, canaryReportPrepareMs, resolveBudget, isDueForPrepare,
} from '../prepareBudget.js';

const step = (s: string, ms: number | null, status = 'pass') => ({ step: s, ms, status });

describe('canaryPrepareMs', () => {
  it('SUMS the sequential preparation steps', () => {
    // They happen one after another, so the cost of reaching a usable section is their total.
    // Taking the maximum would describe the slowest hop and under-budget every package with
    // several moderate steps.
    const ms = canaryPrepareMs([
      step('prepare', 200), step('section-applied', 30),
      step('present', 100), step('section-presented', 50),
    ]);
    expect(ms).toBe(380);
  });

  it('ignores steps outside the measured span', () => {
    // `load` and `handshake` are excluded on purpose: the field measurement starts inside
    // activateModern, after the document exists and has handshaked, so including them here would
    // make the lab number and the field number describe different spans.
    expect(canaryPrepareMs([
      step('prepare', 100), step('load', 5000), step('handshake', 3000),
      step('poster-captured', 9000), step('ab-cycles', 7000),
    ])).toBe(100);
  });

  it('ignores a FAILED step — its duration is how long the failure took', () => {
    // Including it would budget for a path this package does not have.
    expect(canaryPrepareMs([step('prepare', 100), step('present', 5000, 'fail')])).toBe(100);
  });

  it('ignores a missing, negative or non-finite duration', () => {
    expect(canaryPrepareMs([step('prepare', 100), step('present', null)])).toBe(100);
    expect(canaryPrepareMs([step('prepare', 100), step('present', -5)])).toBe(100);
    expect(canaryPrepareMs([step('prepare', 100), step('present', NaN)])).toBe(100);
  });

  it('returns null when there is nothing usable, so "no data" differs from "fast"', () => {
    expect(canaryPrepareMs([])).toBeNull();
    expect(canaryPrepareMs(null)).toBeNull();
    expect(canaryPrepareMs(undefined)).toBeNull();
    expect(canaryPrepareMs([step('poster-captured', 10)])).toBeNull();
    expect(canaryPrepareMs('nonsense' as never)).toBeNull();
  });

  it('accepts a step with no explicit status', () => {
    expect(canaryPrepareMs([{ step: 'prepare', ms: 100 }])).toBe(100);
  });

  it('spans exactly what the field measurement spans', () => {
    // The client's `requested` mark is inside activateModern, so a measured totalMs covers
    // prepare -> reveal. Two numbers used interchangeably must measure the same thing.
    expect([...BUDGET_STEPS]).toEqual(['prepare', 'section-applied', 'present', 'section-presented']);
    expect(BUDGET_STEPS).not.toContain('load');
    expect(BUDGET_STEPS).not.toContain('handshake');
  });
});

describe('resolveBudget', () => {
  it('prefers this session measurements and says so', () => {
    const b = resolveBudget({ measuredP90Ms: 400, canaryMs: 100 });
    expect(b.source).toBe('measured');
    expect(b.ms).toBe(500);
  });

  it('falls back to the package own canary, with NO safety factor', () => {
    // The floor already covers the CI-hardware gap; multiplying a lab measurement by a guess would
    // produce a constant pretending to be data.
    const b = resolveBudget({ measuredP90Ms: null, canaryMs: 600 });
    expect(b.source).toBe('canary');
    expect(b.ms).toBe(600);
  });

  it('falls back to the floor and SAYS it is a floor', () => {
    // A closed-loop controller that cannot tell a measured budget from a default would eventually
    // treat its own fallback as evidence and adapt to it.
    const b = resolveBudget({ measuredP90Ms: null, canaryMs: null });
    expect(b.source).toBe('floor');
    expect(b.ms).toBe(MIN_BUDGET_MS);
  });

  it('never returns less than the floor — a CI machine is not a phone', () => {
    expect(resolveBudget({ measuredP90Ms: null, canaryMs: 5 }).ms).toBe(MIN_BUDGET_MS);
    expect(resolveBudget({ measuredP90Ms: 1, canaryMs: null }).ms).toBe(MIN_BUDGET_MS);
  });

  it('caps the budget — past the ceiling a poster is the better answer', () => {
    expect(resolveBudget({ measuredP90Ms: 10 ** 6, canaryMs: null }).ms).toBe(MAX_BUDGET_MS);
    expect(resolveBudget({ measuredP90Ms: null, canaryMs: 10 ** 6 }).ms).toBe(MAX_BUDGET_MS);
  });

  it('ignores a nonsensical measurement rather than adopting it', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(resolveBudget({ measuredP90Ms: bad, canaryMs: 600 }).source).toBe('canary');
    }
  });

  it('ignores a nonsensical canary value', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(resolveBudget({ measuredP90Ms: null, canaryMs: bad }).source).toBe('floor');
    }
  });
});

describe('isDueForPrepare', () => {
  it('is due exactly within the lead window', () => {
    expect(isDueForPrepare({ nowSec: 9.5, sectionStartSec: 10, budgetMs: 1000 })).toBe(true);
    expect(isDueForPrepare({ nowSec: 9.0, sectionStartSec: 10, budgetMs: 1000 })).toBe(true);
  });

  it('is not due before the window opens', () => {
    expect(isDueForPrepare({ nowSec: 5, sectionStartSec: 10, budgetMs: 1000 })).toBe(false);
  });

  it('is NOT due for a section already started', () => {
    // That section is late, not upcoming: the caller must activate it now, not schedule work.
    expect(isDueForPrepare({ nowSec: 10, sectionStartSec: 10, budgetMs: 1000 })).toBe(false);
    expect(isDueForPrepare({ nowSec: 11, sectionStartSec: 10, budgetMs: 1000 })).toBe(false);
  });

  it('never prepares anything with a zero or negative budget', () => {
    expect(isDueForPrepare({ nowSec: 9.99, sectionStartSec: 10, budgetMs: 0 })).toBe(false);
    expect(isDueForPrepare({ nowSec: 9.99, sectionStartSec: 10, budgetMs: -1000 })).toBe(false);
  });

  it('refuses a non-finite clock rather than scheduling on it', () => {
    expect(isDueForPrepare({ nowSec: NaN, sectionStartSec: 10, budgetMs: 1000 })).toBe(false);
    expect(isDueForPrepare({ nowSec: 9, sectionStartSec: Infinity, budgetMs: 1000 })).toBe(false);
  });

  it('scales with the budget', () => {
    expect(isDueForPrepare({ nowSec: 5, sectionStartSec: 10, budgetMs: 6000 })).toBe(true);
    expect(isDueForPrepare({ nowSec: 5, sectionStartSec: 10, budgetMs: 4000 })).toBe(false);
  });
});

// ── The REAL report shape ────────────────────────────────────────────────────────────────────────

describe('canaryReportPrepareMs — steps live per CASE', () => {
  const caseWith = (ms: number[]) => ({
    steps: [
      { step: 'prepare', ms: ms[0], status: 'pass' },
      { step: 'section-applied', ms: ms[1], status: 'pass' },
      { step: 'present', ms: ms[2], status: 'pass' },
      { step: 'section-presented', ms: ms[3], status: 'pass' },
    ],
  });

  it('reads cases[].steps, which is where the report actually puts them', () => {
    // The original implementation read report.steps — a field CanaryReport does not have — so the
    // budget was empty for every real report while looking implemented.
    expect(canaryReportPrepareMs({ cases: [caseWith([200, 30, 100, 50])] })).toBe(380);
  });

  it('takes the WORST case, not the average', () => {
    // Each case is the same package in a different variant; a lead time covering only the average
    // variant is too short for the others exactly when it matters.
    expect(canaryReportPrepareMs({
      cases: [caseWith([10, 10, 10, 10]), caseWith([100, 100, 100, 100])],
    })).toBe(400);
  });

  it('returns null for a report with no usable cases', () => {
    expect(canaryReportPrepareMs({ cases: [] })).toBeNull();
    expect(canaryReportPrepareMs({})).toBeNull();
    expect(canaryReportPrepareMs(null)).toBeNull();
    expect(canaryReportPrepareMs({ cases: [{ steps: [] }] })).toBeNull();
  });

  it('ignores a case with no usable steps rather than counting it as zero', () => {
    expect(canaryReportPrepareMs({
      cases: [{ steps: [] }, caseWith([100, 0, 0, 0])],
    })).toBe(100);
  });

  it('does NOT read a top-level steps field, which no report has', () => {
    // Guards the exact regression: a shape that looks plausible must not silently work.
    expect(canaryReportPrepareMs({
      steps: [{ step: 'prepare', ms: 999, status: 'pass' }],
    } as never)).toBeNull();
  });
});
