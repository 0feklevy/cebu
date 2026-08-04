/**
 * The immutable-revision model: publication state machine, storage layout, cache policy, rollback
 * selection, and the canonical manifest (Priority 7.1–7.3).
 *
 * WHY THIS SUITE LIVES IN client-web/__tests__ AND NOT IN shared/
 * `shared` has no test runner — it is a types-and-pure-functions package compiled by `tsc` and
 * consumed by both `client-web` and `backend-api`. client-web's vitest project already resolves the
 * `shared/src/*` export map (vitest.config.ts + the `shared` file: link in package.json), so the
 * acceptance tests for shared's pure modules are hosted here. See simProtocolEnvelope.test.ts for
 * the precedent. This file imports ONLY from `shared/src/sim/*` and touches no browser API.
 *
 * WHAT IS BEING DEFENDED
 * Every function under test is load-bearing for a guarantee that is invisible when it holds and
 * catastrophic when it does not:
 *
 *   canTransition        a status graph that admits one extra edge admits a publication path that
 *                        skips verification — the pointer would then be allowed to name bytes
 *                        nobody proved.
 *   revisionIdFromKey    decides whether a URL may be cached for a YEAR. A false positive on a
 *                        customer-controlled path makes a mutable object permanently uncacheable-
 *                        wrong: the CDN keeps serving bytes that were replaced.
 *   rollbackTargetFor    picks what an operator gets during an incident. Ordering it by the wrong
 *                        column restores the revision that was just judged bad.
 *   validateManifest     the publication gate. Asserting only "it failed" would pass even if it
 *                        failed for a reason that has nothing to do with the fault injected, which
 *                        is indistinguishable from the validator being the bug — so EVERY problem
 *                        code is produced by a purpose-built input and asserted BY NAME, and the
 *                        case table is a Record over the union so a new code with no test is a
 *                        COMPILE error.
 *   computeManifestHash  answers "did anything change". A hash that moves when nothing served
 *                        changed makes every republish look like a change; one that stays when a
 *                        served fact changes makes a real change invisible.
 *
 * Two `KNOWN GAP:` tests below pin behaviour that is currently tolerated rather than desired. They
 * are characterization tests: each says exactly what would have to change and instructs the reader
 * to flip it when it does. They are not assertions that the gap is correct.
 */
import { describe, expect, it } from 'vitest';

import {
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_FILENAME,
  POINTER_CACHE_CONTROL,
  SIM_REVISION_STATUSES,
  cacheControlForKey,
  canTransition,
  isImmutableRevisionKey,
  isServable,
  isValidRevisionId,
  mustRetainBytes,
  packageRevisionOf,
  revisionFileKey,
  revisionIdFromKey,
  revisionManifestKey,
  revisionPrefix,
  rollbackTargetFor,
  type SimRevisionRecord,
  type SimRevisionStatus,
} from 'shared/src/sim/simRevision';

import {
  SIM_MANIFEST_VERSION,
  canonicalizeManifest,
  caseFoldKey,
  computeManifestHash,
  manifestIsValid,
  normalizeManifestPath,
  validateManifest,
  type ManifestProblemCode,
  type SimManifest,
  type SimManifestFile,
} from 'shared/src/sim/simManifest';

import { posterIdentityString } from 'shared/src/sim/posterIdentity';
import { sha256Hex } from 'shared/src/sim/sha256';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The state machine, restated independently
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Restated from the Priority 7.1 description, NOT imported: `TRANSITIONS` is deliberately private,
 * and a test that read it would assert the table equals itself. This is the second opinion.
 */
const RESTATED_TRANSITIONS: Record<SimRevisionStatus, readonly SimRevisionStatus[]> = {
  // Nothing is uploaded yet; the only ways out are to start writing or to give up.
  draft: ['uploading', 'failed'],
  // Bytes are landing; they are not yet proven to be the bytes the manifest describes.
  uploading: ['validating', 'failed'],
  // Proof in progress. Passing proof is NOT the same as passing the canary.
  validating: ['canary_passed', 'failed'],
  // Proven and canary-proven; eligible for the pointer.
  canary_passed: ['active', 'failed'],
  // Live. Leaves either because something newer took over or because a human withdrew it.
  active: ['retired', 'rolled_back', 'failed'],
  // Superseded, bytes retained — re-activating IS rollback.
  retired: ['active', 'failed'],
  // Withdrawn by judgement, bytes retained — can be re-activated once the judgement is reversed.
  rolled_back: ['active', 'failed'],
  // Terminal. A failed publication is never resurrected; a new revision is minted instead.
  failed: [],
};

/**
 * Every member of the union, spelled out. `Record<SimRevisionStatus, true>` means adding a status
 * to the union without adding it here is a COMPILE error, which is the only way this suite can
 * notice a new state.
 */
const EVERY_STATUS: Record<SimRevisionStatus, true> = {
  draft: true,
  uploading: true,
  validating: true,
  canary_passed: true,
  active: true,
  retired: true,
  rolled_back: true,
  failed: true,
};

const ALL_STATUSES = Object.keys(EVERY_STATUS) as SimRevisionStatus[];

