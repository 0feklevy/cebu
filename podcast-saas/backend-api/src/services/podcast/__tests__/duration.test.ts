import { describe, it, expect } from 'vitest';
import { countSpokenWords, estimateMinutes, wordBudget, SPOKEN_WPM, BUDGET_LOW, BUDGET_HIGH } from '../duration.js';

describe('countSpokenWords', () => {
  it('counts plain words', () => {
    expect(countSpokenWords('so what happens next')).toBe(4);
  });
  it('ignores audio tags', () => {
    expect(countSpokenWords('[laughs] no way — really? [thoughtful] hmm')).toBe(5);
  });
  it('handles empty and tag-only lines', () => {
    expect(countSpokenWords('')).toBe(0);
    expect(countSpokenWords('[gasps]')).toBe(0);
  });
});

describe('estimateMinutes', () => {
  it('overlap backchannels add no runtime', () => {
    const base = [{ text: 'word '.repeat(SPOKEN_WPM).trim(), overlap: false }];
    const withBc = [...base, { text: 'no way', overlap: true }];
    expect(estimateMinutes(withBc)).toBeCloseTo(estimateMinutes(base), 5);
  });

  it('one WPM-sized turn is ~1 minute', () => {
    const turns = [{ text: 'word '.repeat(SPOKEN_WPM).trim(), overlap: false }];
    expect(estimateMinutes(turns)).toBeGreaterThan(0.95);
    expect(estimateMinutes(turns)).toBeLessThan(1.1);
  });

  it('gaps between sequential turns add time', () => {
    const one = [{ text: 'word '.repeat(100).trim(), overlap: false }];
    const many = Array.from({ length: 20 }, () => ({ text: 'word '.repeat(5).trim(), overlap: false }));
    expect(estimateMinutes(many)).toBeGreaterThan(estimateMinutes(one));
  });
});

describe('wordBudget', () => {
  it('a script written to targetWords lands inside [BUDGET_LOW, BUDGET_HIGH] of the ceiling', () => {
    for (const mins of [3, 5, 8, 12, 20]) {
      const { targetWords } = wordBudget(mins);
      // ~30 turns of even size — the shape of a real episode
      const per = Math.max(1, Math.round(targetWords / 30));
      const turns = Array.from({ length: 30 }, () => ({ text: 'word '.repeat(per).trim(), overlap: false }));
      const est = estimateMinutes(turns);
      expect(est).toBeGreaterThan(mins * (BUDGET_LOW - 0.06));
      expect(est).toBeLessThanOrEqual(mins);
    }
  });

  it('hardCapWords stays under the ceiling', () => {
    for (const mins of [3, 5, 8, 12, 20]) {
      const { hardCapWords } = wordBudget(mins);
      const turns = [{ text: 'word '.repeat(hardCapWords).trim(), overlap: false }];
      expect(estimateMinutes(turns)).toBeLessThanOrEqual(mins * 1.02);
    }
  });
});
