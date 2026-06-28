import { describe, it, expect } from 'vitest';
import { shouldSkipCaption } from '../CaptionService.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe('shouldSkipCaption — cluster-aware claim/skip', () => {
  it('never skips when forced', () => {
    expect(shouldSkipCaption({ status: 'ready', hashMatches: true, updatedAtMs: NOW, force: true, now: NOW })).toBe(false);
  });

  it('does not skip when the source hash changed (regenerate)', () => {
    expect(shouldSkipCaption({ status: 'ready', hashMatches: false, updatedAtMs: NOW, now: NOW })).toBe(false);
  });

  it('skips when already ready for the same source', () => {
    expect(shouldSkipCaption({ status: 'ready', hashMatches: true, updatedAtMs: NOW, now: NOW })).toBe(true);
  });

  it('skips a FRESH processing claim (another worker is on it)', () => {
    expect(shouldSkipCaption({ status: 'processing', hashMatches: true, updatedAtMs: NOW - 1 * MIN, now: NOW })).toBe(true);
  });

  it('does NOT skip a STALE processing claim (crashed worker → reclaim)', () => {
    expect(shouldSkipCaption({ status: 'processing', hashMatches: true, updatedAtMs: NOW - 25 * MIN, now: NOW })).toBe(false);
  });

  it('skips a recently-failed job (retry backoff)', () => {
    expect(shouldSkipCaption({ status: 'failed', hashMatches: true, updatedAtMs: NOW - 2 * MIN, now: NOW })).toBe(true);
  });

  it('retries a failed job after the backoff window', () => {
    expect(shouldSkipCaption({ status: 'failed', hashMatches: true, updatedAtMs: NOW - 15 * MIN, now: NOW })).toBe(false);
  });

  it('does not skip a fresh/none video', () => {
    expect(shouldSkipCaption({ status: 'none', hashMatches: false, updatedAtMs: 0, now: NOW })).toBe(false);
    expect(shouldSkipCaption({ status: null, hashMatches: false, updatedAtMs: 0, now: NOW })).toBe(false);
  });
});
