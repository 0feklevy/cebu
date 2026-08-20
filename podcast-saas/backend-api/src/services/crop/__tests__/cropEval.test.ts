/**
 * The eval harness, as a gate.
 *
 * Two jobs. First, prove the metric code itself is right — a harness that scores wrongly is
 * worse than no harness, because it launders a regression as an improvement. Second, run
 * the real pipeline over the whole fixture set and hold it to the committed baseline in
 * `scripts/crop-eval/results/`, so a change to src/services/crop that moves a number has to
 * move the committed number with it in the same commit.
 *
 * The baseline is keyed by ALGO_VERSION. Bumping the version without refreshing the results
 * fails here, which is the point: the version bump is what makes existing videos recompute,
 * so it must never be made casually.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCropSource, type CropSource } from '../cropProcessor.js';
import { algoVersion } from '../algo.js';
import { evalClips, cropHalfWidth, type EvalClip, type FrameLabel } from '../eval/fixtures.js';
import {
  scoreClip, aggregate, windowIou, jitter, travel, sampleTrack, targetX, type EvalReport,
} from '../eval/metrics.js';

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/crop-eval/results');
const load = (name: string) => JSON.parse(readFileSync(join(RESULTS, name), 'utf8')) as EvalReport;

function fixtureSource(clip: EvalClip): CropSource {
  return {
    probe: async () => ({ width: clip.width, height: clip.height, durationSec: clip.durationSec }),
    audio: async () => clip.audio(),
    frames: async (_w, _h, _fps, onFrame) => {
      const n = Math.round(clip.durationSec * clip.sampleFps);
      for (let i = 0; i < n; i++) onFrame(clip.frame(i), i);
    },
  };
}

describe('eval metrics', () => {
  it('scores identical windows 1 and disjoint windows 0', () => {
    expect(windowIou(0.5, 0.5, 0.3164)).toBe(1);
    expect(windowIou(0.2, 0.9, 0.3164)).toBe(0);
    // Half a window apart: overlap w/2, union 3w/2 → 1/3.
    expect(windowIou(0.4, 0.4 + 0.3164 / 2, 0.3164)).toBeCloseTo(1 / 3, 6);
  });

  it('puts the IoU@0.5 boundary at a third of a window width', () => {
    const w = 0.3164;
    expect(windowIou(0.4, 0.4 + w / 3 - 1e-6, w)).toBeGreaterThanOrEqual(0.5);
    expect(windowIou(0.4, 0.4 + w / 3 + 1e-3, w)).toBeLessThan(0.5);
  });

  it('measures jitter as curvature, not movement', () => {
    // A constant-velocity pan has zero second difference; a zig-zag of the same total
    // travel does not. A metric that could not tell those apart would punish tracking.
    expect(jitter([0, 0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0, 12);
    expect(jitter([0, 0.1, 0, 0.1, 0])).toBeGreaterThan(0.15);
    expect(travel([0, 0.1, 0, 0.1])).toBeCloseTo(0.3, 12);
  });

  it('interpolates the crop track between keyframes and holds past the end', () => {
    const kf = [{ t: 0, x: 0.2 }, { t: 1, x: 0.6 }];
    expect(sampleTrack(kf, [0, 0.5, 1, 2])).toEqual([0.2, 0.4, 0.6, 0.6]);
  });

  it('refuses to invent a target when the labels do not name a speaker', () => {
    const half = 0.1582;
    const twoFaces: FrameLabel = { t: 0, boxes: [[0.2, 0.3, 0.1, 0.2], [0.7, 0.3, 0.1, 0.2]], activeIdx: null };
    expect(targetX(twoFaces, half)).toBeNull();
    expect(targetX({ t: 0, boxes: [], activeIdx: null }, half)).toBe(0.5);
    expect(targetX({ ...twoFaces, activeIdx: 1 }, half)).toBeCloseTo(0.75, 6);
  });

  it('clamps the ground-truth window to what a 9:16 crop can actually reach', () => {
    const half = 0.1582;
    // A face at the very edge cannot be centred; the best any algorithm can do is the clamp.
    expect(targetX({ t: 0, boxes: [[0.95, 0.3, 0.04, 0.2]], activeIdx: 0 }, half)).toBeCloseTo(1 - half, 6);
  });

  it('excludes ambiguous frames from mIoU instead of scoring them as failures', () => {
    const clip = evalClips().find((c) => c.id === 'no-audio-two-shot')!;
    const score = scoreClip(clip, clip.labels.map((l) => ({ t: l.t, x: 0.5 })), cropHalfWidth(clip.width, clip.height));
    expect(score.scored_frames).toBe(0);
    expect(score.total_frames).toBeGreaterThan(100);
  });
});

describe('eval fixtures', () => {
  it('regenerates byte-identical frames and audio across runs', () => {
    const a = evalClips().find((c) => c.id === 'two-shot-same-gender')!;
    const b = evalClips().find((c) => c.id === 'two-shot-same-gender')!;
    expect(Buffer.from(a.frame(37))).toEqual(Buffer.from(b.frame(37)));
    expect(a.audio().slice(0, 4096)).toEqual(b.audio().slice(0, 4096));
  });

  it('covers every adversarial category the diagnosis names', () => {
    const cats = new Set(evalClips().map((c) => c.category));
    for (const required of ['two_shot', 'same_gender', 'dark_skin', 'warm_set', 'no_subject',
      'multicam', 'moving_subject', 'no_audio', 'single']) {
      expect(cats, `missing eval category ${required}`).toContain(required);
    }
  });
});

describe('crop eval baseline', () => {
  it('matches the committed results for this ALGO_VERSION', async () => {
    // Keyed by version: a bump with no refreshed results file fails on the read, which is
    // exactly when it should — the bump is what forces every ready row to recompute.
    const committed = load(`v1@${algoVersion('v1')}.json`);

    const half = cropHalfWidth(1920, 1080);
    const scores = [];
    for (const clip of evalClips()) {
      const { keyframes } = await processCropSource(clip.id, fixtureSource(clip));
      scores.push(scoreClip(clip, keyframes, half));
    }
    const overall = aggregate(scores);

    // The pipeline is deterministic, so this is an equality check with room only for
    // floating-point drift across platforms — not a tolerance band a regression can hide in.
    expect(overall.m_iou).toBeCloseTo(committed.overall.m_iou, 3);
    expect(overall.out_of_frame).toBeCloseTo(committed.overall.out_of_frame, 3);
    expect(overall.attribution!).toBeCloseTo(committed.overall.attribution!, 3);
    expect(overall.jitter).toBeCloseTo(committed.overall.jitter, 4);
  });

  it('beats the centre-crop baseline it has to justify itself against', () => {
    const v1 = load(`v1@${algoVersion('v1')}.json`);
    const centre = load('centre@baseline.json');
    expect(
      v1.overall.m_iou,
      'if the crop pipeline does not beat x=0.5 it is net-negative versus shipping nothing',
    ).toBeGreaterThan(centre.overall.m_iou);
    expect(v1.overall.out_of_frame).toBeLessThan(centre.overall.out_of_frame);
  });
});
