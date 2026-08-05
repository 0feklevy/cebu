/**
 * The section-boundary sentinel (Priority 8.6).
 *
 * The claims are narrow on purpose. This reduces boundary DETECTION lateness from ~125ms mean
 * (timeupdate at ~4Hz) to roughly a frame; it does not make a simulation appear sooner. The tests
 * therefore pin the mechanics that could go wrong — arming windows, cancellation across element
 * swaps, and the fallback where requestVideoFrameCallback does not exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { armBoundarySentinel, supportsRvfc, DEFAULT_HORIZON_SEC } from '../lib/sim/boundaryClock.js';

type Cb = (now: number, meta: { mediaTime: number }) => void;

function makeVideo(opts: { rvfc?: boolean; currentTime?: number; rate?: number } = {}) {
  const cbs = new Map<number, Cb>();
  let next = 1;
  const v = {
    currentTime: opts.currentTime ?? 0,
    playbackRate: opts.rate ?? 1,
    cancelled: [] as number[],
  } as unknown as HTMLVideoElement & {
    cancelled: number[]; __fire(mediaTime: number): void; __pending(): number;
  };
  if (opts.rvfc !== false) {
    (v as unknown as Record<string, unknown>).requestVideoFrameCallback = (cb: Cb) => {
      const h = next++; cbs.set(h, cb); return h;
    };
    (v as unknown as Record<string, unknown>).cancelVideoFrameCallback = (h: number) => {
      v.cancelled.push(h); cbs.delete(h);
    };
  }
  v.__fire = (mediaTime: number) => {
    for (const [h, cb] of [...cbs]) { cbs.delete(h); cb(0, { mediaTime }); }
  };
  v.__pending = () => cbs.size;
  return v;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('arming', () => {
  it('arms with rVFC when available', () => {
    const s = armBoundarySentinel({
      video: makeVideo(), targetSec: 0.2, onBoundary: () => {} });
    expect(s.mode).toBe('rvfc');
  });

  it('falls back to a timer where rVFC does not exist', () => {
    // Notably Firefox for most of its history. The fallback is more precise BETWEEN frames and less
    // robust to rate changes, which is why timeupdate stays the safety net either way.
    const s = armBoundarySentinel({
      video: makeVideo({ rvfc: false }), targetSec: 0.2, onBoundary: () => {} });
    expect(s.mode).toBe('timeout');
  });

  it('does not arm for a boundary already passed — the caller must act, not schedule', () => {
    const s = armBoundarySentinel({
      video: makeVideo({ currentTime: 5 }), targetSec: 5, onBoundary: () => {} });
    expect(s.mode).toBe('none');
  });

  it('does not arm outside the horizon, so a long section holds no handle', () => {
    const v = makeVideo();
    expect(armBoundarySentinel({ video: v, targetSec: 60, onBoundary: () => {} }).mode).toBe('none');
    expect(v.__pending()).toBe(0);
  });

  it('respects a custom horizon', () => {
    const s = armBoundarySentinel({
      video: makeVideo(), targetSec: 5, onBoundary: () => {}, horizonSec: 10 });
    expect(s.mode).toBe('rvfc');
  });

  it('refuses a non-finite target', () => {
    expect(armBoundarySentinel({
      video: makeVideo(), targetSec: NaN, onBoundary: () => {} }).mode).toBe('none');
  });

  it('survives a video whose currentTime throws', () => {
    // A detached or errored element must not turn a boundary into an exception.
    const bad = {
      get currentTime(): number { throw new Error('detached'); },
      playbackRate: 1,
    } as unknown as HTMLVideoElement;
    expect(armBoundarySentinel({ video: bad, targetSec: 1, onBoundary: () => {} }).mode).toBe('none');
  });

  it('reports rVFC support honestly', () => {
    expect(supportsRvfc(makeVideo())).toBe(true);
    expect(supportsRvfc(makeVideo({ rvfc: false }))).toBe(false);
  });

  it('has a sub-second default horizon', () => {
    expect(DEFAULT_HORIZON_SEC).toBeLessThan(1);
  });
});

describe('firing', () => {
  it('fires with the frame own mediaTime, not the sampled currentTime', () => {
    // mediaTime is the presentation timestamp of the frame actually shown; currentTime is an
    // estimate, which is the whole reason for preferring rVFC.
    const v = makeVideo();
    const seen: number[] = [];
    armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    v.__fire(0.2501);
    expect(seen).toEqual([0.2501]);
  });

  it('re-arms until the boundary is actually reached', () => {
    const v = makeVideo();
    const seen: number[] = [];
    armBoundarySentinel({ video: v, targetSec: 0.3, onBoundary: (t) => seen.push(t) });
    v.__fire(0.1);
    expect(seen).toEqual([]);
    v.__fire(0.2);
    expect(seen).toEqual([]);
    v.__fire(0.31);
    expect(seen).toEqual([0.31]);
  });

  it('fires exactly once', () => {
    const v = makeVideo();
    const seen: number[] = [];
    armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    v.__fire(0.25);
    v.__fire(0.30);
    expect(seen).toHaveLength(1);
  });

  it('fires on the timer fallback, scaled by playback rate', () => {
    const v = makeVideo({ rvfc: false, rate: 2 });
    const seen: number[] = [];
    armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    // 0.2s of media at 2x = 100ms of wall clock.
    vi.advanceTimersByTime(99);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(seen).toHaveLength(1);
  });

  it('treats a non-positive playback rate as 1 rather than dividing by it', () => {
    // Dividing by zero yields an Infinite delay, which Node coerces to ~1ms — so the boundary would
    // fire almost immediately instead of at the right time. Asserting only that it eventually fires
    // would pass for that bug, so the early check is the one that matters.
    const v = makeVideo({ rvfc: false, rate: 0 });
    const seen: number[] = [];
    armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    vi.advanceTimersByTime(199);
    expect(seen, 'the boundary fired far too early').toEqual([]);
    vi.advanceTimersByTime(2);
    expect(seen).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('cancels the rVFC handle — handles are per-ELEMENT and this player swaps elements', () => {
    // A self-rescheduling loop left running against a detached element fires boundaries for a video
    // nobody is watching.
    const v = makeVideo();
    const s = armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: () => {} });
    s.cancel();
    expect(v.cancelled.length).toBeGreaterThan(0);
    expect(v.__pending()).toBe(0);
  });

  it('never fires after cancellation', () => {
    const v = makeVideo();
    const seen: number[] = [];
    const s = armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    s.cancel();
    v.__fire(0.5);
    expect(seen).toEqual([]);
  });

  it('cancels the timer fallback too', () => {
    const v = makeVideo({ rvfc: false });
    const seen: number[] = [];
    const s = armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it('stops firing even when the browser offers no cancelVideoFrameCallback', () => {
    // Some engines expose requestVideoFrameCallback without the cancel half. There, the internal
    // done-flag is the ONLY thing preventing a boundary from firing for a video the player has
    // already moved on from — the handle cannot be withdrawn.
    const v = makeVideo();
    delete (v as unknown as Record<string, unknown>).cancelVideoFrameCallback;
    const seen: number[] = [];
    const s2 = armBoundarySentinel({ video: v, targetSec: 0.2, onBoundary: (t) => seen.push(t) });
    s2.cancel();
    v.__fire(0.5);
    expect(seen).toEqual([]);
  });

  it('actually CLEARS the fallback timer rather than only ignoring it', () => {
    // Leaving the timer pending keeps a closure over a swapped-out element alive for its full delay.
    const v = makeVideo({ rvfc: false });
    const before = vi.getTimerCount();
    const s2 = armBoundarySentinel({ video: v, targetSec: 5, onBoundary: () => {}, horizonSec: 10 });
    expect(vi.getTimerCount()).toBe(before + 1);
    s2.cancel();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('cancel is idempotent and never throws', () => {
    const s = armBoundarySentinel({ video: makeVideo(), targetSec: 0.2, onBoundary: () => {} });
    expect(() => { s.cancel(); s.cancel(); }).not.toThrow();
  });

  it('cancelling an unarmed sentinel is safe', () => {
    const s = armBoundarySentinel({ video: makeVideo(), targetSec: 999, onBoundary: () => {} });
    expect(() => s.cancel()).not.toThrow();
  });
});
