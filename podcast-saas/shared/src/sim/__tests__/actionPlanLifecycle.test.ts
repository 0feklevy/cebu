/**
 * The reset-generation coordinator, driven by a fake clock.
 *
 * ADR §6.6 requires the lifecycle to be proven: single reset generation, ordered barriers,
 * deadlines, fail-closed. The four `describe` blocks below are those four properties, and each one
 * is stated as the thing that would go wrong rather than as the mechanism that prevents it — a
 * test named after the implementation stops being a check the moment the implementation changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ResetCoordinator,
  type Barrier,
  type FailureKind,
  type FreshnessEvidence,
  type RejectReason,
} from '../actionPlanLifecycle.js';

const EXPECTED: FreshnessEvidence = {
  documentId: 'doc-2',
  revisionId: 'rev-1',
  packageHash: 'pkg-1',
  baselineControlHash: 'base-1',
};

const GENERIC: Barrier[] = ['ready', 'painted', 'prepared', 'plan-ready'];
const SEEKABLE: Barrier[] = ['ready', 'painted', 'prepared', 'plan-ready', 'clock-applied'];
const TIMEOUT = 5000;

interface H {
  coord: ResetCoordinator;
  t: number;
  advance(ms: number): void;
  covers: number[];
  navigations: Array<{ generation: number; nonce: string }>;
  reveals: number[];
  failures: Array<{ kind: FailureKind; generation: number; barrier?: Barrier }>;
  rejects: Array<{ reason: RejectReason; barrier?: Barrier }>;
  /** Walk the happy path for one generation, up to but not including the final barrier. */
  bringUp(docId?: string, barriers?: Barrier[]): void;
}

function harness(required: Barrier[] = GENERIC, expected = EXPECTED): H {
  const h: Partial<H> & { t: number } = {
    t: 1000,
    covers: [], navigations: [], reveals: [], failures: [], rejects: [],
  };
  h.advance = (ms: number) => { h.t += ms; };
  const coord = new ResetCoordinator(
    { required, barrierTimeoutMs: TIMEOUT, expected },
    { now: () => h.t, nonce: (g) => `nonce-${g}` },
    {
      cover: (g) => h.covers!.push(g),
      navigate: (g, nonce) => h.navigations!.push({ generation: g, nonce }),
      reveal: (g) => h.reveals!.push(g),
      fail: (kind, g, barrier) => h.failures!.push({ kind, generation: g, barrier }),
      rejected: (reason, _g, barrier) => h.rejects!.push({ reason, barrier }),
    },
  );
  h.coord = coord;
  h.bringUp = (docId = 'doc-2', barriers = required.slice(0, -1)) => {
    coord.markDirty();
    coord.onNavigated(coord.currentGeneration(), docId);
    coord.reportFreshness(coord.currentGeneration(), { ...expected, documentId: docId });
    for (const b of barriers) coord.onBarrier(coord.currentGeneration(), docId, b);
  };
  return h as H;
}

let h: H;
beforeEach(() => { h = harness(); });

// ── 1. ONE GENERATION ────────────────────────────────────────────────────────

describe('exactly one reset generation', () => {
  it('several reasons to reset, arriving before the first finishes, produce ONE navigation', () => {
    h.coord.markDirty();          // a seek
    h.coord.requestEntry();       // a re-entry while it is still loading
    h.coord.markDirty();          // another seek
    h.coord.requestEntry();

    expect(h.coord.navigationCount(), 'a second document was brought up').toBe(1);
    expect(h.covers).toEqual([1]);
    expect(h.navigations).toEqual([{ generation: 1, nonce: 'nonce-1' }]);
  });

  it('joining does not reset progress already made', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onBarrier(1, 'doc-2', 'ready');
    h.coord.requestEntry();       // joins

    expect(h.coord.metBarriers()).toEqual(['ready']);
    expect(h.coord.navigationCount()).toBe(1);
  });

  it('covers before it navigates, every time', () => {
    h.coord.markDirty();
    // The old frame must be hidden BEFORE the new document starts loading — otherwise the reset is
    // visible as a flash of the outgoing content.
    expect(h.covers).toEqual([1]);
    expect(h.navigations.length).toBe(1);
  });

  it('a fresh reset after a completed one is a NEW generation with a new nonce', () => {
    h.bringUp();
    h.coord.onBarrier(1, 'doc-2', 'plan-ready');
    expect(h.reveals).toEqual([1]);

    h.coord.markDirty();
    expect(h.coord.currentGeneration()).toBe(2);
    // A different nonce is what makes assigning the SAME url actually navigate.
    expect(h.navigations.at(-1)).toEqual({ generation: 2, nonce: 'nonce-2' });
  });
});

