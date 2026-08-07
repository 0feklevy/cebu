/**
 * Occurrence planning and predictive admission (Priority 8.2–8.5).
 *
 * The rules being pinned are the ones a residency planner can get catastrophically wrong: evicting
 * what is on screen, letting speculative work displace work that must happen, holding one package
 * twice because two sections share it, and preparing a section the network cannot deliver.
 */

import { describe, it, expect } from 'vitest';
import {
  activeOccurrence, dueTimes, planResidency, type SimOccurrence,
} from '../occurrencePlanner.js';

const occ = (sectionId: string, packageKey: string, startSec: number, endSec: number): SimOccurrence =>
  ({ sectionId, packageKey, startSec, endSec });

const plan = (o: SimOccurrence[], nowSec: number, over: Record<string, unknown> = {}) =>
  planResidency({ occurrences: o, nowSec, capacity: 3, budgetMsFor: () => 2000, ...over });

// ── Active section ───────────────────────────────────────────────────────────────────────────────

describe('activeOccurrence', () => {
  it('finds the section covering now, half-open so a boundary is unambiguous', () => {
    const o = [occ('a', 'P1', 0, 10), occ('b', 'P2', 10, 20)];
    expect(activeOccurrence(o, 5)?.sectionId).toBe('a');
    expect(activeOccurrence(o, 10)?.sectionId).toBe('b');
    expect(activeOccurrence(o, 20)).toBeNull();
  });

  it('resolves an overlap by the LATEST start, not by array position', () => {
    // A plan must not depend on how the timeline happened to be ordered in the database.
    const o = [occ('early', 'P1', 0, 30), occ('late', 'P2', 10, 30)];
    expect(activeOccurrence(o, 15)?.sectionId).toBe('late');
    expect(activeOccurrence([...o].reverse(), 15)?.sectionId).toBe('late');
  });

  it('is null before anything starts', () => {
    expect(activeOccurrence([occ('a', 'P1', 10, 20)], 0)).toBeNull();
  });
});

// ── Due times ────────────────────────────────────────────────────────────────────────────────────

describe('dueTimes', () => {
  it('collapses several sections of one package to its soonest upcoming start', () => {
    // The pool holds one document per PACKAGE; planning per section but admitting per package is
    // what keeps a residency cap meaningful.
    const d = dueTimes([occ('a', 'P1', 30, 40), occ('b', 'P1', 10, 20), occ('c', 'P2', 15, 25)], 0);
    expect(d.get('P1')).toBe(10);
    expect(d.get('P2')).toBe(15);
    expect(d.size).toBe(2);
  });

  it('ignores occurrences already in the past', () => {
    expect(dueTimes([occ('a', 'P1', 0, 5)], 10).size).toBe(0);
  });
});

// ── Residency ────────────────────────────────────────────────────────────────────────────────────

