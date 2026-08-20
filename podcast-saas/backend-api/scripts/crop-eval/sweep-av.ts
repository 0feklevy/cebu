/*
 * Threshold sweep for the active-speaker gate.
 *
 *   pnpm --filter backend-api eval:crop:sweep
 *
 * The shipped gate fires when the better of two windowed Pearson correlations clears
 * `minCorr` and leads the other by `margin`. At the shipped `halfWindow: 5` those windows
 * hold n = 11 samples, whose null distribution has SD ≈ 1/√(n−1) ≈ 0.32 — so `minCorr 0.12`
 * and `margin 0.06` sit at roughly 0.4σ and 0.2σ of pure noise. They are not thresholds;
 * they are a coin flip with extra steps. This sweep replaces them with whatever the eval
 * set actually prefers, and prints the whole grid so the choice is auditable rather than
 * asserted.
 *
 * Ranked by attribution accuracy on the two-shot clips (the property the gate exists to
 * deliver), with mIoU and jitter shown so a winner that buys accuracy with a shaking crop
 * is visible rather than hidden.
 */

import { processCropSource, type CropSource } from '../../src/services/crop/cropProcessor.js';
import { nullSigma } from '../../src/services/crop/activeSpeaker.js';
import { evalClips, cropHalfWidth, type EvalClip } from '../../src/services/crop/eval/fixtures.js';
import { scoreClip, aggregate } from '../../src/services/crop/eval/metrics.js';

const HALF_WINDOWS = [5, 8, 10, 12];
const MIN_CORRS = [0.12, 0.20, 0.28, 0.35, 0.45];
const MARGINS = [0.06, 0.10, 0.15, 0.22];

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

const half = cropHalfWidth(1920, 1080);
const clips = evalClips();
const rows: Array<{ hw: number; mc: number; mg: number; attr: number; iou: number; jit: number; oof: number }> = [];

for (const hw of HALF_WINDOWS) {
  for (const mc of MIN_CORRS) {
    for (const mg of MARGINS) {
      const scores = [];
      for (const clip of clips) {
        const sigma = nullSigma(hw);
        const { keyframes } = await processCropSource(clip.id, fixtureSource(clip), {
          av: { halfWindow: hw, minCorrSigma: mc / sigma, marginSigma: mg / sigma },
        });
        scores.push(scoreClip(clip, keyframes, half));
      }
      const o = aggregate(scores);
      rows.push({ hw, mc, mg, attr: o.attribution ?? 0, iou: o.m_iou, jit: o.jitter, oof: o.out_of_frame });
      process.stderr.write('.');
    }
  }
}
process.stderr.write('\n');

rows.sort((a, b) => b.attr - a.attr || b.iou - a.iou);
console.log('halfWindow  minCorr  margin  attrib  mIoU    outFrame  jitter');
console.log('----------  -------  ------  ------  ------  --------  -------');
for (const r of rows) {
  console.log(
    `${String(r.hw).padStart(10)}  ${r.mc.toFixed(2).padStart(7)}  ${r.mg.toFixed(2).padStart(6)}  ` +
    `${r.attr.toFixed(3)}   ${r.iou.toFixed(3)}   ${r.oof.toFixed(3)}     ${r.jit.toFixed(5)}`,
  );
}
