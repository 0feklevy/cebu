/**
 * Immutable revision model (Priority 7.1 / 7.2).
 *
 * The key-parsing and cache-policy tests here guard failures that are SILENT in production: a
 * mis-parsed key costs only latency, and an over-cached entry document only misbehaves after a
 * later change that never arrives. Neither would surface as an error, so both are pinned.
 */

import { describe, it, expect } from 'vitest';
import {
  SIM_REVISION_STATUSES,
  canTransition,
  mustRetainBytes,
  isServable,
  isValidRevisionId,
  packageRevisionFor,
  revisionPrefix,
  revisionManifestKey,
  revisionFileKey,
  revisionIdFromKey,
  revisionIdForPrefix,
  isImmutableRevisionKey,
  cacheControlForKey,
  IMMUTABLE_CACHE_CONTROL,
  POINTER_CACHE_CONTROL,
  rollbackTargetFor,
  type SimRevisionRecord,
  type SimRevisionStatus,
} from '../simRevision.js';

const REV = 'rev_abcdef12';
const PREFIX = 'simulations/proj-1/sim-1';

function rec(over: Partial<SimRevisionRecord> = {}): SimRevisionRecord {
  return {
    id: 'r1', simulationId: 's1', revisionNumber: 1, status: 'retired',
    manifestHash: null, bridgeProtocolVersion: 3, runtimeProtocolVersion: 3,
    createdAt: '2026-01-01T00:00:00.000Z', activatedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null, rollbackOfRevisionId: null, metadata: null, ...over,
  };
}

// ── State machine ───────────────────────────────────────────────────────────────────────────────

describe('revision status machine', () => {
  it('every status has a transition entry', () => {
    for (const s of SIM_REVISION_STATUSES) {
      expect(() => canTransition(s, 'failed')).not.toThrow();
    }
  });

  it('failed is terminal', () => {
    for (const s of SIM_REVISION_STATUSES) expect(canTransition('failed', s)).toBe(false);
  });

  it('allows the forward publication path and refuses skipping validation', () => {
    expect(canTransition('draft', 'uploading')).toBe(true);
    expect(canTransition('uploading', 'validating')).toBe(true);
    expect(canTransition('validating', 'canary_passed')).toBe(true);
    expect(canTransition('canary_passed', 'active')).toBe(true);
    expect(canTransition('uploading', 'active')).toBe(false);
    expect(canTransition('draft', 'active')).toBe(false);
  });

  it('allows re-activation from retired and rolled_back — that IS rollback', () => {
    expect(canTransition('retired', 'active')).toBe(true);
    expect(canTransition('rolled_back', 'active')).toBe(true);
  });

  it('keeps retired and rolled_back distinct as outcomes of active', () => {
    // One means "something newer took over", the other "a human judged this wrong".
    expect(canTransition('active', 'retired')).toBe(true);
    expect(canTransition('active', 'rolled_back')).toBe(true);
  });

  it('retains bytes for exactly the statuses rollback and audit need', () => {
    expect(mustRetainBytes('active')).toBe(true);
    expect(mustRetainBytes('retired')).toBe(true);
    expect(mustRetainBytes('rolled_back')).toBe(true);
    expect(mustRetainBytes('draft')).toBe(false);
    expect(mustRetainBytes('failed')).toBe(false);
  });

  it('serves only the active revision', () => {
    for (const s of SIM_REVISION_STATUSES) {
      expect(isServable(s)).toBe(s === 'active');
    }
  });
});

describe('isValidRevisionId', () => {
  it('accepts URL-safe ids of legal length', () => {
    expect(isValidRevisionId('abcdefgh')).toBe(true);
    expect(isValidRevisionId('rev_abc-DEF123')).toBe(true);
  });
  it('rejects short, long, and path-bearing ids', () => {
    expect(isValidRevisionId('short')).toBe(false);
    expect(isValidRevisionId('a'.repeat(65))).toBe(false);
    expect(isValidRevisionId('has/slash')).toBe(false);
    expect(isValidRevisionId('has.dot!!')).toBe(false);
  });
});

