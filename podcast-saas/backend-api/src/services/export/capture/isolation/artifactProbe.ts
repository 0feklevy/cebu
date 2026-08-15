/**
 * What the capture ACTUALLY produced, measured rather than believed.
 *
 * Everything else on this boundary checks the shape of the container's claims: that `result.json`
 * parses, that the frame names are the expected ones, that nothing escapes the output directory.
 * None of that looks inside a single byte of image data. A container that writes 450 well-named,
 * correctly-sized, perfectly-confined files of 320x180 — or of something that is not an image at
 * all — passes every one of those checks, and the first thing to notice would be a viewer watching
 * a stretched or broken section of their finished video.
 *
 * So the artifacts are probed. `ffprobe` is the only thing here that reads pixels, and it is run
 * under the same global concurrency cap as every other ffmpeg process (an unbounded probe per frame
 * would be a denial of service the container could trigger by writing more frames) with its own
 * deadline and the job's cancellation signal.
 */

import { spawn } from 'node:child_process';

import { runFfmpegLimited } from '../../../ffmpegLimit.js';

/** A probe must not outlive the thing it is describing. */
export const PROBE_TIMEOUT_MS = 30_000;

export interface ProbedVideo {
  /** How many streams of any kind the file carries. */
  streams: number;
  codec: string;
  pixFmt: string;
  width: number;
  height: number;
  /** Frames per second as a rational, evaluated. */
  fps: number;
  durationSec: number;
  /** Frame count, when the container records one. */
  frames: number | null;
}

export interface ProbedImage {
  codec: string;
  width: number;
  height: number;
}

class ProbeFailed extends Error {
  constructor(what: string, detail: string) {
    super(`capture artifact probe failed for ${what}: ${detail}`);
    this.name = 'ProbeFailed';
  }
}

/** Run ffprobe over one path and return its JSON, bounded and cancellable. */
async function ffprobeJson(
  path: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return runFfmpegLimited(
    () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const proc = spawn('ffprobe', ['-hide_banner', '-loglevel', 'error', '-of', 'json', ...args, path], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          fn();
        };
        const kill = (why: string): void => {
          proc.kill('SIGKILL');
          finish(() => reject(new ProbeFailed(path, why)));
        };
        const timer = setTimeout(() => kill(`timed out after ${opts.timeoutMs ?? PROBE_TIMEOUT_MS} ms`),
          opts.timeoutMs ?? PROBE_TIMEOUT_MS);
        const onAbort = (): void => kill('cancelled');
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        proc.stdout.on('data', (d) => { if (out.length < 1_000_000) out += String(d); });
        proc.stderr.on('data', (d) => { if (err.length < 4096) err += String(d); });
        proc.on('error', (e) => finish(() => reject(new ProbeFailed(path, e.message))));
        proc.on('close', (code) => {
          finish(() => {
            if (code !== 0) return reject(new ProbeFailed(path, `ffprobe exited ${code}: ${err.slice(-300)}`));
            try {
              resolve(JSON.parse(out) as Record<string, unknown>);
            } catch (e) {
              reject(new ProbeFailed(path, `ffprobe output is not JSON: ${e instanceof Error ? e.message : String(e)}`));
            }
          });
        });
      }),
    opts.signal,
  );
}

/** Evaluate an ffprobe rational ("30/1", "30000/1001") without trusting it to be one. */
function rational(value: unknown): number {
  const s = String(value ?? '');
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) {
    const den = Number(m[2]);
    return den === 0 ? 0 : Number(m[1]) / den;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Probe an encoded clip: streams, codec, pixel format, dimensions, rate, duration, frame count. */
export async function probeClip(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ProbedVideo> {
  const json = await ffprobeJson(path, ['-show_streams', '-show_format', '-count_frames'], opts);
  const streams = Array.isArray(json.streams) ? (json.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new ProbeFailed(path, 'no video stream');
  if (!(Number(video.width) > 0) || !(Number(video.height) > 0)) {
    throw new ProbeFailed(path, `video stream has no dimensions (${video.width}x${video.height})`);
  }
  const format = (json.format ?? {}) as Record<string, unknown>;
  const frames = Number(video.nb_read_frames ?? video.nb_frames);
  return {
    streams: streams.length,
    codec: String(video.codec_name ?? ''),
    pixFmt: String(video.pix_fmt ?? ''),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps: rational(video.avg_frame_rate ?? video.r_frame_rate),
    durationSec: Number(format.duration ?? video.duration ?? 0),
    frames: Number.isFinite(frames) && frames > 0 ? frames : null,
  };
}

/** Probe a single frame file: what it actually is, and how big. */
export async function probeImage(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ProbedImage> {
  const json = await ffprobeJson(path, ['-show_streams', '-select_streams', 'v:0'], opts);
  const streams = Array.isArray(json.streams) ? (json.streams as Record<string, unknown>[]) : [];
  const s = streams[0];
  if (!s) throw new ProbeFailed(path, 'no decodable image stream');
  const width = Number(s.width ?? 0);
  const height = Number(s.height ?? 0);
  // ffprobe will happily report a codec for a file it cannot actually decode — a text file named
  // `frame-000000.jpg` comes back as mjpeg with 0x0. Dimensions are the property that separates
  // "an image" from "a file ffprobe was willing to guess about".
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ProbeFailed(path, `no decodable image data (reported ${width}x${height})`);
  }
  return { codec: String(s.codec_name ?? ''), width, height };
}

export interface ExpectedVideo {
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/**
 * Hold a probed clip against what the export asked for.
 *
 * The tolerance is ONE FRAME on both duration and count, and no more. A clip that is short by two
 * frames leaves a gap the assembler fills by stretching or repeating — visible, and attributed by
 * the viewer to the simulation rather than to the encoder.
 */
export function assertClipMatches(probed: ProbedVideo, want: ExpectedVideo, label: string): void {
  if (probed.width !== want.width || probed.height !== want.height) {
    throw new Error(
      `${label}: clip is ${probed.width}x${probed.height}, not the requested ${want.width}x${want.height}`,
    );
  }
  if (Math.abs(probed.fps - want.fps) > 0.01) {
    throw new Error(`${label}: clip runs at ${probed.fps.toFixed(3)} fps, not ${want.fps}`);
  }
  if (probed.frames !== null && Math.abs(probed.frames - want.frames) > 1) {
    throw new Error(`${label}: clip holds ${probed.frames} frames, not the expected ${want.frames}`);
  }
  const wantSec = want.frames / want.fps;
  const oneFrame = 1 / want.fps;
  if (probed.durationSec > 0 && Math.abs(probed.durationSec - wantSec) > oneFrame + 0.001) {
    throw new Error(
      `${label}: clip runs ${probed.durationSec.toFixed(3)}s, not ${wantSec.toFixed(3)}s (±1 frame)`,
    );
  }
}
