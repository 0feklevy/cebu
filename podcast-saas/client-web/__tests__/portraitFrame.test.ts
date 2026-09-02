/**
 * The two client-side rules a portrait source relies on (night run 2026-09-03 §3), as pure
 * functions with their own tests — because the guard used to live only inside a RAF closure,
 * where a regression would have cropped the top and bottom off a portrait video on a portrait
 * phone and nothing would have gone red.
 */
import { describe, it, expect } from 'vitest';
import { isPortraitSource } from '../components/viewer/useCropOverlay';
import { filmstripCellWidth } from '../lib/filmstrip';

describe('isPortraitSource — the crop overlay never covers a portrait element', () => {
  it('is true only when the displayed height exceeds the width', () => {
    expect(isPortraitSource(1080, 1920)).toBe(true);
    expect(isPortraitSource(720, 1280)).toBe(true);
    expect(isPortraitSource(1920, 1080)).toBe(false);
    expect(isPortraitSource(1080, 1080)).toBe(false);
  });

  it('treats unknown dimensions as landscape — the pre-geometry assumption, not a crop', () => {
    expect(isPortraitSource(0, 0)).toBe(false);
    expect(isPortraitSource(0, 1920)).toBe(false);
    expect(isPortraitSource(1080, 0)).toBe(false);
  });
});

describe('filmstripCellWidth — the thumbnail cell takes the frame’s shape', () => {
  it('is 80 wide for 16:9, 26 for 9:16, and in between for in between', () => {
    expect(filmstripCellWidth(1920, 1080)).toBe(80);
    expect(filmstripCellWidth(1080, 1920)).toBe(26);
    expect(filmstripCellWidth(1080, 1080)).toBe(45);
    expect(filmstripCellWidth(1440, 1080)).toBe(60);
  });

  it('clamps: an ultra-wide frame never exceeds 80, a very tall one never drops under 26', () => {
    expect(filmstripCellWidth(4000, 1000)).toBe(80);
    expect(filmstripCellWidth(1000, 4000)).toBe(26);
  });

  it('falls back to the widest cell when the frame is unknown', () => {
    expect(filmstripCellWidth(0, 0)).toBe(80);
    expect(filmstripCellWidth(Number.NaN, 1080)).toBe(80);
  });
});
