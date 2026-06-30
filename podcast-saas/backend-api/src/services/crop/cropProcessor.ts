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

import { probeVideo, streamRgbFrames, extractMonoPcm } from './ffmpegExtract.js';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { SceneAnalyzer, PROFILE_COLS, type FaceHook } from './sceneAnalyzer.js';
import { locateHeads } from './headLocator.js';
import {
  analyzeChunk, labelFromPitch, calibratePitchThreshold,
  SAMPLE_RATE, type SpeakerLabel, type ChunkPitch,
} from './speaker.js';
import {
  regionMotionSeries, windowedActiveRegions, calibrateGenderRegion,
} from './activeSpeaker.js';
import { bhattacharyya } from './dsp.js';
import { DebounceState, applyDebounce } from './debounce.js';
import { smoothKeyframes, type Keyframe } from './smoother.js';

export const CROP_ASPECT = 9 / 16;
const DEFAULT_SAMPLE_INTERVAL = 0.25;  // 4 fps — fine enough for audio-visual correlation
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
    av: number;        // frames cropped from direct AV-correlation
    gender: number;    // frames cropped from gender→region mapping
    hold: number;      // frames holding (silence / ambiguous)
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

  const { width: W, height: H, durationSec } = await runFfmpegLimited(() => probeVideo(videoPath));

  // Audio is decoded up front because Pass 1 needs random access into the PCM per frame (pitch).
  // The video frames, by contrast, are consumed strictly in order, so they're STREAMED below
  // rather than buffered — the old code concatenated every decoded frame (~2.5 GB for a long
  // take) before this loop even started (perf-001).
  const audio = await runFfmpegLimited(() => extractMonoPcm(videoPath, SAMPLE_RATE)).catch(() => new Float32Array(0));
  const hasAudio = audio.length > 0;

  const analyzer = new SceneAnalyzer(ANALYSIS_W, ANALYSIS_H, { faceHook: options.faceHook });

  // ── Pass 1 ──────────────────────────────────────────────────────────────────
  // Per-frame profiles are kept so head localization can be done per shot below. Frame count is
  // unknown until the stream ends, so these grow via push (identical contents/order to the old
  // preallocated arrays). The raw RGB frame itself is never retained past its onFrame call.
  const motionPerFrame: Float64Array[] = [];
  const skinPerFrame: Float64Array[] = [];
  const salPerFrame: Float64Array[] = [];
  const interestXs: number[] = [];
  const pitches: ChunkPitch[] = [];
  const times: number[] = [];

  const shotTimes: number[] = [0];
  let prevGray: Uint8Array | null = null;
  let prevHist: Float64Array | null = null;
  const totalEstimate = Math.max(1, Math.round(durationSec * sampleFps)); // progress denominator only

  await runFfmpegLimited(() => streamRgbFrames(videoPath, ANALYSIS_W, ANALYSIS_H, sampleFps, (frame, i) => {
    const t = Number((i / sampleFps).toFixed(3));
    times.push(t);
    const gray = analyzer.toGray(frame);
    const p = analyzer.analyze(frame, gray, prevGray);

    motionPerFrame.push(p.motion);
    skinPerFrame.push(p.skin);
    salPerFrame.push(p.saliency);
    interestXs.push(p.interestX);

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
      pitches.push(analyzeChunk(audio.subarray(a0, Math.min(a1, audio.length)), SAMPLE_RATE));
    } else {
      pitches.push({ rms: 0, f0: 0, conf: 0 });
    }

    prevGray = gray;
    options.onProgress?.(i + 1, totalEstimate);
  }));

  const nFrames = times.length;

  // ── Between passes ────────────────────────────────────────────────────────────
  const threshold = hasAudio ? calibratePitchThreshold(pitches) : 160;
  const labels: Array<{ label: SpeakerLabel; conf: number }> = pitches.map((p) => labelFromPitch(p, threshold));
  const env = Float64Array.from(pitches, (p) => p.rms);

  // Convert shot-boundary times → frame-index segments. Head localization and the
  // active-speaker decision run PER SHOT, not globally: the camera framing is only
  // stable within a continuous take, and a video that mixes a two-shot with B-roll
  // and single close-ups would otherwise have its global head profile swamped by
  // the non-two-shot footage (→ a single false head in the middle).
  const segments = buildFrameSegments(shotTimes, nFrames, sampleFps);

  // ── Pass 2 (per shot) ───────────────────────────────────────────────────────
  const stats = { two_shot: 0, av: 0, gender: 0, hold: 0 };
  let twoShotSegs = 0;
  const lastHeads: number[] = [];
  let lastCal = 'n/a';
  const raw: Keyframe[] = new Array(nFrames);

  for (const [f0, f1] of segments) {
    // Localize heads from THIS shot's accumulated profiles.
    const skinS = new Float64Array(PROFILE_COLS);
    const salS  = new Float64Array(PROFILE_COLS);
    const actS  = new Float64Array(PROFILE_COLS);
    for (let i = f0; i < f1; i++) {
      const sk = skinPerFrame[i], sa = salPerFrame[i], mo = motionPerFrame[i];
      for (let x = 0; x < PROFILE_COLS; x++) { skinS[x] += sk[x]; salS[x] += sa[x]; actS[x] += mo[x]; }
    }
    const hm = locateHeads(skinS, salS, actS);

    if (hm.isTwoShot && hasAudio && f1 - f0 >= 4) {
      twoShotSegs++;
      const heads = hm.heads;
      lastHeads.length = 0; lastHeads.push(...heads);

      // AV-correlation within this shot only.
      const segMotion = motionPerFrame.slice(f0, f1);
      const segEnv = env.slice(f0, f1);
      const motionL = regionMotionSeries(segMotion, heads[0]);
      const motionR = regionMotionSeries(segMotion, heads[1]);
      const avActive = windowedActiveRegions(motionL, motionR, segEnv);
      const segLabels = labels.slice(f0, f1);
      const genderRegion = calibrateGenderRegion(segLabels, avActive);
      lastCal = `male→r${genderRegion.male ?? '?'} female→r${genderRegion.female ?? '?'}`;

      const debounce = new DebounceState();
      for (let i = f0; i < f1; i++) {
        stats.two_shot++;
        const j = i - f0;
        const speaker = segLabels[j].label;

        // Priority: AV-active (direct) → gender→region (gap-fill) → hold.
        let region: 0 | 1 | null = null;
        if (avActive[j] !== null) { region = avActive[j]; stats.av++; }
        else if ((speaker === 'male' || speaker === 'female') && genderRegion[speaker] !== null) {
          region = genderRegion[speaker]; stats.gender++;
        }

        let key: string;
        let candidate: number | null;
        if (region !== null) { key = `r${region}`; candidate = heads[region]; }
        else if (speaker === 'silence') { key = 'silence'; candidate = null; stats.hold++; }
        else { key = 'unclear'; candidate = null; stats.hold++; }

        const committed = applyDebounce(debounce, key, times[i], candidate);
        const cx = committed !== null ? committed : (heads[0] + heads[1]) / 2;
        raw[i] = { t: times[i], x: interestToCropX(cx, W, H) };
      }
    } else {
      // Not a two-shot (single speaker / B-roll / animation) → interest centroid.
      for (let i = f0; i < f1; i++) raw[i] = { t: times[i], x: interestToCropX(interestXs[i], W, H) };
    }
  }

  const keyframes = smoothKeyframes(raw, shotTimes, 1.2, sampleInterval);

  return {
    video_id: videoId,
    duration: Number(durationSec.toFixed(3)),
    width: W,
    height: H,
    crop_aspect: CROP_ASPECT,
    keyframes,
    stats: {
      frames: nFrames,
      heads: lastHeads.map((h) => Number(h.toFixed(3))),
      two_shot: stats.two_shot,
      av: stats.av,
      gender: stats.gender,
      hold: stats.hold,
      pitch_threshold_hz: Number(threshold.toFixed(1)),
      calibration: `${twoShotSegs} two-shot seg(s); last ${lastCal}`,
      shots: shotTimes.length,
    },
  };
}

function grayHist(frame: Uint8Array): Float64Array {
  const h = new Float64Array(SHOT_BINS);
  for (let i = 0; i < frame.length; i++) h[(frame[i] * SHOT_BINS) >> 8]++;
  return h;
}

/** Convert shot-boundary timestamps to [startFrame, endFrame) index ranges. */
function buildFrameSegments(shotTimes: number[], nFrames: number, sampleFps: number): Array<[number, number]> {
  const bounds = Array.from(new Set(shotTimes)).sort((a, b) => a - b);
  const starts = bounds.map((t) => Math.max(0, Math.min(nFrames, Math.round(t * sampleFps))));
  const segs: Array<[number, number]> = [];
  for (let i = 0; i < starts.length; i++) {
    const f0 = starts[i];
    const f1 = i + 1 < starts.length ? starts[i + 1] : nFrames;
    if (f1 > f0) segs.push([f0, f1]);
  }
  if (segs.length === 0) segs.push([0, nFrames]);
  return segs;
}
