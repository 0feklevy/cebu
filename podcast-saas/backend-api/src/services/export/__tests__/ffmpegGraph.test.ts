/**
 * Pure graph-builder tests — no ffmpeg, always run.
 *
 * These pin the plan's measured discipline as TEXT properties of the emitted graph:
 * the normalisation chain on every branch, split counts on multiply-consumed
 * sources, apad+atrim from the window (one number), the half-open enable helper,
 * bounded image inputs, amix flags, and the source-level ban on the closed-interval
 * operator (and on the deprecated script-file option spelling).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  enableExpr,
  fmtSec,
  videoNormChain,
  audioNormChain,
  buildVideoSpine,
  buildAudioMixBatch,
  buildSilenceAudio,
  mutedBrollAudit,
  planAudioBatches,
  masterOutputArgs,
  MIX_BATCH,
  REQUIRED_FILTERS,
  TAIL_PAD_FRAMES,
  tailPadSec,
  videoSourcePaths,
  auditSourceShortfall,
  describeShortfall,
  type TimelineWindow,
  type AudioWindow,
} from '../ffmpegGraph.js';
import { EXPORT_GRID } from '../types.js';

const GRID = EXPORT_GRID;

/** The 7-window fixture from the plan doc's shape: main spliced twice (split=2),
 *  a silent capture, an anamorphic b-roll clip, a still, a poster, and a black
 *  poster-fallback. */
function fixtureTimeline(): TimelineWindow[] {
  return [
    { kind: 'video', startSec: 0, endSec: 3, sourcePath: '/tmp/main.mp4', sourceInSec: 0 },
    { kind: 'sim-capture', startSec: 3, endSec: 5, sourcePath: '/tmp/capture.mp4', sourceInSec: 0.5 },
    { kind: 'clip', startSec: 5, endSec: 7, sourcePath: '/tmp/broll.mp4', sourceInSec: 0.5 },
    { kind: 'image', startSec: 7, endSec: 9, sourcePath: '/tmp/still.png' },
    { kind: 'poster-fallback', startSec: 9, endSec: 11, sourcePath: '/tmp/poster.png' },
    { kind: 'poster-fallback', startSec: 11, endSec: 12 },
    { kind: 'video', startSec: 12, endSec: 14, sourcePath: '/tmp/main.mp4', sourceInSec: 1 },
  ];
}

describe('enableExpr', () => {
  it('emits the half-open [start, end) form', () => {
    expect(enableExpr(3, 6.5)).toBe('gte(t,3)*lt(t,6.5)');
    expect(enableExpr(0, 1 / 3)).toBe('gte(t,0)*lt(t,0.333333)');
  });

  it('rejects an empty or inverted window', () => {
    expect(() => enableExpr(5, 5)).toThrow(/must be >/);
    expect(() => enableExpr(5, 4)).toThrow(/must be >/);
  });
});

describe('the closed-interval operator is banned from the export modules', () => {
  // The measured seam bug (§5): the closed-interval operator draws BOTH sections on
  // the frame at a shared boundary. The only defence that survives refactoring is a
  // source scan — if anyone swaps enableExpr's implementation, this fails.
  const banned = ['between('];
  // -filter_complex_script is deprecated in ffmpeg 8 (measured); graphs go through
  // the `-/filter_complex` file spelling instead.
  const bannedOptionSpelling = 'filter_complex_script';

  for (const module of ['../ffmpegGraph.ts', '../LinearAssembler.ts', '../resolvePlan.ts']) {
    it(`${module} contains no banned construct`, () => {
      const src = readFileSync(fileURLToPath(new URL(module, import.meta.url)), 'utf8');
      for (const b of banned) expect(src.includes(b), `found "${b}" in ${module}`).toBe(false);
      expect(src.includes(bannedOptionSpelling), `found "${bannedOptionSpelling}" in ${module}`).toBe(false);
    });
  }
});

describe('fmtSec', () => {
  it('emits fixed-point, no exponent, no trailing zeros', () => {
    expect(fmtSec(2)).toBe('2');
    expect(fmtSec(0.5)).toBe('0.5');
    expect(fmtSec(1 / 3)).toBe('0.333333');
    expect(fmtSec(0.0000001)).toBe('0');
    expect(fmtSec(0)).toBe('0');
    expect(fmtSec(14)).toBe('14');
  });

  it('rejects non-finite input', () => {
    expect(() => fmtSec(Number.NaN)).toThrow();
    expect(() => fmtSec(Infinity)).toThrow();
  });
});

