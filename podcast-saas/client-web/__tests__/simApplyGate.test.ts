/**
 * The same-document apply gate — the rule that decides whether a section switch may be presented
 * immediately or must wait for the bridge's SCRIPT_APPLIED acknowledgement.
 *
 * The audited hazard: `painted` is a per-DOCUMENT flag, so after the first section of a package
 * has painted, every later section switch was revealed instantly — potentially showing the
 * PREVIOUS section's frozen frame while the new body was still being applied.
 */
import { describe, it, expect } from 'vitest';
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

describe('applyGateFor — a TORN-DOWN document is not a fresh one', () => {
  // The deferred exit stop runs the section's cleanup: whatever it hid is restored (full UI back)
  // while the canvas still holds that section's frozen frame. The player recorded that by nulling
  // lastScript — which reads as a genuine first activation and therefore reveals IMMEDIATELY,
  // guaranteeing the exact wrong-frame reveal the gate exists to prevent (audited).
  it('a stopped document waits for the ack even though lastScript is null', () => {
    expect(applyGateFor(meta({ lastScript: null, stopped: true }), 'section-A')).toBe('await-ack');
  });

  it('re-entering the SAME section after a teardown still waits — the body must re-apply', () => {
    expect(applyGateFor(meta({ lastScript: null, stopped: true }), 'section-B')).toBe('await-ack');
  });

  it('a stopped LEGACY document still reveals immediately (it can never ack)', () => {
    expect(applyGateFor(meta({ ackCapable: null, stopped: true }), 'section-A')).toBe('reveal-now');
    expect(applyGateFor(meta({ dynamic: false, stopped: true }), 'section-A')).toBe('reveal-now');
  });

  it('a genuine first activation is still immediate — stopped is what distinguishes them', () => {
    expect(applyGateFor(meta({ lastScript: null, stopped: false }), 'section-A')).toBe('reveal-now');
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


// The SOURCE INVARIANT block that used to live here grepped useProjectPlayer.ts for the gate call
// and the terminal reveal. Both moved into lib/sim/SimRuntimeClient.ts during the shared-runtime
// migration, where they are pinned by EXECUTION in simRuntimeClient.test.ts rather than by string
// match, and __tests__/transitionOrder.test.ts asserts that no surface calls applyGateFor directly.
