/**
 * Speaker-turn regression harness.
 *
 * Owner-reported production symptom (D-16, confirmed after v0.1.28):
 *   "vertical crop is not capturing the right person who is speaking — if the woman
 *    talks and there are 2 people in the frame, it shows the man and not the woman."
 *
 * These cases are the pure-CPU repro scripts from
 * `.audit-ledger/vertical-crop-investigation.md` (§2/BUG-3), promoted into the suite so
 * the failure is provable rather than argued. They drive the REAL `applyDebounce` +
 * `smoothKeyframes` — no ffmpeg, no I/O, no fixtures.
 *
 * The measured baseline they were written against (zero-phase sigma=1.2s Gaussian):
 *   turn 1.5s -> peak x 0.487, a 409 px miss   -> the speaker is OFF-SCREEN
 *   turn 2.0s -> peak x 0.538, a 312 px miss   -> the speaker is OFF-SCREEN
 *   step response: 17.4% travelled 1.2s BEFORE the switch, only 54.1% at the switch.
 */

import { describe, it, expect } from 'vitest';
import { DebounceState, applyDebounce } from '../debounce.js';
import { smoothKeyframes, type Keyframe } from '../smoother.js';

const SI = 0.25;                 // the pipeline's real sample interval (4 fps)
const A = 0.30, B = 0.70;        // two head positions in a two-shot
const TRAVEL = B - A;

/** Half-width of the 9:16 crop window inside a 1920x1080 frame, in frame-width units. */
const HALF_WINDOW = (1080 * (9 / 16)) / 1920 / 2;   // 0.15820 -> 304 px on 1920

/** Build the debounce-gated raw keyframe series for "B speaks for `turnSec`, A otherwise". */
function turnSeries(turnSec: number, nFrames = 480, startFrame = 200): Keyframe[] {
  const st = new DebounceState();
  const n = Math.round(turnSec / SI);
  return Array.from({ length: nFrames }, (_, i) => {
    const t = i * SI;
    const inTurn = i >= startFrame && i < startFrame + n;
    const committed = applyDebounce(st, inTurn ? 'r1' : 'r0', t, inTurn ? B : A);
    return { t: Number(t.toFixed(3)), x: committed ?? (A + B) / 2 };
  });
}

function smooth(raw: Keyframe[]): Keyframe[] {
  return smoothKeyframes(raw, [0], 1.2, SI);
}

/** Fraction of the A->B travel delivered at a given keyframe. */
const delivered = (x: number) => (x - A) / TRAVEL;

describe('speaker turn — the crop must actually arrive on the person talking', () => {
  // 1.0s is deliberately suppressed by the debounce (MIN_SPEAKER_DURATION = 0.8s plus
  // the frame it commits on), so it is excluded: no switch is ordered, nothing to deliver.
  for (const turnSec of [1.5, 2, 2.5, 3]) {
    it(`a committed ${turnSec}s turn puts the speaker inside the 9:16 window`, () => {
      const out = smooth(turnSeries(turnSec));
      const peak = Math.max(...out.map((k) => k.x));
      const missPx = (B - peak) * 1920;
      expect(
        B - peak,
        `turn ${turnSec}s: peak x=${peak.toFixed(3)}, speaker at ${B}, miss ${missPx.toFixed(0)} px ` +
        `(9:16 half-window is ${(HALF_WINDOW * 1920).toFixed(0)} px)`,
      ).toBeLessThan(HALF_WINDOW);
    });

    it(`a committed ${turnSec}s turn delivers >=90% of the travel`, () => {
      const out = smooth(turnSeries(turnSec));
      const peak = Math.max(...out.map((k) => k.x));
      expect(
        delivered(peak),
        `turn ${turnSec}s delivered only ${(delivered(peak) * 100).toFixed(1)}% of the A->B travel`,
      ).toBeGreaterThanOrEqual(0.9);
    });
  }
});

describe('step response of the crop trajectory', () => {
  /** A single committed switch at t = 50s, held to the end. */
  function stepSeries(): Keyframe[] {
    const st = new DebounceState();
    return Array.from({ length: 400 }, (_, i) => {
      const t = i * SI;
      const committed = applyDebounce(st, i < 200 ? 'r0' : 'r1', t, i < 200 ? A : B);
      return { t: Number(t.toFixed(3)), x: committed ?? A };
    });
  }
  // applyDebounce holds the switch for MIN_SPEAKER_DURATION, so the committed step
  // lands later than frame 200. Find where it actually is rather than assuming.
  const raw = stepSeries();
  const stepIdx = raw.findIndex((k) => k.x > (A + B) / 2);
  const out = smooth(raw);
  const at = (offsetSec: number) => out[stepIdx + Math.round(offsetSec / SI)].x;

  it('does not anticipate — the crop stays on the current speaker until the switch', () => {
    // The Gaussian is zero-phase, so it starts leaving the current speaker BEFORE the
    // next person is committed. That reads on screen as the camera drifting off whoever
    // is talking, which is the "cheap" tell.
    expect(
      delivered(at(-1.2)),
      `1.2s before the switch the crop had already travelled ${(delivered(at(-1.2)) * 100).toFixed(1)}% away from the current speaker`,
    ).toBeLessThanOrEqual(0.05);
  });

  it('arrives — >=95% of the travel is complete within 0.5s of the switch', () => {
    expect(
      delivered(at(0.5)),
      `0.5s after the switch only ${(delivered(at(0.5)) * 100).toFixed(1)}% of the travel was delivered`,
    ).toBeGreaterThanOrEqual(0.95);
  });
});