describe('buildVideoSpine', () => {
  it('normalises EVERY branch with the measured chain (setsar fix included)', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    const norm = videoNormChain(GRID);
    expect(norm).toContain('scale=trunc(iw*sar/2)*2:ih,setsar=1,');
    expect(norm).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1');
    expect(norm).toContain('fps=30,format=yuv420p,settb=1/30000');
    // 6 input streams: main, capture, broll, still, poster, black — one chain each
    // (the capture source gets the start_time=0 variant, the other five the default).
    expect(spine.graph.split(norm).length - 1).toBe(5);
    expect(spine.graph.split(videoNormChain(GRID, 'capture')).length - 1).toBe(1);
    // the squaring prefix is on all six without exception
    expect(spine.graph.split('scale=trunc(iw*sar/2)*2:ih,setsar=1,').length - 1).toBe(6);
  });

  it('pins start_time=0 on capture branches only (late first frames, sparse VFR)', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    // capture.mp4 is consumed exclusively by the sim-capture window → capture chain
    expect(spine.graph).toMatch(/\[1:v\][^;]*fps=30:start_time=0[^;]*\[src1\]/);
    // the main video branch does NOT get it
    expect(spine.graph).toMatch(/\[0:v\][^;]*,fps=30,[^;]*\[src0\]/);
    expect(videoNormChain(GRID, 'capture')).toContain('fps=30:start_time=0,format=yuv420p');
  });

  it('splits a source consumed by N windows exactly N ways, and only then', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    expect(spine.graph).toContain('split=2[src0p0][src0p1]');
    expect(spine.graph).not.toContain('split=1');
    expect(spine.graph.match(/split=/g)!.length).toBe(1);
    // both consumers trim from their own split leg
    expect(spine.graph).toMatch(/\[src0p0\]trim=start=0:end=3,setpts=PTS-STARTPTS,/);
    expect(spine.graph).toMatch(/\[src0p1\]trim=start=1:end=3,setpts=PTS-STARTPTS,/);
    // single-use sources are consumed directly, no split
    expect(spine.graph).toMatch(/\[src1\]trim=start=0\.5:end=2\.5,setpts=PTS-STARTPTS,/);
  });

  it('trims + resets PTS on every window and concats them in order', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    expect(spine.graph.match(/trim=start=[^,]+,setpts=PTS-STARTPTS,/g)!.length).toBe(7);
    expect(spine.graph).toContain('[w0][w1][w2][w3][w4][w5][w6]concat=n=7:v=1:a=0[vout]');
    expect(spine.outLabel).toBe('[vout]');
    expect(spine.totalSec).toBe(14);
    expect(spine.frameCount).toBe(420);
  });

  it('bounds image inputs at the input: -loop 1 -framerate <grid> -t <dur>', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    const still = spine.inputs.find((i) => i.args.includes('/tmp/still.png'))!;
    expect(still.args).toEqual(['-loop', '1', '-framerate', '30', '-t', '2', '-i', '/tmp/still.png']);
    const poster = spine.inputs.find((i) => i.args.includes('/tmp/poster.png'))!;
    expect(poster.args).toEqual(['-loop', '1', '-framerate', '30', '-t', '2', '-i', '/tmp/poster.png']);
  });

  it('applies a fractional crop to image windows BEFORE the normalise chain', () => {
    const tl: TimelineWindow[] = [
      { kind: 'image', startSec: 0, endSec: 2, sourcePath: '/tmp/still.png', cropFrac: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } },
    ];
    const spine = buildVideoSpine(tl, GRID);
    expect(spine.graph).toContain('[0:v]crop=iw*0.5:ih*0.5:iw*0.1:ih*0.2,scale=trunc(iw*sar/2)*2:ih,');
    expect(() =>
      buildVideoSpine(
        [{ ...tl[0]!, cropFrac: { x: 0.8, y: 0, w: 0.5, h: 1 } }],
        GRID,
      ),
    ).toThrow(/invalid cropFrac/);
  });

  it('renders a poster-fallback window with no poster as bounded black', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    const black = spine.inputs.find((i) => i.args.some((a) => a.startsWith('color=c=black')))!;
    expect(black.args).toEqual(['-f', 'lavfi', '-t', '1', '-i', 'color=c=black:s=1920x1080:r=30']);
  });

  it('refuses gaps, overlaps, and a timeline not starting at 0', () => {
    const base = fixtureTimeline();
    expect(() => buildVideoSpine([], GRID)).toThrow(/empty timeline/);
    expect(() =>
      buildVideoSpine([{ ...base[0]!, startSec: 1, endSec: 3 }], GRID),
    ).toThrow(/contiguous/);
    const gap = fixtureTimeline();
    gap[1] = { ...gap[1]!, startSec: 3.5 };
    expect(() => buildVideoSpine(gap, GRID)).toThrow(/contiguous/);
    const overlap = fixtureTimeline();
    overlap[1] = { ...overlap[1]!, startSec: 2.5 };
    expect(() => buildVideoSpine(overlap, GRID)).toThrow(/contiguous/);
  });

  it('refuses windows without a source (except poster-fallback) and negative in-points', () => {
    expect(() =>
      buildVideoSpine([{ kind: 'video', startSec: 0, endSec: 2 }], GRID),
    ).toThrow(/no sourcePath/);
    expect(() =>
      buildVideoSpine(
        [{ kind: 'video', startSec: 0, endSec: 2, sourcePath: '/tmp/m.mp4', sourceInSec: -1 }],
        GRID,
      ),
    ).toThrow(/negative sourceInSec/);
    expect(() =>
      buildVideoSpine([{ kind: 'video', startSec: 0, endSec: 0, sourcePath: '/tmp/m.mp4' }], GRID),
    ).toThrow(/non-positive duration/);
  });
});

