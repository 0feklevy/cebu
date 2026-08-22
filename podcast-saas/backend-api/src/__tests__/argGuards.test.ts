/**
 * scripts-ship-010 — a ceiling that cannot be read is not a ceiling.
 *
 * Both destructive backfills bounded themselves with
 * `Number(argValue('--max-affected') ?? '50')`. `argValue` returns the NEXT argv element whatever
 * it is, so `--max-affected --apply` produced NaN — and the gate is
 * `totalAffected > maxAffectedRows`, which is FALSE against NaN. The typo did not fail the run; it
 * DISARMED the guard, and an `--apply` pass of unbounded rewrites proceeded without
 * `--approve-unsafe`.
 *
 * The tests are the two questions that matter: does the ordinary case stay easy, and does every
 * unreadable case REFUSE rather than default?
 */
import { describe, it, expect } from 'vitest';
import { positiveIntArg, argValue, BadArgumentError } from '../scripts/argGuards.js';

describe('positiveIntArg — the ordinary cases stay ergonomic', () => {
  it('uses the default when the flag is absent', () => {
    expect(positiveIntArg(['--apply'], '--max-affected', 50)).toBe(50);
    expect(positiveIntArg([], '--max-affected', 200)).toBe(200);
  });

  it('reads a real value', () => {
    expect(positiveIntArg(['--max-affected', '120'], '--max-affected', 50)).toBe(120);
    expect(positiveIntArg(['--apply', '--max-affected', '7', '--json', 'x'], '--max-affected', 50)).toBe(7);
  });
});

describe('positiveIntArg — every unreadable case REFUSES', () => {
  it('THE REPORTED CASE: the next argument is another flag', () => {
    // This produced NaN, and NaN is what made the ceiling comparison false.
    expect(() => positiveIntArg(['--max-affected', '--apply'], '--max-affected', 50))
      .toThrow(/its value is missing/);
  });

  it('the flag is last on the command line', () => {
    expect(() => positiveIntArg(['--apply', '--max-affected'], '--max-affected', 50))
      .toThrow(/given with no value/);
  });

  it('the value is not a number', () => {
    expect(() => positiveIntArg(['--max-affected', 'foo'], '--max-affected', 50))
      .toThrow(BadArgumentError);
  });

  it('the value is the literal string NaN — what the release CLI can send', () => {
    // ops/release stringifies Number(flags.get('max-affected')), so a bad flag travels to the VM
    // as 'NaN' rather than as the original text.
    expect(() => positiveIntArg(['--max-affected', 'NaN'], '--max-affected', 50))
      .toThrow(BadArgumentError);
  });

  it('the value is zero or negative — a ceiling that permits nothing is a misconfiguration', () => {
    expect(() => positiveIntArg(['--max-affected', '0'], '--max-affected', 50)).toThrow();
    expect(() => positiveIntArg(['--max-affected', '-5'], '--max-affected', 50)).toThrow();
  });

  it('the value is fractional or infinite', () => {
    expect(() => positiveIntArg(['--max-affected', '1.5'], '--max-affected', 50)).toThrow();
    expect(() => positiveIntArg(['--max-affected', 'Infinity'], '--max-affected', 50)).toThrow();
  });

  it('names the flag and the offending value, so an operator can fix it', () => {
    expect(() => positiveIntArg(['--max-affected', 'foo'], '--max-affected', 50))
      .toThrow(/--max-affected.*"foo"/);
  });
});

describe('argValue', () => {
  it('still returns the raw next element — it is the primitive, not the guard', () => {
    expect(argValue(['--run-id', 'abc'], '--run-id')).toBe('abc');
    expect(argValue(['--run-id'], '--run-id')).toBeUndefined();
    expect(argValue([], '--run-id')).toBeUndefined();
  });
});
