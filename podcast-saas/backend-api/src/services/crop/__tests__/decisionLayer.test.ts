/**
 * The decision layer — debounce, smoothing boundaries, pitch labelling, shot segmentation.
 *
 * These four files decide when the crop is allowed to move and where the moves are allowed
 * to be blurred, and between them they held every constant the vertical-crop diagnosis
 * indicted while having no direct tests at all. The switch-boundary behaviour in particular
 * was previously inferred from the shape of the smoother's own output, so nothing proved that
 * a switch the debounce actually committed became a cut rather than a three-second glide.
 */

import { describe, it, expect } from 'vitest';
import { DebounceState, applyDebounce } from '../debounce.js';
import { smoothKeyframes, type Keyframe } from '../smoother.js';
import { labelFromPitch } from '../speaker.js';
import { buildFrameSegments } from '../cropProcessor.js';

const DT = 0.25;   // the pipeline's 4 fps

describe('applyDebounce', () => {
  it('adopts the first speaker immediately and records the commit', () => {
    const s = new DebounceState();
    expect(applyDebounce(s, 'r0', 0, 0.3)).toBe(0.3);
    expect(s.commits).toEqual([0]);
  });

  it('makes a challenger hold the floor for 0.8 s before the crop moves', () => {
    const s = new DebounceState();
    applyDebounce(s, 'r0', 0, 0.3);
    const seen: Array<number | null> = [];
    for (let k = 1; k <= 5; k++) seen.push(applyDebounce(s, 'r1', k * DT, 0.7));
    // Pending from t=0.25; commits at the first sample where t − pendingSince >= 0.8, which at
    // 4 fps is t = 1.25 — the debounce costs one sample more than 0.8 s of speech.
    expect(seen).toEqual([0.3, 0.3, 0.3, 0.3, 0.7]);
    expect(s.commits).toEqual([0, 1.25]);
  });

  it('clears a pending challenger as soon as the current speaker talks again', () => {
    const s = new DebounceState();
    applyDebounce(s, 'r0', 0, 0.3);
    applyDebounce(s, 'r1', 0.25, 0.7);
    expect(s.pendingSpeaker).toBe('r1');
    applyDebounce(s, 'r0', 0.5, 0.3);
    expect(s.pendingSpeaker).toBeNull();
    // The interjection never commits: the challenger has to start its 0.8 s again.
    applyDebounce(s, 'r1', 0.75, 0.7);
    expect(applyDebounce(s, 'r1', 1.25, 0.7)).toBe(0.3);
    expect(s.commits).toEqual([0]);
  });

  it('holds the framing through silence, and forgets the speaker after 1.5 s of it', () => {
    const s = new DebounceState();
    applyDebounce(s, 'r0', 0, 0.3);
    expect(applyDebounce(s, 'silence', 1.0, null)).toBe(0.3);
    expect(s.currentSpeaker).toBe('r0');
    expect(applyDebounce(s, 'silence', 2.0, null)).toBe(0.3);   // 2.0 − 0 > 1.5 → reset
    expect(s.currentSpeaker).toBeNull();
    // After a reset the next speaker is adopted at once rather than waiting 0.8 s.
    expect(applyDebounce(s, 'r1', 2.25, 0.7)).toBe(0.7);
  });

  it('treats "unclear" as hold without touching the silence timer', () => {
    const s = new DebounceState();
    applyDebounce(s, 'r0', 0, 0.3);
    expect(applyDebounce(s, 'unclear', 5.0, null)).toBe(0.3);
    expect(s.lastSpeechT).toBe(0);
    expect(s.currentSpeaker).toBe('r0');
  });
});