describe('the video spine has a LENGTH GUARANTEE at the tail (media-001)', () => {
  // A real re-encoded file is routinely a frame short of its probed CONTAINER duration:
  // AAC pads the audio track out to a whole packet, so format.duration (what the planner
  // stores) exceeds the video stream by up to ~21ms. Audio already survives that —
  // apad + atrim=end=<window> makes every audio branch a function of ONE number. The video
  // spine had no such guarantee: `trim` can only cut, never extend, so a short source
  // shortened the concat, the master's video stream came out short of its audio, and
  // assertMasterGates rejected the whole export at the stream-agreement gate for a reason
  // no user can act on.
  //
  // The tail therefore HOLDS THE LAST FRAME for a narrow, grid-derived tolerance and is then
  // cut to the window. Narrow is the point: a gap wider than the tolerance still falls
  // through to the gates, so a genuine planning bug is still caught, not papered over.
  const TAIL = '0.066667'; // 2 frames at the 30fps grid

  it('makes every window length a function of the WINDOW alone (tpad + trim=end=<dur>)', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    const durs = [3, 2, 2, 2, 2, 1, 2];
    durs.forEach((dur, i) => {
      expect(spine.graph, `window ${i}`).toContain(
        `,tpad=stop_mode=clone:stop_duration=${TAIL},trim=end=${fmtSec(dur)},setpts=PTS-STARTPTS[w${i}]`,
      );
    });
  });

  it('cuts every branch at a SOURCE-INDEPENDENT point: the last trim carries no start=', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    let checked = 0;
    for (const part of spine.graph.split(';\n')) {
      if (!/\[w\d+\]$/.test(part)) continue;
      checked++;
      const trims = part.match(/trim=[^,[]+/g) ?? [];
      expect(trims.length, part).toBeGreaterThanOrEqual(2);
      expect(trims[trims.length - 1], part).not.toContain('start=');
    }
    expect(checked).toBe(7);
  });

  it('holds the last frame rather than inserting black, and keeps the tolerance narrow', () => {
    const spine = buildVideoSpine(fixtureTimeline(), GRID);
    expect(spine.graph).toContain('stop_mode=clone');   // not tpad's default (black `add`)
    expect(spine.graph).not.toContain('stop_mode=add');
    expect(Number(TAIL)).toBeLessThanOrEqual(2 / GRID.fps + 1e-6);
    expect(Number(TAIL)).toBeGreaterThan(0);
  });

  it('scales the tolerance with the GRID RATE, never with the timeline length', () => {
    const slow = buildVideoSpine(fixtureTimeline(), { w: 1920, h: 1080, fps: 25 });
    expect(slow.graph).toContain('tpad=stop_mode=clone:stop_duration=0.08,'); // 2/25
  });

  it('declares tpad so a deficient ffmpeg build fails fast BY NAME at job start', () => {
    expect(REQUIRED_FILTERS).toContain('tpad');
  });
});

