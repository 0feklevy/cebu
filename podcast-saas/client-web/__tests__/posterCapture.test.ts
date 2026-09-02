import { describe, it, expect } from 'vitest';
import { fitContain, posterTargets } from '../lib/posterCapture';

describe('fitContain — object-contain, centred', () => {
  it('a 16:9 source fills a 16:9 box exactly', () => {
    expect(fitContain(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
  it('a square source is pillarboxed in a wide box and letterboxed in a tall one', () => {
    expect(fitContain(1000, 1000, 1280, 720)).toEqual({ x: 280, y: 0, w: 720, h: 720 });
    expect(fitContain(1000, 1000, 720, 1280)).toEqual({ x: 0, y: 280, w: 720, h: 720 });
  });
  it('a portrait source in a portrait box fills it', () => {
    expect(fitContain(1080, 1920, 720, 1280)).toEqual({ x: 0, y: 0, w: 720, h: 1280 });
  });
  it('an unknown source size fills the box rather than dividing by zero', () => {
    expect(fitContain(0, 0, 640, 360)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });
});

describe('posterTargets — the shared size table, by aspect', () => {
  it('names standard and compact for wide and for portrait', () => {
    expect(posterTargets('wide')).toEqual([
      { size: 'standard', width: 1280, height: 720 },
      { size: 'compact', width: 640, height: 360 },
    ]);
    expect(posterTargets('portrait')).toEqual([
      { size: 'standard', width: 720, height: 1280 },
      { size: 'compact', width: 360, height: 640 },
    ]);
  });
});
