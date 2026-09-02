/**
 * The surface ledger covers the whole anchor registry, exactly once. A new `TOUR_ANCHORS` entry
 * fails here until a mount test claims it; an anchor removed from the registry fails here until
 * its claim is removed. (What each claim is worth is proven by the `tourAnchors.*.test.tsx` mounts.)
 */
import { describe, it, expect } from 'vitest';
import { TOUR_ANCHORS } from '@/lib/tours/anchors';
import { SURFACE_ANCHORS } from './helpers/tourSurfaces';

describe('tour surfaces', () => {
  const claimed = Object.values(SURFACE_ANCHORS).flat();

  it('every registered anchor is claimed by exactly one mounted surface', () => {
    const registry = Object.keys(TOUR_ANCHORS).sort();
    expect([...claimed].sort()).toEqual(registry);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});