describe('auditSourceShortfall — the tail pad is never silent (media-001)', () => {
  // The tolerance is only defensible if every use of it is visible. The assembler probes
  // each spliced source once and pushes these lines into the export's warnings AND the log.
  const FRAME = 1 / GRID.fps;

  it('reports a one-frame shortfall as absorbed by the tail, naming the window and the deficit', () => {
    // main.mp4 is spliced twice and must reach 3s both times; give it a frame less.
    const probed = new Map([['/tmp/main.mp4', 3 - FRAME]]);
    const found = auditSourceShortfall(fixtureTimeline(), GRID, probed);
    expect(found.map((f) => f.windowIndex)).toEqual([0, 6]);
    expect(found.every((f) => f.padded)).toBe(true);
    expect(found[0]!.shortfallFrames).toBeCloseTo(1, 6);
    const msg = describeShortfall(found[0]!);
    expect(msg).toContain('/tmp/main.mp4');
    expect(msg).toContain('short by 1 frame(s)');
    expect(msg).toContain(`within the ${TAIL_PAD_FRAMES}-frame tail tolerance`);
  });

  it('reports a WIDER gap as a planning bug the gates will still reject', () => {
    const probed = new Map([['/tmp/main.mp4', 2.5]]);
    const found = auditSourceShortfall(fixtureTimeline(), GRID, probed);
    expect(found.length).toBe(2);
    expect(found.some((f) => f.padded)).toBe(false);
    const msg = describeShortfall(found[0]!);
    expect(msg).toContain(`BEYOND the ${TAIL_PAD_FRAMES}-frame tail tolerance`);
    expect(msg).toContain('fail its duration gate');
  });

  it('draws the padded/not-padded line exactly at the tolerance', () => {
    const at = auditSourceShortfall(fixtureTimeline(), GRID, new Map([['/tmp/main.mp4', 3 - 2 * FRAME]]));
    const past = auditSourceShortfall(fixtureTimeline(), GRID, new Map([['/tmp/main.mp4', 3 - 3 * FRAME]]));
    expect(at[0]!.padded).toBe(true);
    expect(past[0]!.padded).toBe(false);
  });

  it('is silent when every source covers its window, and skips sources it was given no probe for', () => {
    expect(auditSourceShortfall(fixtureTimeline(), GRID, new Map([['/tmp/main.mp4', 30]]))).toEqual([]);
    expect(auditSourceShortfall(fixtureTimeline(), GRID, new Map())).toEqual([]);
  });

  it('never audits looped stills — those are bounded at the input, not by their file', () => {
    const probed = new Map([['/tmp/still.png', 0], ['/tmp/poster.png', 0]]);
    expect(auditSourceShortfall(fixtureTimeline(), GRID, probed)).toEqual([]);
  });

  it('videoSourcePaths lists each spliced media file once, in first-use order', () => {
    expect(videoSourcePaths(fixtureTimeline())).toEqual([
      '/tmp/main.mp4', '/tmp/capture.mp4', '/tmp/broll.mp4',
    ]);
  });

  it('publishes the tolerance the spine was built with', () => {
    expect(tailPadSec(GRID)).toBe(TAIL_PAD_FRAMES / GRID.fps);
    expect(buildVideoSpine(fixtureTimeline(), GRID).tailPadSec).toBe(tailPadSec(GRID));
  });
});

