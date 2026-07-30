import { describe, it, expect } from 'vitest';
import { normalizeCircleSections, inCircleSection, circlesLayers, makeCircleSection, MIN_CIRCLE_SECTION_SEC } from './circleSections';

const r = (start: number, end: number, id = `${start}-${end}`) => ({ id, start_sec: start, end_sec: end });

describe('normalizeCircleSections', () => {
  it('sorts, clamps to [0,total], and drops sub-minimum ranges', () => {
    const out = normalizeCircleSections([r(50, 200), r(-5, 4), r(10, 10.1)], 60);
    expect(out).toEqual([
      { id: '-5-4', start_sec: 0, end_sec: 4 },
      { id: '50-200', start_sec: 50, end_sec: 60 },
    ]);
    expect(out.every((x) => x.end_sec - x.start_sec >= MIN_CIRCLE_SECTION_SEC)).toBe(true);
  });

  it('merges overlapping and touching ranges, first id wins', () => {
    const out = normalizeCircleSections([r(0, 10, 'a'), r(8, 20, 'b'), r(20, 30, 'c'), r(40, 45, 'd')]);
    expect(out).toEqual([
      { id: 'a', start_sec: 0, end_sec: 30 },
      { id: 'd', start_sec: 40, end_sec: 45 },
    ]);
  });

  it('repairs inverted ranges and tolerates missing ids', () => {
    const out = normalizeCircleSections([{ id: '', start_sec: 12, end_sec: 2 }]);
    expect(out).toHaveLength(1);
    expect(out[0].start_sec).toBe(2);
    expect(out[0].end_sec).toBe(12);
    expect(out[0].id).toBeTruthy();
  });
});

describe('inCircleSection', () => {
  const ranges = [r(2, 5), r(10, 12)];
  it('inclusive start, exclusive end', () => {
    expect(inCircleSection(ranges, 2)).toBe(true);
    expect(inCircleSection(ranges, 4.99)).toBe(true);
    expect(inCircleSection(ranges, 5)).toBe(false);
    expect(inCircleSection(ranges, 9)).toBe(false);
    expect(inCircleSection(ranges, 11)).toBe(true);
    expect(inCircleSection([], 3)).toBe(false);
    expect(inCircleSection(undefined, 3)).toBe(false);
  });
});

describe('circlesLayers', () => {
  it('maps every visibility value to its layers (legacy defaults to broll)', () => {
    expect(circlesLayers(undefined)).toEqual({ always: false, broll: true, manual: false });
    expect(circlesLayers('broll')).toEqual({ always: false, broll: true, manual: false });
    expect(circlesLayers('manual')).toEqual({ always: false, broll: false, manual: true });
    expect(circlesLayers('broll+manual')).toEqual({ always: false, broll: true, manual: true });
    expect(circlesLayers('always')).toEqual({ always: true, broll: false, manual: false });
    expect(circlesLayers('none')).toEqual({ always: false, broll: false, manual: false });
  });
});

describe('makeCircleSection', () => {
  it('creates unique ids', () => {
    expect(makeCircleSection(0, 1).id).not.toBe(makeCircleSection(0, 1).id);
  });
});
