/**
 * The rules that keep the spend page from lying while looking fine.
 *
 * The 22 August incident was not caused by missing data — it was caused by nobody being able to
 * see it. A page that shows a confident WRONG figure would be a worse outcome, because a number on
 * a dashboard gets believed in a way an empty screen never is. Every test here pins one way that
 * could happen.
 */
import { describe, it, expect } from 'vitest';
import { formatUsd, formatQuantity, humaniseUnit, spendCaveat, toDateInput } from '../lib/spendFormat';

describe('money', () => {
  it('keeps sub-cent amounts visible instead of rounding them to free', () => {
    // One short preview costs a fraction of a cent. Rendering it as "$0.00" tells the reader the
    // work was free, which is the single most misleading thing this page could say.
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(0.0004)).not.toBe('$0.00');
  });

  it('renders ordinary amounts in cents', () => {
    expect(formatUsd(16.394)).toBe('$16.39');
    expect(formatUsd(1)).toBe('$1.00');
  });

  it('renders a true zero as zero — that is not the same as sub-cent', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('shows a dash for a non-number rather than "$NaN"', () => {
    // "$NaN" reads as broken software; a dash reads as missing data, which is what it is.
    expect(formatUsd(NaN)).toBe('—');
    expect(formatUsd(Infinity)).toBe('—');
  });
});

describe('quantities, which must never appear without their unit', () => {
  it('always writes the unit alongside the number', () => {
    // "1,400" beside "3" invites a reader to add them. "1,400 characters" beside "3 images" does
    // not. Formatting them apart would reintroduce the exact mistake the API shape prevents.
    expect(formatQuantity(1400, 'characters')).toBe('1,400 characters');
    expect(formatQuantity(3, 'images')).toBe('3 images');
  });

  it('spells an underscored unit as words', () => {
    expect(formatQuantity(12, 'source_minutes')).toBe('12 source minutes');
  });

  it('keeps a small quantity precise', () => {
    expect(formatQuantity(4.5, 'seconds')).toBe('4.5 seconds');
  });

  it('shows a dash for a non-number but still names the unit', () => {
    expect(formatQuantity(NaN, 'images')).toBe('— images');
  });
});

describe('humanising, without disagreeing with the invoice', () => {
  it('reads long audio in minutes', () => {
    expect(humaniseUnit(600, 'seconds')).toBe('10.0 minutes of audio');
  });

  it('leaves short audio in seconds', () => {
    expect(humaniseUnit(45, 'seconds')).toBe('45 seconds');
  });

  it('abbreviates very large character counts', () => {
    expect(humaniseUnit(360_000, 'characters')).toBe('360k characters');
  });

  it('leaves units that are ALREADY in their natural scale alone', () => {
    // `source_minutes` is what the dubbing invoice itemises. Converting it to hours here would put
    // the page into a different unit from the bill it exists to be compared against.
    expect(humaniseUnit(180, 'source_minutes')).toBe('180 source minutes');
    expect(humaniseUnit(240, 'session_minutes')).toBe('240 session minutes');
  });
});

describe('the caveat, which says out loud what a total hides', () => {
  it('warns when the window was truncated', () => {
    // A partial sum wearing a total's clothes.
    const c = spendCaveat({ rows: 20_000, zeroCostRows: 0, truncated: true, totalUsd: 500 });
    expect(c).toMatch(/partial/i);
  });

  it('warns when EVERY row is priced at zero, and says WHY that is suspicious', () => {
    // What an unset or malformed rate looks like — and it renders identically to a quiet period.
    //
    // Asserted on the distinctive wording, not on "priced at zero": the mostly-zero branch below
    // also contains that phrase and also fires on an all-zero window, so a looser assertion passed
    // with this branch deleted entirely. The all-zero case earns its own message because it can
    // name the likely CAUSE, which the generic one cannot.
    const c = spendCaveat({ rows: 1_204, zeroCostRows: 1_204, truncated: false, totalUsd: 0 });
    expect(c).toMatch(/unset or malformed rate/i);
    expect(c).toMatch(/1,204/);
  });

  it('warns when MOST rows are zero but some are not', () => {
    // The shape of one provider's rate being wrong, rather than the account being idle.
    const c = spendCaveat({ rows: 1_000, zeroCostRows: 900, truncated: false, totalUsd: 3 });
    expect(c).toMatch(/900 of 1,000/);
  });

  it('says nothing when the numbers are ordinary', () => {
    // A caveat on every page is a caveat nobody reads.
    expect(spendCaveat({ rows: 500, zeroCostRows: 3, truncated: false, totalUsd: 42 })).toBeNull();
  });

  it('says nothing for an empty window rather than crying "all zero"', () => {
    // No rows is not a broken rate. Warning here would train the reader to dismiss the warning.
    expect(spendCaveat({ rows: 0, zeroCostRows: 0, truncated: false, totalUsd: 0 })).toBeNull();
  });

  it('prefers the truncation warning over the zero one', () => {
    // Truncation makes every other figure unreliable, so it is the thing to say first.
    const c = spendCaveat({ rows: 20_000, zeroCostRows: 20_000, truncated: true, totalUsd: 0 });
    expect(c).toMatch(/partial/i);
  });
});

describe('date inputs', () => {
  it('uses the UTC day, matching the API and the invoice', () => {
    expect(toDateInput('2026-08-22T23:59:00.000Z')).toBe('2026-08-22');
  });

  it('returns empty for an unparseable value instead of "NaN-NaN-NaN"', () => {
    expect(toDateInput('nonsense')).toBe('');
  });
});
