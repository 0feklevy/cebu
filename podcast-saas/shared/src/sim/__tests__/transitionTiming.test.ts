/**
 * Transition timing (Priority 8.1 / 8.9).
 *
 * The properties under test are mostly about HONESTY of measurement rather than arithmetic: a
 * missing stage must not read as a fast one, an out-of-order mark must not launder into 0 ms, and a
 * lead time must be able to say whether it was measured or guessed. Each of those is a way a
 * measurement layer can look healthy while reporting fiction.
 */

import { describe, it, expect } from 'vitest';
import {
  TRANSITION_STAGES, computeDurations, isComplete, furthestStage, percentile, summarize,
  deriveLeadMs, type TransitionMarks,
} from '../transitionTiming.js';

const full = (over: Partial<Record<string, number>> = {}): TransitionMarks => ({
  marks: {
    requested: 0, 'prepare-sent': 10, applied: 60, 'present-sent': 65, presented: 100, revealed: 120,
    ...over,
  } as TransitionMarks['marks'],
  applyMs: 42,
  framesSubmitted: 1,
});

describe('computeDurations', () => {
  it('computes every stage and the total a viewer actually waits through', () => {
    const d = computeDurations(full());
    expect(d.dispatchMs).toBe(10);
    expect(d.prepareMs).toBe(50);
    expect(d.turnaroundMs).toBe(5);
    expect(d.presentMs).toBe(35);
    expect(d.revealMs).toBe(20);
    expect(d.totalMs).toBe(120);
  });

  it('reports a missing stage as null, never as zero', () => {
    // Zero is a real, achievable measurement. Using it as the absent value would make "never
    // observed" indistinguishable from "instantaneous" — and the second is what a broken
    // measurement looks like.
    const d = computeDurations({ marks: { requested: 0, revealed: 50 } });
    expect(d.prepareMs).toBeNull();
    expect(d.presentMs).toBeNull();
    expect(d.totalMs).toBe(50);
  });

  it('has no total for a transition that never revealed', () => {
    expect(computeDurations({ marks: { requested: 0, applied: 10 } }).totalMs).toBeNull();
  });

  it('drops an out-of-order mark rather than clamping it to zero', () => {
    // Clamping would launder a real ordering bug into a plausible 0 ms that no percentile flags.
    const d = computeDurations({ marks: { requested: 100, revealed: 50 } });
    expect(d.totalMs).toBeNull();
  });

  it('rejects non-finite marks', () => {
    expect(computeDurations({ marks: { requested: 0, revealed: Infinity } }).totalMs).toBeNull();
    expect(computeDurations({ marks: { requested: NaN, revealed: 10 } }).totalMs).toBeNull();
  });

  it('keeps the child applyMs separate from our prepareMs', () => {
    // prepareMs includes two postMessage hops applyMs does not. Averaging them would hide whether a
    // slow prepare is the package's fault or the transport's.
    const d = computeDurations(full());
    expect(d.applyMs).toBe(42);
    expect(d.prepareMs).toBe(50);
  });

  it('rejects a negative or non-finite applyMs from the child', () => {
    expect(computeDurations({ marks: {}, applyMs: -1 }).applyMs).toBeNull();
    expect(computeDurations({ marks: {}, applyMs: NaN }).applyMs).toBeNull();
    expect(computeDurations({ marks: {} }).applyMs).toBeNull();
  });

  it('accepts a genuine zero from the child', () => {
    expect(computeDurations({ marks: {}, applyMs: 0 }).applyMs).toBe(0);
  });
});

describe('completion and furthest stage', () => {
  it('knows a complete transition from an abandoned one', () => {
    expect(isComplete(full())).toBe(true);
    expect(isComplete({ marks: { requested: 0, applied: 5 } })).toBe(false);
  });

  it('reports where an abandoned transition died', () => {
    // A package that always dies at `applied` is failing differently from one dying at
    // `prepare-sent`; a summary counting only completions would report both as simply absent.
    expect(furthestStage({ marks: { requested: 0, 'prepare-sent': 1 } })).toBe('prepare-sent');
    expect(furthestStage({ marks: { requested: 0, applied: 9 } })).toBe('applied');
    expect(furthestStage({ marks: {} })).toBeNull();
  });

  it('reports the furthest stage by protocol order, not by insertion order', () => {
    const t: TransitionMarks = { marks: { applied: 9, requested: 0 } };
    expect(furthestStage(t)).toBe('applied');
  });

  it('declares the stages in protocol order', () => {
    expect([...TRANSITION_STAGES]).toEqual(
      ['requested', 'prepare-sent', 'applied', 'present-sent', 'presented', 'revealed']);
  });
});

