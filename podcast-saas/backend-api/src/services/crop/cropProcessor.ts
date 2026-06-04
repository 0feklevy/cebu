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

  // Gender → side calibration by VOTING. With exactly two heads we only need to
  // learn which head each gender speaks from; a confidence-weighted majority vote
  // over "which head is moving while gender X talks" is far more stable than
  // averaging positions (which collapses to centre when the active head flips).
  const genderHead = mapGenderToHead(headModel.isTwoShot, heads, labels, motionPerFrame);

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
      let candidate: number | null = null;
      if ((speaker === 'male' || speaker === 'female') && genderHead[speaker] !== null) {
        candidate = heads[genderHead[speaker]!];
        stats.calibrated++;
      }
      if (candidate === null) {
        const ai = activeHeadIndex(motionPerFrame[i], heads);
        if (ai !== null) { candidate = heads[ai]; stats.motion++; }
      }
      if (candidate === null && heads.length >= 2) {
        candidate = (heads[0] + heads[heads.length - 1]) / 2;
        stats.fallback++;
      }

      const committed = applyDebounce(debounce, speaker, t, candidate);
      if (committed !== null) cropX = interestToCropX(committed, W, H);
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
 * Confidence-weighted majority vote: for each gender, which head is moving while
 * they speak. Resolves conflicts (both genders voting the same head) by giving
 * the contested head to the stronger voter and the other head to the loser.
 */
function mapGenderToHead(
  isTwoShot: boolean,
  heads: number[],
  labels: Array<{ label: SpeakerLabel; conf: number }>,
  motionPerFrame: Float64Array[],
): { male: number | null; female: number | null } {
  if (!isTwoShot || heads.length < 2) return { male: null, female: null };

  const votes: Record<'male' | 'female', number[]> = { male: [0, 0], female: [0, 0] };
  for (let i = 0; i < labels.length; i++) {
    const { label, conf } = labels[i];
    if (label !== 'male' && label !== 'female') continue;
    const ai = activeHeadIndex(motionPerFrame[i], heads);
    if (ai !== null) votes[label][ai] += conf;
  }

  const maleBest = votes.male[0] >= votes.male[1] ? 0 : 1;
  const femaleBest = votes.female[0] >= votes.female[1] ? 0 : 1;
  const maleHas = votes.male[0] + votes.male[1] > 0;
  const femaleHas = votes.female[0] + votes.female[1] > 0;

  if (!maleHas && !femaleHas) return { male: null, female: null };
  if (maleHas && femaleHas && maleBest === femaleBest) {
    // Conflict — assign the contested head to whoever wants it more.
    const contested = maleBest;
    const other = 1 - contested;
    const maleStrength = votes.male[contested];
    const femaleStrength = votes.female[contested];
    return maleStrength >= femaleStrength
      ? { male: contested, female: other }
      : { male: other, female: contested };
  }
  return {
    male: maleHas ? maleBest : (femaleHas ? 1 - femaleBest : null),
    female: femaleHas ? femaleBest : (maleHas ? 1 - maleBest : null),
  };
}

function grayHist(frame: Uint8Array): Float64Array {
  const h = new Float64Array(SHOT_BINS);
  for (let i = 0; i < frame.length; i++) h[(frame[i] * SHOT_BINS) >> 8]++;
  return h;
}
