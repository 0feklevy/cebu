import { describe, it, expect } from 'vitest';
import {
  OVERLAY_LAYER, stacksAbove, topmostAt, coversPoint, firstOverlappingPair,
} from '../overlayStack.js';

const r = (id: string, start: number, end: number, layer: number = OVERLAY_LAYER.clip) =>
  ({ id, start, end, layer });

describe('the stacking rule', () => {
  it('puts a higher layer class on top regardless of time', () => {
    const clip = r('a', 100, 200);
    const image = r('b', 0, 500, OVERLAY_LAYER.image);
    expect(stacksAbove(image, clip)).toBe(true);
    expect(stacksAbove(clip, image)).toBe(false);
  });

  it('breaks a same-class tie by the LATER start', () => {
    expect(stacksAbove(r('a', 40, 50), r('b', 35, 45))).toBe(true);
    expect(stacksAbove(r('b', 35, 45), r('a', 40, 50))).toBe(false);
  });

  it('breaks a full tie by id, so both surfaces reach the same answer', () => {
    expect(stacksAbove(r('b', 10, 20), r('a', 10, 20))).toBe(true);
    expect(stacksAbove(r('a', 10, 20), r('b', 10, 20))).toBe(false);
  });

  it('is strict — an identical rank does not displace the incumbent', () => {
    expect(stacksAbove(r('a', 10, 20), r('a', 10, 20))).toBe(false);
  });

  it('is a strict weak ordering: never mutually above', () => {
    const all = [r('a', 10, 20), r('b', 10, 20), r('c', 15, 25), r('d', 0, 99, OVERLAY_LAYER.image)];
    for (const x of all) for (const y of all) {
      if (x === y) continue;
      expect(stacksAbove(x, y) && stacksAbove(y, x), `${x.id} vs ${y.id}`).toBe(false);
    }
  });
});

describe('coversPoint', () => {
  it('is half-open, so abutting overlays never both claim the seam', () => {
    const a = r('a', 10, 20);
    expect(coversPoint(a, 10)).toBe(true);
    expect(coversPoint(a, 19.999)).toBe(true);
    expect(coversPoint(a, 20)).toBe(false);
    expect(coversPoint(a, 9.999)).toBe(false);
  });
});

describe('topmostAt', () => {
  /**
   * THE REPORTED DIVERGENCE, as a test.
   *
   * A(sort_order 1, offset 35, 10s) and B(sort_order 2, offset 40, 10s); at t=42 the viewer showed A
   * (first in array order) and the export picked B (later start). B is correct — it is what the
   * author most recently placed — and both sides must now say B.
   */
  it('picks the later-started clip at an overlapping instant', () => {
    const a = r('a', 35, 45);
    const b = r('b', 40, 50);
    expect(topmostAt([a, b], 42)?.id).toBe('b');
  });

  it('gives the same answer whatever order the list is assembled in', () => {
    const a = r('a', 35, 45);
    const b = r('b', 40, 50);
    const c = r('c', 30, 60, OVERLAY_LAYER.image);
    for (const list of [[a, b, c], [c, b, a], [b, a, c], [a, c, b]]) {
      expect(topmostAt(list, 42)?.id, JSON.stringify(list.map((x) => x.id))).toBe('c');
    }
  });

  it('lets a clip_overlay beat a broll_clip when it started later — the cross-lane case', () => {
    // In the viewer these came from two different arrays, and the second array could never win.
    const broll = r('broll-1', 10, 60);
    const overlay = r('clip-1', 20, 30);
    expect(topmostAt([broll, overlay], 25)?.id).toBe('clip-1');
  });

  it('returns null when nothing covers the instant', () => {
    expect(topmostAt([r('a', 10, 20)], 25)).toBeNull();
    expect(topmostAt([], 5)).toBeNull();
  });
});

describe('firstOverlappingPair', () => {
  it('finds a genuine overlap', () => {
    const pair = firstOverlappingPair([r('a', 10, 30), r('b', 20, 40)]);
    expect(pair?.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('does NOT treat abutting ranges as overlapping', () => {
    expect(firstOverlappingPair([r('a', 10, 20), r('b', 20, 30)])).toBeNull();
  });

  it('returns null for a disjoint set', () => {
    expect(firstOverlappingPair([r('a', 0, 10), r('b', 20, 30), r('c', 40, 50)])).toBeNull();
  });
});