describe('percentile — nearest rank', () => {
  it('returns a value that actually occurred', () => {
    // An interpolated p90 is a number no transition ever took — a poor basis for a budget someone
    // will later be paged about.
    const xs = [10, 20, 30, 40, 100];
    expect(xs).toContain(percentile(xs, 0.9));
    expect(percentile(xs, 0.5)).toBe(30);
    expect(percentile(xs, 0.9)).toBe(100);
  });

  it('handles the edges', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe('summarize', () => {
  it('counts completions and where the rest died', () => {
    const s = summarize([
      full(), full({ revealed: 200 }),
      { marks: { requested: 0, 'prepare-sent': 1 } },
      { marks: { requested: 0, applied: 5 } },
    ]);
    expect(s.samples).toBe(4);
    expect(s.completed).toBe(2);
    expect(s.abandonedAt['prepare-sent']).toBe(1);
    expect(s.abandonedAt.applied).toBe(1);
  });

  it('ignores incomplete transitions in the totals but not in the sample count', () => {
    const s = summarize([full(), { marks: { requested: 0 } }]);
    expect(s.samples).toBe(2);
    expect(s.p50TotalMs).toBe(120);
  });

  it('summarizes an empty set without inventing numbers', () => {
    const s = summarize([]);
    expect(s.p50TotalMs).toBeNull();
    expect(s.p90TotalMs).toBeNull();
    expect(s.maxTotalMs).toBeNull();
    expect(s.completed).toBe(0);
  });

  it('reports the true maximum, not the p90', () => {
    const s = summarize([...Array(20)].map((_, i) => full({ revealed: (i + 1) * 10 })));
    expect(s.maxTotalMs).toBe(200);
    expect(s.p90TotalMs).toBeLessThan(200);
  });
});

describe('deriveLeadMs', () => {
  const measured = summarize([...Array(10)].map((_, i) => full({ revealed: 100 + i * 10 })));

  it('uses the measured p90 with a safety factor once there are enough samples', () => {
    const r = deriveLeadMs({ summary: measured, fallbackMs: 999 });
    expect(r.source).toBe('measured');
    expect(r.leadMs).toBe(Math.round(measured.p90TotalMs! * 1.25));
  });

  it('falls back below the sample floor and SAYS it fell back', () => {
    // A caller must be able to tell a measured budget from a guessed one; a lead time that cannot
    // say which it is invites treating a constant as evidence.
    const r = deriveLeadMs({ summary: summarize([full()]), fallbackMs: 800 });
    expect(r.source).toBe('fallback');
    expect(r.leadMs).toBe(800);
  });

  it('falls back when nothing completed, however many samples there were', () => {
    const none = summarize([...Array(50)].map(() => ({ marks: { requested: 0, applied: 1 } })));
    expect(deriveLeadMs({ summary: none, fallbackMs: 700 }).source).toBe('fallback');
  });

  it('uses the p90 rather than the median — a lead right half the time is not a lead', () => {
    const skewed = summarize([
      ...[...Array(9)].map(() => full({ revealed: 50 })),
      full({ revealed: 1000 }),
    ]);
    const r = deriveLeadMs({ summary: skewed, fallbackMs: 0 });
    expect(r.leadMs).toBeGreaterThan(skewed.p50TotalMs!);
  });

  it('caps the lead so one pathological sample cannot pin it open', () => {
    const awful = summarize([...Array(10)].map(() => full({ revealed: 10 ** 7 })));
    expect(deriveLeadMs({ summary: awful, fallbackMs: 0, maxMs: 10_000 }).leadMs).toBe(10_000);
  });

  it('never returns a negative lead', () => {
    expect(deriveLeadMs({ summary: summarize([]), fallbackMs: -5 }).leadMs).toBe(0);
  });
});