// ── Identity ────────────────────────────────────────────────────────────────────────────────────

describe('packageRevisionFor — one resolver', () => {
  const derive = (id: string, bh: string | null | undefined) => `derived:${id}:${bh ?? 'none'}`;

  it('falls back to the pre-revision derivation when there is no active revision', () => {
    // This is what keeps every existing simulation working unchanged.
    expect(packageRevisionFor({ id: 's1', bridge_hash: 'bh' }, derive)).toBe('derived:s1:bh');
    expect(packageRevisionFor({ id: 's1', bridge_hash: null, active_revision_id: null }, derive))
      .toBe('derived:s1:none');
  });

  it('takes identity from the revision once one is active', () => {
    const v = packageRevisionFor({ id: 's1', bridge_hash: 'bh', active_revision_id: REV }, derive);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(v).not.toBe('derived:s1:bh');
  });

  it('ignores bridge_hash once a revision is active — the bytes are what is immutable', () => {
    const a = packageRevisionFor({ id: 's1', bridge_hash: 'x', active_revision_id: REV }, derive);
    const b = packageRevisionFor({ id: 's1', bridge_hash: 'y', active_revision_id: REV }, derive);
    expect(a).toBe(b);
  });

  it('distinguishes different revisions', () => {
    const a = packageRevisionFor({ id: 's1', active_revision_id: 'rev_aaaaaaaa' }, derive);
    const b = packageRevisionFor({ id: 's1', active_revision_id: 'rev_bbbbbbbb' }, derive);
    expect(a).not.toBe(b);
  });
});

// ── Storage layout ──────────────────────────────────────────────────────────────────────────────

describe('storage layout', () => {
  it('builds a revision prefix from the simulation own storage_prefix', () => {
    expect(revisionPrefix(PREFIX, REV)).toBe(`${PREFIX}/revisions/${REV}`);
  });

  it('tolerates a trailing slash on the stored prefix', () => {
    // storage_prefix is a free-form column; a trailing slash would otherwise produce a '//' segment
    // that normalizeManifestPath rejects downstream.
    expect(revisionPrefix(`${PREFIX}/`, REV)).toBe(`${PREFIX}/revisions/${REV}`);
    expect(revisionPrefix(`${PREFIX}///`, REV)).toBe(`${PREFIX}/revisions/${REV}`);
  });

  it('nests the manifest and files under the revision', () => {
    expect(revisionManifestKey(PREFIX, REV)).toBe(`${PREFIX}/revisions/${REV}/manifest.json`);
    expect(revisionFileKey(PREFIX, REV, 'package/index.html'))
      .toBe(`${PREFIX}/revisions/${REV}/package/index.html`);
  });
});

