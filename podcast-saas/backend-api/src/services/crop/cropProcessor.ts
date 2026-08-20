/**
 * Smart-crop processor — two-pass orchestrator.
 *
 * Pass 1 (one video decode + one audio decode):
 *   • per frame: motion / saliency / skin column profiles + interest centroid
 *     (SceneAnalyzer), shot-boundary histogram, and raw pitch features.
 *   • accumulate global skin/saliency/activity sums.
 * Between passes:
 *   • locate the (≤2) stable head positions for the whole take (static camera).
 *   • self-calibrate the pitch threshold and label every window (speech vs silence).
 * Pass 2 (no decode):
 *   • per two-shot frame pick the active head from audio-visual correlation alone,
 *     gate switches through the speaker debounce, emit crop x.
 *   • non-two-shot frames use the interest centroid.
 * Then per-shot median + Gaussian smoothing.
 *
 * See crop-processor/PIPELINE.md for the full rationale.
 */

import { probeVideo, streamRgbFrames, extractMonoPcm } from './ffmpegExtract.js';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { SceneAnalyzer, PROFILE_COLS, type FaceHook } from './sceneAnalyzer.js';
import { locateHeads, fallbackColumn } from './headLocator.js';
import {
  analyzeChunk, labelFromPitch, calibratePitchThreshold,
  SAMPLE_RATE, type SpeakerLabel, type ChunkPitch,
} from './speaker.js';
import {
  regionMotionSeries, windowedActiveRegions, speechCorrelatedMotion, headSpeechEvidence,
  DEFAULT_AV, type AVConfig,
} from './activeSpeaker.js';
import { blockHistogram, blockDistance, detectShotBoundaries } from './shotDetect.js';
import { DebounceState, applyDebounce } from './debounce.js';
import { smoothKeyframes, type Keyframe } from './smoother.js';
import { algoVersion } from './algo.js';

export const CROP_ASPECT = 9 / 16;
const DEFAULT_SAMPLE_INTERVAL = 0.25;  // 4 fps — fine enough for audio-visual correlation
const ANALYSIS_W = 320;
const ANALYSIS_H = 180;

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
    av: number;        // frames cropped from direct windowed AV-correlation
    evidence: number;  // frames cropped from the shot's dominant speech-correlated head
    gender: number;    // always 0 — the gender→region gap-fill was removed; kept for schema stability
    hold: number;      // frames holding (silence / ambiguous)
    pitch_threshold_hz: number;
    calibration: string;
    shots: number;
    algo_version: string;
  };
}

export interface CropOptions {
  faceHook?: FaceHook;
  sampleInterval?: number;
  onProgress?: (done: number, total: number) => void;
  /** Override the active-speaker gate. Exists so the eval harness can sweep it; production
   *  never passes it, and the defaults live in `activeSpeaker.ts` where they are argued for. */
  av?: Partial<AVConfig>;
}

export function interestToCropX(interestX: number, vw: number, vh: number, aspect = CROP_ASPECT): number {
  const cropWNorm = (vh * aspect) / vw;
  const half = cropWNorm / 2;
  return Math.max(half, Math.min(1 - half, interestX));
}

/**
 * The decode surface this pipeline needs, isolated behind an interface.
 *
 * Production passes `ffmpegSource`. The eval harness passes a generator of synthetic frames
 * and PCM, which is what lets the whole real pipeline — analyzer, shot detection, head
 * model, AV correlation, debounce, smoother — be scored headlessly against known-correct
 * answers with no media files, no ffmpeg and no nondeterminism from a codec. Every stage
 * below the decode is exercised by the harness exactly as production runs it; that is the
 * point of the seam, and why it is an interface rather than a test-only mock.
 */
export interface CropSource {
  probe(): Promise<{ width: number; height: number; durationSec: number }>;
  audio(sampleRate: number): Promise<Float32Array>;
  frames(
    width: number,
    height: number,
    fps: number,
    onFrame: (frame: Uint8Array, index: number) => void,
  ): Promise<unknown>;
}

/** The production source: one streamed video decode + one buffered audio decode, both limited. */
export function ffmpegSource(videoPath: string): CropSource {
  return {
    probe: () => runFfmpegLimited(() => probeVideo(videoPath)),
    audio: (sr) => runFfmpegLimited(() => extractMonoPcm(videoPath, sr)),
    frames: (w, h, fps, onFrame) => runFfmpegLimited(() => streamRgbFrames(videoPath, w, h, fps, onFrame)),
  };
}