describe('planResidency', () => {
  it('always admits the active package first', () => {
    const p = plan([occ('a', 'P1', 0, 100), occ('b', 'P2', 1, 2)], 50);
    expect(p.admit[0]!.packageKey).toBe('P1');
    expect(p.admit[0]!.reason).toBe('active');
  });

  it('NEVER evicts the package on screen, even when capacity is one', () => {
    // Evicting what is showing to make room for what is coming is the one mistake a residency
    // planner must never make.
    const p = plan([occ('a', 'P1', 0, 100), occ('b', 'P2', 51, 60), occ('c', 'P3', 52, 60)], 50,
      { capacity: 1 });
    expect(p.admit.map((e) => e.packageKey)).toEqual(['P1']);
    expect(p.evict).toContain('P2');
    expect(p.evict).toContain('P3');
  });

  it('orders upcoming packages by soonest needed', () => {
    const p = plan([occ('a', 'P3', 90, 95), occ('b', 'P1', 10, 15), occ('c', 'P2', 50, 55)], 0);
    expect(p.admit.map((e) => e.packageKey)).toEqual(['P1', 'P2', 'P3']);
  });

  it('ranks a DUE package above a speculative one that is due sooner in clock terms', () => {
    // Work that must happen outranks work that might pay off. Here P2 is inside its lead window
    // because its budget is large; P1 is not, despite starting earlier.
    const budgets: Record<string, number> = { P1: 100, P2: 60_000 };
    const p = plan([occ('a', 'P1', 10, 20), occ('b', 'P2', 30, 40)], 0,
      { capacity: 2, budgetMsFor: (k: string) => budgets[k] ?? 0 });
    expect(p.admit[0]!.reason).toBe('due');
    expect(p.admit[0]!.packageKey).toBe('P2');
  });

  it('holds one entry per package however many sections share it', () => {
    const p = plan([occ('a', 'P1', 10, 20), occ('b', 'P1', 30, 40), occ('c', 'P1', 50, 60)], 0);
    expect(p.admit.map((e) => e.packageKey)).toEqual(['P1']);
  });

  it('respects the capacity exactly', () => {
    const o = [1, 2, 3, 4, 5].map((i) => occ(`s${i}`, `P${i}`, i * 10, i * 10 + 5));
    expect(plan(o, 0, { capacity: 2 }).admit).toHaveLength(2);
    expect(plan(o, 0, { capacity: 0 }).admit).toHaveLength(0);
  });

  it('evicts exactly what did not fit', () => {
    const o = [1, 2, 3].map((i) => occ(`s${i}`, `P${i}`, i * 10, i * 10 + 5));
    const p = plan(o, 0, { capacity: 1 });
    expect(p.admit.map((e) => e.packageKey)).toEqual(['P1']);
    expect(p.evict.sort()).toEqual(['P2', 'P3']);
  });

  it('never admits the ACTIVE package twice when it also has an upcoming occurrence', () => {
    // The active package is excluded from the upcoming list explicitly. Without that, a package
    // playing now AND appearing later would occupy two of a small number of residency slots while
    // the pool holds only one document for it.
    const o = [occ('a', 'P1', 0, 10), occ('b', 'P1', 20, 30), occ('c', 'P2', 15, 18)];
    const p = plan(o, 5, { capacity: 3 });
    expect(p.admit.filter((e) => e.packageKey === 'P1')).toHaveLength(1);
    expect(p.admit.map((e) => e.packageKey)).toEqual(['P1', 'P2']);
  });

  it('never lists a package as both admitted and evicted', () => {
    const o = [occ('a', 'P1', 10, 20), occ('b', 'P1', 15, 25), occ('c', 'P2', 12, 18)];
    const p = plan(o, 0, { capacity: 1 });
    for (const k of p.admit.map((e) => e.packageKey)) expect(p.evict).not.toContain(k);
  });
});

// ── Preparation ──────────────────────────────────────────────────────────────────────────────────

describe('preparation admission', () => {
  it('prepares only what is inside its lead window', () => {
    // 2000ms budget: P1 at t=1 is inside, P2 at t=50 is not.
    const p = plan([occ('a', 'P1', 1, 5), occ('b', 'P2', 50, 55)], 0);
    expect(p.prepare).toEqual(['P1']);
  });

  it('prepares nothing when nothing is close enough', () => {
    expect(plan([occ('a', 'P1', 90, 95)], 0).prepare).toEqual([]);
  });

  it('never prepares the active section — it is already live, not upcoming', () => {
    const p = plan([occ('a', 'P1', 0, 100)], 50);
    expect(p.prepare).toEqual([]);
  });

  it('does not prepare a DEGENERATE section whose start is exactly now', () => {
    // A section starting exactly now is normally the ACTIVE one and never reaches the lead-window
    // check. The case that does reach it is a zero-length (or already-ended) section at the current
    // time: activeOccurrence rejects it because the interval is half-open, dueTimes keeps it because
    // it filters only strictly-past starts, and the lead window then sees zero time remaining.
    // Preparing it would schedule work for a section that can never be shown.
    const p = plan([occ('a', 'P1', 0, 0)], 0);
    expect(p.prepare).toEqual([]);
  });

  it('does not prepare the active section when another package is also live', () => {
    const p = plan([occ('a', 'P1', 0, 10)], 0);
    expect(p.prepare).toEqual([]);
    expect(p.admit[0]!.reason).toBe('active');
  });

  it('prepare is always a subset of admit', () => {
    const o = [1, 2, 3, 4].map((i) => occ(`s${i}`, `P${i}`, i, i + 1));
    const p = plan(o, 0, { capacity: 2 });
    for (const k of p.prepare) expect(p.admit.map((e) => e.packageKey)).toContain(k);
  });

  it('scales the lead window with the package own budget', () => {
    const budgets: Record<string, number> = { SLOW: 30_000, FAST: 200 };
    const o = [occ('a', 'SLOW', 20, 25), occ('b', 'FAST', 21, 26)];
    const p = plan(o, 0, { budgetMsFor: (k: string) => budgets[k] ?? 0 });
    expect(p.prepare).toContain('SLOW');
    expect(p.prepare).not.toContain('FAST');
  });

  it('refuses to prepare a section the buffer cannot reach', () => {
    // Preparing a document the network cannot yet deliver competes with the segment fetches that
    // would make it reachable.
    const p = plan([occ('a', 'P1', 1.5, 5)], 0, { bufferedAheadSec: 0.5 });
    expect(p.prepare).toEqual([]);
    // It is still admitted — an idle resident document is cheap; running its body is not.
    expect(p.admit.map((e) => e.packageKey)).toContain('P1');
  });

  it('prepares when the buffer does reach it', () => {
    expect(plan([occ('a', 'P1', 1.5, 5)], 0, { bufferedAheadSec: 5 }).prepare).toEqual(['P1']);
  });

  it('treats an UNKNOWN buffer as reachable', () => {
    // Refusing to prepare because we cannot measure would turn a missing signal into a permanent
    // regression on every browser that does not report it.
    expect(plan([occ('a', 'P1', 1.5, 5)], 0, { bufferedAheadSec: NaN }).prepare).toEqual(['P1']);
    expect(plan([occ('a', 'P1', 1.5, 5)], 0, { bufferedAheadSec: undefined }).prepare).toEqual(['P1']);
  });
});

