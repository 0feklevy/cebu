/**
 * The reserved namespaces under a simulation prefix.
 *
 * WHY THIS EXISTS. Two subsystems write into one keyspace. Immutable revisions live at
 * `<prefix>/revisions/<id>/…`, captured posters at `<prefix>/posters/<identity>/…`, and the
 * "replace simulation" flow uploads a customer bundle into `<prefix>/` and then DELETES everything
 * under it the new bundle does not contain. Nothing marked those two subtrees as system-owned, so:
 *
 *   • an ordinary replace swept every published revision's bytes while its `sim_revisions` row
 *     survived — and that row still activates, because the promote CAS checks `manifest_hash` and
 *     `entry_path`, never that the bytes exist. The pointer then resolves to nothing and
 *     `simulationUrlOf` has no fallback, so every section 404s. Rollback dies too: the retained
 *     revisions were swept in the same pass.
 *   • a bundle entry named `revisions/<id>/…` wrote INTO a revision. Revision ids are public
 *     (they appear inside `simulation_url` in every player config) and revision bytes are served
 *     `max-age=31536000, immutable`, so that pins replaced content for a year.
 */
import { describe, it, expect } from 'vitest';
import {
  isSystemOwnedKey, isSystemOwnedRelPath, revisionFileKey, SYSTEM_OWNED_SEGMENTS,
} from '../sim/simRevision.js';
import { posterStoragePath, type PosterKey } from '../sim/posterIdentity.js';

const PREFIX = 'simulations/proj-1/sim-1';
const REV = '3f7c1d2e-0000-4000-a000-00000000abcd';

describe('isSystemOwnedKey — what a replace sweep must never delete', () => {
  // THE REGRESSION. Every one of these is a real key the revision writer produces.
  it('protects every file of a published revision, not just the ones with lucky names', () => {
    for (const rel of ['package/index.html', 'package/bridge.js', 'package/app.js', 'manifest.json']) {
      const key = revisionFileKey(PREFIX, REV, rel);
      expect(isSystemOwnedKey(key, PREFIX), key).toBe(true);
    }
  });

  it('protects captured posters, whose rows also outlive their bytes', () => {
    // Built through the REAL path builder, so a change to the poster layout is caught here rather
    // than silently moving posters out from under the protection.
    const key = posterStoragePath(PREFIX, {
      packageRevision: 'rev-1' as PosterKey['packageRevision'],
      variantKey: 'main' as PosterKey['variantKey'],
      configHash: 'cfg' as PosterKey['configHash'],
      aspectProfile: 'wide' as PosterKey['aspectProfile'],
      qualityProfile: 'high' as PosterKey['qualityProfile'],
    }, 'standard', 'webp');
    expect(isSystemOwnedKey(key, PREFIX), key).toBe(true);
  });

  it('does NOT protect the customer bundle — a replace must still clear stale files', () => {
    for (const k of [
      `${PREFIX}/index.html`,
      `${PREFIX}/assets/old-texture.png`,
      `${PREFIX}/lib/vendor.js`,
      `${PREFIX}/revisionary/notes.txt`,   // merely starts with the same letters
      `${PREFIX}/posterior.png`,
    ]) {
      expect(isSystemOwnedKey(k, PREFIX), k).toBe(false);
    }
  });

  it('is scoped to the given prefix — another simulation is never "system-owned" here', () => {
    expect(isSystemOwnedKey('simulations/proj-1/sim-2/revisions/x/a.js', PREFIX)).toBe(false);
    expect(isSystemOwnedKey('other/revisions/x/a.js', PREFIX)).toBe(false);
  });

  it('tolerates a trailing slash on the prefix, which storage_prefix is free to carry', () => {
    expect(isSystemOwnedKey(`${PREFIX}/revisions/${REV}/manifest.json`, `${PREFIX}/`)).toBe(true);
  });
});

describe('isSystemOwnedRelPath — what an uploaded bundle may not contain', () => {
  it('rejects a bundle entry that would overwrite immutable revision bytes', () => {
    expect(isSystemOwnedRelPath(`revisions/${REV}/package/app.js`)).toBe(true);
    expect(isSystemOwnedRelPath('posters/abc/md.webp')).toBe(true);
    expect(isSystemOwnedRelPath('/revisions/x/a.js')).toBe(true);   // leading slash stripped upstream
  });

  it('accepts ordinary bundle paths', () => {
    for (const p of ['index.html', 'assets/a.png', 'revisionary/x.js', 'sub/revisions/x.js']) {
      expect(isSystemOwnedRelPath(p), p).toBe(false);
    }
  });
});

describe('the two predicates share one list', () => {
  // If a third system subtree is added, both call sites must learn about it at once.
  it('covers exactly the declared segments', () => {
    expect([...SYSTEM_OWNED_SEGMENTS].sort()).toEqual(['posters', 'revisions']);
    for (const seg of SYSTEM_OWNED_SEGMENTS) {
      expect(isSystemOwnedRelPath(`${seg}/x`), seg).toBe(true);
      expect(isSystemOwnedKey(`${PREFIX}/${seg}/x`, PREFIX), seg).toBe(true);
    }
  });
});
