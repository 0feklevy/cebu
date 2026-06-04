/**
 * Smart-crop processor — two-pass orchestrator.
 *
 * Pass 1 (one video decode + one audio decode):
 *   • per frame: motion / saliency / skin column profiles + interest centroid
 *     (SceneAnalyzer), shot-boundary histogram, and raw pitch features.
 *   • accumulate global skin/saliency/activity sums.
 * Between passes:
 *   • locate the (≤2) stable head positions for the whole take (static camera).
 *   • self-calibrate the pitch threshold and label every window.
 *   • calibrate gender → head position from two-shot active frames.
 * Pass 2 (no decode):
 *   • per two-shot frame pick the active head (calibrated gender → motion →
 *     midpoint), gate switches through the speaker debounce, emit crop x.
 *   • non-two-shot frames use the interest centroid.
 * Then per-shot median + Gaussian smoothing.
 *
 * See crop-processor/PIPELINE.md for the full rationale.
 */

import { probeVideo, extractRgbFrames, extractMonoPcm } from './ffmpegExtract.js';
import { SceneAnalyzer, PROFILE_COLS, type FaceHook } from './sceneAnalyzer.js';
import { locateHeads, activeHeadIndex } from './headLocator.js';
import {
  analyzeChunk, labelFromPitch, calibratePitchThreshold,
  SAMPLE_RATE, type SpeakerLabel, type ChunkPitch,
} from './speaker.js';
import { bhattacharyya } from './dsp.js';
import { DebounceState, applyDebounce } from './debounce.js';
import { smoothKeyframes, type Keyframe } from './smoother.js';

export const CROP_ASPECT = 9 / 16;
const DEFAULT_SAMPLE_INTERVAL = 0.5;   // 2 fps — snappier speaker switching than the 1 fps reference
const ANALYSIS_W = 320;
const ANALYSIS_H = 180;
const SHOT_BINS = 32;
const SHOT_THRESHOLD = 0.30;
const SHOT_MIN_GAP = 0.5;

export interface CropMetadata {
  video_id: string;
  duration: number;
  width: number;
  height: number;
  crop_aspect: number;
  keyframes: Keyframe[];
  stats?: {
    frames: number;
    heads: number[];
    two_shot: number;
    calibrated: number;
    motion: number;
    fallback: number;
    pitch_threshold_hz: number;
    calibration: string;
    shots: number;
  };
}

export interface CropOptions {
  faceHook?: FaceHook;
  sampleInterval?: number;
  onProgress?: (done: number, total: number) => void;
}

export function interestToCropX(interestX: number, vw: number, vh: number, aspect = CROP_ASPECT): number {
  const cropWNorm = (vh * aspect) / vw;
  const half = cropWNorm / 2;
  return Math.max(half, Math.min(1 - half, interestX));
}

