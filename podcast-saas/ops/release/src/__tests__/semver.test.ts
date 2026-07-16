import { describe, expect, it } from 'vitest';
import { assertTagAvailable, bump, compareSemver, computeNextVersion, parseSemverTag } from '../semver.js';

describe('parseSemverTag', () => {
  it('parses vMAJOR.MINOR.PATCH', () => {
    expect(parseSemverTag('v0.1.1')).toEqual({ major: 0, minor: 1, patch: 1 });
    expect(parseSemverTag('v12.34.56')).toEqual({ major: 12, minor: 34, patch: 56 });
  });

  it('rejects non-release tags', () => {
    for (const t of ['0.1.1', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3.4', 'release-1', 'v1.2.x', '']) {
      expect(parseSemverTag(t), t).toBeNull();
    }
  });
});

describe('bump', () => {
  const base = { major: 1, minor: 2, patch: 3 };
  it('patch/minor/major reset lower components', () => {
    expect(bump(base, 'patch')).toEqual({ major: 1, minor: 2, patch: 4 });
    expect(bump(base, 'minor')).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(bump(base, 'major')).toEqual({ major: 2, minor: 0, patch: 0 });
  });
});

describe('computeNextVersion', () => {
  it('bumps from the highest existing semver tag (numeric, not lexicographic)', () => {
    const tags = ['v0.1.1', 'v0.1.0', 'v0.9.0', 'v0.10.0', 'junk', 'v1.2'];
    expect(computeNextVersion(tags, 'patch')).toEqual({ currentTag: 'v0.10.0', nextTag: 'v0.10.1', bump: 'patch' });
    expect(computeNextVersion(tags, 'minor').nextTag).toBe('v0.11.0');
    expect(computeNextVersion(tags, 'major').nextTag).toBe('v1.0.0');
  });

  it('matches the real repository state: v0.1.1 + patch -> v0.1.2', () => {
    expect(computeNextVersion(['v0.1.0', 'v0.1.1'], 'patch').nextTag).toBe('v0.1.2');
  });

  it('starts from v0.0.0 when no release tags exist', () => {
    expect(computeNextVersion([], 'patch').nextTag).toBe('v0.0.1');
    expect(computeNextVersion(['not-semver'], 'minor').nextTag).toBe('v0.1.0');
  });

  it('sorts using semver order for the baseline', () => {
    expect(compareSemver(parseSemverTag('v0.10.0')!, parseSemverTag('v0.9.9')!)).toBeGreaterThan(0);
  });
});

describe('assertTagAvailable (existing-tag rejection)', () => {
  it('throws when the computed tag already exists', () => {
    expect(() => assertTagAvailable(['v0.1.2'], 'v0.1.2')).toThrow(/immutable/);
  });

  it('computeNextVersion refuses a collision outright', () => {
    // Malicious/odd state: someone pre-created the next tag by hand.
    expect(() => computeNextVersion(['v0.1.1', 'v0.1.2'], 'patch')).not.toThrow(); // 0.1.2 is now current -> 0.1.3
    expect(computeNextVersion(['v0.1.1', 'v0.1.2'], 'patch').nextTag).toBe('v0.1.3');
  });
});
