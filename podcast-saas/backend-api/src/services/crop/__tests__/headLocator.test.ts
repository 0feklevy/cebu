/**
 * Head localization — does the crop find the person who is SPEAKING?
 *
 * Owner-reported production symptom (D-16): "if the woman talks and there are 2 people
 * in the frame, it shows the man and not the woman."
 *
 * `locateHeads` scores person-energy as skin x2.0 + saliency x0.6 + motion x1.0. Skin and
 * saliency both answer "a person is HERE"; neither answers "this person is SPEAKING", and
 * raw motion at the pipeline's 4 fps is gross head/body motion, so an animated listener
 * outscores a still-headed talker. When the two-shot gate then fails, `dominantColumn`
 * pins ONE column for the whole shot — and the whole video sits on the wrong person.
 *
 * Measured baseline for the scene below (before the speech-correlation term existed):
 *   locateHeads -> heads=[0.305] twoShot=false
 *   the speaker is 758 px outside a 304 px half-window, for the entire take.
 *
 * Pure CPU: synthetic column profiles, no ffmpeg, no fixtures.
 */

import { describe, it, expect } from 'vitest';
import { locateHeads, fallbackColumn } from '../headLocator.js';
import { PROFILE_COLS } from '../sceneAnalyzer.js';
import { speechCorrelatedMotion } from '../activeSpeaker.js';

const MAN = 0.30, WOMAN = 0.70;
const HALF_WINDOW = (1080 * (9 / 16)) / 1920 / 2;   // 0.15820 -> 304 px on 1920
const N = 240;                                       // 60 s at 4 fps

function bump(a: Float64Array, cx: number, amp: number, half: number): void {
  const c = Math.round(cx * (PROFILE_COLS - 1));
  for (let x = c - half; x <= c + half; x++) {
    if (x < 0 || x >= PROFILE_COLS) continue;
    const d = Math.abs(x - c) / (half + 1);
    a[x] += amp * (1 - d * d);
  }
}

/**
 * A two-shot in which:
 *   • the MAN has a big, well-lit face (strong skin response) and is the LISTENER,
 *     but nods and gestures constantly on his own clock — motion uncorrelated with speech;
 *   • the WOMAN is TALKING, so her region's motion rises and falls with the audio,
 *     but her skin response is `womanSkin` x his (deep skin tone, side light, or a
 *     dark top — `isSkin` is a 1990s RGB rule that scores ~0 on a deep tone).
 */
function scene(womanSkin: number) {
  let seed = 31;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const motion: Float64Array[] = [];
  const env = new Float64Array(N);
  const skinS = new Float64Array(PROFILE_COLS);
  const salS = new Float64Array(PROFILE_COLS);
  const actS = new Float64Array(PROFILE_COLS);

  for (let i = 0; i < N; i++) {
    const womanTalking = (i % 40) < 30;                       // she holds the floor 75% of the take
    const e = 0.02 + 0.06 * Math.abs(Math.sin(i * 1.9)) + 0.004 * rnd();
    env[i] = e;
    const m = new Float64Array(PROFILE_COLS);
    bump(m, WOMAN, womanTalking ? e * 700 : 15 * rnd(), 6);   // tracks the audio envelope
    bump(m, MAN, 300 * (0.5 + 0.5 * Math.sin(i * 0.41)) + 15 * rnd(), 7);  // nodding, uncorrelated
    motion.push(m);
    bump(skinS, MAN, 1.0, 7);
    bump(skinS, WOMAN, womanSkin, 6);
    bump(salS, MAN, 0.9, 8);
    bump(salS, WOMAN, 0.85, 8);
    for (let x = 0; x < PROFILE_COLS; x++) actS[x] += m[x];
  }
  return { motion, env, skinS, salS, actS };
}

/** Closest located head to `target`, in frame-width units. */
function missTo(heads: number[], target: number): number {
  if (heads.length === 0) return 1;
  return Math.min(...heads.map((h) => Math.abs(h - target)));
}

describe('locateHeads finds the person who is speaking', () => {
  it('locates a talking woman whose face barely registers as skin, next to a nodding man', () => {
    const { motion, env, skinS, salS, actS } = scene(0.05);
    const speechS = speechCorrelatedMotion(motion, env);
    const hm = locateHeads(skinS, salS, actS, speechS);

    expect(
      missTo(hm.heads, WOMAN),
      `heads=[${hm.heads.map((h) => h.toFixed(3)).join(', ')}] twoShot=${hm.isTwoShot}; ` +
      `the speaker at ${WOMAN} is ${(missTo(hm.heads, WOMAN) * 1920).toFixed(0)} px from the nearest located head`,
    ).toBeLessThan(HALF_WINDOW);
  });

  it('the audio-blind signal alone still gets this scene wrong (the defect is real, not the test)', () => {
    // Same scene, no speech term — this is exactly what production computed.
    const { skinS, salS, actS } = scene(0.05);
    const hm = locateHeads(skinS, salS, actS);
    expect(hm.isTwoShot).toBe(false);
    expect(hm.heads).toHaveLength(1);
    expect(missTo(hm.heads, MAN)).toBeLessThan(HALF_WINDOW);       // pinned on the listener
    expect(missTo(hm.heads, WOMAN)).toBeGreaterThan(HALF_WINDOW);  // the speaker is out of frame
  });
});

