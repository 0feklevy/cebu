/**
 * The execution snapshot's identity.
 *
 * The properties that matter are all about what must and must not change the hash. Equal plans have
 * to hash equally or the verification is noise; unequal plans have to hash differently or it is
 * worse than noise, because a changed timeline would pass a check that claims to detect exactly
 * that. And nothing may be silently dropped on the way in: a field that vanishes under
 * `JSON.stringify` is a field whose change the fingerprint cannot see.
 */

import { describe, it, expect } from 'vitest';

import {
  canonicalJson,
  fingerprintPlan,
  isFingerprint,
  assertFrozenPlan,
  NotCanonicalisable,
  FINGERPRINT_DOMAIN,
} from '../planFingerprint.js';

const PLAN = {
  projectId: 'p-1',
  grid: { w: 1920, h: 1080, fps: 30 },
  timeline: [
    { kind: 'video', startSec: 0, endSec: 4 },
    { kind: 'sim-capture', sectionId: 's1', startSec: 4, endSec: 14, packageDigest: 'sha256:aaa' },
  ],
  warnings: [],
};

describe('canonicalJson', () => {
  it('sorts object keys, so key order cannot produce two fingerprints for one plan', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
    // …recursively.
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it('PRESERVES array order, because a timeline is a sequence', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('refuses values JSON would silently drop or flatten', () => {
    // Each of these is a way for a plan to change without the fingerprint noticing.
    // An undefined PROPERTY is omitted, exactly as JSON.stringify omits it — the hash must
    // describe the snapshot as stored, since that is what the worker reads back and verifies.
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    // Inside an ARRAY it becomes null, which is a real change of value, so it is refused.
    expect(() => canonicalJson([undefined])).toThrow(NotCanonicalisable);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ a: Symbol('s') })).toThrow(/symbol/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
    // NaN and both infinities all become `null` under JSON — three plans, one hash.
    expect(() => canonicalJson({ a: NaN })).toThrow(/NaN/);
    expect(() => canonicalJson({ a: Infinity })).toThrow(/Infinity/);
    expect(() => canonicalJson({ a: -Infinity })).toThrow(/Infinity/);
    // A Date hashes by whatever toJSON does today.
    expect(() => canonicalJson({ a: new Date() })).toThrow(/Date instance/);
    class Window { constructor(public k = 1) {} }
    expect(() => canonicalJson({ a: new Window() })).toThrow(/Window instance/);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalJson({ timeline: [{ startSec: NaN }] })).toThrow(/timeline\[0\]\.startSec/);
  });

  it('treats -0 and 0 as one number', () => {
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it('accepts the shapes a plan is actually made of', () => {
    expect(() => canonicalJson(PLAN)).not.toThrow();
    expect(() => canonicalJson({ a: null, b: [], c: {}, d: '', e: false, f: 0 })).not.toThrow();
  });
});

describe('fingerprintPlan', () => {
  it('is 64 lowercase hex characters', () => {
    const fp = fingerprintPlan(PLAN);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(isFingerprint(fp)).toBe(true);
  });

  it('is stable across key order and across repeated calls', () => {
    const reordered = { warnings: [], timeline: PLAN.timeline, grid: PLAN.grid, projectId: PLAN.projectId };
    expect(fingerprintPlan(reordered)).toBe(fingerprintPlan(PLAN));
    expect(fingerprintPlan(PLAN)).toBe(fingerprintPlan(PLAN));
  });

  it('changes when ANY part of the plan changes', () => {
    const base = fingerprintPlan(PLAN);
    const variants = [
      { ...PLAN, projectId: 'p-2' },
      { ...PLAN, grid: { ...PLAN.grid, fps: 24 } },
      { ...PLAN, timeline: [PLAN.timeline[1], PLAN.timeline[0]] },          // reordered
      { ...PLAN, timeline: [{ ...PLAN.timeline[0], endSec: 5 }, PLAN.timeline[1]] }, // retimed
      // The immutable content identity: republishing the simulation must invalidate the snapshot.
      { ...PLAN, timeline: [PLAN.timeline[0], { ...PLAN.timeline[1], packageDigest: 'sha256:bbb' }] },
      { ...PLAN, timeline: [PLAN.timeline[0]] },                            // section removed
    ];
    for (const v of variants) expect(fingerprintPlan(v)).not.toBe(base);
  });

  it('is domain-separated, so it cannot collide with a bare hash of the same JSON', async () => {
    const { createHash } = await import('node:crypto');
    const bare = createHash('sha256').update(canonicalJson(PLAN)).digest('hex');
    expect(fingerprintPlan(PLAN)).not.toBe(bare);
    expect(FINGERPRINT_DOMAIN).toContain('v1');
  });
});

describe('assertFrozenPlan', () => {
  const fp = fingerprintPlan(PLAN);

  it('accepts a snapshot that matches its fingerprint and its project', () => {
    expect(() => assertFrozenPlan(PLAN, fp, 'p-1')).not.toThrow();
  });

  it('refuses a plan that was EDITED after it was stored', () => {
    const tampered = { ...PLAN, timeline: [{ ...PLAN.timeline[0], endSec: 99 }, PLAN.timeline[1]] };
    expect(() => assertFrozenPlan(tampered, fp, 'p-1')).toThrow(/fingerprint mismatch/);
  });

  it('refuses a snapshot belonging to another project', () => {
    expect(() => assertFrozenPlan(PLAN, fp, 'p-other')).toThrow(/not p-other/);
  });

  it('refuses a missing plan, and a fingerprint that is not a fingerprint', () => {
    expect(() => assertFrozenPlan(null, fp, 'p-1')).toThrow(/missing or not an object/);
    expect(() => assertFrozenPlan(PLAN, 'nope', 'p-1')).toThrow(/64 hex/);
    expect(() => assertFrozenPlan(PLAN, fp.toUpperCase(), 'p-1')).toThrow(/64 hex/);
    expect(() => assertFrozenPlan(PLAN, null, 'p-1')).toThrow(/64 hex/);
  });
});
