import { describe, it, expect } from 'vitest';
import { LAST_SEEN_DEBOUNCE_MS, shouldTouchLastSeen } from '../lastSeen.js';

describe('shouldTouchLastSeen', () => {
  const now = new Date('2026-09-03T12:00:00Z');
  it('writes for a user never seen, or seen longer ago than the window', () => {
    expect(shouldTouchLastSeen(null, now)).toBe(true);
    expect(shouldTouchLastSeen(undefined, now)).toBe(true);
    expect(shouldTouchLastSeen(new Date(now.getTime() - LAST_SEEN_DEBOUNCE_MS), now)).toBe(true);
    expect(shouldTouchLastSeen('2026-09-03T11:00:00Z', now)).toBe(true);
  });
  it('skips the write inside the window — the hot auth path stops writing per request', () => {
    expect(shouldTouchLastSeen(new Date(now.getTime() - 1000), now)).toBe(false);
    expect(shouldTouchLastSeen(new Date(now.getTime() - LAST_SEEN_DEBOUNCE_MS + 1), now)).toBe(false);
  });
  it('an unparseable timestamp writes rather than trusting garbage', () => {
    expect(shouldTouchLastSeen('not a date', now)).toBe(true);
  });
});