// ── 2. BARRIERS ARE ORDERED AND GENERATION-STAMPED ───────────────────────────

describe('barriers', () => {
  it('reveals only after every required barrier, in order', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.reportFreshness(1, EXPECTED);

    for (const b of GENERIC) {
      expect(h.reveals, `revealed before ${b}`).toEqual([]);
      h.coord.onBarrier(1, 'doc-2', b);
    }
    expect(h.reveals).toEqual([1]);
  });

  it('refuses a barrier that arrives out of sequence', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onBarrier(1, 'doc-2', 'plan-ready');       // skipping ready/painted/prepared

    expect(h.rejects).toEqual([{ reason: 'out-of-order-barrier', barrier: 'plan-ready' }]);
    expect(h.coord.metBarriers()).toEqual([]);
  });

  it('refuses a repeated barrier, so one ack cannot stand in for two', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onBarrier(1, 'doc-2', 'ready');
    h.coord.onBarrier(1, 'doc-2', 'ready');

    expect(h.rejects).toEqual([{ reason: 'duplicate-barrier', barrier: 'ready' }]);
  });

  it('refuses a barrier from the PREVIOUS generation — it is true about a dead activation', () => {
    h.bringUp();
    h.coord.onBarrier(1, 'doc-2', 'plan-ready');
    h.coord.markDirty();                                // generation 2 begins

    h.coord.onBarrier(1, 'doc-2', 'ready');
    expect(h.rejects.at(-1)).toEqual({ reason: 'stale-generation', barrier: 'ready' });
  });

  it('refuses a barrier from a document this generation is not waiting on', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onBarrier(1, 'doc-OTHER', 'ready');

    expect(h.rejects).toEqual([{ reason: 'wrong-document', barrier: 'ready' }]);
  });

  it('refuses a barrier the policy never asked for, rather than ignoring it', () => {
    // A child announcing CLOCK_APPLIED for a generic plan disagrees with the parent about the
    // plan's execution policy. Silence would hide that.
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onBarrier(1, 'doc-2', 'clock-applied');

    expect(h.rejects).toEqual([{ reason: 'barrier-not-required', barrier: 'clock-applied' }]);
  });

  it('a seekable policy additionally waits for clock-applied', () => {
    const s = harness(SEEKABLE);
    s.bringUp();                                        // everything except the last
    expect(s.reveals, 'revealed without the clock').toEqual([]);
    s.coord.onBarrier(1, 'doc-2', 'clock-applied');
    expect(s.reveals).toEqual([1]);
  });
});

// ── 3. DEADLINES ─────────────────────────────────────────────────────────────

describe('deadlines', () => {
  it('a document that goes quiet fails the generation instead of holding the cover forever', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onBarrier(1, 'doc-2', 'ready');

    h.advance(TIMEOUT - 1);
    h.coord.tick();
    expect(h.failures).toEqual([]);

    h.advance(2);
    h.coord.tick();
    expect(h.failures).toEqual([{ kind: 'barrier-timeout', generation: 1, barrier: 'painted' }]);
    expect(h.reveals, 'a timeout must never reveal').toEqual([]);
  });

  it('the deadline is per barrier — progress resets the clock', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    for (const b of ['ready', 'painted', 'prepared'] as Barrier[]) {
      h.advance(TIMEOUT - 1);
      h.coord.tick();
      h.coord.onBarrier(1, 'doc-2', b);
    }
    // Well past TIMEOUT in total, but never TIMEOUT without progress.
    expect(h.failures).toEqual([]);
  });

  it('a document error fails immediately, without waiting out the deadline', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onDocumentError(1);

    expect(h.failures).toEqual([{ kind: 'document-error', generation: 1, barrier: undefined }]);
    expect(h.coord.currentState()).toBe('failed');
  });

  it('a failed generation accepts nothing further', () => {
    h.coord.markDirty();
    h.coord.onNavigated(1, 'doc-2');
    h.coord.onDocumentError(1);
    h.coord.onBarrier(1, 'doc-2', 'ready');

    expect(h.rejects.at(-1)?.reason).toBe('stale-generation');
    expect(h.reveals).toEqual([]);
  });
});

