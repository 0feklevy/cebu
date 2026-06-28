import { describe, it, expect } from 'vitest';
import { avatarProjectAllowed } from '../avatarAccess.js';

const proj = (visibility: string, created_by: string | null = 'owner-1') => ({ visibility, created_by });

describe('avatarProjectAllowed (avatar visibility gate)', () => {
  it('public → anyone (anonymous or another user)', () => {
    expect(avatarProjectAllowed(proj('public'), null)).toBe(true);
    expect(avatarProjectAllowed(proj('public'), 'other')).toBe(true);
  });

  it('unlisted/share-link → anyone (treated like public for the viewer)', () => {
    expect(avatarProjectAllowed(proj('unlisted'), null)).toBe(true);
    expect(avatarProjectAllowed(proj('unlisted'), 'other')).toBe(true);
  });

  it('private + anonymous → denied', () => {
    expect(avatarProjectAllowed(proj('private'), null)).toBe(false);
  });

  it('private + a different user → denied', () => {
    expect(avatarProjectAllowed(proj('private'), 'other')).toBe(false);
  });

  it('private + owner → allowed', () => {
    expect(avatarProjectAllowed(proj('private', 'owner-1'), 'owner-1')).toBe(true);
  });
});