export async function processVideoCrop(
  videoId: string,
  videoPath: string,
  options: CropOptions = {},
): Promise<CropMetadata> {
  const sampleInterval = options.sampleInterval ?? DEFAULT_SAMPLE_INTERVAL;
  const sampleFps = 1 / sampleInterval;

  const { width: W, height: H, durationSec } = await probeVideo(videoPath);

  const [rgb, audio] = await Promise.all([
    extractRgbFrames(videoPath, ANALYSIS_W, ANALYSIS_H, sampleFps),
    extractMonoPcm(videoPath, SAMPLE_RATE).catch(() => new Float32Array(0)),
  ]);
  const hasAudio = audio.length > 0;
  const nFrames = rgb.frames.length;

  const analyzer = new SceneAnalyzer(rgb.width, rgb.height, { faceHook: options.faceHook });

  // ── Pass 1 ──────────────────────────────────────────────────────────────────
  const skinSum = new Float64Array(PROFILE_COLS);
  const salSum = new Float64Array(PROFILE_COLS);
  const actSum = new Float64Array(PROFILE_COLS);

  const motionPerFrame: Float64Array[] = new Array(nFrames);
  const interestXs = new Float64Array(nFrames);
  const pitches: ChunkPitch[] = new Array(nFrames);
  const times = new Float64Array(nFrames);

  const shotTimes: number[] = [0];
  let prevGray: Uint8Array | null = null;
  let prevHist: Float64Array | null = null;

  for (let i = 0; i < nFrames; i++) {
    const t = Number((i / sampleFps).toFixed(3));
    times[i] = t;
    const frame = rgb.frames[i];
    const gray = analyzer.toGray(frame);
    const p = analyzer.analyze(frame, gray, prevGray);

    motionPerFrame[i] = p.motion;
    interestXs[i] = p.interestX;
    for (let x = 0; x < PROFILE_COLS; x++) {
      skinSum[x] += p.skin[x];
      salSum[x] += p.saliency[x];
      actSum[x] += p.motion[x];
    }

    // inline shot detection
    const hist = grayHist(gray);
    if (prevHist && bhattacharyya(prevHist, hist) > SHOT_THRESHOLD &&
        t - shotTimes[shotTimes.length - 1] > SHOT_MIN_GAP) {
      shotTimes.push(t);
    }
    prevHist = hist;

    // pitch
    if (hasAudio) {
      const a0 = Math.floor(t * SAMPLE_RATE);
      const a1 = Math.floor((t + sampleInterval) * SAMPLE_RATE);
      pitches[i] = analyzeChunk(audio.subarray(a0, Math.min(a1, audio.length)), SAMPLE_RATE);
    } else {
      pitches[i] = { rms: 0, f0: 0, conf: 0 };
    }

    prevGray = gray;
    options.onProgress?.(i + 1, nFrames);
  }

  // ── Between passes ────────────────────────────────────────────────────────────
  const headModel = locateHeads(skinSum, salSum, actSum);
  const heads = headModel.heads;

  const threshold = hasAudio ? calibratePitchThreshold(pitches) : 160;
  const labels: Array<{ label: SpeakerLabel; conf: number }> = pitches.map((p) => labelFromPitch(p, threshold));

  // ── Gender → head calibration ─────────────────────────────────────────────
  // Two-stage: (1) accumulated voice-motion profiles — most robust for podcast
  // content where faces are static but lips/head move subtly while speaking.
  // (2) interestX statistics as fallback when motion is too low.
  const genderHead = mapGenderToHead(headModel.isTwoShot, heads, labels, motionPerFrame, interestXs);

  // ── Pass 2 ──────────────────────────────────────────────────────────────────
  const stats = { two_shot: 0, calibrated: 0, motion: 0, fallback: 0 };
  const raw: Keyframe[] = new Array(nFrames);
  let debounce = new DebounceState();
  let lastSeg = -1;

  for (let i = 0; i < nFrames; i++) {
    const t = times[i];
    let cropX = interestToCropX(interestXs[i], W, H);

    if (headModel.isTwoShot) {
      stats.two_shot++;
      // reset debounce at shot boundaries
      let seg = -1;
      for (let s = 0; s < shotTimes.length; s++) { if (shotTimes[s] <= t) seg = s; else break; }
      if (seg !== lastSeg) { debounce = new DebounceState(); lastSeg = seg; }

      const speaker = labels[i].label;

      // Resolve candidate — calibration → per-frame motion.
      // THE KEY FIX: midpoint is NOT a candidate for the debounce.
      // It is only the display-fallback when nothing has been committed yet.
      // Previously, midpoint was fed into applyDebounce as the first candidate,
      // which caused the debounce to commit at 0.505 and never recover.
      let candidate: number | null = null;
      if ((speaker === 'male' || speaker === 'female') && genderHead[speaker] !== null) {
        candidate = heads[genderHead[speaker]!];
        stats.calibrated++;
      }
      if (candidate === null) {
        const ai = activeHeadIndex(motionPerFrame[i], heads);
        if (ai !== null) { candidate = heads[ai]; stats.motion++; }
      }

      const committed = applyDebounce(debounce, speaker, t, candidate);
      if (committed !== null) {
        cropX = interestToCropX(committed, W, H);
      } else {
        // No speech has committed yet — show midpoint as a neutral holding position.
        // This does NOT commit the debounce so the first real voice event will take over.
        cropX = interestToCropX((heads[0] + heads[heads.length - 1]) / 2, W, H);
        stats.fallback++;
      }
    }

    raw[i] = { t, x: cropX };
  }

  const keyframes = smoothKeyframes(raw, shotTimes, 1.5, sampleInterval);

  return {
    video_id: videoId,
    duration: Number(durationSec.toFixed(3)),
    width: W,
    height: H,
    crop_aspect: CROP_ASPECT,
    keyframes,
    stats: {
      frames: nFrames,
      heads: heads.map((h) => Number(h.toFixed(3))),
      ...stats,
      pitch_threshold_hz: Number(threshold.toFixed(1)),
      calibration: `male→head${genderHead.male ?? '?'} female→head${genderHead.female ?? '?'}`,
      shots: shotTimes.length,
    },
  };
}

/**
 * Two-stage gender→head mapping.
 *
 * Stage 1 — Accumulated voice-motion profiles:
 *   For every frame labeled 'male' (or 'female') with confident pitch, add that
 *   frame's motion profile to a per-gender accumulator. The peak of the accumulated
 *   profile reveals WHERE in the frame the face was moving while that voice spoke.
 *   This is robust because: even tiny lip/nod movements accumulate into a clear
 *   peak over many speaking frames, whereas per-frame votes are too noisy.
 *
 * Stage 2 — interestX statistics (fallback):
 *   The interest-map centroid is biased toward whichever face is more active.
 *   Mean interestX during male speech vs female speech separates the two positions
 *   even without any motion — useful for fully static scenes.
 */