describe('what the smoother must NOT lose', () => {
  const sd = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const maxJump = (ks: Keyframe[]) => {
    let m = 0;
    for (let i = 1; i < ks.length; i++) m = Math.max(m, Math.abs(ks[i].x - ks[i - 1].x));
    return m;
  };

  // +/-0.05 is a deliberately pessimistic detector noise floor: five times the amplitude
  // the fix was tuned against, and roughly a third of the 9:16 half-window.
  for (const amp of [0.02, 0.05]) {
    it(`suppresses +/-${amp} of detector jitter without snapping on it`, () => {
      // Guard against two opposite regressions: "fix the lag by deleting the smoothing",
      // and "treat every noise excursion as a speaker switch and snap on it".
      let seed = 5;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const raw: Keyframe[] = Array.from({ length: 200 }, (_, i) => ({
        t: Number((i * SI).toFixed(3)),
        x: A + (rnd() - 0.5) * amp * 2,
      }));
      const out = smooth(raw);
      const before = sd(raw.map((k) => k.x)), after = sd(out.map((k) => k.x));
      expect(after, `jitter sd ${before.toFixed(4)} -> ${after.toFixed(4)}`).toBeLessThan(before * 0.4);
      expect(maxJump(out), 'no sample-to-sample snap may appear out of pure noise').toBeLessThan(0.01);
    });
  }

  it('still delivers a switch when each speaker\'s target itself wobbles', () => {
    // Today the two-shot path emits exactly heads[region], so both levels are perfectly
    // flat. Any future per-frame tracking within a shot (a speaker who leans or swivels)
    // makes them jittery instead — the switch must survive that, or the owner's symptom
    // comes straight back for exactly the footage that tracking was added to help.
    let seed = 13;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const raw: Keyframe[] = Array.from({ length: 400 }, (_, i) => ({
      t: Number((i * SI).toFixed(3)),
      x: (i < 200 ? A : B) + (rnd() - 0.5) * 0.04,
    }));
    const out = smooth(raw);
    // 0.5s after the switch — the same deadline the flat-target step response is held to.
    const at = out[200 + Math.round(0.5 / SI)].x;
    expect(
      delivered(at),
      `0.5s after a switch between two wobbling targets the crop reached only ${(delivered(at) * 100).toFixed(1)}%`,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('does not snap on a wobble the old Gaussian would have absorbed', () => {
    // A slow +/-0.08 oscillation: large in amplitude but never fast, so it is a pan, not a switch.
    const raw: Keyframe[] = Array.from({ length: 400 }, (_, i) => ({
      t: Number((i * SI).toFixed(3)),
      x: 0.5 + 0.08 * Math.sin(i * SI * 2 * Math.PI * 0.1),
    }));
    expect(maxJump(smooth(raw))).toBeLessThan(0.02);
  });

  it('never blends the crop across a shot boundary', () => {
    // Shot 0: speaker at A. Shot 1 (cut at t=25s): speaker at B.
    const raw: Keyframe[] = Array.from({ length: 200 }, (_, i) => ({
      t: Number((i * SI).toFixed(3)),
      x: i < 100 ? A : B,
    }));
    const out = smoothKeyframes(raw, [0, 25], 1.2, SI);
    expect(out[99].x).toBeCloseTo(A, 3);    // last frame before the cut is fully on A
    expect(out[100].x).toBeCloseTo(B, 3);   // first frame after the cut is fully on B
  });

  it('leaves a slow intentional pan alone (no false switch detection)', () => {
    // A continuous drift (the interest-centroid fallback path) must keep being smoothed,
    // not chopped into snapped runs.
    const raw: Keyframe[] = Array.from({ length: 200 }, (_, i) => ({
      t: Number((i * SI).toFixed(3)),
      x: 0.35 + (i / 199) * 0.20,           // 0.20 of frame width over 50s
    }));
    const out = smooth(raw);
    let maxJump = 0;
    for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i].x - out[i - 1].x));
    expect(maxJump, `largest single-sample jump on a slow pan: ${maxJump.toFixed(4)}`).toBeLessThan(0.01);
  });
});
