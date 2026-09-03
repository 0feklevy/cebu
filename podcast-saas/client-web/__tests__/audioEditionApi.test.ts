/**
 * P3-B / A2.2 — the pure rules behind the listening surface.
 *
 * Two of these decide whether the steering-wheel skip button appears to work, and both fail in
 * ways nobody would notice while testing at a desk with the screen on.
 */
import { describe, it, expect } from 'vitest';
import { chapterIndexAt, formatClock, formatDuration, type AudioChapter } from '../lib/audioEditionApi';

const ch = (startMs: number, endMs: number, title = 't'): AudioChapter => ({ startMs, endMs, title });

describe('which chapter a moment belongs to', () => {
  const chapters = [ch(0, 60_000, 'One'), ch(60_000, 120_000, 'Two'), ch(120_000, 180_000, 'Three')];

  it('finds the chapter containing a position', () => {
    expect(chapterIndexAt(chapters, 30_000)).toBe(0);
    expect(chapterIndexAt(chapters, 90_000)).toBe(1);
  });

  it('a position exactly ON a boundary belongs to the chapter it BEGINS', () => {
    // Half-open intervals, `[start, end)`. Getting this backwards makes "next chapter" seek to
    // the boundary and immediately report the PREVIOUS chapter as current — which on a lock
    // screen reads as the skip button not working, and is the kind of thing a desk test with the
    // screen on never surfaces.
    expect(chapterIndexAt(chapters, 60_000)).toBe(1);
    expect(chapterIndexAt(chapters, 120_000)).toBe(2);
  });

  it('the final millisecond belongs to the last chapter, not to nothing', () => {
    // `positionMs >= lastEnd` is reachable exactly at the end of the file, and returning -1 there
    // would blank the lock-screen title on the last tick of every episode.
    expect(chapterIndexAt(chapters, 180_000)).toBe(2);
    expect(chapterIndexAt(chapters, 999_000)).toBe(2);
  });

  it('reports -1 before the first chapter rather than guessing', () => {
    // Only reachable when the chapter list does not start at 0 — which the backend prevents, but
    // a client must not depend on a server-side invariant it cannot see.
    expect(chapterIndexAt([ch(5_000, 10_000)], 1_000)).toBe(-1);
  });

  it('handles an empty chapter list', () => {
    // A legitimate shape: a project with no labelled sections. The player falls back to ±30s.
    expect(chapterIndexAt([], 1_000)).toBe(-1);
  });
});

describe('a duration a listener reads before deciding to start', () => {
  it.each([
    [null, ''],
    [0, ''],
    [-5, ''],
    [31_000, '31s'],
    [252_000, '4m 12s'],
    [3_840_000, '1h 04m'],
  ])('%s ms → "%s"', (ms, expected) => {
    expect(formatDuration(ms as number | null)).toBe(expected);
  });

  it('drops seconds once there are hours', () => {
    // Nobody choosing between two hour-long episodes cares about the 12 seconds, and the extra
    // digits crowd out the number that does matter.
    expect(formatDuration(3_852_000)).toBe('1h 04m');
  });

  it('pads minutes so hour-long durations line up in a list', () => {
    expect(formatDuration(3_660_000)).toBe('1h 01m');
  });
});

describe('the running clock beside a scrubber', () => {
  it.each([
    [0, '00:00'],
    [61_000, '01:01'],
    [3_600_000, '1:00:00'],
    [3_661_000, '1:01:01'],
  ])('%s ms → "%s"', (ms, expected) => {
    expect(formatClock(ms as number)).toBe(expected);
  });

  it('never renders a negative clock', () => {
    // Reachable from a seek that clamps below zero, and `-1:-1` beside a scrubber looks like the
    // player has crashed.
    expect(formatClock(-5_000)).toBe('00:00');
  });

  it('is zero-padded, so a chapter list does not jitter as it scrolls', () => {
    expect(formatClock(9_000)).toBe('00:09');
    expect(formatClock(540_000)).toBe('09:00');
  });
});
