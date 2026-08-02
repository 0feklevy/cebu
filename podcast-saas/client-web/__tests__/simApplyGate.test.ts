/**
 * The same-document apply gate — the rule that decides whether a section switch may be presented
 * immediately or must wait for the bridge's SCRIPT_APPLIED acknowledgement.
 *
 * The audited hazard: `painted` is a per-DOCUMENT flag, so after the first section of a package
 * has painted, every later section switch was revealed instantly — potentially showing the
 * PREVIOUS section's frozen frame while the new body was still being applied.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyGateFor, type ApplyGateMeta } from '../lib/simApplyGate';

const meta = (over: Partial<ApplyGateMeta> = {}): ApplyGateMeta => ({
  dynamic: true, ackCapable: true, lastScript: 'section-A', ...over,
});

describe('applyGateFor — MODERN (proven-acking) documents', () => {
  it('a switch to a DIFFERENT section waits for the acknowledgement', () => {
    expect(applyGateFor(meta(), 'section-B')).toBe('await-ack');
  });

  it('re-entering the SAME section reveals immediately (already applied — no flicker on re-entry)', () => {
    expect(applyGateFor(meta({ lastScript: 'section-B' }), 'section-B')).toBe('reveal-now');
  });

  it('the FIRST activation on a document reveals immediately (nothing to switch away from)', () => {
    expect(applyGateFor(meta({ lastScript: null }), 'section-A')).toBe('reveal-now');
  });
});

describe('applyGateFor — LEGACY / unknown documents are never made to wait on silence', () => {
  it('a bridge that has never acked reveals immediately (stored pre-ack bridge)', () => {
    // ackCapable stays null because the package's FIRST activation produced no SCRIPT_APPLIED —
    // which is exactly how a stored pre-v2.1 bridge is identified, before any switch happens.
    expect(applyGateFor(meta({ ackCapable: null }), 'section-B')).toBe('reveal-now');
  });

  it('a bridge explicitly classified as non-acking reveals immediately', () => {
    expect(applyGateFor(meta({ ackCapable: false }), 'section-B')).toBe('reveal-now');
  });

  it('a non-dynamic (navigating) bridge never uses the in-place gate', () => {
    expect(applyGateFor(meta({ dynamic: false }), 'section-B')).toBe('reveal-now');
    expect(applyGateFor(meta({ dynamic: null }), 'section-B')).toBe('reveal-now');
  });

  it('REGRESSION: legacy switches are not delayed at all — no blind 200ms ceiling remains', () => {
    // The first implementation waited 200ms for ANY dynamic bridge (ackCapable !== false) and then
    // force-revealed an unacknowledged frame. Legacy must neither wait nor be revealed blind.
    for (const ackCapable of [null, false] as const) {
      expect(applyGateFor(meta({ ackCapable }), 'section-B')).toBe('reveal-now');
    }
  });

  it('REGRESSION: a SLOW modern body is never force-revealed — the gate keeps waiting', () => {
    // A modern body may legitimately take >200ms (the generation prompt tells bodies to poll for
    // async-built controls). The decision must not depend on elapsed time at all.
    expect(applyGateFor(meta({ ackCapable: true }), 'slow-section')).toBe('await-ack');
  });
});

describe('call-site ordering — the gate decision must be taken BEFORE lastScript is updated', () => {
  // The extraction bug (audited RELEASE_BLOCKER): the player set meta.lastScript = script and
  // THEN called applyGateFor(meta, script), so lastScript === nextScript always held and the
  // gate always returned 'reveal-now' — the whole ack machinery was dead code. This pins the
  // ordering contract the player must honour.
  it('deciding AFTER the write always yields reveal-now (the bug) — proving order matters', () => {
    const m = meta({ lastScript: 'A' });
    // BUG ORDER: write then decide.
    m.lastScript = 'B';
    expect(applyGateFor(m, 'B')).toBe('reveal-now');   // wrong for a real A→B switch
  });

  it('deciding BEFORE the write yields await-ack for a genuine switch (the fix)', () => {
    const m = meta({ lastScript: 'A' });
    // FIX ORDER: decide first, then write.
    const decision = applyGateFor(m, 'B');
    m.lastScript = 'B';
    expect(decision).toBe('await-ack');
  });
});


describe('SOURCE INVARIANT — the player computes the gate decision before writing lastScript', () => {
  // A pure-function test cannot catch the real bug (the player wrote meta.lastScript = script and
  // THEN called applyGateFor). Assert against the actual hook source that, in the painted-path
  // activation, the applyGateFor(...) call precedes the `meta.lastScript = script` write — the
  // ONLY ordering under which the gate is live.
  const src = readFileSync(join(__dirname, '../components/viewer/useProjectPlayer.ts'), 'utf8');

  it('applyGateFor is called before the lastScript assignment in the activation block', () => {
    const iDecision = src.indexOf('applyGateFor(meta, script)');
    const iWrite = src.indexOf('meta.lastScript = script;');
    expect(iDecision, 'applyGateFor(meta, script) call not found').toBeGreaterThan(-1);
    expect(iWrite, 'meta.lastScript = script write not found').toBeGreaterThan(-1);
    expect(iDecision, 'the gate decision MUST be taken before lastScript is updated').toBeLessThan(iWrite);
  });

  it('the awaited pending apply has a terminal reveal (never a permanent hold)', () => {
    // The await-ack timer must call revealSim, not merely log — otherwise a post-roll sim whose
    // bridge never acks holds a paused frame forever (audited HIGH).
    const block = src.slice(src.indexOf('await-ack'), src.indexOf('await-ack') + 1200);
    expect(block).toContain('revealSim({ force: true })');
  });
});
