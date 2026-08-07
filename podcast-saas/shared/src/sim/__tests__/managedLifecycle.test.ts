/**
 * The managed lifecycle leak verdict — shared-side.
 *
 * RELATIONSHIP TO client-web
 * There is none. `judgeLeak` and `DEFAULT_PLATEAUS` have no test in any workspace, and this file is
 * the only place they are covered. They decide whether an A -> B -> A soak run passed, so a wrong
 * verdict here is either a leak shipped as green or a healthy package blocked from publication.
 *
 * THE SUBTLETY WORTH STATING
 * `observedDrift` is `last - first` of the WARM window, not `max - min`. Those differ on exactly the
 * series that matters most: a run that spikes mid-way and comes back has zero drift and is correct
 * to pass on that axis — a transient allocation is not a leak — while `max - min` would fail it.
 * The spike is caught by `observedMax` instead, which is why both bounds exist and why neither
 * alone would do.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLATEAUS,
  judgeLeak,
  type ManagedResourceKind,
  type ResourcePlateau,
} from '../managedLifecycle.js';
import { ZERO_RESOURCE_COUNTS } from '../runtimeProtocol.js';

const plateau = (max: number, maxDrift: number): ResourcePlateau => ({ max, maxDrift });

describe('DEFAULT_PLATEAUS', () => {
  it('bounds every resource the protocol counts — a new counter without a bound fails here', () => {
    // The counters and the leak report have to stay in agreement: a resource the scope tracks but
    // the plateau table does not is a resource that can grow without limit and still pass a soak.
    const counted = Object.keys(ZERO_RESOURCE_COUNTS).sort();
    const bounded = Object.keys(DEFAULT_PLATEAUS).sort();
    expect(bounded).toEqual(counted);
    expect(counted).toHaveLength(20);
  });

  it('requires strictly flat drift for every resource', () => {
    // A plateau is not zero — the document legitimately keeps its renderer, its loaded textures and
    // its resident listeners across activations, and releasing those per activation would defeat the
    // resident pool entirely. What must not grow is the per-ACTIVATION set, so the ceiling varies
    // by resource while the drift bound is zero for all of them.
    for (const [kind, p] of Object.entries(DEFAULT_PLATEAUS) as [ManagedResourceKind, ResourcePlateau][]) {
      expect(p.maxDrift, kind).toBe(0);
      expect(Number.isInteger(p.max), kind).toBe(true);
      expect(p.max, kind).toBeGreaterThan(0);
    }
  });

  it('gives GPU and document-owned resources a larger ceiling than per-activation ones', () => {
    // Stated as a relationship rather than as literal numbers, so tuning a ceiling does not break
    // the test while inverting the intent does.
    expect(DEFAULT_PLATEAUS.glGeometries!.max).toBeGreaterThan(DEFAULT_PLATEAUS.rafCallbacks!.max);
    expect(DEFAULT_PLATEAUS.listeners!.max).toBeGreaterThan(DEFAULT_PLATEAUS.intervals!.max);
    expect(DEFAULT_PLATEAUS.audioContexts!.max).toBeLessThanOrEqual(DEFAULT_PLATEAUS.audioNodes!.max);
  });
});

describe('judgeLeak — the warm-up window', () => {
  it('ignores the first ten cycles, where the document-owned baseline is legitimately allocated', () => {
    // Counting the first activations as growth would make every healthy package fail: the renderer,
    // the shared geometry and the audio graph are all built during them.
    const counts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 2, 2, 2];
    const verdict = judgeLeak('rafCallbacks', counts, plateau(4, 0));
    expect(verdict.ok).toBe(true);
    expect(verdict.observedMax).toBe(2);
    expect(verdict.observedDrift).toBe(0);
  });

  it('passes vacuously when the run was shorter than the warm-up', () => {
    // Nothing was observed after warm-up, so there is nothing to judge. Reported as zeroes rather
    // than as a failure, because "too short to tell" is not "leaking".
    for (const counts of [[], [1], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]) {
      const verdict = judgeLeak('timeouts', counts, plateau(8, 0));
      expect(verdict.ok).toBe(true);
      expect(verdict.observedMax).toBe(0);
      expect(verdict.observedDrift).toBe(0);
    }
  });

  it('honours a custom warm-up length', () => {
    const counts = [100, 100, 1, 1, 1];
    expect(judgeLeak('timeouts', counts, plateau(8, 0), 2).ok).toBe(true);
    expect(judgeLeak('timeouts', counts, plateau(8, 0), 0).ok).toBe(false);
    expect(judgeLeak('timeouts', counts, plateau(8, 0), 0).observedMax).toBe(100);
  });

  it('judges the very next sample when the warm-up is zero', () => {
    expect(judgeLeak('ports', [5], plateau(4, 0), 0).ok).toBe(false);
    expect(judgeLeak('ports', [4], plateau(4, 0), 0).ok).toBe(true);
  });
});

describe('judgeLeak — drift is last minus first, not max minus min', () => {
  const warm = (values: number[]): number[] => [...Array<number>(10).fill(0), ...values];

  it('passes a transient spike that comes back down', () => {
    const verdict = judgeLeak('listeners', warm([4, 40, 4, 4]), plateau(64, 0));
    expect(verdict.observedDrift).toBe(0);
    expect(verdict.observedMax).toBe(40);
    expect(verdict.ok).toBe(true);
  });

  it('still fails that spike when it breaches the ceiling — the two bounds catch different things', () => {
    const verdict = judgeLeak('listeners', warm([4, 100, 4, 4]), plateau(64, 0));
    expect(verdict.observedDrift).toBe(0);
    expect(verdict.observedMax).toBe(100);
    expect(verdict.ok).toBe(false);
  });

  it('fails a steady upward trend even when every sample is under the ceiling', () => {
    const verdict = judgeLeak('rafCallbacks', warm([1, 2, 3, 4]), plateau(64, 0));
    expect(verdict.observedDrift).toBe(3);
    expect(verdict.observedMax).toBe(4);
    expect(verdict.ok).toBe(false);
  });

  it('passes a downward trend — releasing more than it allocated is not a leak', () => {
    const verdict = judgeLeak('rafCallbacks', warm([4, 3, 2, 1]), plateau(64, 0));
    expect(verdict.observedDrift).toBe(-3);
    expect(verdict.ok).toBe(true);
  });

  it('sees only the endpoints of the warm window, whatever happened between them', () => {
    const rising = judgeLeak('workers', warm([1, 9, 0, 2]), plateau(64, 5));
    expect(rising.observedDrift).toBe(1);
    expect(rising.ok).toBe(true);
  });
});

describe('judgeLeak — the boundaries of both bounds', () => {
  const warm = (values: number[]): number[] => [...Array<number>(10).fill(0), ...values];

  it('passes at exactly the ceiling and fails one above it', () => {
    expect(judgeLeak('glTextures', warm([256, 256]), plateau(256, 0)).ok).toBe(true);
    expect(judgeLeak('glTextures', warm([256, 257]), plateau(256, 0)).ok).toBe(false);
  });

  it('passes at exactly the drift bound and fails one above it', () => {
    expect(judgeLeak('observers', warm([1, 3]), plateau(64, 2)).ok).toBe(true);
    expect(judgeLeak('observers', warm([1, 4]), plateau(64, 2)).ok).toBe(false);
  });

  it('fails when either bound is breached, never requiring both', () => {
    const onlyMax = judgeLeak('intervals', warm([99, 99]), plateau(4, 0));
    expect(onlyMax.observedDrift).toBe(0);
    expect(onlyMax.ok).toBe(false);

    const onlyDrift = judgeLeak('intervals', warm([0, 3]), plateau(4, 0));
    expect(onlyDrift.observedMax).toBe(3);
    expect(onlyDrift.ok).toBe(false);
  });

  it('reports the kind and the plateau it judged against, so a verdict is self-describing', () => {
    const p = plateau(4, 0);
    const verdict = judgeLeak('abortControllers', warm([1, 1]), p);
    expect(verdict.kind).toBe('abortControllers');
    expect(verdict.plateau).toBe(p);
  });
});

describe('judgeLeak against the shipped plateaus', () => {
  const cycles = 60;

  it('passes a healthy soak: a flat per-activation set on top of a document baseline', () => {
    const failures: string[] = [];
    for (const [kind, p] of Object.entries(DEFAULT_PLATEAUS) as [ManagedResourceKind, ResourcePlateau][]) {
      // Ramp up to a steady state during warm-up, then hold it — the shape a correct package makes.
      const counts = Array.from({ length: cycles }, (_, i) => Math.min(i, 10) * (p.max / 20));
      const verdict = judgeLeak(kind, counts, p);
      if (!verdict.ok) failures.push(`${kind}: max=${verdict.observedMax} drift=${verdict.observedDrift}`);
    }
    expect(failures).toEqual([]);
  });

  it('fails a leaking soak: one extra resource retained per cycle', () => {
    const passed: string[] = [];
    for (const [kind, p] of Object.entries(DEFAULT_PLATEAUS) as [ManagedResourceKind, ResourcePlateau][]) {
      const counts = Array.from({ length: cycles }, (_, i) => i);
      const verdict = judgeLeak(kind, counts, p);
      if (verdict.ok) passed.push(`${kind}: max=${verdict.observedMax} drift=${verdict.observedDrift}`);
    }
    // Every kind must catch a one-per-cycle leak: the drift bound is zero for all of them, so the
    // ceiling being generous for GPU resources cannot let a leak through.
    expect(passed).toEqual([]);
  });
});