function mapGenderToHead(
  isTwoShot: boolean,
  heads: number[],
  labels: Array<{ label: SpeakerLabel; conf: number }>,
  motionPerFrame: Float64Array[],
  interestXs: Float64Array,
): { male: number | null; female: number | null } {
  if (!isTwoShot || heads.length < 2) return { male: null, female: null };

  const cols = PROFILE_COLS;
  const CAL_CONF = 0.30;

  // Stage 1: accumulated motion profiles per gender
  const maleAcc   = new Float64Array(cols);
  const femaleAcc = new Float64Array(cols);
  let maleN = 0, femaleN = 0;

  for (let i = 0; i < labels.length; i++) {
    const { label, conf } = labels[i];
    if (conf < CAL_CONF) continue;
    if (label === 'male') {
      for (let x = 0; x < cols; x++) maleAcc[x] += motionPerFrame[i][x] * conf;
      maleN++;
    } else if (label === 'female') {
      for (let x = 0; x < cols; x++) femaleAcc[x] += motionPerFrame[i][x] * conf;
      femaleN++;
    }
  }

  // Smooth the accumulators with a broad kernel to merge adjacent columns
  const smoothKernel = Math.max(2, Math.floor(cols * 0.07));
  const maleSmooth   = boxSmooth(maleAcc,   smoothKernel);
  const femaleSmooth = boxSmooth(femaleAcc, smoothKernel);

  const malePeakX   = argmaxInRange(maleSmooth,   Math.floor(cols * 0.05), Math.floor(cols * 0.95)) / (cols - 1);
  const femalePeakX = argmaxInRange(femaleSmooth, Math.floor(cols * 0.05), Math.floor(cols * 0.95)) / (cols - 1);
  const maleStrong   = maleN   >= 3 && maleSmooth[Math.round(malePeakX * (cols - 1))]     > 1e-3;
  const femaleStrong = femaleN >= 3 && femaleSmooth[Math.round(femalePeakX * (cols - 1))] > 1e-3;

  if (maleStrong && femaleStrong && Math.abs(malePeakX - femalePeakX) > 0.12) {
    const maleLeft = malePeakX < femalePeakX;
    return { male: maleLeft ? 0 : 1, female: maleLeft ? 1 : 0 };
  }
  if (maleStrong && !femaleStrong) {
    const mIdx = malePeakX < 0.5 ? 0 : 1;
    return { male: mIdx, female: 1 - mIdx };
  }
  if (femaleStrong && !maleStrong) {
    const fIdx = femalePeakX < 0.5 ? 0 : 1;
    return { male: 1 - fIdx, female: fIdx };
  }

  // Stage 2: interestX statistics — works even when motion is absent
  let maleIxSum = 0, maleIxW = 0, femaleIxSum = 0, femaleIxW = 0;
  for (let i = 0; i < labels.length; i++) {
    const { label, conf } = labels[i];
    if (conf < 0.40) continue;
    if (label === 'male')   { maleIxSum   += interestXs[i] * conf; maleIxW   += conf; }
    if (label === 'female') { femaleIxSum += interestXs[i] * conf; femaleIxW += conf; }
  }
  const maleMx   = maleIxW   > 0 ? maleIxSum   / maleIxW   : null;
  const femaleMx = femaleIxW > 0 ? femaleIxSum / femaleIxW : null;

  if (maleMx !== null && femaleMx !== null && Math.abs(maleMx - femaleMx) > 0.04) {
    const maleLeft = maleMx < femaleMx;
    return { male: maleLeft ? 0 : 1, female: maleLeft ? 1 : 0 };
  }
  if (maleMx !== null) { const m = maleMx < 0.5 ? 0 : 1; return { male: m, female: 1 - m }; }
  if (femaleMx !== null) { const f = femaleMx < 0.5 ? 0 : 1; return { male: 1 - f, female: f }; }

  return { male: null, female: null };
}

function boxSmooth(a: Float64Array, radius: number): Float64Array {
  const n = a.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -radius; k <= radius; k++) { const j = i + k; if (j >= 0 && j < n) { s += a[j]; c++; } }
    out[i] = c > 0 ? s / c : 0;
  }
  return out;
}

function argmaxInRange(a: Float64Array, lo: number, hi: number): number {
  let idx = lo, v = -Infinity;
  for (let i = lo; i <= hi && i < a.length; i++) if (a[i] > v) { v = a[i]; idx = i; }
  return idx;
}

function grayHist(frame: Uint8Array): Float64Array {
  const h = new Float64Array(SHOT_BINS);
  for (let i = 0; i < frame.length; i++) h[(frame[i] * SHOT_BINS) >> 8]++;
  return h;
}
