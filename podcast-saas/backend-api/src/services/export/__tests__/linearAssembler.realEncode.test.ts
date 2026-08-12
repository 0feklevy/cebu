/**
 * The assembler against a REAL ffmpeg (mirrors hlsTranscoder.realEncode.test.ts).
 *
 * Everything else in this directory proves properties of TEXT. This file spends
 * real CPU proving the plan's measured claims hold end-to-end on deliberately
 * hostile sources — a 25fps 720p silent "capture", an anamorphic 60fps b-roll, a
 * 30fps 1080p main with audio — exactly the mismatches §5 measured drifting when
 * assembled naively:
 *
 *   - exact frame count + duration + zero A/V drift on the master;
 *   - the setsar fix (anamorphic content fills the frame; without it the leftmost
 *     columns are black — the measured signature);
 *   - a poster window really renders (non-uniform pixels at its midpoint) and a
 *     black fallback really is black;
 *   - seam discipline (frame N-1 belongs to the left window, frame N to the right —
 *     no double-draw at a shared boundary);
 *   - b-roll audio parity (stored broll_volume is warned about, never mixed);
 *   - cancellation mid-encode → typed error, no master returned, and the truncated
 *     (valid! measured §6) file is REJECTED by the gates — by the duration gate;
 *   - progress monotonic 0→100 from out_time_us;
 *   - amix normalize=0 (region levels stay equal when a second input drops out).
 *
 * OPT-IN: run with EXPORT_REAL_ENCODE=1 and ffmpeg/ffprobe on PATH
 * (e.g. PATH="/opt/homebrew/bin:$PATH" on this machine).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assembleResolved,
  assertMasterGates,
  createLinearAssembler,
  ExportCancelledError,
} from '../LinearAssembler.js';
import type { ResolvedAssembly } from '../ffmpegGraph.js';
import type { ExportPlan } from '../types.js';

const ENABLED = process.env.EXPORT_REAL_ENCODE === '1';
const GRID = { w: 1920, h: 1080, fps: 30 };
const FRAME = 1 / 30;

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

async function ff(args: string[]): Promise<void> {
  const { code, stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args]);
  expect(code, `fixture ffmpeg failed: ${stderr.slice(-400)}`).toBe(0);
}

async function probeJson(path: string): Promise<{
  format: { duration?: string };
  streams: Array<Record<string, unknown>>;
}> {
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ]);
  expect(code, 'ffprobe exited non-zero').toBe(0);
  return JSON.parse(stdout);
}

/** Decode ONE frame at an output timestamp to raw RGB24 and return it. */
async function frameAt(masterPath: string, tSec: number, outPath: string): Promise<Buffer> {
  await ff(['-ss', tSec.toFixed(3), '-i', masterPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', outPath]);
  return readFile(outPath);
}

/** Decode the frame with exact index n (no seeking — frame-accurate). */
async function frameByIndex(masterPath: string, n: number, outPath: string): Promise<Buffer> {
  await ff([
    '-i', masterPath,
    '-vf', `select=eq(n\\,${n})`, '-fps_mode', 'passthrough', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', outPath,
  ]);
  return readFile(outPath);
}

function rgbAt(frame: Buffer, width: number, x: number, y: number): [number, number, number] {
  const o = (y * width + x) * 3;
  return [frame[o]!, frame[o + 1]!, frame[o + 2]!];
}

/** Mean/stddev of luma over a sparse sample of the frame. */
function lumaStats(frame: Buffer): { mean: number; stddev: number } {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let o = 0; o + 2 < frame.length; o += 3 * 997) {
    const l = 0.2126 * frame[o]! + 0.7152 * frame[o + 1]! + 0.0722 * frame[o + 2]!;
    sum += l;
    sumSq += l * l;
    n++;
  }
  const mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

async function meanVolumeDb(path: string, fromSec: number, durSec: number): Promise<{ mean: number; max: number }> {
  const { code, stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostdin',
    '-ss', fromSec.toFixed(3), '-t', durSec.toFixed(3), '-i', path,
    '-af', 'volumedetect', '-f', 'null', '-',
  ]);
  expect(code).toBe(0);
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const max = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  expect(mean, 'volumedetect emitted no mean_volume').not.toBeNull();
  return { mean: Number(mean![1]), max: Number(max![1]) };
}

let root: string;
let mainPath: string;
let capturePath: string;
let brollPath: string;
let posterPath: string;
let stillPath: string;
let tonePath: string;

// The 14s fixture plan: main spliced twice (split discipline), silent 25fps
// capture, anamorphic 60fps b-roll with a LOUD embedded tone (which must never be
// heard), a still, a poster, a black fallback. Audio: main's own track [0,3),
// a -14dB cutaway [8,10), and an adversarial b-roll audio window that the muted-
// b-roll audit must drop.
function mainPlan(): ResolvedAssembly {
  return {
    grid: { ...GRID },
    timeline: [
      { kind: 'video', startSec: 0, endSec: 3, sourcePath: mainPath, sourceInSec: 0 },
      { kind: 'sim-capture', startSec: 3, endSec: 5, sourcePath: capturePath, sourceInSec: 0.5 },
      { kind: 'clip', startSec: 5, endSec: 7, sourcePath: brollPath, sourceInSec: 0.5, brollVolume: 0.8 },
      { kind: 'image', startSec: 7, endSec: 9, sourcePath: stillPath },
      { kind: 'poster-fallback', startSec: 9, endSec: 11, sourcePath: posterPath },
      { kind: 'poster-fallback', startSec: 11, endSec: 12 },
      { kind: 'video', startSec: 12, endSec: 14, sourcePath: mainPath, sourceInSec: 1 },
    ],
    audio: [
      { sourcePath: mainPath, startSec: 0, endSec: 3, sourceInSec: 0 },
      { sourcePath: tonePath, startSec: 8, endSec: 10, sourceInSec: 0, gainDb: -14 },
      { sourcePath: brollPath, startSec: 5, endSec: 7, sourceInSec: 0.5 },
    ],
  };
}

let masterPath = '';
let masterProgress: number[] = [];
let masterWarnings: string[] = [];

beforeAll(async () => {
  if (!ENABLED) return;
  root = await mkdtemp(join(tmpdir(), 'export-real-encode-'));
  mainPath = join(root, 'main.mp4');
  capturePath = join(root, 'capture.mp4');
  brollPath = join(root, 'broll.mp4');
  posterPath = join(root, 'poster.png');
  stillPath = join(root, 'still.png');
  tonePath = join(root, 'tone.wav');

  // main: 1080p30 with its own audio.
  await ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    mainPath,
  ]);
  // capture: 25fps 720p, NO audio stream — the silent-capture failure mode.
  await ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    capturePath,
  ]);
  // b-roll: ANAMORPHIC (1440x1080 SAR 4:3 → DAR 16:9) 60fps solid red, with a loud
  // embedded tone. The red fill is the setsar-fix witness; the tone must stay muted.
  await ff([
    '-f', 'lavfi', '-i', 'color=c=red:size=1440x1080:rate=60:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-vf', 'setsar=4/3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    brollPath,
  ]);
  await ff(['-f', 'lavfi', '-i', 'gradients=size=800x600:duration=1', '-frames:v', '1', posterPath]);
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=1:duration=1', '-frames:v', '1', stillPath]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3', '-c:a', 'pcm_s16le', tonePath]);

  // The main assemble, once — several tests assert different aspects of it.
  const work = join(root, 'work-main');
  await mkdir(work, { recursive: true });
  masterProgress = [];
  const result = await assembleResolved(mainPlan(), work, (pct) => masterProgress.push(pct));
  masterPath = result.masterPath;
  masterWarnings = result.warnings;
  expect(result.frameCount).toBe(420);
}, 300_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe.runIf(ENABLED)('LinearAssembler against real ffmpeg', () => {
  it('produces the exact planned duration and frame count with zero A/V drift', async () => {
    const j = await probeJson(masterPath);
    const v = j.streams.find((s) => s.codec_type === 'video')!;
    const a = j.streams.find((s) => s.codec_type === 'audio')!;

    expect(Math.abs(parseFloat(j.format.duration!) - 14)).toBeLessThanOrEqual(FRAME + 1e-3);
    expect(Number(v.nb_frames), 'frame count must be EXACT — drift compounds').toBe(420);
    const vDur = parseFloat(String(v.duration));
    const aDur = parseFloat(String(a.duration));
    expect(Math.abs(vDur - aDur), 'v/a stream durations must agree within a frame').toBeLessThanOrEqual(FRAME + 1e-3);
  }, 300_000);

  it('conforms to §7: h264 High@4.0 yuv420p 30fps 1080p, aac 48k stereo, faststart', async () => {
    const j = await probeJson(masterPath);
    const v = j.streams.find((s) => s.codec_type === 'video')!;
    const a = j.streams.find((s) => s.codec_type === 'audio')!;
    expect(v.codec_name).toBe('h264');
    expect(v.profile).toBe('High');
    expect(v.level).toBe(40);
    expect(v.pix_fmt).toBe('yuv420p');
    expect(v.width).toBe(1920);
    expect(v.height).toBe(1080);
    expect(v.avg_frame_rate).toBe('30/1');
    expect(a.codec_name).toBe('aac');
    expect(a.sample_rate).toBe('48000');
    expect(a.channels).toBe(2);
    // moov before mdat, from the bytes.
    const head = (await readFile(masterPath)).subarray(0, 64 * 1024);
    const moovIdx = head.indexOf('moov');
    const mdatIdx = head.indexOf('mdat');
    expect(moovIdx, 'moov not near the head of the file').toBeGreaterThan(0);
    expect(mdatIdx === -1 || moovIdx < mdatIdx).toBe(true);
  }, 300_000);

  it('fills the frame on anamorphic input — the setsar fix (drop it and the left edge goes black)', async () => {
    // t=6.0 is inside the b-roll window [5,7): solid red 1440x1080 SAR 4:3 → squared
    // to exactly 1920x1080. Without the leading squaring pair, the measured failure
    // is a ~240px black pillar on each side.
    const frame = await frameAt(masterPath, 6.0, join(root, 'f-broll.rgb'));
    for (const x of [100, 960, 1820]) {
      const [r, g, b] = rgbAt(frame, 1920, x, 540);
      expect(r, `x=${x} should be red (setsar fix)`).toBeGreaterThan(180);
      expect(g).toBeLessThan(80);
      expect(b).toBeLessThan(80);
    }
  }, 300_000);

  it('renders the poster window (non-uniform pixels at its midpoint) and black fallback as black', async () => {
    const poster = await frameAt(masterPath, 10.0, join(root, 'f-poster.rgb'));
    expect(lumaStats(poster).stddev, 'poster midpoint must not be uniform').toBeGreaterThan(8);

    const black = await frameAt(masterPath, 11.5, join(root, 'f-black.rgb'));
    const s = lumaStats(black);
    expect(s.mean, 'no-poster fallback must be black').toBeLessThan(16);
    expect(s.stddev).toBeLessThan(4);
  }, 300_000);

  it('keeps b-roll MUTED (viewer parity): warnings surfaced, no tone in the b-roll window', async () => {
    expect(masterWarnings.some((w) => w.includes('broll_volume 0.8'))).toBe(true);
    expect(masterWarnings.some((w) => w.includes('dropped from the mix'))).toBe(true);

    // [3,8) has no legitimate audio asset: the capture is silent BY DISCIPLINE
    // (apad silence) and the b-roll's loud 880Hz tone must have been dropped.
    const silent = await meanVolumeDb(masterPath, 3.2, 4.4);
    expect(silent.max, 'capture+b-roll span must be silent').toBeLessThan(-60);

    // The -14dB cutaway at [8,10) IS there (the mix itself works).
    const cutaway = await meanVolumeDb(masterPath, 8.2, 1.6);
    expect(cutaway.mean).toBeGreaterThan(-45);

    // Main's own track at [0,3) is there.
    const mainAudio = await meanVolumeDb(masterPath, 0.5, 2.0);
    expect(mainAudio.mean).toBeGreaterThan(-45);
  }, 300_000);

  it('reports monotonic progress 0→100 from out_time_us', () => {
    expect(masterProgress.length).toBeGreaterThanOrEqual(3);
    expect(masterProgress[0]).toBe(0);
    expect(masterProgress[masterProgress.length - 1]).toBe(100);
    for (let i = 1; i < masterProgress.length; i++) {
      expect(masterProgress[i]!, 'progress must be strictly increasing').toBeGreaterThan(masterProgress[i - 1]!);
      expect(masterProgress[i]!).toBeLessThanOrEqual(100);
    }
    // A microseconds-as-milliseconds parser clamps its first reading to the top
    // immediately; a real encode of this size must pass through the middle.
    expect(
      masterProgress.some((p) => p > 0 && p < 95),
      'no mid-range progress reading — is out_time_us being misparsed?',
    ).toBe(true);
  });

  it('rejects a master measured against the wrong planned duration — the duration gate by name', async () => {
    await expect(assertMasterGates(masterPath, GRID, 15)).rejects.toMatchObject({
      name: 'ExportGateError',
      gate: 'duration',
    });
  }, 300_000);

  it('owns the seam: the boundary frame belongs to the RIGHT window, the one before to the LEFT', async () => {
    // Two solid sources sharing a boundary at 2.0s. Frame 59 (t=59/30) must be pure
    // red; frame 60 (t=2.0) must be pure blue — no double-draw, no off-by-one.
    const redPath = join(root, 'red.mp4');
    const bluePath = join(root, 'blue.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=red:size=1920x1080:rate=30:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', redPath]);
    await ff(['-f', 'lavfi', '-i', 'color=c=blue:size=1920x1080:rate=30:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', bluePath]);

    const plan: ResolvedAssembly = {
      grid: { ...GRID },
      timeline: [
        { kind: 'video', startSec: 0, endSec: 2, sourcePath: redPath },
        { kind: 'video', startSec: 2, endSec: 4, sourcePath: bluePath },
      ],
      audio: [], // exercises the bounded-silence degenerate path through the gates too
    };
    const work = join(root, 'work-seam');
    await mkdir(work, { recursive: true });
    const { masterPath: seamMaster } = await assembleResolved(plan, work);

    const before = await frameByIndex(seamMaster, 59, join(root, 'f-seam-before.rgb'));
    const at = await frameByIndex(seamMaster, 60, join(root, 'f-seam-at.rgb'));
    const [rb, gb, bb] = rgbAt(before, 1920, 960, 540);
    const [ra, ga, ba] = rgbAt(at, 1920, 960, 540);
    expect(rb, 'frame 59 must still be the left (red) window').toBeGreaterThan(180);
    expect(bb).toBeLessThan(80);
    expect(ba, 'frame 60 must be the right (blue) window — no double-draw').toBeGreaterThan(180);
    expect(ra).toBeLessThan(80);
    expect(gb + ga, 'a blend at the seam would drag green up').toBeLessThan(160);
  }, 300_000);

  it('keeps region levels equal across an input dropout — amix normalize=0', async () => {
    // Narration spans [0,8); a (near-silent) bed spans only [0,4). With the default
    // amix normalisation, the narration in [0,4) comes out ~6dB quieter than in
    // [4,8) (measured §5: 5dB on real material). With normalize=0 they are equal —
    // and the two-pass LINEAR loudnorm preserves the relation.
    const narrPath = join(root, 'narr.wav');
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8', '-c:a', 'pcm_s16le', narrPath]);
    const plan: ResolvedAssembly = {
      grid: { ...GRID },
      timeline: [{ kind: 'poster-fallback', startSec: 0, endSec: 8 }],
      audio: [
        { sourcePath: narrPath, startSec: 0, endSec: 8, gainDb: -6 },
        { sourcePath: narrPath, startSec: 0, endSec: 4, gainDb: -90 },
      ],
    };
    const work = join(root, 'work-loudness');
    await mkdir(work, { recursive: true });
    const { masterPath: loudMaster } = await assembleResolved(plan, work);

    const withBed = await meanVolumeDb(loudMaster, 1, 2);
    const solo = await meanVolumeDb(loudMaster, 5, 2);
    expect(
      Math.abs(withBed.mean - solo.mean),
      `narration level moved when the bed dropped out (${withBed.mean} vs ${solo.mean} dB) — amix normalisation is on`,
    ).toBeLessThan(1.5);
  }, 300_000);

  it('cancels via SIGTERM: typed error, no master returned, truncated file REJECTED by the duration gate', async () => {
    // A 40s encode so the abort lands mid-flight, triggered by the first real
    // progress report (the encode is definitely underway).
    const longPath = join(root, 'long.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=40',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', longPath]);
    const plan: ResolvedAssembly = {
      grid: { ...GRID },
      timeline: [{ kind: 'video', startSec: 0, endSec: 40, sourcePath: longPath }],
      audio: [],
    };
    const work = join(root, 'work-cancel');
    await mkdir(work, { recursive: true });

    const controller = new AbortController();
    let armed = false;
    const attempt = assembleResolved(plan, work, (pct) => {
      if (pct > 0 && pct < 100 && !armed) {
        armed = true;
        controller.abort();
      }
    }, controller.signal);

    await expect(attempt).rejects.toBeInstanceOf(ExportCancelledError);
    expect(armed, 'the abort must have fired mid-encode').toBe(true);

    // The measured trap (§6): SIGTERM finalises the container — the partial file is
    // a VALID, playable MP4 that even satisfies faststart. Only the duration gate
    // stands between it and publication. It must throw, by name.
    const partial = join(work, 'master.mp4');
    await expect(assertMasterGates(partial, GRID, 40)).rejects.toMatchObject({
      name: 'ExportGateError',
      gate: 'duration',
    });
  }, 300_000);

  it('assembles a CONTRACT plan end-to-end: storage keys, layered timeline, post-roll tail', async () => {
    // Base: solid green with a tone. Overlays: the gradient poster as an IMAGE
    // section [2,4) (the base must RESUME, not rewind), and a post-roll poster
    // tail [6,8) extending the export past the base video.
    const greenPath = join(root, 'green.mp4');
    await ff([
      '-f', 'lavfi', '-i', 'color=c=green:size=1920x1080:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      greenPath,
    ]);
    const bytesByKey = new Map<string, string>([
      ['videos/green.mp4', greenPath],
      ['images/poster.png', posterPath],
    ]);
    const storage = {
      readObject: async (key: string) => {
        const p = bytesByKey.get(key);
        if (!p) throw new Error(`unexpected storage key ${key}`);
        return readFile(p);
      },
    };
    const plan: ExportPlan = {
      projectId: 'p-test',
      grid: { ...GRID },
      timeline: [
        {
          kind: 'video', sectionId: null, label: 'green.mp4', startSec: 0, endSec: 6,
          videoFileId: 'v-green', storageKey: 'videos/green.mp4', sourceInSec: 0, sourceOutSec: 6,
        },
        {
          kind: 'image', sectionId: 'sec-img', label: 'img', startSec: 2, endSec: 4,
          imageFileId: 'i1', storageKey: 'images/poster.png', crop: { x: 0, y: 0, w: 1, h: 1 },
        },
        {
          kind: 'poster-fallback', sectionId: 'sec-sim', label: 'sim tail', startSec: 6, endSec: 8,
          posterKey: 'images/poster.png',
        },
      ],
      audio: [{
        source: 'main', sectionId: null, globalOffsetSec: 0,
        sourceInSec: 0, sourceOutSec: 6, storageKey: 'videos/green.mp4', gain: 1.0,
      }],
      sources: [], rendererIdentity: null, warnings: [],
      estimatedSourceBytes: 0, requiredDiskBytes: 0,
      totalDurationSec: 8,
    };

    const work = join(root, 'work-contract');
    await mkdir(work, { recursive: true });
    const progress: number[] = [];
    const controller = new AbortController();
    const { masterPath: contractMaster } = await createLinearAssembler(storage)
      .assemble(plan, work, (pct) => progress.push(pct), controller.signal);

    // Duration gate ran against plan.totalDurationSec inside; verify independently.
    const j = await probeJson(contractMaster);
    expect(Math.abs(parseFloat(j.format.duration!) - 8)).toBeLessThanOrEqual(FRAME + 1e-3);
    expect(progress[progress.length - 1]).toBe(100);

    // t=1: base green. t=3: the image overlay (non-uniform gradient). t=5: base
    // RESUMED (green — and the base kept playing underneath). t=7: post-roll poster.
    const g1 = rgbAt(await frameAt(contractMaster, 1.0, join(root, 'f-c1.rgb')), 1920, 960, 540);
    expect(g1[1], 'base before the overlay must be green').toBeGreaterThan(100);
    expect(g1[0]).toBeLessThan(80);
    const overlay = lumaStats(await frameAt(contractMaster, 3.0, join(root, 'f-c3.rgb')));
    expect(overlay.stddev, 'image overlay must be visible at its midpoint').toBeGreaterThan(8);
    const g5 = rgbAt(await frameAt(contractMaster, 5.0, join(root, 'f-c5.rgb')), 1920, 960, 540);
    expect(g5[1], 'base after the overlay must be green again').toBeGreaterThan(100);
    expect(g5[0]).toBeLessThan(80);
    const tail = lumaStats(await frameAt(contractMaster, 7.0, join(root, 'f-c7.rgb')));
    expect(tail.stddev, 'post-roll poster tail must render the poster').toBeGreaterThan(8);

    // The tail has no audio asset: silence by the apad discipline.
    const tailAudio = await meanVolumeDb(contractMaster, 6.2, 1.6);
    expect(tailAudio.max).toBeLessThan(-60);
    const baseAudio = await meanVolumeDb(contractMaster, 0.5, 2.0);
    expect(baseAudio.mean).toBeGreaterThan(-45);
  }, 300_000);
});
