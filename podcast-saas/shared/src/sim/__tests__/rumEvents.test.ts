/**
 * RUM payload, sampling and validation (Priority 8.9).
 *
 * The claims worth testing here are all about failure DIRECTION: a bad config must collect nothing
 * rather than everything, a truncated buffer must say it was truncated, and an unauthenticated
 * endpoint's validator must bound what a hostile caller can store.
 */

import { describe, it, expect } from 'vitest';
import {
  SIM_RUM_VERSION, RUM_MAX_EVENTS_PER_BATCH, MEMORY_BUCKETS, CORE_BUCKETS,
  shouldSample, normalizeSampleRate, bucketDevice, RumRing, validateBatch,
  type RumEvent,
} from '../rumEvents.js';

const ev = (over: Partial<RumEvent> = {}): RumEvent => ({
  kind: 'transition', t: 10, packageRevision: 'abc123', ...over,
});
const batch = (over: Record<string, unknown> = {}) => ({
  v: SIM_RUM_VERSION, sessionId: 'session-abcdef', device: bucketDevice({}),
  events: [ev()], dropped: 0, ...over,
});

// ── Sampling ─────────────────────────────────────────────────────────────────────────────────────

describe('sampling', () => {
  it('is off at zero and on at one', () => {
    expect(shouldSample(0, 0)).toBe(false);
    expect(shouldSample(1, 0.999)).toBe(true);
  });

  it('admits below the rate and refuses at or above it', () => {
    expect(shouldSample(0.1, 0.09)).toBe(true);
    expect(shouldSample(0.1, 0.1)).toBe(false);
    expect(shouldSample(0.1, 0.5)).toBe(false);
  });

  it('refuses a nonsense rate rather than defaulting to on', () => {
    // The failure mode of a bad config must be "collect nothing", never "collect everything".
    for (const bad of [NaN, Infinity, -1, -0.5]) expect(shouldSample(bad, 0)).toBe(false);
  });
});

describe('normalizeSampleRate', () => {
  it('defaults anything unparseable to zero', () => {
    for (const bad of [undefined, null, 'abc', {}, NaN, -1]) {
      expect(normalizeSampleRate(bad)).toBe(0);
    }
  });

  it('caps at one and accepts a numeric string', () => {
    expect(normalizeSampleRate(5)).toBe(1);
    expect(normalizeSampleRate('0.25')).toBe(0.25);
  });
});

// ── Device bucketing ─────────────────────────────────────────────────────────────────────────────

describe('bucketDevice', () => {
  it('rounds DOWN so a device is never reported as more capable than it is', () => {
    // Rounding up would make a slow measurement look like it came from a fast machine.
    expect(bucketDevice({ deviceMemory: 3 }).memoryGb).toBe(2);
    expect(bucketDevice({ deviceMemory: 7.9 }).memoryGb).toBe(4);
    expect(bucketDevice({ hardwareConcurrency: 6 }).cores).toBe(4);
    expect(bucketDevice({ hardwareConcurrency: 12 }).cores).toBe(8);
  });

  it('clamps a huge value to the top bucket', () => {
    expect(bucketDevice({ deviceMemory: 1024 }).memoryGb).toBe(MEMORY_BUCKETS[MEMORY_BUCKETS.length - 1]);
    expect(bucketDevice({ hardwareConcurrency: 256 }).cores).toBe(CORE_BUCKETS[CORE_BUCKETS.length - 1]);
  });

  it('reports null for absent or nonsensical signals rather than guessing', () => {
    const d = bucketDevice({});
    expect(d.memoryGb).toBeNull();
    expect(d.cores).toBeNull();
    expect(d.coarsePointer).toBeNull();
    expect(d.saveData).toBeNull();
    expect(d.dpr).toBeNull();
    expect(d.poolTier).toBeNull();
    expect(bucketDevice({ deviceMemory: -1 }).memoryGb).toBeNull();
    expect(bucketDevice({ deviceMemory: NaN }).memoryGb).toBeNull();
  });

  it('keeps dpr to one decimal', () => {
    expect(bucketDevice({ dpr: 2.6666 }).dpr).toBe(2.7);
    expect(bucketDevice({ dpr: 0 }).dpr).toBeNull();
  });

  it('carries the pool tier, without which no duration can be read', () => {
    expect(bucketDevice({ poolTier: 'window' }).poolTier).toBe('window');
  });

  it('collects no identifying field', () => {
    const d = bucketDevice({ deviceMemory: 8, hardwareConcurrency: 16, dpr: 2 }) as unknown as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(
      ['coarsePointer', 'cores', 'dpr', 'memoryGb', 'poolTier', 'saveData'].sort());
  });
});