describe('smoothKeyframes', () => {
  const step = (n: number, at: number, lo: number, hi: number): Keyframe[] =>
    Array.from({ length: n }, (_, i) => ({ t: Number((i * DT).toFixed(3)), x: i < at ? lo : hi }));

  it('delivers a declared switch as a step, not a ramp', () => {
    const kf = step(40, 20, 0.3, 0.7);
    const out = smoothKeyframes(kf, [0], 1.2, DT, [20 * DT]);
    // Immediately before and after the boundary the two levels must still be the two levels.
    expect(out[19].x).toBeCloseTo(0.3, 3);
    expect(out[20].x).toBeCloseTo(0.7, 3);
  });

  it('glides across the same step when no boundary is declared and the levels are not held', () => {
    // A jump that findSwitches cannot certify — the run after it is too short to look held —
    // keeps the Gaussian's eased behaviour, which is the conservative direction.
    const kf = step(24, 22, 0.3, 0.7);
    const out = smoothKeyframes(kf, [0], 1.2, DT, []);
    expect(out[22].x).toBeLessThan(0.7);
    expect(out[22].x).toBeGreaterThan(0.3);
  });

  it('never blends across a shot cut', () => {
    const kf = step(40, 20, 0.3, 0.7);
    const out = smoothKeyframes(kf, [0, 20 * DT], 1.2, DT);
    expect(out[19].x).toBeCloseTo(0.3, 3);
    expect(out[20].x).toBeCloseTo(0.7, 3);
  });

  it('leaves a constant framing constant and crushes jitter within a run', () => {
    const flat: Keyframe[] = Array.from({ length: 40 }, (_, i) => ({ t: i * DT, x: 0.42 }));
    for (const k of smoothKeyframes(flat, [0], 1.2, DT)) expect(k.x).toBeCloseTo(0.42, 4);

    const noisy: Keyframe[] = Array.from({ length: 40 }, (_, i) => ({ t: i * DT, x: 0.5 + (i % 2 ? 0.04 : -0.04) }));
    const out = smoothKeyframes(noisy, [0], 1.2, DT);
    const spread = Math.max(...out.map((k) => k.x)) - Math.min(...out.map((k) => k.x));
    expect(spread).toBeLessThan(0.01);
  });

  it('rounds to the published contract precision', () => {
    const kf: Keyframe[] = [{ t: 1 / 3, x: 1 / 3 }, { t: 2 / 3, x: 2 / 3 }];
    const out = smoothKeyframes(kf, [0], 1.2, DT);
    for (const k of out) {
      expect(String(k.t).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
      expect(String(k.x).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });
});

describe('labelFromPitch', () => {
  const conf = 0.8;

  it('calls silence from level alone, before pitch is consulted', () => {
    expect(labelFromPitch({ rms: 0.001, f0: 200, conf }, 160)).toEqual({ label: 'silence', conf: 1 });
  });

  it('refuses to guess when the pitch estimate is not confident', () => {
    expect(labelFromPitch({ rms: 0.1, f0: 200, conf: 0.29 }, 160).label).toBe('unclear');
    expect(labelFromPitch({ rms: 0.1, f0: 0, conf: 0.9 }, 160).label).toBe('unclear');
  });

  it('abstains inside the ±10 Hz grey zone and discounts its confidence', () => {
    expect(labelFromPitch({ rms: 0.1, f0: 165, conf }, 160)).toEqual({ label: 'unclear', conf: conf * 0.4 });
    expect(labelFromPitch({ rms: 0.1, f0: 170, conf }, 160).label).toBe('female');
    expect(labelFromPitch({ rms: 0.1, f0: 149.9, conf }, 160).label).toBe('male');
  });

  it('moves the boundary with the calibrated threshold', () => {
    // 185 Hz is a woman below a 200 Hz split and a man above a 160 Hz one — which is the whole
    // reason the threshold self-calibrates instead of being fixed at 160.
    expect(labelFromPitch({ rms: 0.1, f0: 185, conf }, 200).label).toBe('male');
    expect(labelFromPitch({ rms: 0.1, f0: 185, conf }, 160).label).toBe('female');
  });
});

describe('buildFrameSegments', () => {
  it('turns boundary times into contiguous, gap-free frame ranges', () => {
    expect(buildFrameSegments([0, 2, 5], 40, 4)).toEqual([[0, 8], [8, 20], [20, 40]]);
  });

  it('collapses duplicate and unsorted boundaries', () => {
    expect(buildFrameSegments([5, 0, 5, 2], 40, 4)).toEqual([[0, 8], [8, 20], [20, 40]]);
  });

  it('drops boundaries past the end rather than emitting empty shots', () => {
    expect(buildFrameSegments([0, 3, 99], 12, 4)).toEqual([[0, 12]]);
  });

  it('always returns at least one segment', () => {
    expect(buildFrameSegments([], 10, 4)).toEqual([[0, 10]]);
  });
});
