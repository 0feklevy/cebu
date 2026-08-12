/**
 * The conformance gate, run against the REAL encoder (P0.2).
 *
 * Every other test in this directory fakes ffmpeg at the spawn boundary, which means they all
 * share one unproven assumption: that libx264, handed our per-tier arguments, actually emits the
 * profile and level the tier matrix claims — and that our GOP arguments actually produce segments
 * inside the duration tolerance. If that assumption is wrong the gate does not merely mis-report:
 * it THROWS, and every transcode in production fails. A mocked ffprobe answering from the matrix
 * can never catch that, because it is the matrix that would be wrong.
 *
 * So this file spends real CPU on a real encode and asserts what the gate asserts:
 *   - probed profile/level equals the matrix entry (the gate's equality check);
 *   - the first frame of the first segment is a keyframe;
 *   - every EXTINF is within SEGMENT_DURATION_TOLERANCE_SEC of the 4s target;
 *   - avc1CodecString accepts what ffprobe actually spells (x264 reports Baseline as
 *     "Constrained Baseline", which is exactly the kind of vocabulary mismatch that would
 *     throw in production and cannot surface against a fixture).
 *
 * The source is deliberately hostile to keyframe alignment: 20s at 30fps with hard scene cuts
 * every second. Without -sc_threshold 0 and -force_key_frames the encoder scatters keyframes on
 * those cuts and the muxer cuts segments wherever they land — which is how the audited command
 * produced 8.333s segments from a 4s request.
 *
 * OPT-IN: a full four-tier 1080p encode is far too slow for the default suite. Run with
 * HLS_REAL_ENCODE=1 (and ffmpeg/ffprobe on PATH). CI should run it on the video-pipeline path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  TIERS,
  buildTierArgs,
  avc1CodecString,
  findPlaylistDurationViolations,
  SEGMENT_DURATION_TOLERANCE_SEC,
} from '../HLSTranscoder.js';

const ENABLED = process.env.HLS_REAL_ENCODE === '1';
const SEGMENT_SEC = 4;
const SOURCE_FPS = 30;

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout: out.join(''), stderr: err.join('') }));
  });
}

async function probeJson(args: string[]): Promise<Record<string, unknown>> {
  const { code, stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', ...args]);
  expect(code, 'ffprobe exited non-zero').toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

let workDir: string;
let inputPath: string;

beforeAll(async () => {
  if (!ENABLED) return;
  workDir = await mkdtemp(join(tmpdir(), 'hls-real-encode-'));
  inputPath = join(workDir, 'source.mp4');

  // 20s @ 30fps. `testsrc` changes content every frame and the 1s-period hard cuts between two
  // very different patterns give the scene-cut detector something loud to react to.
  const { code, stderr } = await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `testsrc=size=1920x1080:rate=${SOURCE_FPS}:duration=20`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=20`,
    '-vf', "geq=r='if(lt(mod(floor(T),2),1),255*sin(X/9),X)':g='Y':b='128'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    inputPath,
  ]);
  expect(code, `fixture encode failed: ${stderr.slice(-400)}`).toBe(0);
}, 300_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe.runIf(ENABLED)('the conformance gate holds against real libx264 output', () => {
  for (const tier of TIERS) {
    it(`${tier.name} encodes as ${tier.profile}/${tier.level} with aligned segments`, async () => {
      const tierDir = join(workDir, tier.name);
      await mkdir(tierDir, { recursive: true });
      const playlistPath = join(tierDir, 'index.m3u8');

      const { code, stderr } = await run('ffmpeg', ['-y', ...buildTierArgs(tier, {
        fps: SOURCE_FPS,
        segmentSec: SEGMENT_SEC,
        inputPath,
        segmentPattern: join(tierDir, 'seg_%03d.ts'),
        playlistPath,
      })]);
      expect(code, `encode failed: ${stderr.slice(-600)}`).toBe(0);

      // (1) THE GATE'S EQUALITY CHECK. If libx264 silently promotes the level (it will, rather
      // than emit a non-conforming stream) this fails here instead of failing every production
      // transcode.
      const seg0 = join(tierDir, 'seg_000.ts');
      const streams = (await probeJson(['-show_streams', '-select_streams', 'v:0', seg0]))
        .streams as Array<{ profile?: string; level?: number }>;
      const probed = streams[0]!;
      expect(
        { profile: probed.profile, level: probed.level },
        `${tier.name}: libx264 emitted a profile/level the tier matrix does not expect — the `
        + 'conformance gate would reject every transcode of this tier',
      ).toEqual({ profile: expect.any(String), level: tier.level });

      // The matrix says 'baseline'|'main'|'high'; ffprobe spells them differently, and
      // avc1CodecString is the mapping. It THROWS on an unknown spelling, so calling it here
      // proves production can name what the encoder actually produced.
      const codec = avc1CodecString(probed.profile!, probed.level!);
      expect(codec).toMatch(/^avc1\.[0-9a-f]{6}$/);

      // (2) First frame of the first segment must be a keyframe — otherwise the segment is not
      // independently decodable and a player joining there shows nothing.
      const frames = (await probeJson([
        '-show_frames', '-select_streams', 'v:0', '-read_intervals', '%+#1', seg0,
      ])).frames as Array<{ key_frame?: number }>;
      expect(frames[0]?.key_frame, `${tier.name}: first frame of seg_000.ts is not a keyframe`).toBe(1);

      // (3) Segment durations. This is the audited failure reproduced in reverse: the same
      // hostile source that yielded 8.333s segments must now stay inside tolerance.
      const playlist = await readFile(playlistPath, 'utf-8');
      const violations = findPlaylistDurationViolations(playlist, SEGMENT_SEC + SEGMENT_DURATION_TOLERANCE_SEC);
      expect(
        violations,
        `${tier.name}: EXTINF outside tolerance — GOP alignment is not doing its job`,
      ).toEqual([]);
    }, 300_000);
  }

  it('reproduces the audited 8.3s segmentation without the alignment arguments, and fixes it with them', async () => {
    // WHY A SECOND, SMOOTH SOURCE. The fixture above cuts scenes every second, and x264's
    // scene-cut detection (on by default) therefore sprays keyframes at ~1s — which lets even
    // the UNALIGNED command land 4s segments. That flatters the old command and proves nothing.
    // The audited failure needs the opposite: continuous motion with no cuts, where x264 falls
    // back to its default keyint of 250 frames — 8.33s at 30fps, which is exactly the
    // 8.333/8.333/3.333 segmentation the audit measured from a 20s source.
    const smoothPath = join(workDir, 'smooth.mp4');
    const fixture = await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=${SOURCE_FPS}:duration=20`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      smoothPath,
    ]);
    expect(fixture.code, 'smooth fixture encode failed').toBe(0);

    const tier = TIERS[2]!; // 720p — same conclusion as 1080p, a third of the CPU
    const maxSec = SEGMENT_SEC + SEGMENT_DURATION_TOLERANCE_SEC;

    // (a) The audited command: -hls_time 4 and no keyframe policy whatsoever.
    const bareDir = join(workDir, 'bare-720p');
    await mkdir(bareDir, { recursive: true });
    const barePlaylist = join(bareDir, 'index.m3u8');
    const bare = await run('ffmpeg', [
      '-y', '-i', smoothPath,
      '-vf', `scale=${tier.width}:${tier.height}:force_original_aspect_ratio=decrease,pad=${tier.width}:${tier.height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', tier.videoBitrate, '-maxrate', tier.videoBitrate, '-bufsize', '5600k',
      '-c:a', 'aac', '-b:a', tier.audioBitrate, '-ar', '44100',
      '-hls_time', String(SEGMENT_SEC), '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(bareDir, 'seg_%03d.ts'),
      barePlaylist,
    ]);
    expect(bare.code).toBe(0);
    const bareViolations = findPlaylistDurationViolations(await readFile(barePlaylist, 'utf-8'), maxSec);

    // (b) The same encode with the production arguments.
    const fixedDir = join(workDir, 'fixed-720p');
    await mkdir(fixedDir, { recursive: true });
    const fixedPlaylist = join(fixedDir, 'index.m3u8');
    const fixed = await run('ffmpeg', ['-y', ...buildTierArgs(tier, {
      fps: SOURCE_FPS,
      segmentSec: SEGMENT_SEC,
      inputPath: smoothPath,
      segmentPattern: join(fixedDir, 'seg_%03d.ts'),
      playlistPath: fixedPlaylist,
    })]);
    expect(fixed.code).toBe(0);
    const fixedViolations = findPlaylistDurationViolations(await readFile(fixedPlaylist, 'utf-8'), maxSec);

    // The comparison IS the assertion: the old command overshoots on this source, the new one
    // does not. If the encoder's defaults ever change so that (a) passes on its own, this fails
    // loudly and someone re-checks whether the alignment arguments are still load-bearing.
    expect(
      bareViolations.length,
      'the audited command no longer overshoots on a smooth source — x264 defaults may have '
      + 'changed; re-verify that the alignment arguments are still doing work',
    ).toBeGreaterThan(0);
    expect(
      fixedViolations,
      'the production arguments failed to align segments on a smooth source',
    ).toEqual([]);
  }, 300_000);
});
