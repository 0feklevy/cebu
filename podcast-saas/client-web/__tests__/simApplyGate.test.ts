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