describe('revisionIdFromKey — positional, not first-match', () => {
  it('parses what revisionPrefix emits under a canonical prefix', () => {
    expect(revisionIdFromKey(revisionFileKey(PREFIX, REV, 'package/a.js'))).toBe(REV);
    expect(revisionIdFromKey(revisionManifestKey(PREFIX, REV))).toBe(REV);
  });

  // NAMED FOR WHAT IT ASSERTS. This was called "REFUSES a legacy customer directory" while
  // asserting the opposite — the parser ACCEPTS a customer directory at the canonical depth, and
  // a reader trusting the name would conclude the shape was handled here. It is not: this function
  // is positional only, and the thing that actually refuses a customer directory is
  // `isVerifiedRevisionKey` (backend-api/src/services/simulation/revisionIdentity.ts), which
  // requires a UUID AND a sim_revisions row for that simulation before any immutable caching.
  it('is POSITIONAL only — depth decides, and a customer directory at that depth still parses', () => {
    // A pre-revision package whose bundle has a top-level `revisions/` dir sits at exactly this
    // shape, and by shape alone it is indistinguishable from a real revision.
    expect(revisionIdFromKey('simulations/proj-1/sim-1/revisions/customerdir/app.js')).toBe('customerdir');
    // What this function DOES guarantee: anything deeper cannot masquerade.
    expect(revisionIdFromKey('simulations/proj-1/sim-1/package/revisions/customerdir/app.js')).toBeNull();
    expect(revisionIdFromKey('simulations/proj-1/sim-1/a/b/revisions/customerdir/app.js')).toBeNull();
  });

  it('refuses a percent-decoded key that re-parents itself into a revision prefix', () => {
    // The route percent-decodes, so `%2F` arrives as a real separator. A scan-based parser matched
    // the injected segment at any depth; the positional parser requires depth 3 exactly.
    expect(revisionIdFromKey('simulations/a/b/c/revisions/abcdefgh/x.css')).toBeNull();
    expect(revisionIdFromKey('simulations/a/revisions/abcdefgh/x.css')).toBeNull();
  });

  it('refuses a key rooted outside simulations/', () => {
    // The serving layer guards this too, but an untested branch is an unjustified branch — and a
    // second bucket root reaching this helper must not be able to mint immutable headers.
    expect(revisionIdFromKey('other/proj-1/sim-1/revisions/abcdefgh/x.js')).toBeNull();
    expect(revisionIdFromKey('/simulations/proj-1/sim-1/revisions/abcdefgh/x.js')).toBeNull();
  });

  it('refuses a non-canonical storage prefix rather than guessing', () => {
    // Never immutable is a latency cost. Wrongly immutable is a year-long incident.
    expect(revisionIdFromKey(revisionFileKey('sims/tenant-a/x/y/z', REV, 'a.js'))).toBeNull();
    expect(revisionIdFromKey(revisionFileKey('flat', REV, 'a.js'))).toBeNull();
  });

  it('requires a path segment below the revision id', () => {
    expect(revisionIdFromKey(`${PREFIX}/revisions/${REV}`)).toBeNull();
    expect(revisionIdFromKey(`${PREFIX}/revisions/${REV}/`)).toBeNull();
  });

  it('rejects an illegal revision id', () => {
    expect(revisionIdFromKey(`${PREFIX}/revisions/short/a.js`)).toBeNull();
    expect(revisionIdFromKey(`${PREFIX}/revisions/has.dots.here/a.js`)).toBeNull();
  });

  it('returns null for a legacy mutable key — unfamiliar means mutable', () => {
    expect(revisionIdFromKey(`${PREFIX}/index.html`)).toBeNull();
    expect(revisionIdFromKey('')).toBeNull();
    expect(isImmutableRevisionKey(`${PREFIX}/index.html`)).toBe(false);
  });
});

describe('revisionIdForPrefix — exact, when the prefix is known', () => {
  it('parses a NON-canonical prefix that the positional parser must refuse', () => {
    // This is why both exist: with the row in hand there is nothing to guess.
    const key = revisionFileKey('sims/tenant-a/x/y/z', REV, 'package/a.js');
    expect(revisionIdForPrefix(key, 'sims/tenant-a/x/y/z')).toBe(REV);
    expect(revisionIdFromKey(key)).toBeNull();
  });

  it('refuses a key belonging to a different simulation', () => {
    const key = revisionFileKey(PREFIX, REV, 'package/a.js');
    expect(revisionIdForPrefix(key, 'simulations/proj-1/sim-2')).toBeNull();
  });

  it('refuses a customer directory named revisions below the prefix', () => {
    expect(revisionIdForPrefix(`${PREFIX}/package/revisions/customerdir/a.js`, PREFIX)).toBeNull();
  });

  it('tolerates a trailing slash on the prefix', () => {
    const key = revisionFileKey(PREFIX, REV, 'a.js');
    expect(revisionIdForPrefix(key, `${PREFIX}/`)).toBe(REV);
  });

  it('requires a path segment below the revision id', () => {
    expect(revisionIdForPrefix(`${PREFIX}/revisions/${REV}`, PREFIX)).toBeNull();
  });
});

// ── Cache policy ────────────────────────────────────────────────────────────────────────────────