describe('buildAudioMixBatch', () => {
  const w: AudioWindow = { sourcePath: '/tmp/a.wav', startSec: 5, endSec: 9, sourceInSec: 2, gainDb: -14 };

  it('derives audio length from the WINDOW alone: apad + atrim=end=<window dur>', () => {
    const g = buildAudioMixBatch([w], 20, { limiter: true });
    // trim the source range, reset, normalise, then pad-and-cut to the window's ONE number
    expect(g.graph).toContain('[0:a]atrim=start=2:end=6,asetpts=PTS-STARTPTS,');
    expect(g.graph).toContain(`${audioNormChain()},apad,atrim=end=4,`);
    expect(g.graph).toContain('volume=-14.00dB,adelay=5000:all=1,apad[a0]');
  });

  it('anchors the mix duration on the FIRST branch only (duration=first must span the total)', () => {
    const g = buildAudioMixBatch([
      w,
      { sourcePath: '/tmp/b.wav', startSec: 12, endSec: 15 },
    ], 20, { limiter: true });
    // branch 0 padded past its window (silence), later branches end at their windows —
    // otherwise amix duration=first truncates everything after input 0's end (measured)
    expect(g.graph).toContain(',adelay=5000:all=1,apad[a0]');
    expect(g.graph).toContain(',adelay=12000:all=1[a1]');
  });

  it('mixes with duration=first, dropout_transition=0 and normalize=0, then pins the total', () => {
    const g = buildAudioMixBatch([w], 20, { limiter: true });
    expect(g.graph).toContain('amix=inputs=1:duration=first:dropout_transition=0:normalize=0[mixed]');
    expect(g.graph).toContain('[mixed]apad,atrim=end=20,alimiter=limit=0.97:level=false[aout]');
  });

  it('omits the limiter on submix passes but still pins the total', () => {
    const g = buildAudioMixBatch([w], 20, { limiter: false });
    expect(g.graph).toContain('[mixed]apad,atrim=end=20[aout]');
    expect(g.graph).not.toContain('alimiter');
  });

  it('omits the volume filter at gain 0 / undefined', () => {
    const g = buildAudioMixBatch([{ sourcePath: '/tmp/a.wav', startSec: 0, endSec: 2 }], 4, { limiter: true });
    expect(g.graph).not.toContain('volume=');
    expect(g.graph).toContain('adelay=0:all=1,apad[a0]');
  });

  it('refuses more than MIX_BATCH inputs per pass', () => {
    const many = Array.from({ length: MIX_BATCH + 1 }, (_, i) => ({
      sourcePath: `/tmp/${i}.wav`, startSec: i, endSec: i + 1,
    }));
    expect(() => buildAudioMixBatch(many, 100, { limiter: true })).toThrow(/MIX_BATCH/);
  });

  it('planAudioBatches chunks at MIX_BATCH', () => {
    const batches = planAudioBatches(Array.from({ length: 100 }, (_, i) => i));
    expect(batches.map((b) => b.length)).toEqual([40, 40, 20]);
    expect(planAudioBatches([])).toEqual([]);
  });
});

describe('buildSilenceAudio (the only permitted synthesized-silence source)', () => {
  it('bounds the lavfi input and pins the total with apad+atrim', () => {
    const g = buildSilenceAudio(20);
    expect(g.inputs).toEqual([{ args: ['-f', 'lavfi', '-t', '20', '-i', 'anullsrc=r=48000:cl=stereo'] }]);
    expect(g.graph).toContain('apad,atrim=end=20[aout]');
  });
});

describe('mutedBrollAudit (b-roll audio parity with the viewer)', () => {
  const timeline = fixtureTimeline().map((w) =>
    w.kind === 'clip' ? { ...w, brollVolume: 0.8 } : w,
  );

  it('warns on a stored broll_volume > 0 without producing audio for it', () => {
    const { mixableAudio, warnings } = mutedBrollAudit(timeline, [
      { sourcePath: '/tmp/main.mp4', startSec: 0, endSec: 3 },
    ]);
    expect(warnings.some((w) => w.includes('broll_volume 0.8'))).toBe(true);
    expect(mixableAudio).toHaveLength(1);
  });

  it('drops an audio window sourced from a clip-only file, with a warning', () => {
    const { mixableAudio, warnings } = mutedBrollAudit(timeline, [
      { sourcePath: '/tmp/main.mp4', startSec: 0, endSec: 3 },
      { sourcePath: '/tmp/broll.mp4', startSec: 5, endSec: 7 },
    ]);
    expect(mixableAudio.map((a) => a.sourcePath)).toEqual(['/tmp/main.mp4']);
    expect(warnings.some((w) => w.includes('dropped from the mix'))).toBe(true);
  });

  it('keeps audio from a file that is ALSO a non-clip window (the main video case)', () => {
    const tl: TimelineWindow[] = [
      { kind: 'video', startSec: 0, endSec: 2, sourcePath: '/tmp/dual.mp4' },
      { kind: 'clip', startSec: 2, endSec: 4, sourcePath: '/tmp/dual.mp4' },
    ];
    const { mixableAudio, warnings } = mutedBrollAudit(tl, [
      { sourcePath: '/tmp/dual.mp4', startSec: 0, endSec: 2 },
    ]);
    expect(mixableAudio).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('is silent when b-roll has no stored volume', () => {
    const { warnings } = mutedBrollAudit(fixtureTimeline(), []);
    expect(warnings).toEqual([]);
  });
});

describe('masterOutputArgs — §7 exactly', () => {
  it('emits the locked flag set', () => {
    expect(masterOutputArgs(GRID)).toEqual([
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-profile:v', 'high',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-crf', '20',
      '-fps_mode', 'cfr',
      '-r', '30',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-flags', '+cgop',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
    ]);
  });
});
