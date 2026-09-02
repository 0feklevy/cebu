import { describe, expect, it } from 'vitest';
import {
  aspectRatioOf,
  canonicalFrame,
  displayedGeometry,
  orientationOf,
  projectOrientation,
} from '../video/orientation.js';

describe('orientationOf', () => {
  it('is portrait only when height exceeds width', () => {
    expect(orientationOf({ width: 1080, height: 1920 })).toBe('portrait');
    expect(orientationOf({ width: 1920, height: 1080 })).toBe('landscape');
    expect(orientationOf({ width: 720, height: 1280 })).toBe('portrait');
  });

  it('treats square as landscape — the safe default for a frame with no long side', () => {
    expect(orientationOf({ width: 1080, height: 1080 })).toBe('landscape');
  });

  it('treats unknown, null, zero and garbage as landscape — every pre-082 row', () => {
    expect(orientationOf(null)).toBe('landscape');
    expect(orientationOf(undefined)).toBe('landscape');
    expect(orientationOf({})).toBe('landscape');
    expect(orientationOf({ width: null, height: 1920 })).toBe('landscape');
    expect(orientationOf({ width: 0, height: 1920 })).toBe('landscape');
    expect(orientationOf({ width: Number.NaN, height: 1920 })).toBe('landscape');
    expect(orientationOf({ width: -1080, height: 1920 })).toBe('landscape');
  });
});

describe('displayedGeometry', () => {
  it('swaps the axes for a 90° or 270° rotation tag — phone footage is coded landscape', () => {
    expect(displayedGeometry(1920, 1080, { rotationDeg: 90 })).toEqual({ width: 1080, height: 1920 });
    expect(displayedGeometry(1920, 1080, { rotationDeg: -90 })).toEqual({ width: 1080, height: 1920 });
    expect(displayedGeometry(1920, 1080, { rotationDeg: 270 })).toEqual({ width: 1080, height: 1920 });
    expect(displayedGeometry(1920, 1080, { rotationDeg: 180 })).toEqual({ width: 1920, height: 1080 });
    expect(displayedGeometry(1920, 1080, { rotationDeg: 0 })).toEqual({ width: 1920, height: 1080 });
    expect(displayedGeometry(1920, 1080, {})).toEqual({ width: 1920, height: 1080 });
  });

  it('widens an anamorphic frame by its sample aspect before deciding', () => {
    // 1440×1080 with SAR 4:3 displays as 1920×1080 — the anamorphic fixture the HLS suite uses.
    expect(displayedGeometry(1440, 1080, { sarNum: 4, sarDen: 3 })).toEqual({ width: 1920, height: 1080 });
    // Square pixels are a no-op.
    expect(displayedGeometry(1440, 1080, { sarNum: 1, sarDen: 1 })).toEqual({ width: 1440, height: 1080 });
    // A missing or absurd SAR is ignored rather than dividing by zero.
    expect(displayedGeometry(1440, 1080, { sarNum: 0, sarDen: 1 })).toEqual({ width: 1440, height: 1080 });
    expect(displayedGeometry(1440, 1080, { sarNum: null, sarDen: null })).toEqual({ width: 1440, height: 1080 });
  });

  it('applies SAR first, then rotation', () => {
    expect(displayedGeometry(1440, 1080, { sarNum: 4, sarDen: 3, rotationDeg: 90 })).toEqual({ width: 1080, height: 1920 });
  });
});

describe('projectOrientation', () => {
  it('lets the first non-b-roll video decide, in the order given', () => {
    expect(projectOrientation([
      { width: 1920, height: 1080, is_broll: true },
      { width: 1080, height: 1920, is_broll: false },
      { width: 1920, height: 1080, is_broll: false },
    ])).toBe('portrait');
  });

  it('falls back to the first video when every video is b-roll, and to landscape with none', () => {
    expect(projectOrientation([{ width: 1080, height: 1920, is_broll: true }])).toBe('portrait');
    expect(projectOrientation([])).toBe('landscape');
  });

  it('orders by created_at when every row carries one, so newest-first and oldest-first callers agree', () => {
    const newestFirst = [
      { width: 1920, height: 1080, is_broll: false, created_at: '2026-02-01T00:00:00Z' },
      { width: 1080, height: 1920, is_broll: false, created_at: '2026-01-01T00:00:00Z' },
    ];
    expect(projectOrientation(newestFirst)).toBe('portrait');
    expect(projectOrientation([...newestFirst].reverse())).toBe('portrait');
    // Date objects too — the backend rows carry Dates, the API JSON carries strings.
    expect(projectOrientation([
      { width: 1920, height: 1080, is_broll: false, created_at: new Date('2026-02-01T00:00:00Z') },
      { width: 1080, height: 1920, is_broll: false, created_at: new Date('2026-01-01T00:00:00Z') },
    ])).toBe('portrait');
  });

  it('is landscape when the primary video has not been probed yet, whatever the others say', () => {
    expect(projectOrientation([
      { width: null, height: null, is_broll: false },
      { width: 1080, height: 1920, is_broll: false },
    ])).toBe('landscape');
  });
});

describe('aspectRatioOf / canonicalFrame', () => {
  it('names the two canonical frames and their ratios', () => {
    expect(aspectRatioOf('landscape')).toBeCloseTo(16 / 9);
    expect(aspectRatioOf('portrait')).toBeCloseTo(9 / 16);
    expect(canonicalFrame('landscape')).toEqual({ width: 1920, height: 1080 });
    expect(canonicalFrame('portrait')).toEqual({ width: 1080, height: 1920 });
  });
});