describe('what head localization must NOT lose', () => {
  it('still detects an ordinary two-shot when both faces read normally', () => {
    const { motion, env, skinS, salS, actS } = scene(1.0);
    const hm = locateHeads(skinS, salS, actS, speechCorrelatedMotion(motion, env));
    expect(hm.isTwoShot).toBe(true);
    expect(hm.heads).toHaveLength(2);
    expect(Math.abs(hm.heads[0] - MAN)).toBeLessThan(0.05);
    expect(Math.abs(hm.heads[1] - WOMAN)).toBeLessThan(0.05);
  });

  it('is unchanged when there is no audio to correlate against', () => {
    // extractMonoPcm resolves empty on a silent or undecodable track; the crop still runs.
    // With no speech signal the result must be bit-identical to the audio-blind path.
    const { motion, skinS, salS, actS } = scene(0.4);
    const silent = new Float64Array(N);          // no audio energy at all
    const withSilentAudio = locateHeads(skinS, salS, actS, speechCorrelatedMotion(motion, silent));
    const audioBlind = locateHeads(skinS, salS, actS);
    expect(withSilentAudio).toEqual(audioBlind);
  });
});

describe('speechCorrelatedMotion', () => {
  it('keeps motion that tracks the audio and discards motion that does not', () => {
    const { motion, env } = scene(1.0);
    const sp = speechCorrelatedMotion(motion, env);
    const at = (x: number) => sp[Math.round(x * (PROFILE_COLS - 1))];
    expect(at(WOMAN), 'the talker keeps her energy').toBeGreaterThan(0);
    expect(at(WOMAN), 'the talker must outscore the nodding listener').toBeGreaterThan(at(MAN) * 3);
  });

  it('has no opinion when the audio is silent or constant', () => {
    const { motion } = scene(1.0);
    const flat = new Float64Array(N).fill(0.05);   // constant -> zero variance
    expect(Array.from(speechCorrelatedMotion(motion, flat)).every((v) => v === 0)).toBe(true);
    expect(Array.from(speechCorrelatedMotion(motion, new Float64Array(N))).every((v) => v === 0)).toBe(true);
  });
});

describe('the null hypothesis — shots with nobody in them', () => {
  const FRAMES = 96;

  /** A title card: strong, broad saliency from text; no skin, no motion. */
  function titleCard(): { sk: Float64Array; sa: Float64Array; ac: Float64Array } {
    const sa = new Float64Array(PROFILE_COLS);
    for (let x = Math.round(0.14 * PROFILE_COLS); x < Math.round(0.58 * PROFILE_COLS); x++) sa[x] = FRAMES;
    return { sk: new Float64Array(PROFILE_COLS), sa, ac: new Float64Array(PROFILE_COLS) };
  }

  it('finds no head when only saliency carries energy', () => {
    // Before the floor existed this returned a confident head at the left edge, which the
    // 9:16 clamp turned into x = 0.158 — hard left, held for the whole shot.
    const { sk, sa, ac } = titleCard();
    expect(locateHeads(sk, sa, ac, undefined, FRAMES)).toEqual({ heads: [], isTwoShot: false });
  });

  it('declines to name a fallback column without motion, so the caller can centre', () => {
    const { sa, ac } = titleCard();
    expect(fallbackColumn(sa, ac, FRAMES)).toBeNull();
  });

  it('still finds a head from motion alone when the skin rule scores zero', () => {
    // A deep skin tone under cool light: Kovač returns nothing, and motion is all there is.
    const sk = new Float64Array(PROFILE_COLS);
    const sa = new Float64Array(PROFILE_COLS);
    const ac = new Float64Array(PROFILE_COLS);
    bump(ac, 0.62, 400 * FRAMES, 4);
    const hm = locateHeads(sk, sa, ac, undefined, FRAMES);
    expect(hm.heads.length).toBe(1);
    expect(hm.heads[0]).toBeCloseTo(0.62, 1);
  });

  it('names a fallback column when one region genuinely stands out', () => {
    const sa = new Float64Array(PROFILE_COLS);
    const ac = new Float64Array(PROFILE_COLS);
    bump(ac, 0.7, 300 * FRAMES, 3);
    expect(fallbackColumn(sa, ac, FRAMES)).toBeCloseTo(0.7, 1);
  });

  it('scales the floor with shot length, not frame count', () => {
    // The same per-frame evidence must read the same whether the shot is 4 s or 40 s.
    const sk = new Float64Array(PROFILE_COLS);
    bump(sk, 0.4, 40 * 16, 3);
    const short = locateHeads(sk, new Float64Array(PROFILE_COLS), new Float64Array(PROFILE_COLS), undefined, 16);
    const skLong = new Float64Array(PROFILE_COLS);
    bump(skLong, 0.4, 40 * 160, 3);
    const long = locateHeads(skLong, new Float64Array(PROFILE_COLS), new Float64Array(PROFILE_COLS), undefined, 160);
    expect(short.heads.length).toBe(1);
    expect(long.heads.length).toBe(1);
    expect(short.heads[0]).toBeCloseTo(long.heads[0], 6);
  });
});
