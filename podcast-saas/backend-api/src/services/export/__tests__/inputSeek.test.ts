/**
 * media-008 — INPUT SEEK on the export graphs. Pure: asserts the CONSTRUCTED ffmpeg command,
 * never a real encode.
 *
 * The defect: no `-ss` anywhere in the export, so every input decoded from frame 0 up to the
 * first frame it was actually asked for. A ten-second b-roll spliced from minute 45 of its
 * master decoded forty-five minutes of H.264 to produce it — on the 2-vCPU worker that is the
 * single largest avoidable cost in the whole export path.
 *
 * WHY INPUT SEEK AND NOT OUTPUT SEEK. `-ss` after `-i` decodes everything before the target and
 * discards it, which is precisely the cost being removed. `-ss` before `-i` jumps to the
 * keyframe at or before the target and, under `-accurate_seek` (ffmpeg's default when
 * transcoding), decodes and discards forward to the exact position.
 *
 * WHY THE SEEK IS THE EXACT IN-POINT AND THE TRIM BECOMES ZERO. Measured on ffmpeg 8.1.2, a 2s
 * window at 20.017s of a 30 fps / 2s-GOP source, output frames hashed against a full reference
 * decode: baseline `trim=start=20.017` → reference frame 601; `-ss 20.017` + `trim=start=0` →
 * reference frame 601 (byte-identical whole-window output); `-ss 19.017` + `trim=start=1`, the
 * "safety backoff" spelling, → reference frame 602, one frame late, because it rounds twice.
 *
 * WHY SPLIT INPUTS ARE NOT SEEKED. One input carries one `-ss`, so a source spliced N times
 * would need a residual trim on its other windows — the double-rounding above. Exactness wins.
 */

import { describe, it, expect } from 'vitest';

import {
  buildVideoSpine,
  buildAudioMixBatch,
  inputSeekSec,
  MIN_INPUT_SEEK_SEC,
  type TimelineWindow,
  type AudioWindow,
} from '../ffmpegGraph.js';
import { EXPORT_GRID } from '../types.js';

const GRID = EXPORT_GRID;

/** `-ss <n>` immediately before `-i <path>`, or null when the input carries no seek. */
function seekOf(args: string[], path: string): number | null {
  const i = args.indexOf('-i');
  if (i < 1 || args[i + 1] !== path) return null;
  return args[i - 2] === '-ss' ? Number(args[i - 1]) : null;
}

describe('inputSeekSec — the one place the seek position is decided', () => {
  it('is the EXACT in-point, so exactly one ">=" rounding happens, where the trim used to do it', () => {
    expect(inputSeekSec(3000)).toBe(3000);
    expect(inputSeekSec(20.017)).toBe(20.017);
    expect(inputSeekSec(MIN_INPUT_SEEK_SEC)).toBe(MIN_INPUT_SEEK_SEC);
  });

  it('does not seek for in-points too small to be worth it', () => {
    expect(inputSeekSec(0)).toBe(0);
    expect(inputSeekSec(0.5)).toBe(0);
    expect(inputSeekSec(MIN_INPUT_SEEK_SEC - 0.001)).toBe(0);
    expect(inputSeekSec(Number.NaN)).toBe(0);
  });
});

