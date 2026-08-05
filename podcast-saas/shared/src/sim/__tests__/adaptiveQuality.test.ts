/**
 * Adaptive quality with hysteresis (Priority 8.8).
 *
 * The property that matters is that changing quality is EXPENSIVE — it re-mints an identity and
 * discards the poster keyed on the old configHash — so the controller must be much more reluctant
 * to act than a naive threshold would be, and asymmetrically so: quick to protect a struggling
 * device, slow to re-expand a recovering one.
 */

import { describe, it, expect } from 'vitest';
import {
  QUALITY_LADDER, INITIAL_QUALITY_STATE, MIN_SAMPLES, DOWN_STREAK, UP_STREAK,
  decideQuality, type QualityState, type QualitySignals,
} from '../adaptiveQuality.js';

const sig = (over: Partial<QualitySignals> = {}): QualitySignals =>
  ({ p90TotalMs: 500, samples: 20, budgetMs: 1000, ...over });

/** Feed the same signal n times, threading state. */
function run(state: QualityState, s: QualitySignals, n: number): QualityState {
  let st = state;
  for (let i = 0; i < n; i += 1) st = decideQuality(st, s).state;
  return st;
}

describe('the ladder', () => {
  it('is ordered worst to best', () => {
    expect([...QUALITY_LADDER]).toEqual(['low', 'balanced', 'high']);
  });
  it('starts at high', () => {
    expect(INITIAL_QUALITY_STATE.current).toBe('high');
  });
});

describe('no adaptation without evidence', () => {
  it('does nothing below the sample floor', () => {
    const d = decideQuality(INITIAL_QUALITY_STATE, sig({ samples: MIN_SAMPLES - 1, p90TotalMs: 99999 }));
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('insufficient-samples');
  });

  it('RESETS the streak when evidence stops arriving', () => {
    // Evidence that stopped is not evidence that continued.
    let st = run(INITIAL_QUALITY_STATE, sig({ p90TotalMs: 5000 }), DOWN_STREAK - 1);
    expect(st.streak).toBeGreaterThan(0);
    st = decideQuality(st, sig({ samples: 0, p90TotalMs: null })).state;
    expect(st.streak).toBe(0);
    expect(st.direction).toBe('none');
  });

  it('does nothing with a null or non-finite p90', () => {
    expect(decideQuality(INITIAL_QUALITY_STATE, sig({ p90TotalMs: null })).changed).toBe(false);
    expect(decideQuality(INITIAL_QUALITY_STATE, sig({ p90TotalMs: NaN })).changed).toBe(false);
  });

  it('does nothing with a nonsensical budget, however many samples arrive', () => {
    // A single call cannot change quality regardless — the streak forbids it — so asserting one
    // call proves nothing. A budget of 0 makes every measurement "over budget", and without the
    // guard the controller would walk the ladder to the floor on a value that means "unknown".
    for (const b of [0, -1, NaN, Infinity]) {
      const st = run(INITIAL_QUALITY_STATE, sig({ budgetMs: b }), 20);
      expect(st.current, `budget ${b} moved the ladder`).toBe('high');
    }
  });
});

describe('dropping quality — quick, because a viewer is being failed now', () => {
  const slow = sig({ p90TotalMs: 3000, budgetMs: 1000 });

  it('does not drop on a single over-budget sample', () => {
    expect(decideQuality(INITIAL_QUALITY_STATE, slow).changed).toBe(false);
  });

  it('drops after the down streak', () => {
    const st = run(INITIAL_QUALITY_STATE, slow, DOWN_STREAK - 1);
    const d = decideQuality(st, slow);
    expect(d.changed).toBe(true);
    expect(d.next).toBe('balanced');
    expect(d.reason).toBe('over-budget');
  });

  it('RESETS the streak after acting, so the next drop needs fresh evidence', () => {
    // Otherwise one bad stretch walks the ladder all the way down on accumulated momentum.
    const st = run(INITIAL_QUALITY_STATE, slow, DOWN_STREAK);
    expect(st.current).toBe('balanced');
    expect(st.streak).toBe(0);
    expect(decideQuality(st, slow).changed).toBe(false);
  });

  it('walks all the way down and then stops at the floor', () => {
    let st = INITIAL_QUALITY_STATE;
    for (let i = 0; i < 40; i += 1) st = decideQuality(st, slow).state;
    expect(st.current).toBe('low');
    expect(decideQuality(st, slow).reason).toBe('at-limit');
    expect(decideQuality(st, slow).changed).toBe(false);
  });
});

describe('raising quality — slow, because raising costs a poster', () => {
  const fast = sig({ p90TotalMs: 100, budgetMs: 1000 });
  const low: QualityState = { current: 'low', streak: 0, direction: 'none' };

  it('needs a LONGER streak than dropping does', () => {
    expect(UP_STREAK).toBeGreaterThan(DOWN_STREAK);
  });

  it('does not rise before the up streak', () => {
    const st = run(low, fast, UP_STREAK - 1);
    expect(st.current).toBe('low');
  });

  it('rises after the up streak', () => {
    const st = run(low, fast, UP_STREAK - 1);
    const d = decideQuality(st, fast);
    expect(d.changed).toBe(true);
    expect(d.next).toBe('balanced');
    expect(d.reason).toBe('comfortable');
  });

  it('stops at the ceiling', () => {
    let st = INITIAL_QUALITY_STATE;
    for (let i = 0; i < 40; i += 1) st = decideQuality(st, fast).state;
    expect(st.current).toBe('high');
    expect(decideQuality(st, fast).reason).toBe('at-limit');
  });
});

describe('the dead band prevents oscillation', () => {
  it('does nothing between the two thresholds', () => {
    // 0.5x < p90 < 1.0x of budget: neither struggling nor comfortable.
    const d = decideQuality(INITIAL_QUALITY_STATE, sig({ p90TotalMs: 700, budgetMs: 1000 }));
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('dead-band');
  });

  it('CLEARS the streak in the dead band', () => {
    // A run of borderline samples must not accumulate into a change no single sample justified.
    let st = run(INITIAL_QUALITY_STATE, sig({ p90TotalMs: 3000 }), DOWN_STREAK - 1);
    st = decideQuality(st, sig({ p90TotalMs: 700 })).state;
    expect(st.streak).toBe(0);
    // ...so the next over-budget sample starts a fresh streak rather than completing the old one.
    expect(decideQuality(st, sig({ p90TotalMs: 3000 })).changed).toBe(false);
  });

  it('does not oscillate when signals alternate around the band', () => {
    let st = INITIAL_QUALITY_STATE;
    for (let i = 0; i < 30; i += 1) {
      st = decideQuality(st, sig({ p90TotalMs: i % 2 === 0 ? 3000 : 100 })).state;
    }
    // Alternating evidence never sustains either streak, so quality never moved.
    expect(st.current).toBe('high');
  });

  it('changes direction resets the streak rather than continuing it', () => {
    // Started from 'balanced': at 'high' a comfortable signal is at-limit and never builds an
    // upward streak at all, which is correct — there is nowhere above to go.
    const mid: QualityState = { current: 'balanced', streak: 0, direction: 'none' };
    let st = run(mid, sig({ p90TotalMs: 100 }), 3);
    expect(st.direction).toBe('up');
    st = decideQuality(st, sig({ p90TotalMs: 3000 })).state;
    expect(st.direction).toBe('down');
    expect(st.streak).toBe(1);
  });
});