export function processVideoCrop(
  videoId: string,
  videoPath: string,
  options: CropOptions = {},
): Promise<CropMetadata> {
  return processCropSource(videoId, ffmpegSource(videoPath), options);
}

export async function processCropSource(
  videoId: string,
  source: CropSource,
  options: CropOptions = {},
): Promise<CropMetadata> {
  const sampleInterval = options.sampleInterval ?? DEFAULT_SAMPLE_INTERVAL;
  const sampleFps = 1 / sampleInterval;
  const avConfig: AVConfig = { ...DEFAULT_AV, ...options.av };

  const { width: W, height: H, durationSec } = await source.probe();

  // Audio is decoded up front because Pass 1 needs random access into the PCM per frame (pitch).
  // The video frames, by contrast, are consumed strictly in order, so they're STREAMED below
  // rather than buffered — the old code concatenated every decoded frame (~2.5 GB for a long
  // take) before this loop even started (perf-001).
  const audio = await source.audio(SAMPLE_RATE).catch(() => new Float32Array(0));
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

  // Per-frame distance to the previous frame; cuts are picked from it after the decode so the
  // adaptive threshold can look both ways (see shotDetect.ts).
  const shotScores: number[] = [];
  let prevGray: Uint8Array | null = null;
  let prevHist: Float64Array | null = null;
  const totalEstimate = Math.max(1, Math.round(durationSec * sampleFps)); // progress denominator only

  await source.frames(ANALYSIS_W, ANALYSIS_H, sampleFps, (frame, i) => {
    const t = Number((i / sampleFps).toFixed(3));
    times.push(t);
    const gray = analyzer.toGray(frame);
    const p = analyzer.analyze(frame, gray, prevGray);

    motionPerFrame.push(p.motion);
    skinPerFrame.push(p.skin);
    salPerFrame.push(p.saliency);
    interestXs.push(p.interestX);

    const hist = blockHistogram(gray, ANALYSIS_W, ANALYSIS_H);
    shotScores.push(prevHist ? blockDistance(prevHist, hist) : 0);
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
  });

  const nFrames = times.length;
  const shotTimes = [0, ...detectShotBoundaries(shotScores, sampleInterval).map((i) => times[i])];

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
  const stats = { two_shot: 0, av: 0, evidence: 0, gender: 0, hold: 0 };
  /** Where the crop left the previous shot, so a cut between two shots of the same person holds. */
  let prevExitX: number | null = null;
  let twoShotSegs = 0;
  const lastHeads: number[] = [];
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
    // Head localization gets the audio too. Skin and saliency answer "a person is HERE";
    // only motion correlated with the speech envelope answers "this person is SPEAKING",
    // and that distinction is the owner-reported D-16 symptom (a big static face winning
    // the frame over whoever is actually talking). Zero-filled — hence ignored by
    // locateHeads — when the track is silent or failed to decode.
    const segMotionAll = motionPerFrame.slice(f0, f1);
    const speechS = hasAudio ? speechCorrelatedMotion(segMotionAll, env.slice(f0, f1)) : undefined;
    const hm = locateHeads(skinS, salS, actS, speechS, f1 - f0);

    if (hm.isTwoShot && hasAudio && f1 - f0 >= 4) {
      twoShotSegs++;
      const heads = hm.heads;
      lastHeads.length = 0; lastHeads.push(...heads);

      // AV-correlation within this shot only.
      const segEnv = env.slice(f0, f1);
      const motionL = regionMotionSeries(segMotionAll, heads[0]);
      const motionR = regionMotionSeries(segMotionAll, heads[1]);
      const avActive = windowedActiveRegions(motionL, motionR, segEnv, avConfig);
      const segLabels = labels.slice(f0, f1);
      // Which head carries this shot's speech-correlated motion. Computed once per shot over
      // every frame in it, so it is the high-sample-count reading of the same evidence the
      // 11-sample windowed correlator gives a noisy per-frame opinion about.
      const evidence = speechS
        ? ([0, 1] as const).map((k) => headSpeechEvidence(speechS, heads[k]))
        : null;
      const dominant: 0 | 1 | null = evidence === null || evidence[0] === evidence[1]
        ? null
        : (evidence[0] > evidence[1] ? 0 : 1);
      // Carry the previous shot's framing across a cut when a head is close to where the crop
      // already was; otherwise open on whichever head carries this shot's speech evidence.
      const carried = prevExitX !== null ? heads.find((h) => Math.abs(h - prevExitX!) <= 0.10) : undefined;
      const openingX = carried ?? heads[dominant ?? 0];

      const debounce = new DebounceState();
      for (let i = f0; i < f1; i++) {
        stats.two_shot++;
        const j = i - f0;
        const speaker = segLabels[j].label;

        // Priority: windowed AV (direct) → this shot's dominant speaker by visual-speech
        // evidence → hold.
        //
        // The slot the evidence term occupies used to hold a pitch-derived gender→region map,
        // and that map is deleted. It cannot work on a same-gender pair — the dominant podcast
        // format — because the pitch calibration correctly refuses to split two voices under
        // 35 Hz apart, so every confident frame gets ONE label, the map assigns it one region
        // and infers the other by complement, and both hosts' speech routes to the same head
        // for the whole take.
        //
        // Deleting it outright is not enough on its own, and the eval harness is what showed
        // why: measured over the fixture two-shots, the windowed correlator names 13-45% of
        // frames and is right on 17-46% of those — below chance, because at 4 fps a listener
        // nodding through ±12.5% of frame width carries more motion energy than a talker's
        // mouth. Left alone with it, the debounce latches onto whichever head the first firing
        // named and holds there for the take. So the gap-fill is replaced rather than removed:
        // same evidence `locateHeads` uses to find the speaker at all, read per head over the
        // whole shot. Being a constant vote it also costs a competing AV firing 0.8 s of
        // sustained disagreement to overturn, which sparse noise cannot buy.
        //
        // Pitch keeps exactly one job — telling speech from silence — and that is an RMS test.
        let region: 0 | 1 | null = null;
        if (avActive[j] !== null) { region = avActive[j]; stats.av++; }
        else if (dominant !== null && speaker !== 'silence') { region = dominant; stats.evidence++; }

        let key: string;
        let candidate: number | null;
        if (region !== null) { key = `r${region}`; candidate = heads[region]; }
        else if (speaker === 'silence') { key = 'silence'; candidate = null; stats.hold++; }
        else { key = 'unclear'; candidate = null; stats.hold++; }

        const committed = applyDebounce(debounce, key, times[i], candidate);
        // Before the first commit, frame a person rather than the gap between two of them.
        // The midpoint of a two-shot is where nobody is sitting: a 9:16 window centred there
        // is 31.6% of frame width aimed at the table, and it is on screen for as long as the
        // debounce takes to name someone.
        const cx = committed ?? openingX;
        raw[i] = { t: times[i], x: interestToCropX(cx, W, H) };
      }
      prevExitX = raw[f1 - 1]?.x ?? prevExitX;
    } else if (hm.heads.length === 1) {
      // Not a two-shot but locateHeads confidently found ONE dominant person. Use that
      // located head (stable over the whole shot) instead of the noisy per-frame interest
      // centroid, which averages across faces/text/motion and lands in dead space (backend-107).
      const cx = hm.heads[0];
      for (let i = f0; i < f1; i++) raw[i] = { t: times[i], x: interestToCropX(cx, W, H) };
      prevExitX = raw[f1 - 1].x;
    } else {
      // No person in this shot — title card, slate, screen recording, animation. Take one
      // static framing from whatever stands out, and frame centre when nothing does. The
      // per-frame interest centroid this replaces tracked a saliency map with no person in
      // it, wandering across text for the length of the card.
      const cx = fallbackColumn(salS, actS, f1 - f0) ?? 0.5;
      for (let i = f0; i < f1; i++) raw[i] = { t: times[i], x: interestToCropX(cx, W, H) };
      prevExitX = raw[f1 - 1].x;
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
      evidence: stats.evidence,
      gender: stats.gender,
      hold: stats.hold,
      pitch_threshold_hz: Number(threshold.toFixed(1)),
      calibration: `${twoShotSegs} two-shot seg(s); attribution=av_correlation`,
      shots: shotTimes.length,
      algo_version: algoVersion('v1'),
    },
  };
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
