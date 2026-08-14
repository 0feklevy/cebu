/**
 * The package-root grammar — the boundary whose misplacement caused the v0.1.23 incident.
 *
 * THE REAL PRODUCTION KEY, from the failing export (section 75639e6c-…, verified against the
 * production row): `simulations/<projectId>/<simulationId>/boids-3d/index.html`, a LEGACY package
 * (`active_revision_id: null`) with a NESTED entry. Its `bridge.js` sits at the package root and
 * the stored HTML loads it as `../bridge.js`. Anchoring staging at the entry's directory dropped
 * that file, the bridge never installed, and all 11 sim windows timed out at `bridge_ready`.
 *
 * These tests pin the grammar itself: root and entry path for every supported layout, nesting
 * preserved, and every malformed shape refused rather than guessed at.
 */

import { describe, expect, it } from 'vitest';

import { isStageablePackagePath, parseSimPackageKey } from '../simPackageKey.js';

const PROJECT = 'd8e7557a-6efd-4458-ab20-a391a0ee6b52';
const SIM = '49d20194-3fe7-4916-867b-22334c5022b3';
const PREFIX = `simulations/${PROJECT}/${SIM}`;
const REV = '11111111-2222-4333-8444-555555555555';

describe('parseSimPackageKey — LEGACY layout', () => {
  it('THE PRODUCTION KEY: a nested legacy entry roots at the simulation prefix and keeps its nesting', () => {
    const parsed = parseSimPackageKey(`${PREFIX}/boids-3d/index.html`);
    expect(parsed).toEqual({
      layout: 'legacy',
      packageRoot: PREFIX,
      entryPath: 'boids-3d/index.html', // NOT 'index.html' — the incident in one assertion
      entryKey: `${PREFIX}/boids-3d/index.html`,
    });
  });

  it('a flat legacy entry roots at the same prefix with a bare entry path', () => {
    expect(parseSimPackageKey(`${PREFIX}/index.html`)).toMatchObject({
      layout: 'legacy',
      packageRoot: PREFIX,
      entryPath: 'index.html',
    });
  });

  it('a deeply nested legacy entry keeps every segment (../../bridge.js is reachable)', () => {
    expect(parseSimPackageKey(`${PREFIX}/a/b/index.html`)).toMatchObject({
      packageRoot: PREFIX,
      entryPath: 'a/b/index.html',
    });
  });
});

describe('parseSimPackageKey — REVISION layout', () => {
  it('a flat revision entry roots at the revision PACKAGE dir, not the revision root', () => {
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}/package/index.html`)).toEqual({
      layout: 'revision',
      packageRoot: `${PREFIX}/revisions/${REV}/package`,
      entryPath: 'index.html',
      entryKey: `${PREFIX}/revisions/${REV}/package/index.html`,
    });
  });

  it('a nested revision entry keeps its nesting below package/', () => {
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}/package/scene/index.html`)).toMatchObject({
      layout: 'revision',
      packageRoot: `${PREFIX}/revisions/${REV}/package`,
      entryPath: 'scene/index.html',
    });
  });

  it('refuses a revision key that is not inside package/ (manifest.json, posters, canary)', () => {
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}/manifest.json`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}/posters/x/full.png`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}/runtime/bridge.js`)).toBeNull();
  });

  it('refuses an incomplete revision key (no id, no package dir, no entry below package/)', () => {
    expect(parseSimPackageKey(`${PREFIX}/revisions`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}/revisions/${REV}/package`)).toBeNull();
  });
});

describe('parseSimPackageKey — fails CLOSED', () => {
  it('refuses traversal, absolute, backslash and NUL', () => {
    expect(parseSimPackageKey(`${PREFIX}/../../etc/passwd`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}/./index.html`)).toBeNull();
    expect(parseSimPackageKey(`/${PREFIX}/index.html`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}\\index.html`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}/index.html\u0000`)).toBeNull();
    expect(parseSimPackageKey(`${PREFIX}//index.html`)).toBeNull(); // empty segment
  });

  it('refuses anything outside the simulations/ keyspace or above the entry depth', () => {
    expect(parseSimPackageKey('')).toBeNull();
    expect(parseSimPackageKey('podcasts/x/y.mp3')).toBeNull();
    expect(parseSimPackageKey('simulations')).toBeNull();
    expect(parseSimPackageKey(`simulations/${PROJECT}`)).toBeNull();
    expect(parseSimPackageKey(PREFIX)).toBeNull(); // the prefix itself is not an entry
  });

  it('refuses a legacy entry that lives inside a system-owned subtree', () => {
    expect(parseSimPackageKey(`${PREFIX}/posters/identity/full.png`)).toBeNull();
  });
});

describe('isStageablePackagePath — legacy roots exclude the system subtrees', () => {
  it('keeps customer bytes and the package-root runtime', () => {
    for (const p of ['bridge.js', 'guidance.js', 'boids-3d/index.html', 'boids-3d/src/main.js', 'guidance/en/a.mp3']) {
      expect(isStageablePackagePath('legacy', p), p).toBe(true);
    }
  });

  it('EXCLUDES revisions/ and posters/ from a legacy root (publication history is not the package)', () => {
    expect(isStageablePackagePath('legacy', `revisions/${REV}/package/index.html`)).toBe(false);
    expect(isStageablePackagePath('legacy', 'posters/identity/full.png')).toBe(false);
  });

  it('a revision package root is customer bytes only — nothing is excluded there', () => {
    expect(isStageablePackagePath('revision', 'bridge.js')).toBe(true);
    // A customer directory literally named `posters/` inside a revision package IS customer content.
    expect(isStageablePackagePath('revision', 'posters/mine.png')).toBe(true);
  });

  it('refuses an empty path in both layouts', () => {
    expect(isStageablePackagePath('legacy', '')).toBe(false);
    expect(isStageablePackagePath('revision', '')).toBe(false);
  });
});