// ── Degenerate input ─────────────────────────────────────────────────────────────────────────────

describe('degenerate input', () => {
  it('plans nothing from nothing', () => {
    const p = plan([], 0);
    expect(p.admit).toEqual([]);
    expect(p.prepare).toEqual([]);
    expect(p.evict).toEqual([]);
  });

  it('handles a negative capacity as zero', () => {
    expect(plan([occ('a', 'P1', 1, 2)], 0, { capacity: -5 }).admit).toEqual([]);
  });

  it('does not admit a package whose occurrences are all in the past', () => {
    expect(plan([occ('a', 'P1', 0, 5)], 100).admit).toEqual([]);
  });
});

// ── Review findings ──────────────────────────────────────────────────────────────────────────────

describe('the active package is never evicted, at ANY capacity', () => {
  it('keeps the on-screen package even at capacity 0', () => {
    // slice(0, 0) put it in the overflow, so a caller following the plan would drop the document
    // that is on screen — the one mistake this planner must never make.
    const p = plan([occ('a', 'P1', 0, 100)], 50, { capacity: 0 });
    expect(p.admit.map((e) => e.packageKey)).toEqual(['P1']);
    expect(p.evict).not.toContain('P1');
  });

  it('keeps it for a nonsensical capacity too', () => {
    for (const cap of [NaN, -3, undefined as unknown as number]) {
      const p = plan([occ('a', 'P1', 0, 100)], 50, { capacity: cap });
      expect(p.evict, `capacity ${cap} evicted the live package`).not.toContain('P1');
    }
  });
});

describe('evict names everything that should be dropped', () => {
  it('evicts a resident package whose occurrences are all in the past', () => {
    // Such a package never enters `candidates`, so before `resident` was passed in it could never be
    // evicted — a caller would hold that document forever after a forward seek.
    const p = plan([occ('a', 'P2', 200, 210)], 100, { resident: ['P1', 'P2'] });
    expect(p.evict).toContain('P1');
    expect(p.evict).not.toContain('P2');
  });

  it('never evicts something it is also admitting', () => {
    const p = plan([occ('a', 'P1', 0, 100)], 50, { resident: ['P1'] });
    expect(p.evict).not.toContain('P1');
  });

  it('does not list the same package twice', () => {
    const o = [occ('a', 'P1', 10, 20), occ('b', 'P2', 12, 22)];
    const p = plan(o, 0, { capacity: 1, resident: ['P2', 'P2'] });
    expect(new Set(p.evict).size).toBe(p.evict.length);
  });

  it('evicts nothing when nothing is resident and everything fits', () => {
    expect(plan([occ('a', 'P1', 10, 20)], 0, { capacity: 5, resident: [] }).evict).toEqual([]);
  });
});