// ── 4. FAIL CLOSED ───────────────────────────────────────────────────────────

describe('fail closed', () => {
  it('a new documentId is NOT proof of a pristine document — freshness is re-checked at reveal', () => {
    // localStorage, IndexedDB, a service worker and a server-side side effect all survive a reload.
    // The review's rule is that documentId alone is a necessary condition, never a sufficient one.
    const f = harness(GENERIC);
    f.coord.markDirty();
    f.coord.onNavigated(1, 'doc-2');
    f.coord.reportFreshness(1, { ...EXPECTED, baselineControlHash: 'base-DRIFTED' });
    for (const b of GENERIC) f.coord.onBarrier(1, 'doc-2', b);

    expect(f.reveals).toEqual([]);
    expect(f.failures).toEqual([{ kind: 'freshness-mismatch', generation: 1, barrier: undefined }]);
  });

  it('a revision or package that does not match the plan fails, even with every barrier met', () => {
    for (const drift of [{ revisionId: 'rev-OTHER' }, { packageHash: 'pkg-OTHER' }]) {
      const f = harness(GENERIC);
      f.coord.markDirty();
      f.coord.onNavigated(1, 'doc-2');
      f.coord.reportFreshness(1, { ...EXPECTED, ...drift });
      for (const b of GENERIC) f.coord.onBarrier(1, 'doc-2', b);
      expect(f.reveals).toEqual([]);
      expect(f.failures[0].kind).toBe('freshness-mismatch');
    }
  });

  it('ABSENT freshness evidence is a mismatch, not an assumption of health', () => {
    const f = harness(GENERIC);
    f.coord.markDirty();
    f.coord.onNavigated(1, 'doc-2');
    // reportFreshness deliberately never called.
    for (const b of GENERIC) f.coord.onBarrier(1, 'doc-2', b);

    expect(f.reveals).toEqual([]);
    expect(f.failures[0].kind).toBe('freshness-mismatch');
  });

  it('freshness reported for a stale generation is refused, so it cannot vouch for the new one', () => {
    h.bringUp();
    h.coord.onBarrier(1, 'doc-2', 'plan-ready');
    h.coord.markDirty();                                // generation 2
    h.coord.reportFreshness(1, EXPECTED);               // evidence from generation 1

    expect(h.rejects.at(-1)?.reason).toBe('stale-generation');

    h.coord.onNavigated(2, 'doc-2');
    for (const b of GENERIC) h.coord.onBarrier(2, 'doc-2', b);
    expect(h.reveals, 'generation 2 revealed on generation 1 evidence').toEqual([1]);
    expect(h.failures.at(-1)?.kind).toBe('freshness-mismatch');
  });

  it('reveal is emitted exactly once per generation', () => {
    h.bringUp();
    h.coord.onBarrier(1, 'doc-2', 'plan-ready');
    h.coord.onBarrier(1, 'doc-2', 'plan-ready');
    expect(h.reveals).toEqual([1]);
  });
});

// ── construction ─────────────────────────────────────────────────────────────

describe('construction refuses a configuration that could reveal too early', () => {
  it('rejects an empty barrier list — that would reveal on navigation alone', () => {
    expect(() => harness([])).toThrow(/at least one barrier/);
  });

  it('rejects barriers declared out of the canonical order', () => {
    expect(() => harness(['painted', 'ready'])).toThrow(/BARRIER_SEQUENCE order/);
  });
});