describe('buildVideoSpine seeks the input instead of decoding from frame 0', () => {
  it('emits -ss BEFORE -i for a window spliced from deep inside its source, and zeroes the trim', () => {
    const tl: TimelineWindow[] = [
      // the finding's own case: ten seconds taken from minute 50 of a master
      { kind: 'clip', startSec: 0, endSec: 10, sourcePath: '/tmp/broll.mp4', sourceInSec: 3000 },
    ];
    const spine = buildVideoSpine(tl, GRID);

    expect(spine.inputs[0]!.args).toEqual(['-ss', '3000', '-i', '/tmp/broll.mp4']);
    // -ss must PRECEDE -i: as an output option it would decode the fifty minutes anyway.
    expect(spine.inputs[0]!.args.indexOf('-ss')).toBeLessThan(spine.inputs[0]!.args.indexOf('-i'));
    // The seek IS the in-point, so the branch trims from its own zero — one rounding, not two.
    expect(spine.graph).toContain('[src0]trim=start=0:end=10,setpts=PTS-STARTPTS,');
    // Everything downstream of the trim is untouched: the length still comes from the WINDOW.
    expect(spine.graph).toContain('tpad=stop_mode=clone:stop_duration=0.066667,trim=end=10,');
    expect(spine.totalSec).toBe(10);
    expect(spine.frameCount).toBe(300);
  });

  it('does NOT seek an off-grid in-point differently — the seek is whatever the plan asked for', () => {
    // resolvePlan maps a base window's source position from ABSOLUTE time, so in-points are
    // routinely not multiples of the frame period. The seek must carry the exact value; rounding
    // it here is what re-introduces the frame the double-rounding lost.
    const tl: TimelineWindow[] = [
      { kind: 'video', startSec: 0, endSec: 2, sourcePath: '/tmp/main.mp4', sourceInSec: 20.017 },
    ];
    const spine = buildVideoSpine(tl, GRID);
    expect(spine.inputs[0]!.args).toEqual(['-ss', '20.017', '-i', '/tmp/main.mp4']);
    expect(spine.graph).toContain('[src0]trim=start=0:end=2,');
  });

  it('leaves a SPLIT source unseeked — one input carries one -ss, and a residual trim rounds twice', () => {
    const tl: TimelineWindow[] = [
      { kind: 'video', startSec: 0, endSec: 10, sourcePath: '/tmp/main.mp4', sourceInSec: 600 },
      { kind: 'clip', startSec: 10, endSec: 14, sourcePath: '/tmp/broll.mp4', sourceInSec: 0 },
      { kind: 'video', startSec: 14, endSec: 20, sourcePath: '/tmp/main.mp4', sourceInSec: 614 },
    ];
    const spine = buildVideoSpine(tl, GRID);

    const main = spine.inputs.find((i) => i.args.includes('/tmp/main.mp4'))!;
    expect(main.args).toEqual(['-i', '/tmp/main.mp4']);
    expect(seekOf(main.args, '/tmp/main.mp4')).toBeNull();
    // …and both legs keep addressing absolute source positions, exactly as before.
    expect(spine.graph).toContain('split=2[src0p0][src0p1]');
    expect(spine.graph).toContain('[src0p0]trim=start=600:end=610,');
    expect(spine.graph).toContain('[src0p1]trim=start=614:end=620,');
  });

  it('leaves sources needed from the start alone — no -ss, no rebased trim', () => {
    const tl: TimelineWindow[] = [
      { kind: 'video', startSec: 0, endSec: 3, sourcePath: '/tmp/main.mp4', sourceInSec: 0 },
      { kind: 'sim-capture', startSec: 3, endSec: 5, sourcePath: '/tmp/cap.mp4', sourceInSec: 0.5 },
    ];
    const spine = buildVideoSpine(tl, GRID);
    expect(spine.inputs[0]!.args).toEqual(['-i', '/tmp/main.mp4']);
    expect(spine.inputs[1]!.args).toEqual(['-i', '/tmp/cap.mp4']);
    expect(spine.graph).toContain('[src0]trim=start=0:end=3,');
    expect(spine.graph).toContain('[src1]trim=start=0.5:end=2.5,');
  });

  it('never seeks a looped still or a black filler — those are bounded at the input, not trimmed', () => {
    const tl: TimelineWindow[] = [
      { kind: 'image', startSec: 0, endSec: 2, sourcePath: '/tmp/still.png' },
      { kind: 'poster-fallback', startSec: 2, endSec: 4 },
    ];
    const spine = buildVideoSpine(tl, GRID);
    for (const input of spine.inputs) expect(input.args).not.toContain('-ss');
  });
});

describe('buildAudioMixBatch seeks its inputs too', () => {
  it('emits -ss before -i and zeroes the atrim (every mix input is single-use by construction)', () => {
    const windows: AudioWindow[] = [
      { sourcePath: '/tmp/bed.mp3', startSec: 0, endSec: 8, sourceInSec: 2700 },
    ];
    const g = buildAudioMixBatch(windows, 20, { limiter: true });

    expect(g.inputs[0]!.args).toEqual(['-ss', '2700', '-i', '/tmp/bed.mp3']);
    expect(g.graph).toContain('[0:a]atrim=start=0:end=8,asetpts=PTS-STARTPTS,');
    // The window's own length discipline is unchanged — still one number, still the window.
    expect(g.graph).toContain('apad,atrim=end=8,');
  });

  it('seeks each mix input independently to its own in-point', () => {
    const g = buildAudioMixBatch([
      { sourcePath: '/tmp/take.wav', startSec: 0, endSec: 4, sourceInSec: 900 },
      { sourcePath: '/tmp/bed.mp3', startSec: 4, endSec: 8, sourceInSec: 0 },
    ], 20, { limiter: true });

    expect(g.inputs[0]!.args).toEqual(['-ss', '900', '-i', '/tmp/take.wav']);
    expect(g.inputs[1]!.args).toEqual(['-i', '/tmp/bed.mp3']);
    expect(g.graph).toContain('[0:a]atrim=start=0:end=4,');
    expect(g.graph).toContain('[1:a]atrim=start=0:end=4,');
  });

  it('leaves a near-zero in-point alone', () => {
    const g = buildAudioMixBatch(
      [{ sourcePath: '/tmp/a.wav', startSec: 5, endSec: 9, sourceInSec: 2 }],
      20,
      { limiter: true },
    );
    expect(g.inputs[0]!.args).toEqual(['-i', '/tmp/a.wav']);
    expect(g.graph).toContain('[0:a]atrim=start=2:end=6,');
  });
});