describe('cacheControlForKey', () => {
  it('caches revision files forever', () => {
    expect(cacheControlForKey(revisionFileKey(PREFIX, REV, 'package/a.js')))
      .toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('never caches a legacy mutable key', () => {
    expect(cacheControlForKey(`${PREFIX}/index.html`)).toBe(POINTER_CACHE_CONTROL);
  });

  it('never caches the entry document, even inside a revision', () => {
    // injectSimBootSnippet runs at SERVE time, so served bytes are not the stored bytes. An
    // immutable header would pin whichever snippet was live when the response was first cached.
    const key = revisionFileKey(PREFIX, REV, 'package/index.html');
    expect(cacheControlForKey(key, false)).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlForKey(key, true)).toBe(POINTER_CACHE_CONTROL);
  });

  it('uses no-cache rather than no-store so the 304 path survives', () => {
    expect(POINTER_CACHE_CONTROL).toContain('no-cache');
    expect(POINTER_CACHE_CONTROL).not.toContain('no-store');
  });
});

// ── Rollback target ─────────────────────────────────────────────────────────────────────────────

describe('rollbackTargetFor', () => {
  it('picks the most recently active revision that is not current', () => {
    const t = rollbackTargetFor([
      rec({ id: 'r1', activatedAt: '2026-01-01T00:00:00.000Z' }),
      rec({ id: 'r2', activatedAt: '2026-03-01T00:00:00.000Z' }),
      rec({ id: 'r3', status: 'active', activatedAt: '2026-05-01T00:00:00.000Z' }),
    ], 'r3');
    expect(t?.id).toBe('r2');
  });

  it('never returns a revision that is still active, even if currentActiveId is stale', () => {
    // mustRetainBytes('active') is true, so without the status filter a null/stale pointer hands
    // back the very revision the rollback is trying to escape.
    const t = rollbackTargetFor([rec({ id: 'r3', status: 'active' })], null);
    expect(t).toBeNull();
  });

  it('orders by activatedAt, not revisionNumber — a rollback re-activates an older number', () => {
    const t = rollbackTargetFor([
      rec({ id: 'old', revisionNumber: 1, activatedAt: '2026-06-01T00:00:00.000Z' }),
      rec({ id: 'new', revisionNumber: 9, activatedAt: '2026-02-01T00:00:00.000Z' }),
    ], null);
    expect(t?.id).toBe('old');
  });

  it('orders chronologically across mixed ISO offset formats', () => {
    // 'Z' vs '+00:00' sort differently as strings for the same instant.
    const t = rollbackTargetFor([
      rec({ id: 'later', activatedAt: '2026-06-01T12:00:00.000Z' }),
      rec({ id: 'earlier', activatedAt: '2026-06-01T09:00:00.000+00:00' }),
    ], null);
    expect(t?.id).toBe('later');
  });

  it('orders correctly when the data layer hands back Date objects', () => {
    // Drizzle returns Date for timestamp({withTimezone}) unless mode:'string' is set.
    const t = rollbackTargetFor([
      rec({ id: 'later', activatedAt: new Date('2026-06-01T12:00:00Z') as unknown as string }),
      rec({ id: 'earlier', activatedAt: new Date('2026-01-01T00:00:00Z') as unknown as string }),
    ], null);
    expect(t?.id).toBe('later');
  });

  it('never picks a never-activated revision', () => {
    expect(rollbackTargetFor([rec({ id: 'r1', status: 'draft', activatedAt: null })], null)).toBeNull();
  });

  it('never picks a revision whose bytes may have been reclaimed', () => {
    expect(rollbackTargetFor([rec({ id: 'r1', status: 'failed' })], null)).toBeNull();
  });

  it('sorts a malformed timestamp last rather than throwing', () => {
    const t = rollbackTargetFor([
      rec({ id: 'bad', activatedAt: 'not-a-date' }),
      rec({ id: 'good', activatedAt: '2026-01-01T00:00:00.000Z' }),
    ], null);
    expect(t?.id).toBe('good');
  });

  it('returns null when there is nothing to roll back to', () => {
    expect(rollbackTargetFor([], null)).toBeNull();
  });
});
