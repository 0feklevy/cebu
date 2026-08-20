/**
 * `streamRgbFrames` — the memory contract the whole crop pipeline rests on.
 *
 * An earlier version of this extractor concatenated every decoded frame before analysis began:
 * ~2.5 GB of raw RGB for a 60-minute take, and the OOM that followed is why the streaming
 * variant exists (perf-001/perf-009). Nothing tested it. This file drives the real function
 * against a fake ffmpeg — a stub script that writes deterministic frames to stdout — so the
 * ordering, backpressure and error paths are exercised as written rather than as remembered.
 *
 * The async-consumer case is the one that will carry a per-frame model inference. What has to
 * hold there is that a slow consumer PAUSES the producer instead of letting frames queue: the
 * cost of inference must be wall time, never memory.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const W = 4, H = 2;                    // 24-byte frames — small enough to reason about exactly
const FRAME_BYTES = W * H * 3;
const FRAMES = 12;

let dir: string;
let stub: string;

/**
 * A fake `ffmpeg` on PATH. It writes FRAMES whole frames plus a deliberate trailing partial
 * frame, in chunks that do NOT align to frame boundaries, so the reassembly is actually tested.
 */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crop-extract-'));
  stub = join(dir, 'ffmpeg');
  await writeFile(stub, `#!/usr/bin/env node
const FRAME_BYTES = ${FRAME_BYTES}, FRAMES = ${FRAMES};
if (process.env.STUB_EXIT_CODE && process.env.STUB_EXIT_CODE !== '0') {
  process.stderr.write('stub failure\\n');
  process.exit(Number(process.env.STUB_EXIT_CODE));
}
const all = Buffer.alloc(FRAME_BYTES * FRAMES + 7);   // + a trailing partial frame
for (let f = 0; f < FRAMES; f++) all.fill(f + 1, f * FRAME_BYTES, (f + 1) * FRAME_BYTES);
all.fill(0xff, FRAME_BYTES * FRAMES);
let i = 0;
(function write() {
  while (i < all.length) {
    const n = Math.min(7, all.length - i);            // 7 never divides ${FRAME_BYTES}
    const ok = process.stdout.write(all.subarray(i, i + n));
    i += n;
    if (!ok) { process.stdout.once('drain', write); return; }
  }
  process.stdout.end();
})();
`);
  await chmod(stub, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const { streamRgbFrames } = await import('../ffmpegExtract.js');

/** Every frame is filled with its own 1-based index, so content proves ordering. */
const tagOf = (frame: Uint8Array) => frame[0];

describe('streamRgbFrames', () => {
  it('delivers whole frames in order and discards a trailing partial one', async () => {
    const seen: Array<[number, number]> = [];
    const res = await streamRgbFrames('in.mp4', W, H, 4, (frame, i) => { seen.push([i, tagOf(frame)]); });

    expect(res.count).toBe(FRAMES);
    expect(seen.map(([i]) => i)).toEqual([...Array(FRAMES).keys()]);
    expect(seen.map(([, tag]) => tag)).toEqual([...Array(FRAMES).keys()].map((k) => k + 1));
  });

  it('gives each frame whole, despite chunk boundaries falling mid-frame', async () => {
    const uniform: boolean[] = [];
    await streamRgbFrames('in.mp4', W, H, 4, (frame) => {
      uniform.push(frame.length === FRAME_BYTES && frame.every((b) => b === frame[0]));
    });
    expect(uniform).toEqual(new Array(FRAMES).fill(true));
  });

  it('pauses the producer for an async consumer instead of queueing frames behind it', async () => {
    // The consumer is slow and records how many frames were delivered before each of its
    // awaits resolved. If delivery ever ran ahead of the consumer, some frame would start
    // while an earlier one was still pending — which is the failure this asserts against.
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];

    const res = await streamRgbFrames('in.mp4', W, H, 4, async (frame, i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      order.push(tagOf(frame));
      expect(i).toBe(order.length - 1);
      inFlight--;
    });

    expect(res.count).toBe(FRAMES);
    expect(maxInFlight, 'frames overlapped — the stream was not paused for the consumer').toBe(1);
    expect(order).toEqual([...Array(FRAMES).keys()].map((k) => k + 1));
  });

  it('waits for the last async consumer before resolving', async () => {
    // Without the drain-before-resolve the final inference is dropped and the caller is still
    // told it saw every frame — a silent hole at the end of every video.
    const done: number[] = [];
    const res = await streamRgbFrames('in.mp4', W, H, 4, async (_frame, i) => {
      await new Promise((r) => setTimeout(r, 1));
      done.push(i);
    });
    expect(done.length).toBe(res.count);
  });

  it('holds a frame view valid across the consumer\'s await', async () => {
    const tagsAfterAwait: number[] = [];
    await streamRgbFrames('in.mp4', W, H, 4, async (frame) => {
      const before = tagOf(frame);
      await new Promise((r) => setTimeout(r, 2));
      expect(tagOf(frame), 'the frame view was overwritten while the consumer held it').toBe(before);
      tagsAfterAwait.push(tagOf(frame));
    });
    expect(tagsAfterAwait).toEqual([...Array(FRAMES).keys()].map((k) => k + 1));
  });

  it('rejects when a synchronous consumer throws', async () => {
    await expect(streamRgbFrames('in.mp4', W, H, 4, (_f, i) => {
      if (i === 3) throw new Error('consumer exploded');
    })).rejects.toThrow('consumer exploded');
  });

  it('rejects when an async consumer rejects', async () => {
    await expect(streamRgbFrames('in.mp4', W, H, 4, async (_f, i) => {
      if (i === 2) throw new Error('inference failed');
    })).rejects.toThrow('inference failed');
  });

  it('rejects with ffmpeg stderr when the decode fails', async () => {
    vi.stubEnv('STUB_EXIT_CODE', '3');
    try {
      await expect(streamRgbFrames('in.mp4', W, H, 4, () => {})).rejects.toThrow(/stub failure/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
