import { describe, it, expect } from 'vitest';
import { requireProjectAccess, type AccessProject } from '../projectAccess.js';

const make = (over: Partial<AccessProject>): AccessProject => ({
  created_by: 'owner-1',
  visibility: 'private',
  share_token: null,
  ...over,
});

describe('requireProjectAccess', () => {
  it('public → anyone, including anonymous', () => {
    expect(requireProjectAccess(make({ visibility: 'public' }), null)).toBe(true);
    expect(requireProjectAccess(make({ visibility: 'public' }), 'someone-else')).toBe(true);
  });

  it('private → only the owner', () => {
    expect(requireProjectAccess(make({ visibility: 'private' }), 'owner-1')).toBe(true);
    expect(requireProjectAccess(make({ visibility: 'private' }), 'other')).toBe(false);
    expect(requireProjectAccess(make({ visibility: 'private' }), null)).toBe(false);
  });

  it('unlisted → owner only by id; anonymous-by-id is denied', () => {
    expect(requireProjectAccess(make({ visibility: 'unlisted' }), 'owner-1')).toBe(true);
    expect(requireProjectAccess(make({ visibility: 'unlisted' }), null)).toBe(false);
  });

  it('valid share token grants access to a non-public project', () => {
    const p = make({ visibility: 'unlisted', share_token: 'tok-abc' });
    expect(requireProjectAccess(p, null, 'tok-abc')).toBe(true);
    expect(requireProjectAccess(p, null, 'wrong')).toBe(false);
    expect(requireProjectAccess(p, null, null)).toBe(false);
  });

  it('a share token does not grant access when the project has none', () => {
    expect(requireProjectAccess(make({ visibility: 'private', share_token: null }), null, 'anything')).toBe(false);
  });
});
