import { describe, it, expect } from 'vitest';
import { formatFailureRate, formatMs, FAILURE_RATE_BAD_ABOVE } from '../lib/pipelineFormat';

/**
 * The distinction the whole observability-006 change rests on.
 *
 * The backend goes to some trouble to return `null` rather than `0` when no render has settled,
 * so that "no evidence" and "evidence of health" stay different values all the way to the screen.
 * A single `?? 0` anywhere in the display layer would collapse them again, silently, and the
 * dashboard would show a healthy green zero for a pipeline that has never finished anything.
 */
describe('no data and no failures are different facts', () => {
  it('null renders as an explicit no-data state, never as 0%', () => {
    const d = formatFailureRate(null);
    expect(d.text).not.toMatch(/0/);
    expect(d.tone).toBe('unknown');
    expect(d.hint, 'the no-data state must say WHY it is empty').toBeTruthy();
  });

  it('a genuine zero renders as 0% and reads as good', () => {
    const d = formatFailureRate(0);
    expect(d.text).toBe('0.0%');
    expect(d.tone).toBe('good');
    expect(d.hint).toBeNull();
  });

  it('the two never produce the same text', () => {
    expect(formatFailureRate(null).text).not.toBe(formatFailureRate(0).text);
  });
});

describe('a failure rate reads as a problem when it is one', () => {
  it.each([
    [0.001, 'neutral'],
    [FAILURE_RATE_BAD_ABOVE, 'neutral'],       // at the threshold, not over it
    [FAILURE_RATE_BAD_ABOVE + 0.001, 'bad'],
    [0.9, 'bad'],
  ])('%s → %s', (rate, tone) => {
    expect(formatFailureRate(rate as number).tone).toBe(tone);
  });

  it('keeps a decimal while the number is small, drops it once it is large', () => {
    // 0.4% and 0% are different facts. 23.7% and 24% are not, and the digit is only noise.
    expect(formatFailureRate(0.004).text).toBe('0.4%');
    expect(formatFailureRate(0.237).text).toBe('24%');
  });
});

describe('durations read at a glance', () => {
  it.each([
    [0, '—'],
    [-1, '—'],
    [NaN, '—'],
    [450, '450ms'],
    [1500, '1.5s'],
    [61_000, '1m 01s'],
    [1_200_000, '20m 00s'],
  ])('%s ms → %s', (ms, expected) => {
    expect(formatMs(ms as number)).toBe(expected);
  });

  it('never renders a 60-second remainder', () => {
    // 3m 60s is arithmetically reachable through rounding, is wrong, and looks like a bug to
    // exactly the person most likely to be reading this page during an incident.
    expect(formatMs(239_600)).toBe('4m 00s');
  });

  it('0 is "no completed renders", not a duration of zero', () => {
    // The API sends 0 when nothing finished. A render taking no time is not a fact the pipeline
    // can produce, so showing "0ms" would invent one.
    expect(formatMs(0)).toBe('—');
  });
});