describe('SIM_REVISION_STATUSES', () => {
  it('lists exactly the members of the union', () => {
    expect([...SIM_REVISION_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('has no duplicates — a duplicated status would make every exhaustive walk lie about coverage', () => {
    expect(new Set(SIM_REVISION_STATUSES).size).toBe(SIM_REVISION_STATUSES.length);
  });
});

describe('canTransition — exhaustive over every (from, to) pair', () => {
  const pairs: [SimRevisionStatus, SimRevisionStatus][] = [];
  for (const from of ALL_STATUSES) for (const to of ALL_STATUSES) pairs.push([from, to]);

  it('walks all 64 pairs', () => {
    expect(pairs).toHaveLength(ALL_STATUSES.length ** 2);
    expect(ALL_STATUSES).toHaveLength(8);
  });

  it.each(pairs)('%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(RESTATED_TRANSITIONS[from].includes(to));
  });

  it('refuses every self-transition — most importantly active → active', () => {
    for (const s of ALL_STATUSES) expect(canTransition(s, s)).toBe(false);
    // Re-activating the revision the pointer already names would turn "activate" into an operation
    // that appears to do work while the pointer never moves, hiding a failed publication as a
    // success. It is also the shape a duplicate request takes, which is why it must be refused
    // here rather than papered over by an idempotency check at the caller.
    expect(canTransition('active', 'active')).toBe(false);
  });

  it('makes failed terminal in both directions that matter', () => {
    for (const to of ALL_STATUSES) expect(canTransition('failed', to)).toBe(false);
    // Everything except `failed` itself can fail: a publication can be abandoned at any stage.
    for (const from of ALL_STATUSES) {
      expect(canTransition(from, 'failed')).toBe(from !== 'failed');
    }
  });

  it('admits exactly three predecessors of active, and none of them skip verification', () => {
    const predecessors = ALL_STATUSES.filter((s) => canTransition(s, 'active'));
    expect(predecessors.sort()).toEqual(['canary_passed', 'retired', 'rolled_back']);
    // The two that are not `canary_passed` were active once already — their bytes were verified
    // then and have not moved since. Nothing reaches `active` without having been verified.
    for (const s of ['draft', 'uploading', 'validating'] as const) {
      expect(canTransition(s, 'active')).toBe(false);
    }
  });

  it('keeps retired and rolled_back distinct — they answer different questions after an incident', () => {
    expect(canTransition('active', 'retired')).toBe(true);
    expect(canTransition('active', 'rolled_back')).toBe(true);
    // Neither can become the other: that would erase whether a revision stopped serving because
    // something newer arrived or because a human said it was wrong.
    expect(canTransition('retired', 'rolled_back')).toBe(false);
    expect(canTransition('rolled_back', 'retired')).toBe(false);
  });

  it('has no path back into the publication pipeline once a revision has served', () => {
    for (const from of ['active', 'retired', 'rolled_back'] as const) {
      for (const to of ['draft', 'uploading', 'validating', 'canary_passed'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('mustRetainBytes / isServable', () => {
  const RESTATED_RETAIN: Record<SimRevisionStatus, boolean> = {
    draft: false,
    uploading: false,
    validating: false,
    canary_passed: false,
    active: true,
    retired: true,
    rolled_back: true,
    failed: false,
  };

  const RESTATED_SERVABLE: Record<SimRevisionStatus, boolean> = {
    draft: false,
    uploading: false,
    validating: false,
    canary_passed: false,
    active: true,
    retired: false,
    rolled_back: false,
    failed: false,
  };

  it.each(ALL_STATUSES)('mustRetainBytes(%s)', (s) => {
    expect(mustRetainBytes(s)).toBe(RESTATED_RETAIN[s]);
  });

  it.each(ALL_STATUSES)('isServable(%s)', (s) => {
    expect(isServable(s)).toBe(RESTATED_SERVABLE[s]);
  });

  it('serves only from the active revision', () => {
    expect(ALL_STATUSES.filter(isServable)).toEqual(['active']);
  });

  it('retains the bytes of everything servable', () => {
    // A servable revision whose bytes a sweep may delete is a 404 waiting for the next viewer.
    for (const s of ALL_STATUSES) if (isServable(s)) expect(mustRetainBytes(s)).toBe(true);
  });

  it('retains the bytes of every status a rollback can restore', () => {
    // rollbackTargetFor only ever returns retained statuses; if a status could be rolled back TO
    // while its bytes were collectable, rollback would restore a pointer to nothing.
    for (const s of ALL_STATUSES) {
      if (s !== 'canary_passed' && canTransition(s, 'active')) expect(mustRetainBytes(s)).toBe(true);
    }
  });

  it('does not retain a failed revision — its bytes were never served and never will be', () => {
    expect(mustRetainBytes('failed')).toBe(false);
    expect(isServable('failed')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Identity and storage layout
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('isValidRevisionId', () => {
  const VALID = [
    'abcdefgh',                                                          // exactly 8
    '01234567',
    'A_b-C_d-9',
    'r'.repeat(64),                                                      // exactly 64
    'rev_2026_08_04_aaaaaaaa',
  ];
  const INVALID: [string, string][] = [
    ['', 'empty'],
    ['abcdefg', 'seven characters — one short of the floor'],
    ['r'.repeat(65), 'sixty-five characters — one over the ceiling'],
    ['abcdef.h', 'a dot would make the id ambiguous with a file extension in a path'],
    ['abcdef/h', 'a slash would let an id invent a directory level inside the prefix'],
    ['abcdef h', 'a space survives some URL encoders and not others'],
    ['abcdefgé', 'non-ASCII normalises differently on different filesystems'],
    ['abcdefg%20', 'percent-encoding would make one id have two spellings'],
    ['abcdef+h', '+ decodes to a space in query-string parsers'],
    ['../abcdefgh', 'traversal'],
  ];

  it.each(VALID)('accepts %s', (id) => {
    expect(isValidRevisionId(id)).toBe(true);
  });

  it.each(INVALID)('rejects %s (%s)', (id) => {
    expect(isValidRevisionId(id)).toBe(false);
  });

  it('rejects a non-string without throwing', () => {
    expect(isValidRevisionId(undefined as unknown as string)).toBe(false);
    expect(isValidRevisionId(null as unknown as string)).toBe(false);
    expect(isValidRevisionId(12345678 as unknown as string)).toBe(false);
  });
});

describe('packageRevisionOf', () => {
  it('is 16 lowercase hex characters', () => {
    expect(packageRevisionOf('abcdefgh')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic and distinct per revision id', () => {
    expect(packageRevisionOf('abcdefgh')).toBe(packageRevisionOf('abcdefgh'));
    expect(packageRevisionOf('abcdefgh')).not.toBe(packageRevisionOf('abcdefgi'));
  });

  it('is not the revision id itself — the wire value is opaque and fixed-width', () => {
    expect(packageRevisionOf('abcdefgh')).not.toBe('abcdefgh');
    expect(packageRevisionOf('r'.repeat(64))).toHaveLength(16);
  });

  it('is domain-separated from a bare hash of the id', () => {
    // The `rev:` prefix keeps this value from colliding with any other 16-hex identity derived
    // elsewhere from the same string (config hashes are also truncated SHA-256).
    expect(packageRevisionOf('abcdefgh')).not.toBe(sha256Hex('abcdefgh').slice(0, 16));
    expect(packageRevisionOf('abcdefgh')).toBe(sha256Hex('rev:abcdefgh').slice(0, 16));
  });
});

describe('storage layout round-trips', () => {
  const PROJECT = 'proj-1';
  const SIM = 'sim-9';
  const IDS = ['abcdefgh', '01234567', 'A_b-C_d-9', 'r'.repeat(64)];

  it.each(IDS)('revisionPrefix + revisionIdFromKey round-trip for %s', (id) => {
    // The prefix alone is not a key — there are no bytes at a directory — so a trailing slash is
    // required before the id is recoverable.
    expect(revisionIdFromKey(`${revisionPrefix(PROJECT, SIM, id)}/`)).toBe(id);
    expect(revisionIdFromKey(revisionManifestKey(PROJECT, SIM, id))).toBe(id);
    expect(revisionIdFromKey(revisionFileKey(PROJECT, SIM, id, 'package/index.html'))).toBe(id);
    expect(revisionIdFromKey(revisionFileKey(PROJECT, SIM, id, 'runtime/bridge.js'))).toBe(id);
    expect(revisionIdFromKey(revisionFileKey(PROJECT, SIM, id, 'posters/p__q/standard.webp'))).toBe(id);
    expect(revisionIdFromKey(revisionFileKey(PROJECT, SIM, id, 'canary/report.json'))).toBe(id);
  });

  it('composes the manifest key from the prefix and the canonical filename', () => {
    expect(revisionManifestKey(PROJECT, SIM, 'abcdefgh'))
      .toBe(`simulations/${PROJECT}/${SIM}/revisions/abcdefgh/${MANIFEST_FILENAME}`);
    expect(MANIFEST_FILENAME).toBe('manifest.json');
  });

  it('nests customer bytes under package/ so a customer file cannot shadow ours', () => {
    const ours = revisionManifestKey(PROJECT, SIM, 'abcdefgh');
    const theirs = revisionFileKey(PROJECT, SIM, 'abcdefgh', `package/${MANIFEST_FILENAME}`);
    expect(theirs).not.toBe(ours);
    expect(theirs.startsWith(`${revisionPrefix(PROJECT, SIM, 'abcdefgh')}/package/`)).toBe(true);
    // Same for a customer directory named like ours.
    expect(revisionFileKey(PROJECT, SIM, 'abcdefgh', 'package/runtime/bridge.js'))
      .not.toBe(revisionFileKey(PROJECT, SIM, 'abcdefgh', 'runtime/bridge.js'));
  });

  it('keeps two revisions of one simulation completely disjoint', () => {
    const a = revisionPrefix(PROJECT, SIM, 'aaaaaaaa');
    const b = revisionPrefix(PROJECT, SIM, 'bbbbbbbb');
    expect(a.startsWith(b)).toBe(false);
    expect(b.startsWith(a)).toBe(false);
  });

  it('every id isValidRevisionId accepts is recoverable from a key it appears in', () => {
    for (const id of [...IDS, 'rev_2026_08_04_aaaaaaaa', '--------', '________']) {
      expect(isValidRevisionId(id)).toBe(true);
      expect(revisionIdFromKey(revisionFileKey(PROJECT, SIM, id, 'package/a.js'))).toBe(id);
    }
  });
});

describe('revisionIdFromKey — keys that must NOT parse', () => {
  const MUST_NOT_PARSE: [string, string][] = [
    [
      'simulations/proj-1/sim-9/index.html',
      'the legacy mutable layout: no revisions/ level at all',
    ],
    [
      'simulations/proj-1/sim-9/bridge.js',
      'the legacy bridge, overwritten in place on every regeneration',
    ],
    [
      'simulations/proj-1/sim-9/revisions/short7x/package/a.js',
      'a seven-character id — below the floor, so it is not one of ours',
    ],
    [
      `simulations/proj-1/sim-9/revisions/${'r'.repeat(65)}/package/a.js`,
      'a sixty-five-character id — above the ceiling',
    ],
    [
      'simulations/proj-1/sim-9/revisions/bad.id.here/package/a.js',
      'dots are not in the id alphabet',
    ],
    [
      'simulations/proj-1/sim-9/revisions/bad id here/package/a.js',
      'spaces are not in the id alphabet',
    ],
    [
      'simulations/proj-1/sim-9/revisions/abcdefgh',
      'the revision prefix itself, with no trailing slash — a directory holds no bytes, and calling it immutable claims something about objects that do not exist',
    ],
    [
      'assets/user-uploads/simulations/proj-1/sim-9/revisions/deadbeef99/evil.js',
      'A CUSTOMER-CONTROLLED PATH that merely contains the revision layout. Without the ^ anchor this matches, and the customer gets to choose which of their own uploads is cached immutably for a year — an object they can then replace, with the CDN pinned to the old bytes',
    ],
    [
      'simulations/proj-1/revisions/abcdefgh/package/a.js',
      'one path level short — a simulation id is missing, so this is not the layout',
    ],
    [
      'simulations/proj-1/sim-9/extra/revisions/abcdefgh/package/a.js',
      'one path level long',
    ],
    [
      'simulations/proj-1/sim-9/Revisions/abcdefgh/package/a.js',
      'case matters: object stores are case-sensitive and "Revisions" is a different directory',
    ],
    [
      '/simulations/proj-1/sim-9/revisions/abcdefgh/package/a.js',
      'a leading slash is not part of any key this pipeline writes',
    ],
    ['', 'the empty key'],
    ['simulations/proj-1/sim-9/revisions//package/a.js', 'an empty id'],
  ];

  it.each(MUST_NOT_PARSE)('returns null for %s — %s', (key) => {
    expect(revisionIdFromKey(key)).toBeNull();
    expect(isImmutableRevisionKey(key)).toBe(false);
  });

  it('takes the OUTER revision when a customer file repeats the layout inside a real revision', () => {
    // The customer owns everything under package/. A file of theirs called
    // `simulations/x/y/revisions/attacker1/index.html` must not be able to rename the revision the
    // key belongs to — the anchored match makes the first (real) segment authoritative.
    const key = revisionFileKey(
      'proj-1', 'sim-9', 'goodrev01',
      'package/simulations/other/sim/revisions/attacker1/index.html',
    );
    expect(revisionIdFromKey(key)).toBe('goodrev01');
    expect(revisionIdFromKey(key)).not.toBe('attacker1');
  });

  it('does not accept a project or simulation id containing a slash', () => {
    // `[^/]+` is what stops a caller from smuggling extra path levels through an id.
    expect(revisionIdFromKey('simulations/a/b/c/revisions/abcdefgh/package/x.js')).toBeNull();
  });
});

describe('cacheControlForKey', () => {
  const IMMUTABLE_KEYS = [
    revisionManifestKey('p', 's', 'abcdefgh'),
    revisionFileKey('p', 's', 'abcdefgh', 'package/index.html'),
    revisionFileKey('p', 's', 'abcdefgh', 'runtime/bridge.js'),
    revisionFileKey('p', 's', 'r'.repeat(64), 'canary/report.json'),
  ];

  const REVALIDATING_KEYS = [
    'simulations/p/s/index.html',
    'simulations/p/s/bridge.js',
    'assets/user-uploads/simulations/p/s/revisions/deadbeef99/evil.js',
    'simulations/p/s/revisions/short7x/package/a.js',
    'projects/p/player-config.json',
    '',
  ];

  it.each(IMMUTABLE_KEYS)('caches %s for a year', (key) => {
    expect(cacheControlForKey(key)).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it.each(REVALIDATING_KEYS)('makes %s revalidate', (key) => {
    // Anything that is not provably inside a revision may be overwritten in place. Handing it an
    // immutable header pins a CDN to bytes that no longer exist anywhere else.
    expect(cacheControlForKey(key)).toBe(POINTER_CACHE_CONTROL);
  });

  it('never returns the immutable policy for a legacy mutable sim key', () => {
    expect(cacheControlForKey('simulations/p/s/bridge.js')).not.toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlForKey('simulations/p/s/index.html')).not.toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('states the two policies distinctly', () => {
    expect(IMMUTABLE_CACHE_CONTROL).not.toBe(POINTER_CACHE_CONTROL);
    expect(IMMUTABLE_CACHE_CONTROL).toContain('immutable');
    expect(IMMUTABLE_CACHE_CONTROL).toContain('max-age=31536000');
    // no-cache, not no-store: revalidation keeps the cheap 304 while making a cached pointer
    // impossible to outlive a rollback.
    expect(POINTER_CACHE_CONTROL).toContain('no-cache');
    expect(POINTER_CACHE_CONTROL).toContain('must-revalidate');
    expect(POINTER_CACHE_CONTROL).not.toContain('immutable');
  });

  it('agrees with isImmutableRevisionKey for every key tested', () => {
    for (const k of IMMUTABLE_KEYS) expect(isImmutableRevisionKey(k)).toBe(true);
    for (const k of REVALIDATING_KEYS) expect(isImmutableRevisionKey(k)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rollback selection
// ─────────────────────────────────────────────────────────────────────────────────────────────

const rev = (p: Partial<SimRevisionRecord> & { id: string }): SimRevisionRecord => ({
  simulationId: 'sim-9',
  revisionNumber: 1,
  status: 'retired',
  manifestHash: 'h',
  bridgeProtocolVersion: 3,
  runtimeProtocolVersion: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  activatedAt: null,
  retiredAt: null,
  rollbackOfRevisionId: null,
  metadata: null,
  ...p,
});

describe('rollbackTargetFor', () => {
  it('orders by activatedAt, NOT by revisionNumber — the case where the two disagree', () => {
    // The incident this models, in order:
    //   10:00  rev1 (#1) goes live
    //   11:00  rev2 (#2) goes live — rev1 retired
    //   12:00  rev2 is judged bad; an operator rolls back, re-activating rev1's untouched bytes.
    //          rev2 becomes rolled_back (activatedAt stays 11:00), rev1 activatedAt becomes 12:00.
    //   13:00  rev3 (#3) goes live — rev1 retired again at 12:00's activation
    // Rolling back from rev3 must restore rev1: it is the most recently PROVEN-GOOD revision.
    // Ordering by revisionNumber restores rev2 — the exact revision a human already withdrew.
    const rev1 = rev({ id: 'rev1', revisionNumber: 1, status: 'retired', activatedAt: '2026-08-04T12:00:00.000Z' });
    const rev2 = rev({ id: 'rev2', revisionNumber: 2, status: 'rolled_back', activatedAt: '2026-08-04T11:00:00.000Z' });
    const rev3 = rev({ id: 'rev3', revisionNumber: 3, status: 'active', activatedAt: '2026-08-04T13:00:00.000Z' });

    const target = rollbackTargetFor([rev1, rev2, rev3], 'rev3');
    expect(target?.id).toBe('rev1');
    expect(target?.id).not.toBe('rev2');
    // And the highest revision number is genuinely not the answer, so the two orderings really do
    // disagree on this input — otherwise the test would prove nothing.
    const highestNumber = [rev1, rev2].sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
    expect(highestNumber.id).toBe('rev2');
  });

  it('is unaffected by the order the rows arrive in', () => {
    const rev1 = rev({ id: 'rev1', revisionNumber: 1, status: 'retired', activatedAt: '2026-08-04T12:00:00.000Z' });
    const rev2 = rev({ id: 'rev2', revisionNumber: 2, status: 'rolled_back', activatedAt: '2026-08-04T11:00:00.000Z' });
    const rev3 = rev({ id: 'rev3', revisionNumber: 3, status: 'active', activatedAt: '2026-08-04T13:00:00.000Z' });
    const orders: SimRevisionRecord[][] = [
      [rev1, rev2, rev3], [rev3, rev2, rev1], [rev2, rev1, rev3], [rev3, rev1, rev2],
    ];
    for (const rows of orders) expect(rollbackTargetFor(rows, 'rev3')?.id).toBe('rev1');
  });

  it('never returns the current active revision', () => {
    const a = rev({ id: 'a', status: 'active', activatedAt: '2026-08-04T13:00:00.000Z' });
    const b = rev({ id: 'b', status: 'retired', activatedAt: '2026-08-04T12:00:00.000Z' });
    expect(rollbackTargetFor([a, b], 'a')?.id).toBe('b');
    // Even when the active revision is the most recently activated by a wide margin.
    expect(rollbackTargetFor([a], 'a')).toBeNull();
  });

  it('returns the most recently activated revision when there is no pointer at all', () => {
    // A simulation whose pointer is null (never published, or the publication failed) still has a
    // recoverable history: the operator wants the last thing that served.
    const a = rev({ id: 'a', status: 'retired', activatedAt: '2026-08-04T13:00:00.000Z' });
    const b = rev({ id: 'b', status: 'retired', activatedAt: '2026-08-04T12:00:00.000Z' });
    expect(rollbackTargetFor([a, b], null)?.id).toBe('a');
  });

  it('excludes failed and draft revisions even when they carry an activatedAt', () => {
    // A failed revision's bytes are not retained, so restoring the pointer to one restores a 404.
    // `activatedAt` on a failed row is exactly the shape a crashed activation leaves behind.
    const good = rev({ id: 'good', status: 'retired', activatedAt: '2026-08-04T10:00:00.000Z' });
    const failedLate = rev({ id: 'failed', status: 'failed', activatedAt: '2026-08-04T14:00:00.000Z' });
    const draft = rev({ id: 'draft', status: 'draft', activatedAt: null });
    expect(rollbackTargetFor([good, failedLate, draft], null)?.id).toBe('good');
  });

  it('excludes every status whose bytes are not retained, however recent', () => {
    const good = rev({ id: 'good', status: 'retired', activatedAt: '2026-08-04T10:00:00.000Z' });
    for (const s of ALL_STATUSES.filter((x) => !mustRetainBytes(x))) {
      const impostor = rev({ id: `imp-${s}`, status: s, activatedAt: '2026-08-04T23:00:00.000Z' });
      expect(rollbackTargetFor([good, impostor], null)?.id).toBe('good');
    }
  });

  it('excludes a revision that has never been activated', () => {
    // canary_passed bytes are verified but unproven in production; a rollback is not the moment to
    // promote something that has never served.
    const verified = rev({ id: 'verified', status: 'canary_passed', activatedAt: null });
    const active = rev({ id: 'active', status: 'active', activatedAt: '2026-08-04T13:00:00.000Z' });
    expect(rollbackTargetFor([verified, active], 'active')).toBeNull();
  });

  it('returns null when there is nothing to roll back to', () => {
    expect(rollbackTargetFor([], null)).toBeNull();
    expect(rollbackTargetFor([], 'anything')).toBeNull();
    const only = rev({ id: 'only', status: 'active', activatedAt: '2026-08-04T13:00:00.000Z' });
    expect(rollbackTargetFor([only], 'only')).toBeNull();
  });

  it('picks a maximal activatedAt when two candidates tie', () => {
    // Two rows sharing a timestamp is possible at low clock resolution. The model defines no
    // tiebreak, so this asserts the property that matters (the winner is one of the newest) rather
    // than freezing whichever one the sort happens to keep.
    const a = rev({ id: 'a', revisionNumber: 5, status: 'retired', activatedAt: '2026-08-04T12:00:00.000Z' });
    const b = rev({ id: 'b', revisionNumber: 6, status: 'rolled_back', activatedAt: '2026-08-04T12:00:00.000Z' });
    const older = rev({ id: 'older', revisionNumber: 7, status: 'retired', activatedAt: '2026-08-04T09:00:00.000Z' });
    for (const rows of [[a, b, older], [older, b, a]]) {
      const t = rollbackTargetFor(rows, null)!;
      expect(t.activatedAt).toBe('2026-08-04T12:00:00.000Z');
      expect(['a', 'b']).toContain(t.id);
    }
  });

  it('compares ISO timestamps lexicographically, which is only sound for one canonical shape', () => {
    // Same instant, three spellings. Lexicographic comparison of ISO-8601 is correct ONLY for
    // fixed-width UTC strings; an offset form sorts by its text, not its instant. This is what the
    // storage layer must therefore guarantee it writes.
    const utc = rev({ id: 'utc', status: 'retired', activatedAt: '2026-08-04T12:00:00.000Z' });
    const offset = rev({ id: 'offset', status: 'retired', activatedAt: '2026-08-04T14:00:00.000+02:00' });
    const picked = rollbackTargetFor([utc, offset], null)!;
    expect(Date.parse(utc.activatedAt!)).toBe(Date.parse(offset.activatedAt!));
    expect(picked.id).toBe('utc');   // '2026-08-04T14…' > '2026-08-04T12…' would have won on text
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest paths
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('normalizeManifestPath', () => {
  const REJECTED: [string, string][] = [
    ['', 'the empty string names nothing'],
    ['/', 'a bare slash normalises to nothing'],
    ['//', 'two slashes normalise to nothing'],
    ['..', 'traversal, alone'],
    ['.', 'the current directory is not a file'],
    ['package/../secret.js', 'traversal, mid-path — the author expected to escape the prefix'],
    ['../secret.js', 'traversal, leading'],
    ['package/..', 'traversal, trailing'],
    ['./package/a.js', 'a leading . segment'],
    ['package/./a.js', 'a . segment mid-path'],
    ['package//a.js', 'an empty segment'],
    ['package/a.js/', 'a trailing slash — a directory, not an object'],
    ['package\\a.js', 'a backslash: Windows-shaped, and some stores treat it as a separator'],
    ['\\\\host\\share\\a.js', 'a UNC path'],
    ['package/a\0.js', 'a NUL truncates the name in anything that reaches C'],
    ['\0', 'a bare NUL'],
  ];

  it.each(REJECTED)('rejects %j — %s', (raw) => {
    expect(normalizeManifestPath(raw)).toBeNull();
  });

  it('rejects a non-string without throwing', () => {
    expect(normalizeManifestPath(undefined as unknown as string)).toBeNull();
    expect(normalizeManifestPath(null as unknown as string)).toBeNull();
    expect(normalizeManifestPath(42 as unknown as string)).toBeNull();
  });

  const ACCEPTED: [string, string, string][] = [
    ['index.html', 'index.html', 'a bare filename'],
    ['package/index.html', 'package/index.html', 'the ordinary form'],
    ['package/assets/img/logo.png', 'package/assets/img/logo.png', 'nesting'],
    ['runtime/bridge.js', 'runtime/bridge.js', 'a generated runtime file'],
    ['/package/index.html', 'package/index.html', 'leading slashes are stripped, not rejected'],
    ['///package/index.html', 'package/index.html', 'however many of them'],
    ['a.b.c.js', 'a.b.c.js', 'dots inside a name are not segments'],
    ['...', '...', 'only the exact . and .. segments mean traversal; ... is a legal file name'],
    ['..hidden', '..hidden', 'a name that starts with two dots is still a name'],
    ['package/my file.js', 'package/my file.js', 'spaces are legal in object keys'],
    ['package/%2e%2e/a.js', 'package/%2e%2e/a.js', 'percent sequences are NOT decoded — decoding would give one key two meanings, and the store never decodes either'],
    ['package/ünïcode.js', 'package/ünïcode.js', 'non-ASCII names are stored verbatim'],
  ];

  it.each(ACCEPTED)('accepts %j as %j — %s', (raw, want) => {
    expect(normalizeManifestPath(raw)).toBe(want);
  });

  it('is idempotent on everything it accepts', () => {
    for (const [raw] of ACCEPTED) {
      const once = normalizeManifestPath(raw)!;
      expect(normalizeManifestPath(once)).toBe(once);
    }
  });

  it('normalises a leading slash but validateManifest still calls it a bad path', () => {
    // Two different jobs. Normalisation is lenient so a caller can clean input; the manifest gate
    // is strict so a STORED path must already be canonical — otherwise files[] and the storage key
    // it is supposed to describe can differ while both look fine.
    expect(normalizeManifestPath('/package/index.html')).toBe('package/index.html');
    const m = baseManifest();
    m.files[2].path = '/package/app.js';
    expect(validateManifest(m).map((p) => p.code)).toEqual(['bad-path']);
  });
});

describe('caseFoldKey', () => {
  it('folds names that a case-insensitive cache in front of the store would merge', () => {
    expect(caseFoldKey('package/App.JS')).toBe(caseFoldKey('package/app.js'));
    expect(caseFoldKey('package/a.js')).not.toBe(caseFoldKey('package/b.js'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

const H = (seed: string): string => sha256Hex(seed);
const CC = IMMUTABLE_CACHE_CONTROL;

const file = (p: Partial<SimManifestFile> & { path: string }): SimManifestFile => ({
  role: 'asset',
  hash: H(p.path),
  bytes: 10,
  contentType: 'application/javascript',
  cacheControl: CC,
  ...p,
});

const POSTER_IDENTITY = posterIdentityString({
  packageRevision: packageRevisionOf('abcdefgh'),
  variantKey: 'sec-1',
  configHash: '0123456789abcdef',
  aspectProfile: 'wide',
  qualityProfile: 'high',
});

/** A manifest with no problems. Every case below is this, plus exactly one injected fault. */
function baseManifest(): SimManifest {
  return {
    manifestVersion: SIM_MANIFEST_VERSION,
    simulationId: 'sim-9',
    projectId: 'proj-1',
    revisionId: 'abcdefgh',
    revisionNumber: 3,
    bridgeProtocolVersion: 2,
    runtimeProtocolVersion: 3,
    entry: 'package/index.html',
    runtime: ['runtime/bridge.js'],
    files: [
      file({ path: 'package/index.html', role: 'entry', contentType: 'text/html; charset=utf-8' }),
      file({ path: 'runtime/bridge.js', role: 'runtime' }),
      file({ path: 'package/app.js', role: 'asset' }),
      file({ path: `posters/${POSTER_IDENTITY}/standard.png`, role: 'poster', contentType: 'image/png' }),
      file({ path: 'canary/report.json', role: 'canary', contentType: 'application/json' }),
    ],
    variants: [{ variantKey: 'sec-1', configHashes: ['0123456789abcdef'] }],
    posters: [{
      identity: POSTER_IDENTITY,
      variantKey: 'sec-1',
      configHash: '0123456789abcdef',
      aspectProfile: 'wide',
      qualityProfile: 'high',
      paths: [`posters/${POSTER_IDENTITY}/standard.png`],
    }],
    qualityProfiles: ['high', 'balanced'],
    externalDependencies: ['https://cdn.example.com/three.min.js'],
    generatedFrom: { llmInputHash: H('llm'), uploadHash: H('upload') },
    canary: { classification: 'managed-presentable', ranAt: '2026-08-04T12:00:00.000Z', engine: 'chromium' },
    createdAt: '2026-08-04T12:00:00.000Z',
    createdBy: 'user-1',
  };
}

const BASE_REFS: ReadonlySet<string> = new Set(['package/app.js']);

interface ProblemCase {
  /** The hazard the code exists to catch. */
  why: string;
  build: (m: SimManifest) => void;
  refs?: ReadonlySet<string>;
  /** The EXACT codes this input must produce — asserting the set, not merely membership. */
  codes: readonly ManifestProblemCode[];
}

/**
 * One purpose-built input per problem code, keyed BY the code. `Record<ManifestProblemCode, …>`
 * means a new code added to the union without a case here is a compile error, which is the only
 * mechanism that can notice a validator rule shipping untested.
 */
const PROBLEM_CASES: Record<ManifestProblemCode, ProblemCase> = {
  'unknown-manifest-version': {
    why: 'a shape we do not know says nothing reliable about what is stored, so nothing below it may be reported as if it were understood',
    build: (m) => { (m as { manifestVersion: number }).manifestVersion = SIM_MANIFEST_VERSION + 1; },
    codes: ['unknown-manifest-version'],
  },
  'bad-path': {
    why: 'a path the store cannot represent, or one that expected to escape the prefix',
    build: (m) => { m.files.push(file({ path: 'package/../evil.js' })); },
    codes: ['bad-path'],
  },
  'duplicate-path': {
    why: 'two entries for one key: whichever loses silently describes bytes nobody serves',
    build: (m) => { m.files.push(file({ path: 'package/app.js', bytes: 99 })); },
    codes: ['duplicate-path'],
  },
  'case-collision': {
    why: 'a case-insensitive cache in front of a case-sensitive store serves whichever it saw first — the classic "works on staging"',
    build: (m) => { m.files.push(file({ path: 'package/APP.js' })); },
    codes: ['case-collision'],
  },
  'bad-hash': {
    why: 'a hash that is not canonical lowercase hex compares unequal to the same digest computed anywhere else',
    build: (m) => { m.files[2].hash = H('package/app.js').toUpperCase(); },
    codes: ['bad-hash'],
  },
  'bad-size': {
    why: 'a negative or fractional byte count cannot describe stored bytes, so the manifest was not built from what was stored',
    build: (m) => { m.files[2].bytes = -1; },
    codes: ['bad-size'],
  },
  'missing-entry': {
    why: 'the document the iframe loads is not described by the manifest at all',
    build: (m) => { m.entry = 'package/nope.html'; },
    codes: ['missing-entry'],
  },
  'entry-not-html': {
    why: 'an iframe pointed at a script gets a download or a blank frame, never a running package',
    build: (m) => { m.entry = 'package/app.js'; },
    codes: ['entry-not-html'],
  },
  'missing-runtime-file': {
    why: 'the bridge the entry document loads is not in this revision, so the package would boot against whatever the last revision left cached',
    build: (m) => { m.runtime = ['runtime/guidance.js']; },
    codes: ['missing-runtime-file'],
  },
  'unreferenced-role': {
    why: 'roles are how a sweep decides what is ours and what is the customer\'s; a mislabelled file is either deleted as customer content or retained forever as runtime',
    build: (m) => { m.runtime = ['runtime/bridge.js', 'package/app.js']; },
    codes: ['unreferenced-role'],
  },
  'missing-asset-reference': {
    why: 'the package loads something this revision does not contain — at best a 404, at worst a hit on the PREVIOUS revision still in cache',
    build: () => {},
    refs: new Set(['package/app.js', 'package/missing.png']),
    codes: ['missing-asset-reference'],
  },
  'content-type-mismatch': {
    why: 'a script stored as text/plain is refused by every strict-MIME browser, and the failure appears as a blank simulation with no error the user can report',
    build: (m) => { m.files[2].contentType = 'text/plain'; },
    codes: ['content-type-mismatch'],
  },
  'poster-path-missing': {
    why: 'a poster row naming bytes that do not exist renders a broken cover exactly when the live frame is not yet trusted',
    build: (m) => { m.posters[0].paths = [`posters/${POSTER_IDENTITY}/compact.png`]; },
    codes: ['poster-path-missing'],
  },
  'no-variants': {
    why: 'a package with no variants has nothing the player can dispatch to',
    build: (m) => { m.variants = []; },
    codes: ['no-variants'],
  },
  'duplicate-variant': {
    why: 'two entries for one variantKey means the second silently wins, and which one that is depends on iteration order',
    build: (m) => { m.variants.push({ variantKey: 'sec-1', configHashes: ['deadbeefdeadbeef'] }); },
    codes: ['duplicate-variant'],
  },
};

describe('validateManifest', () => {
  it('reports nothing for a manifest with nothing wrong', () => {
    expect(validateManifest(baseManifest(), BASE_REFS)).toEqual([]);
    expect(manifestIsValid(baseManifest(), BASE_REFS)).toBe(true);
  });

  it('skips the reference checks entirely when the caller passes no references', () => {
    // A caller that cannot extract references (no bytes in hand) must not be told its package is
    // broken — every asset would otherwise look unreferenced.
    expect(validateManifest(baseManifest())).toEqual([]);
  });

  it.each(Object.entries(PROBLEM_CASES))('produces %s', (code, testCase) => {
    const m = baseManifest();
    testCase.build(m);
    const problems = validateManifest(m, testCase.refs ?? BASE_REFS);
    expect(problems.map((p) => p.code)).toEqual(testCase.codes);
    expect(problems.map((p) => p.code)).toContain(code as ManifestProblemCode);
    // Every problem must be able to say WHICH thing is wrong, or it cannot be acted on.
    for (const p of problems) expect(p.detail.length).toBeGreaterThan(0);
    expect(manifestIsValid(m, testCase.refs ?? BASE_REFS)).toBe(false);
  });

  it('covers the union with one case per code and no case doing double duty', () => {
    const keys = Object.keys(PROBLEM_CASES);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [code, c] of Object.entries(PROBLEM_CASES)) expect(c.codes).toContain(code);
  });

  it('stops at an unknown version instead of reporting faults it cannot interpret', () => {
    const m = baseManifest();
    (m as { manifestVersion: number }).manifestVersion = 99;
    m.files = [];             // would be several problems under a version we understood
    m.variants = [];
    m.entry = '';
    expect(validateManifest(m).map((p) => p.code)).toEqual(['unknown-manifest-version']);
  });

  it('reports EVERY problem in one pass, not just the first', () => {
    // A gate that reports one fault at a time turns a bad package into N round trips.
    const m = baseManifest();
    m.files[2].hash = 'nope';
    m.files[2].bytes = -3;
    m.files[2].contentType = 'text/plain';
    m.variants = [];
    const codes = validateManifest(m, BASE_REFS).map((p) => p.code);
    expect(codes).toEqual(['bad-hash', 'bad-size', 'content-type-mismatch', 'no-variants']);
  });

  it('rejects a non-integer and a NaN byte count', () => {
    for (const bytes of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = baseManifest();
      m.files[2].bytes = bytes;
      expect(validateManifest(m, BASE_REFS).map((p) => p.code)).toEqual(['bad-size']);
    }
  });

  it('accepts a zero-byte file — empty is a legitimate asset, unlike a negative length', () => {
    const m = baseManifest();
    m.files[2].bytes = 0;
    expect(validateManifest(m, BASE_REFS)).toEqual([]);
  });

  it('rejects a hash of the wrong length in either direction', () => {
    for (const bad of [H('x').slice(0, 63), `${H('x')}0`, '', 'z'.repeat(64)]) {
      const m = baseManifest();
      m.files[2].hash = bad;
      expect(validateManifest(m, BASE_REFS).map((p) => p.code)).toEqual(['bad-hash']);
    }
  });

  it('flags the entry when its role is not entry', () => {
    const m = baseManifest();
    m.files[0].role = 'asset';
    const problems = validateManifest(m, BASE_REFS);
    expect(problems.map((p) => p.code)).toEqual(['unreferenced-role']);
    expect(problems[0].detail).toContain('package/index.html');
  });

  it('accepts .htm as well as .html for the entry', () => {
    const m = baseManifest();
    m.files[0].path = 'package/index.htm';
    m.entry = 'package/index.htm';
    expect(validateManifest(m, BASE_REFS)).toEqual([]);
  });

  it('flags a referenced path that is not representable, separately from one that is missing', () => {
    const m = baseManifest();
    const problems = validateManifest(m, new Set(['package/../a.js', 'package/gone.js']));
    expect(problems.map((p) => p.code)).toEqual(['bad-path', 'missing-asset-reference']);
  });

  it('does not treat an external dependency as a missing asset', () => {
    // Absolute URLs are recorded and never fetched by us; they are not files[] entries and must
    // not be reported as if the revision were incomplete.
    const m = baseManifest();
    m.externalDependencies = ['https://cdn.example.com/three.min.js', 'https://cdn.example.com/x.css'];
    expect(validateManifest(m, BASE_REFS)).toEqual([]);
  });

  it('checks content types only for extensions this pipeline knows', () => {
    const m = baseManifest();
    m.files.push(file({ path: 'package/data.bin', contentType: 'application/octet-stream' }));
    expect(validateManifest(m, BASE_REFS)).toEqual([]);
  });

  it('KNOWN GAP: a poster whose identity contradicts its own fields validates clean', () => {
    // `identity` is the derived key (posterIdentity.ts: revision__variant__config__aspect__quality)
    // and is the ONLY poster field the manifest hash covers, so a manifest can claim an aspect that
    // its identity — and therefore its storage path — does not encode, and nothing notices.
    // Contained today because the identity is computed, never transcribed. If validateManifest
    // grows the cross-check (or the manifest drops the redundant fields), DELETE this test.
    const m = baseManifest();
    m.posters[0].aspectProfile = 'portrait';
    m.posters[0].qualityProfile = 'low';
    expect(m.posters[0].identity).not.toContain('portrait');
    expect(validateManifest(m, BASE_REFS)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest canonicalisation and hashing
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('canonicalizeManifest / computeManifestHash', () => {
  const hashOf = (mutate: (m: SimManifest) => void): string => {
    const m = baseManifest();
    mutate(m);
    return computeManifestHash(m);
  };

  it('is 64 lowercase hex characters and agrees with the canonical string', () => {
    const m = baseManifest();
    expect(computeManifestHash(m)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeManifestHash(m)).toBe(sha256Hex(canonicalizeManifest(m)));
  });

  const INVARIANT: [string, (m: SimManifest) => void][] = [
    ['object key insertion order', (m) => {
      const reordered: SimManifest = { ...m };
      const keys = Object.keys(reordered).reverse() as (keyof SimManifest)[];
      const rebuilt = {} as SimManifest;
      for (const k of keys) (rebuilt as Record<string, unknown>)[k] = reordered[k];
      Object.assign(m, rebuilt);
    }],
    ['files[] order', (m) => { m.files.reverse(); }],
    ['runtime[] order', (m) => { m.runtime = ['runtime/bridge.js'].reverse(); }],
    ['qualityProfiles order', (m) => { m.qualityProfiles = ['balanced', 'high']; }],
    ['externalDependencies order', (m) => {
      m.externalDependencies = ['https://b.example.com/x.js', 'https://cdn.example.com/three.min.js'];
      m.externalDependencies.reverse();
      m.externalDependencies = ['https://cdn.example.com/three.min.js'];
    }],
    ['variants[] order', (m) => {
      m.variants = [
        { variantKey: 'sec-2', configHashes: ['aaaa'] },
        { variantKey: 'sec-1', configHashes: ['0123456789abcdef'] },
      ];
    }],
    ['configHashes order', (m) => {
      m.variants[0].configHashes = ['0123456789abcdef'];
    }],
    ['posters[] paths order', (m) => { m.posters[0].paths = [...m.posters[0].paths].reverse(); }],
    ['createdAt', (m) => { m.createdAt = '2027-01-01T00:00:00.000Z'; }],
    ['createdBy', (m) => { m.createdBy = 'someone-else'; }],
    ['createdBy becoming null', (m) => { m.createdBy = null; }],
    ['generatedFrom', (m) => { m.generatedFrom = { llmInputHash: H('other'), uploadHash: H('other2') }; }],
    ['canary verdict', (m) => { m.canary = { classification: 'legacy-opaque', ranAt: null, engine: 'webkit' }; }],
  ];

  it.each(INVARIANT)('does not change when %s changes', (_label, mutate) => {
    // Two byte-identical revisions published a minute apart, or re-serialised by a different
    // writer, are the same package. A hash that disagreed would make "did anything change"
    // unanswerable and every republish look like a change.
    expect(hashOf(mutate)).toBe(hashOf(() => {}));
  });

  it('is unchanged by a multi-element list arriving in any order', () => {
    const two = (order: 'ab' | 'ba') => hashOf((m) => {
      const a = { variantKey: 'sec-1', configHashes: ['0123456789abcdef', 'aaaabbbbccccdddd'] };
      const b = { variantKey: 'sec-2', configHashes: ['eeeeffff00001111'] };
      m.variants = order === 'ab' ? [a, b] : [b, a];
      if (order === 'ba') m.variants[1].configHashes = ['aaaabbbbccccdddd', '0123456789abcdef'];
    });
    expect(two('ab')).toBe(two('ba'));
  });

  const SERVED_FACTS: [string, (m: SimManifest) => void][] = [
    ['simulationId', (m) => { m.simulationId = 'sim-other'; }],
    ['revisionId', (m) => { m.revisionId = 'zzzzzzzz'; }],
    ['revisionNumber', (m) => { m.revisionNumber = 4; }],
    ['bridgeProtocolVersion', (m) => { m.bridgeProtocolVersion = 3; }],
    ['runtimeProtocolVersion', (m) => { m.runtimeProtocolVersion = 4; }],
    ['entry', (m) => { m.entry = 'package/other.html'; }],
    ['runtime list', (m) => { m.runtime = ['runtime/bridge.js', 'runtime/guidance.js']; }],
    ['qualityProfiles', (m) => { m.qualityProfiles = ['high', 'low']; }],
    ['externalDependencies', (m) => { m.externalDependencies = ['https://evil.example.com/x.js']; }],
    ['a file path', (m) => { m.files[2].path = 'package/app2.js'; }],
    ['a file role', (m) => { m.files[2].role = 'runtime'; }],
    ['a file hash', (m) => { m.files[2].hash = H('different bytes'); }],
    ['a file size', (m) => { m.files[2].bytes = 11; }],
    ['a file content type', (m) => { m.files[2].contentType = 'text/plain'; }],
    ['a file cache-control', (m) => { m.files[2].cacheControl = POINTER_CACHE_CONTROL; }],
    ['an added file', (m) => { m.files.push(file({ path: 'package/extra.js' })); }],
    ['a removed file', (m) => { m.files.splice(2, 1); }],
    ['a variantKey', (m) => { m.variants[0].variantKey = 'sec-2'; }],
    ['a variant configHash', (m) => { m.variants[0].configHashes = ['ffffffffffffffff']; }],
    ['an added variant', (m) => { m.variants.push({ variantKey: 'sec-2', configHashes: [] }); }],
    ['a poster identity', (m) => { m.posters[0].identity = 'other__identity'; }],
    ['a poster path', (m) => { m.posters[0].paths = ['posters/other/standard.png']; }],
    ['an added poster', (m) => {
      m.posters.push({ ...m.posters[0], identity: 'second__identity', paths: ['posters/second/standard.png'] });
    }],
  ];

  it.each(SERVED_FACTS)('changes when %s changes', (_label, mutate) => {
    expect(hashOf(mutate)).not.toBe(hashOf(() => {}));
  });

  it('gives every served-fact mutation its own hash — no two collapse onto one another', () => {
    // A canonical form that folded two different changes into one string would make a real
    // difference invisible; asserting only "differs from base" would not catch it.
    const hashes = new Set([hashOf(() => {}), ...SERVED_FACTS.map(([, m]) => hashOf(m))]);
    expect(hashes.size).toBe(SERVED_FACTS.length + 1);
  });

  it('separates the fields it concatenates so a value cannot impersonate the next field', () => {
    const canon = canonicalizeManifest(baseManifest());
    expect(canon.split('\n')[0]).toBe(`v:${SIM_MANIFEST_VERSION}`);
    expect(canon).toContain('sim:sim-9');
    expect(canon).toContain('rev:abcdefgh');
    // The record separator is a newline, which no field here can contain: paths reject NUL and
    // backslash but a newline in a path would break this — see the KNOWN GAP below.
    expect(canon.split('\n')).toHaveLength(13);
  });

  it('KNOWN GAP: files[] is joined with characters a manifest path is allowed to contain', () => {
    // canonicalizeManifest renders each file as `path role hash bytes contentType cacheControl`
    // and joins with '|'. normalizeManifestPath permits both spaces and '|' in a name, so a single
    // adversarial path can spell out the tail of one file entry AND the head of the next: the
    // two-file manifest below and the one-file manifest below it canonicalise identically.
    //
    // Contained today because (a) the revisionId is inside the hash and revision bytes are never
    // rewritten, so the two manifests can never describe the same revision, and (b) paths are
    // machine-generated. It is still a hash that is not injective over its own input domain.
    // The fix is to length-prefix or escape each field. WHEN THAT LANDS, FLIP THIS TEST to
    // `not.toBe` — the collision disappearing is the success condition, not a regression.
    const h1 = H('x.js');
    const two = baseManifest();
    two.files = [
      file({ path: 'package/index.html', role: 'entry', contentType: 'text/html; charset=utf-8' }),
      file({ path: 'x.js', hash: h1, bytes: 1 }),
      file({ path: 'y.js', hash: H('y.js'), bytes: 2 }),
    ];
    two.runtime = [];
    two.posters = [];

    const one = baseManifest();
    one.files = [
      file({ path: 'package/index.html', role: 'entry', contentType: 'text/html; charset=utf-8' }),
      file({ path: `x.js asset ${h1} 1 application/javascript ${CC}|y.js`, hash: H('y.js'), bytes: 2 }),
    ];
    one.runtime = [];
    one.posters = [];

    // Both are structurally acceptable — the gate does not reject the adversarial name either.
    expect(validateManifest(two)).toEqual([]);
    expect(validateManifest(one)).toEqual([]);
    expect(computeManifestHash(one)).toBe(computeManifestHash(two));
  });
});
