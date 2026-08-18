/**
 * End-to-end crop pipeline on a synthetic two-shot. ffmpeg is the ONLY thing mocked:
 * real RGB frames go through the real SceneAnalyzer, real shot detection, real pitch,
 * real head localization, real AV correlation, real debounce and real smoothing.
 *
 * The scene is the owner-reported D-16 symptom (confirmed in production after v0.1.28):
 * two people in frame, the WOMAN is talking, and the crop showed the MAN.
 *
 * `cropProcessor.ts` had zero direct tests before this file, so the wiring it exercises
 * — that head localization is handed the audio-derived speaking signal at all — was
 * previously unprovable.
 */

import { describe, it, expect, vi } from 'vitest';

const ANALYSIS_W = 320, ANALYSIS_H = 180;
const SR = 16_000;
const FPS = 4;
const DURATION = 60;
const N_FRAMES = DURATION * FPS;

const MAN_X = 0.30, WOMAN_X = 0.70;
const HALF_WINDOW = (1080 * (9 / 16)) / 1920 / 2;   // 304 px on 1920

/** Frame i: is the woman holding the floor? She speaks 0-15s, 20-35s, 40-55s. */
const womanTalking = (i: number) => {
  const t = i / FPS;
  return (t < 15) || (t >= 20 && t < 35) || (t >= 40 && t < 55);
};

/** Speech envelope at frame i — syllabic amplitude while someone talks. */
const speechAmp = (i: number) => 0.05 + 0.045 * Math.abs(Math.sin(i * 1.9));

let seed = 991;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function disc(f: Uint8Array, cx: number, cy: number, r: number, rgb: [number, number, number]) {
  for (let y = Math.max(0, cy - r); y < Math.min(ANALYSIS_H, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(ANALYSIS_W, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const p = (y * ANALYSIS_W + x) * 3;
      f[p] = rgb[0]; f[p + 1] = rgb[1]; f[p + 2] = rgb[2];
    }
  }
}

/**
 * MAN  — big, well-lit face (the RGB skin rule loves him) and he is the LISTENER,
 *        but he nods steadily on his own clock, uncorrelated with the speech.
 * WOMAN— deep skin tone (`isSkin` scores ~0 on it) and a smaller face, but she is
 *        the one TALKING: her jaw/mouth block moves with the speech envelope.
 */
function makeFrame(i: number): Uint8Array {
  const f = new Uint8Array(ANALYSIS_W * ANALYSIS_H * 3);
  for (let p = 0; p < f.length; p += 3) { f[p] = 35; f[p + 1] = 40; f[p + 2] = 50; }

  const manNod = Math.round(5 * Math.sin(i * 0.41));            // no relation to the audio
  disc(f, Math.round(MAN_X * ANALYSIS_W), 62 + manNod, 27, [200, 140, 115]);

  const wx = Math.round(WOMAN_X * ANALYSIS_W);
  disc(f, wx, 64, 24, [85, 55, 42]);
  // her mouth: opens and closes with the speech envelope while she has the floor
  const open = womanTalking(i) ? Math.round(3 + speechAmp(i) * 90) : 1;
  disc(f, wx, 78, open, [40, 22, 18]);
  return f;
}

/** 16 kHz mono speech-like PCM: ~200 Hz while she talks, ~105 Hz while he does. */
function makeAudio(): Float32Array {
  const a = new Float32Array(SR * DURATION);
  let phase = 0;
  for (let s = 0; s < a.length; s++) {
    const i = Math.floor((s / SR) * FPS);
    const f0 = womanTalking(i) ? 200 : 105;
    const amp = speechAmp(i);
    phase += (2 * Math.PI * f0) / SR;
    // a couple of harmonics so the autocorrelation F0 estimator has something to lock to
    a[s] = amp * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)) + 0.002 * (rnd() - 0.5);
  }
  return a;
}

vi.mock('../ffmpegExtract.js', () => ({
  probeVideo: vi.fn(async () => ({ width: 1920, height: 1080, durationSec: DURATION })),
  extractMonoPcm: vi.fn(async () => makeAudio()),
  streamRgbFrames: vi.fn(async (
    _path: string, w: number, h: number, _fps: number,
    onFrame: (frame: Uint8Array, i: number) => void,
  ) => {
    for (let i = 0; i < N_FRAMES; i++) onFrame(makeFrame(i), i);
    return { width: w, height: h, count: N_FRAMES };
  }),
}));

vi.mock('../../ffmpegLimit.js', () => ({
  runFfmpegLimited: <T,>(fn: () => Promise<T> | T) => Promise.resolve(fn()),
}));

const { processVideoCrop } = await import('../cropProcessor.js');

describe('processVideoCrop — the crop follows the person talking', () => {
  it('frames the woman while she has the floor, not the better-lit man beside her', async () => {
    const meta = await processVideoCrop('vid-1', '/nonexistent.mp4');
    expect(meta.keyframes.length).toBeGreaterThan(200);

    const xAt = (sec: number) => meta.keyframes[Math.round(sec * FPS)].x;
    // Sample well inside her turns, past the debounce commit and any transition.
    const samples = [6, 10, 13, 26, 31, 33, 46, 51, 53].map(xAt);
    const onWoman = samples.filter((x) => Math.abs(x - WOMAN_X) < HALF_WINDOW).length;

    expect(
      onWoman,
      `crop x during the woman's turns: [${samples.map((x) => x.toFixed(3)).join(', ')}]; ` +
      `she is at ${WOMAN_X}, the man at ${MAN_X}, half-window ${HALF_WINDOW.toFixed(3)}. ` +
      `stats=${JSON.stringify(meta.stats)}`,
    ).toBeGreaterThanOrEqual(samples.length - 1);
  });

  it('keeps every keyframe inside the frame the 9:16 window can actually occupy', async () => {
    const meta = await processVideoCrop('vid-2', '/nonexistent.mp4');
    for (const k of meta.keyframes) {
      expect(k.x).toBeGreaterThanOrEqual(HALF_WINDOW - 1e-6);
      expect(k.x).toBeLessThanOrEqual(1 - HALF_WINDOW + 1e-6);
    }
  });
});
