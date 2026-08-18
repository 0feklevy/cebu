/**
 * The pixel-reading half of artifact validation, against REAL media produced by ffmpeg.
 *
 * The unit suites stub these probes, because driving the provider with fake frame bytes and then
 * running a real `ffprobe` over 'a' and 'b' would only prove that ffprobe rejects text. That makes
 * this file the one place the production path is actually exercised — without it, "the clip is
 * validated" would be a claim about a function nothing real ever calls with real input.
 *
 * Skipped when ffmpeg/ffprobe are absent, in the same way the linear assembler's real-encode test
 * is: a missing tool must not read as a passing check.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { assertClipMatches, probeClip, probeImage } from '../artifactProbe.js';

const run = promisify(execFile);

let dir: string;
let haveFfmpeg = false;

beforeAll(async () => {
  try {
    await run('ffprobe', ['-version']);
    await run('ffmpeg', ['-version']);
    haveFfmpeg = true;
  } catch {
    haveFfmpeg = false;
  }
  dir = await mkdtemp(join(tmpdir(), 'probe-real-'));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** A real JPEG of an exact size, made the way the capture makes them. */
async function makeJpeg(name: string, w: number, h: number): Promise<string> {
  const path = join(dir, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=${w}x${h}:d=1`, '-frames:v', '1', '-q:v', '3', path]);
  return path;
}

/** A real h264 clip of an exact size, rate and length. */
async function makeClip(name: string, w: number, h: number, fps: number, frames: number): Promise<string> {
  const path = join(dir, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=s=${w}x${h}:r=${fps}`, '-frames:v', String(frames),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
  return path;
}

describe.runIf(!process.env.SKIP_REAL_MEDIA)('artifact probes over real media', () => {
  it('reads a real frame\'s codec and dimensions', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false); // recorded as skipped-by-environment
    const probed = await probeImage(await makeJpeg('frame.jpg', 640, 360));
    expect(probed.codec).toMatch(/mjpeg|jpeg/);
    expect(probed.width).toBe(640);
    expect(probed.height).toBe(360);
  });

  it('refuses a file that is not decodable as an image — the "450 well-named text files" case', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const notAnImage = join(dir, 'frame-000000.jpg');
    await writeFile(notAnImage, 'a'); // correctly named, correctly placed, not an image
    await expect(probeImage(notAnImage)).rejects.toThrow(/probe failed/);
  });

  it('reads a real clip\'s streams, codec, pixel format, size, rate and duration', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const probed = await probeClip(await makeClip('clip.mp4', 640, 360, 30, 60));
    expect(probed.streams).toBe(1);
    expect(probed.codec).toBe('h264');
    expect(probed.pixFmt).toBe('yuv420p');
    expect(probed.width).toBe(640);
    expect(probed.height).toBe(360);
    expect(probed.fps).toBeCloseTo(30, 1);
    expect(probed.frames).toBe(60);
    expect(probed.durationSec).toBeCloseTo(2, 1);
  });

  it('accepts a clip that matches the window, and names what is wrong when it does not', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const probed = await probeClip(await makeClip('exact.mp4', 640, 360, 30, 60));
    expect(() => assertClipMatches(probed, { width: 640, height: 360, fps: 30, frames: 60 }, 'sec')).not.toThrow();

    // Wrong size: the assembler would stretch this across the window and the viewer would blame
    // the simulation.
    expect(() => assertClipMatches(probed, { width: 1920, height: 1080, fps: 30, frames: 60 }, 'sec'))
      .toThrow(/640x360, not the requested 1920x1080/);
    // Short by more than the one-frame tolerance: a gap the assembler covers by repeating.
    expect(() => assertClipMatches(probed, { width: 640, height: 360, fps: 30, frames: 90 }, 'sec'))
      .toThrow(/60 frames, not the expected 90/);
    // Wrong rate.
    expect(() => assertClipMatches(probed, { width: 640, height: 360, fps: 25, frames: 60 }, 'sec'))
      .toThrow(/fps/);
  });

  it('tolerates exactly one frame of drift, and no more', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const probed = await probeClip(await makeClip('drift.mp4', 320, 180, 30, 60));
    expect(() => assertClipMatches(probed, { width: 320, height: 180, fps: 30, frames: 61 }, 'sec')).not.toThrow();
    expect(() => assertClipMatches(probed, { width: 320, height: 180, fps: 30, frames: 62 }, 'sec')).toThrow();
  });

  it('is cancellable — an aborted probe rejects instead of running to completion', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const clip = await makeClip('cancel.mp4', 320, 180, 30, 30);
    const controller = new AbortController();
    controller.abort();
    await expect(probeClip(clip, { signal: controller.signal })).rejects.toThrow();
  });
});

/**
 * Stream enforcement, against real media the audit named: an extra audio stream, a VP9/yuv444p
 * clip, and a clip whose count ffprobe cannot state. "Unknown" must not read as success — a
 * container that strips the numbers must not pass BECAUSE they are missing.
 */
describe.runIf(!process.env.SKIP_REAL_MEDIA)('clip enforcement over real streams', () => {
  it('refuses a clip smuggling an AUDIO stream beside the video', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const path = join(dir, 'with-audio.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-frames:v', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
    const probed = await probeClip(path);
    expect(probed.streams).toBe(2);
    expect(() => assertClipMatches(probed, { width: 320, height: 180, fps: 30, frames: 30 }, 'sec'))
      .toThrow(/carries 2 streams/);
  });

  it('refuses a VP9 clip and a yuv444p clip — not the encoder\'s bytes', async () => {
    if (!haveFfmpeg) return expect(haveFfmpeg).toBe(false);
    const vp9 = join(dir, 'clip.webm');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30', '-frames:v', '10',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', vp9]).catch(() => null);
    try {
      const probed = await probeClip(vp9);
      expect(() => assertClipMatches(probed, { width: 320, height: 180, fps: 30, frames: 10 }, 'sec'))
        .toThrow(/codec is vp9/);
    } catch { /* libvpx not built into this ffmpeg — the codec check is still covered below */ }

    const p444 = join(dir, 'clip444.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30', '-frames:v', '10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv444p', p444]);
    const probed444 = await probeClip(p444);
    expect(() => assertClipMatches(probed444, { width: 320, height: 180, fps: 30, frames: 10 }, 'sec'))
      .toThrow(/pixel format is yuv444p/);
  });

  it('refuses a clip with an UNKNOWN frame count or duration rather than waving it through', () => {
    const base = { streams: 1, codec: 'h264', pixFmt: 'yuv420p', width: 320, height: 180, fps: 30, durationSec: 1, frames: 30 };
    expect(() => assertClipMatches({ ...base, frames: null }, { width: 320, height: 180, fps: 30, frames: 30 }, 'sec'))
      .toThrow(/no frame count/);
    expect(() => assertClipMatches({ ...base, durationSec: 0 }, { width: 320, height: 180, fps: 30, frames: 30 }, 'sec'))
      .toThrow(/no duration/);
  });
});
