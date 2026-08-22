/**
 * The helper exists for its FAILURE message as much as for its type, so the failure message is
 * what is tested. A helper that silences a type error and then throws the same unreadable
 * "cannot read properties of undefined" would have bought nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { callArg, callArgs } from '../mockCalls.js';

describe('reading a captured argument', () => {
  it('returns the argument the mock was called with', () => {
    const fn = vi.fn();
    fn({ simulation_url: 'https://sim.invalid/index.html' });
    expect(callArg(fn).simulation_url).toBe('https://sim.invalid/index.html');
  });

  it('reaches a later call and a later argument', () => {
    const fn = vi.fn();
    fn('first', 1);
    fn('second', 2);
    expect(callArg<string>(fn, 1, 0)).toBe('second');
    expect(callArg<number>(fn, 1, 1)).toBe(2);
  });
});

describe('what it says when the argument is not there', () => {
  it('names the real problem when the mock was never called', () => {
    // This is the whole point. `calls[0][0]` throws "Cannot read properties of undefined
    // (reading '0')" from inside the assertion, which describes the harness rather than the
    // finding — and "the code under test never reached this call" is the finding, and the more
    // likely one when a passing test starts failing.
    const fn = vi.fn();
    expect(() => callArg(fn)).toThrow(/called at least 1 time\(s\), but it was called 0 time\(s\)/);
  });

  it('counts the calls it DID see, so an off-by-one is obvious', () => {
    const fn = vi.fn();
    fn('only one');
    expect(() => callArg(fn, 2)).toThrow(/at least 3 time\(s\), but it was called 1 time\(s\)/);
  });

  it('distinguishes "never called" from "called with fewer arguments"', () => {
    // Different causes: one is the code not reaching the call, the other is it reaching the call
    // and passing less than the test assumes. Reporting them identically sends the reader to the
    // wrong half of the code.
    const fn = vi.fn();
    fn('one arg');
    expect(() => callArg(fn, 0, 3)).toThrow(/received 1 argument\(s\); argument 3 was never passed/);
  });

  it('does not treat an explicitly passed undefined as a missing argument', () => {
    // `fn(undefined)` IS a call with one argument, and a test asserting the code passed undefined
    // is a legitimate test. Length is what decides, never the value.
    const fn = vi.fn();
    fn(undefined);
    expect(callArg<undefined>(fn, 0, 0)).toBeUndefined();
  });
});

describe('every call at once', () => {
  it('returns the first argument of each call, in order', () => {
    const fn = vi.fn();
    fn('a'); fn('b'); fn('c');
    expect(callArgs<string>(fn)).toEqual(['a', 'b', 'c']);
  });

  it('is empty for a mock that was never called', () => {
    expect(callArgs(vi.fn())).toEqual([]);
  });
});
