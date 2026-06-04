/**
 * ffmpeg-backed extraction for the crop pipeline.
 *
 * Two passes over the source file, both streaming raw bytes from ffmpeg stdout
 * (the same approach HLSTranscoder uses for waveform peaks):
 *   • extractGrayFrames — decimated grayscale frames at a fixed sample rate and
 *     a small analysis resolution (we never need full-res for a 1-D crop signal).
 *   • extractMonoPcm    — 16 kHz mono float PCM for pitch analysis.
 *
 * Keeping the analysis resolution small (default 320×180) is the single biggest
 * speed win versus the Python reference, which decoded full-resolution frames.
 */

import { spawn } from 'child_process';

export interface ProbeResult {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
}

export function probeVideo(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      inputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${Buffer.concat(err).toString().slice(-400)}`));
      try {
        const json = JSON.parse(Buffer.concat(out).toString());
        const stream = json.streams?.[0] ?? {};
        const width = Number(stream.width) || 0;
        const height = Number(stream.height) || 0;
        const durationSec = Number(stream.duration) || Number(json.format?.duration) || 0;
        let fps = 30;
        if (typeof stream.r_frame_rate === 'string' && stream.r_frame_rate.includes('/')) {
          const [a, b] = stream.r_frame_rate.split('/').map(Number);
          if (b) fps = a / b;
        }
        if (!width || !height) return reject(new Error('ffprobe: missing video dimensions'));
        resolve({ width, height, durationSec, fps });
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${(e as Error).message}`));
      }
    });
  });
}

export interface GrayFrames {
  width: number;      // analysis width (downscaled)
  height: number;     // analysis height (downscaled)
  fps: number;        // sample rate of the returned frames (== sampleFps)
  frames: Uint8Array[]; // one gray8 buffer (width*height) per sampled frame
}

/**
 * Decode `sampleFps` grayscale frames per second at a small analysis resolution.
 * Frames are gray8 (1 byte/px), row-major. Returns them as an array of buffers.
 */
export function extractGrayFrames(
  inputPath: string,
  analysisWidth = 320,
  analysisHeight = 180,
  sampleFps = 1,
): Promise<GrayFrames> {
  return new Promise((resolve, reject) => {
    const frameBytes = analysisWidth * analysisHeight;
    const proc = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-an',                                       // no audio
      '-vf', `fps=${sampleFps},scale=${analysisWidth}:${analysisHeight}`,
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      'pipe:1',
      '-loglevel', 'error',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg frames failed: ${Buffer.concat(err).toString().slice(-400)}`));
      const raw = Buffer.concat(chunks);
      const nFrames = Math.floor(raw.length / frameBytes);
      const frames: Uint8Array[] = [];
      for (let i = 0; i < nFrames; i++) {
        frames.push(new Uint8Array(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes));
      }
      resolve({ width: analysisWidth, height: analysisHeight, fps: sampleFps, frames });
    });
  });
}

/**
 * Decode RGB frames (for shot detection via colour histograms) at the same
 * sample rate, at a coarse resolution. Returns interleaved rgb24 buffers.
 */
export function extractRgbFrames(
  inputPath: string,
  analysisWidth = 64,
  analysisHeight = 36,
  sampleFps = 1,
): Promise<{ width: number; height: number; frames: Uint8Array[] }> {
  return new Promise((resolve, reject) => {
    const frameBytes = analysisWidth * analysisHeight * 3;
    const proc = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-an',
      '-vf', `fps=${sampleFps},scale=${analysisWidth}:${analysisHeight}`,
      '-pix_fmt', 'rgb24',
      '-f', 'rawvideo',
      'pipe:1',
      '-loglevel', 'error',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg rgb frames failed: ${Buffer.concat(err).toString().slice(-400)}`));
      const raw = Buffer.concat(chunks);
      const nFrames = Math.floor(raw.length / frameBytes);
      const frames: Uint8Array[] = [];
      for (let i = 0; i < nFrames; i++) {
        frames.push(new Uint8Array(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes));
      }
      resolve({ width: analysisWidth, height: analysisHeight, frames });
    });
  });
}

/** Decode the whole audio track as mono float32 at `sr` Hz. */
export function extractMonoPcm(inputPath: string, sr = 16000): Promise<Float32Array> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', String(sr),
      '-f', 's16le',
      'pipe:1',
      '-loglevel', 'error',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', () => resolve(new Float32Array(0)));
    proc.on('close', () => {
      if (chunks.length === 0) { resolve(new Float32Array(0)); return; }
      const raw = Buffer.concat(chunks);
      const n = Math.floor(raw.byteLength / 2);
      const samples = new Int16Array(raw.buffer, raw.byteOffset, n);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = samples[i] / 32768;
      resolve(out);
    });
  });
}