// ── The ring ─────────────────────────────────────────────────────────────────────────────────────

describe('RumRing', () => {
  it('keeps everything below the cap', () => {
    const r = new RumRing(5);
    for (let i = 0; i < 5; i += 1) r.push(ev({ t: i }));
    expect(r.size).toBe(5);
    expect(r.dropped).toBe(0);
  });

  it('drops the OLDEST and counts it', () => {
    // The interesting events in a stuck session are the recent ones; a buffer discarding those
    // would preserve exactly the part nobody needs. And a silent cap makes a truncated trace
    // indistinguishable from a short one.
    const r = new RumRing(3);
    for (let i = 0; i < 5; i += 1) r.push(ev({ t: i }));
    expect(r.size).toBe(3);
    expect(r.dropped).toBe(2);
    expect(r.drain().events.map((e) => e.t)).toEqual([2, 3, 4]);
  });

  it('drains and resets, carrying the drop count WITH the batch it describes', () => {
    const r = new RumRing(2);
    for (let i = 0; i < 4; i += 1) r.push(ev({ t: i }));
    const first = r.drain();
    expect(first.dropped).toBe(2);
    expect(r.size).toBe(0);
    expect(r.dropped).toBe(0);
    expect(r.drain().events).toEqual([]);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────────────────────────

describe('validateBatch — this endpoint is unauthenticated', () => {
  it('accepts a well-formed batch', () => {
    expect(validateBatch(batch()).ok).toBe(true);
  });

  it('refuses an unknown payload version', () => {
    const r = validateBatch(batch({ v: 99 }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unknown-version');
  });

  it('refuses a batch with no events', () => {
    expect(!validateBatch(batch({ events: [] })).ok).toBe(true);
  });

  it('bounds how many events one call can store', () => {
    const many = [...Array(RUM_MAX_EVENTS_PER_BATCH + 1)].map(() => ev());
    const r = validateBatch(batch({ events: many }));
    expect(!r.ok && r.reason).toBe('too-many-events');
  });

  it('bounds the session id in both directions', () => {
    expect(!validateBatch(batch({ sessionId: 'short' })).ok).toBe(true);
    expect(!validateBatch(batch({ sessionId: 'x'.repeat(129) })).ok).toBe(true);
    expect(!validateBatch(batch({ sessionId: 42 })).ok).toBe(true);
  });

  it('refuses an unknown event kind', () => {
    expect(!validateBatch(batch({ events: [ev({ kind: 'exfiltrate' as never })] })).ok).toBe(true);
  });

  it('refuses an event with no package — a duration with no package is unusable', () => {
    expect(!validateBatch(batch({ events: [ev({ packageRevision: '' })] })).ok).toBe(true);
    expect(!validateBatch(batch({ events: [ev({ packageRevision: 'x'.repeat(65) })] })).ok).toBe(true);
    expect(!validateBatch(batch({ events: [{ kind: 'transition', t: 1 } as never] })).ok).toBe(true);
  });

  it('refuses a negative or non-finite timestamp', () => {
    expect(!validateBatch(batch({ events: [ev({ t: -1 })] })).ok).toBe(true);
    expect(!validateBatch(batch({ events: [ev({ t: NaN })] })).ok).toBe(true);
    expect(!validateBatch(batch({ events: [ev({ t: Infinity })] })).ok).toBe(true);
  });

  it('bounds the failure code so it cannot become a free-text sink', () => {
    expect(validateBatch(batch({ events: [ev({ kind: 'failure', code: 'present-timeout' })] })).ok).toBe(true);
    expect(!validateBatch(batch({ events: [ev({ code: 'x'.repeat(65) })] })).ok).toBe(true);
  });

  it('refuses garbage rather than throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(() => validateBatch(bad)).not.toThrow();
      expect(validateBatch(bad).ok).toBe(false);
    }
  });
});
