import { describe, it, expect } from 'vitest';
import {
  regionMotionSeries, windowedActiveRegions, calibrateGenderRegion,
  calibrateGenderRegionByActivity,
} from '../activeSpeaker.js';
import { PROFILE_COLS } from '../sceneAnalyzer.js';

/** Build a synthetic per-frame motion profile with energy concentrated at `headX`. */
function frameWithMotionAt(headX: number, energy: number): Float64Array {
  const m = new Float64Array(PROFILE_COLS);
  const c = Math.round(headX * (PROFILE_COLS - 1));
  for (let x = c - 6; x <= c + 6; x++) if (x >= 0 && x < PROFILE_COLS) m[x] = energy;
  return m;
}

describe('windowedActiveRegions (audio-visual correlation)', () => {
  it('attributes speech to whichever face moves in sync — even at equal pitch', () => {
    // 80 frames: LEFT speaks 0-39, RIGHT speaks 40-79. Both regions also carry
    // independent background motion + a common-mode wobble (must be rejected).
    const N = 80;
    const env = new Float64Array(N);
    const motionL = new Float64Array(N);
    const motionR = new Float64Array(N);
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    for (let i = 0; i < N; i++) {
      const e = 0.04 + 0.03 * Math.abs(Math.sin(i * 1.7)) + 0.01 * rnd();
      env[i] = e;
      const bgL = 0.5 * rnd(), bgR = 0.5 * rnd();
      const common = 0.3 * Math.sin(i * 0.3);
      if (i < 40) { motionL[i] = e * 40 + bgL + common; motionR[i] = bgR + common; }
      else        { motionL[i] = bgL + common;          motionR[i] = e * 40 + bgR + common; }
    }

    const av = windowedActiveRegions(motionL, motionR, env);
    const left  = av.slice(8, 36).filter((x) => x === 0).length;
    const right = av.slice(44, 72).filter((x) => x === 1).length;
    expect(left).toBeGreaterThan(20);
    expect(right).toBeGreaterThan(20);
  });

  it('returns null during silence (no audio energy)', () => {
    const N = 40;
    const env = new Float64Array(N);            // all zero → silence
    const motionL = new Float64Array(N).fill(1);
    const motionR = new Float64Array(N).fill(2);
    const av = windowedActiveRegions(motionL, motionR, env);
    expect(av.every((x) => x === null)).toBe(true);
  });
});

describe('regionMotionSeries', () => {
  it('pools motion energy from the head\'s column window', () => {
    const frames = [frameWithMotionAt(0.3, 10), frameWithMotionAt(0.3, 20)];
    const series = regionMotionSeries(frames, 0.3);
    expect(series[1]).toBeGreaterThan(series[0]);     // more energy → larger value
    const off = regionMotionSeries(frames, 0.8);      // far from the motion
    expect(off[0]).toBe(0);
  });
});

describe('calibrateGenderRegion', () => {
  it('maps each gender to the region the AV detector flagged while they spoke', () => {
    const N = 40;
    const labels = Array.from({ length: N }, (_, i) => ({ label: i < 20 ? 'male' : 'female', conf: 0.8 }));
    const av: Array<0 | 1 | null> = Array.from({ length: N }, (_, i) => (i < 20 ? 0 : 1));
    expect(calibrateGenderRegion(labels, av)).toEqual({ male: 0, female: 1 });
  });

  it('resolves conflicts (both genders favouring one region) by vote strength', () => {
    const labels = [
      { label: 'male', conf: 0.9 }, { label: 'male', conf: 0.9 },   // strongly region 1
      { label: 'female', conf: 0.4 },                                // weakly region 1
    ];
    const av: Array<0 | 1 | null> = [1, 1, 1];
    // male wins the contested region 1, female pushed to region 0
    expect(calibrateGenderRegion(labels, av)).toEqual({ male: 1, female: 0 });
  });
});

describe('calibrateGenderRegionByActivity', () => {
  /**
   * The D-16 scene: the LEFT head is a listener who nods constantly (high, flat motion);
   * the RIGHT head is the woman actually talking (motion rises only while she speaks).
   * Raw magnitude says "left"; each region measured against its own baseline says "right".
   */
  function nodderVsTalker(N = 120) {
    const labels: Array<{ label: string; conf: number }> = [];
    const motionL = new Float64Array(N);
    const motionR = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const femaleTurn = i % 40 < 30;                    // she holds the floor 75% of the time
      labels.push({ label: femaleTurn ? 'female' : 'male', conf: 0.8 });
      motionL[i] = 300 + 40 * Math.sin(i * 0.41);        // nodding, indifferent to who speaks
      motionR[i] = femaleTurn ? 90 : 10;                 // rises only while she talks
    }
    return { labels, motionL, motionR };
  }

  it('maps the talker to her own region even when the listener moves far more', () => {
    const { labels, motionL, motionR } = nodderVsTalker();
    expect(calibrateGenderRegionByActivity(labels, motionL, motionR)).toEqual({ male: 0, female: 1 });
  });

  it('declines when the two genders do not separate — a coin flip would drive most frames', () => {
    // Same-gender hosts: pitch carries no information, so both regions look alike per label.
    const N = 120;
    const labels = Array.from({ length: N }, (_, i) => ({ label: i % 2 ? 'male' : 'female', conf: 0.8 }));
    const motionL = new Float64Array(N).fill(100);
    const motionR = Float64Array.from({ length: N }, (_, i) => 50 + (i % 7));
    expect(calibrateGenderRegionByActivity(labels, motionL, motionR)).toBeNull();
  });

  it('declines when a region carries no motion at all, or the shot is too short', () => {
    const { labels, motionL } = nodderVsTalker();
    expect(calibrateGenderRegionByActivity(labels, motionL, new Float64Array(120))).toBeNull();
    expect(calibrateGenderRegionByActivity(labels.slice(0, 4), motionL.slice(0, 4), motionL.slice(0, 4))).toBeNull();
  });

  it('declines when only one gender was heard', () => {
    const N = 60;
    const labels = Array.from({ length: N }, () => ({ label: 'female', conf: 0.8 }));
    const motionL = new Float64Array(N).fill(10);
    const motionR = Float64Array.from({ length: N }, (_, i) => 50 + i);
    expect(calibrateGenderRegionByActivity(labels, motionL, motionR)).toBeNull();
  });
});
