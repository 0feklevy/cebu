/**
 * Pure filtergraph builders for the linear video export (Phase 1 of
 * md-files/LINEAR-VIDEO-EXPORT-PLAN.md). No fs, no child_process — everything here
 * is text in, text out, so the graph discipline the plan measured is unit-testable
 * without an encoder:
 *
 *   - ONE normalisation chain applied to EVERY video branch (the measured setsar fix:
 *     square the pixels FIRST, or anamorphic input comes out both pillarboxed and
 *     stretched — §5 of the plan, and a live bug in HLSTranscoder.buildTierArgs).
 *   - Splices via trim/atrim + setpts/asetpts + the concat FILTER, never the concat
 *     demuxer (measured: demuxer + `-c copy` exits 0 with 1.36s of baked-in A/V drift).
 *   - A filter output label may be consumed exactly once, so a source spliced N times
 *     is `split=N` once and trimmed per window.
 *   - Audio length is a function of ONE number (the window) via `apad` + `atrim` —
 *     an under-length source can never shorten the timeline cumulatively (§5).
 *   - Enable expressions come from ONE helper emitting the half-open `[start, end)`
 *     form `gte(t,S)*lt(t,E)`. The closed-interval operator draws BOTH sections on
 *     the frame at a shared boundary (measured: one frame of double-exposure at every
 *     seam), so it is banned from this module — a test scans the source for it.
 *   - `amix` with `normalize=0` (measured: the default made narration 5 dB quieter
 *     when a bed joined) and `dropout_transition=0`, `adelay=…:all=1`.
 */

// ---------------------------------------------------------------------------
// Resolved (assembler-local) shapes.
//
// The CONTRACT plan (services/export/types.ts, sibling-owned) speaks storage keys
// and a LAYERED timeline. resolvePlan.ts flattens and localises it into these
// shapes: contiguous splice windows and mix windows over LOCAL FILES — the level
// this module's graph builders (and their real-encode tests) operate on.
// ---------------------------------------------------------------------------

import type { ExportGrid } from './types.js';

export type { ExportGrid };

export type TimelineWindowKind = 'video' | 'sim-capture' | 'clip' | 'image' | 'poster-fallback';

/** One resolved splice window on the output timeline, absolute times, half-open [startSec, endSec). */
export interface TimelineWindow {
  kind: TimelineWindowKind;
  startSec: number;
  endSec: number;
  /**
   * Local file path of the media for this window. Required for every kind except
   * 'poster-fallback', where its absence means "no poster known" and the window
   * renders as black (degraded loudly in the plan's warnings, never silently).
   */
  sourcePath?: string;
  /** Source-local in-point (seconds) for trimmed video/clip/capture windows. Default 0. */
  sourceInSec?: number;
  /**
   * For 'clip' (b-roll) windows: the stored viewer volume (`broll_volume`), carried
   * for auditing only. B-roll is MUTED in the export — the viewer's b-roll <video>
   * elements carry the `muted` attribute (plan §2), so an export honouring the
   * stored volume would produce audio the product never plays. A stored volume > 0
   * surfaces as a warning, never as sound (see mutedBrollAudit).
   */
  brollVolume?: number;
  /**
   * For 'image' windows: fractional source crop (x/y/w/h in [0,1] of the source
   * frame), applied BEFORE normalisation. v1 renders the cropped still statically —
   * Ken Burns motion is cut by ruling (a warning upstream records that).
   */
  cropFrac?: { x: number; y: number; w: number; h: number };
}

/** One audio asset placed on the absolute output timeline, half-open [startSec, endSec). */
export interface AudioWindow {
  sourcePath: string;
  startSec: number;
  endSec: number;
  /** Source-local in-point (seconds). Default 0. */
  sourceInSec?: number;
  /** Gain applied to this asset window, dB. Default 0 (omit the volume filter). */
  gainDb?: number;
}

/** What the ffmpeg half assembles: the flattened, localised plan (see resolvePlan.ts). */
export interface ResolvedAssembly {
  grid: ExportGrid;
  timeline: TimelineWindow[];
  audio: AudioWindow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max `-i` inputs per audio mix pass — mirrors MIX_BATCH in podcast/audio/ffmpegAudio.ts. */
export const MIX_BATCH = 40;

/** Audio is locked to 48 kHz stereo (§7: every video source here is 48 kHz). */
export const AUDIO_RATE = 48000;

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Seconds → filter-option literal: fixed-point, no exponent, no trailing zeros. */
export function fmtSec(sec: number): string {
  if (!Number.isFinite(sec)) throw new Error(`fmtSec: not a finite number: ${sec}`);
  const s = sec.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * The one place an enable expression is built. Half-open [start, end): the closed
 * interval draws both neighbours on the frame at a shared boundary (measured §5) —
 * never hand-write the closed-interval operator anywhere in this codebase.
 * Not consumed by the Phase-1 spine (which splices, it does not overlay); exported
 * for the Phase-3 overlay stage and to keep the discipline in exactly one helper.
 */
export function enableExpr(startSec: number, endSec: number): string {
  if (!(endSec > startSec)) throw new Error(`enableExpr: end (${endSec}) must be > start (${startSec})`);
  return `gte(t,${fmtSec(startSec)})*lt(t,${fmtSec(endSec)})`;
}

/**
 * The measured normalisation chain, applied to EVERY video branch without exception
 * (§5 / §9.4): square anamorphic pixels first (`scale=trunc(iw*sar/2)*2:ih,setsar=1`),
 * fit + pad onto the grid, pin SAR again (concat silently adopts the first input's SAR),
 * collapse VFR onto the grid rate, one pixel format, one timebase.
 *
 * `capture` branches (sim recordings) pin `start_time=0` on the fps collapse — the
 * 2026-08-13 decision's measured finding: it absorbs sparse-VFR gaps AND a late
 * first frame (MediaRecorder fixtures start as late as 0.3s). A no-op for sources
 * that already start at 0, so it is scoped to capture branches only, exactly as the
 * doc specifies.
 */
export function videoNormChain(grid: ExportGrid, variant: 'default' | 'capture' = 'default'): string {
  const { w, h, fps } = grid;
  const fpsStep = variant === 'capture' ? `fps=${fps}:start_time=0` : `fps=${fps}`;
  return (
    `scale=trunc(iw*sar/2)*2:ih,setsar=1,` +
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
    `${fpsStep},format=yuv420p,settb=1/${fps * 1000}`
  );
}

/** The audio counterpart: healed timestamps, one sample format/rate/layout, one timebase. */
export function audioNormChain(): string {
  return (
    `aresample=async=1:first_pts=0,` +
    `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo,` +
    `asettb=1/${AUDIO_RATE}`
  );
}

// ---------------------------------------------------------------------------
// Graph shapes
// ---------------------------------------------------------------------------

/** One `-i` (or lavfi) input of a built graph, as literal ffmpeg argv fragments. */
export interface GraphInput {
  args: string[];
}

export interface BuiltGraph {
  inputs: GraphInput[];
  /** filter_complex text. Callers write it to a file and pass it via `-/filter_complex`. */
  graph: string;
  /** The single mapped output label, including brackets. */
  outLabel: string;
  totalSec: number;
}

export interface BuiltVideoSpine extends BuiltGraph {
  /** Exact frame count the spine must produce: round(totalSec × fps). */
  frameCount: number;
}

function windowDur(w: { startSec: number; endSec: number }): number {
  return w.endSec - w.startSec;
}

function validateTimeline(timeline: TimelineWindow[]): void {
  if (timeline.length === 0) throw new Error('buildVideoSpine: empty timeline');
  let cursor = 0;
  timeline.forEach((w, i) => {
    if (!(windowDur(w) > EPS)) {
      throw new Error(`buildVideoSpine: window ${i} has non-positive duration [${w.startSec}, ${w.endSec})`);
    }
    if (Math.abs(w.startSec - cursor) > EPS) {
      throw new Error(
        `buildVideoSpine: timeline must be contiguous from 0 — window ${i} starts at ` +
        `${w.startSec} but the previous window ended at ${cursor} (splice model: no gaps, no overlaps)`,
      );
    }
    if (w.kind !== 'poster-fallback' && !w.sourcePath) {
      throw new Error(`buildVideoSpine: window ${i} (kind ${w.kind}) has no sourcePath`);
    }
    if ((w.sourceInSec ?? 0) < 0) {
      throw new Error(`buildVideoSpine: window ${i} has negative sourceInSec`);
    }
    cursor = w.endSec;
  });
}

/**
 * The video spine: every window normalised onto the canonical grid, trimmed, PTS
 * reset, and concat'ed in order. Video-file sources consumed by more than one
 * window share one input and one normalised branch, `split` per consumer.
 *
 * Image-like inputs are BOUNDED at the input (`-loop 1 -framerate <fps> -t <dur>`):
 * a looped image input defaults to 25 fps regardless of the output rate, and an
 * unbounded input decodes for every output frame (both measured, §5).
 */
export function buildVideoSpine(timeline: TimelineWindow[], grid: ExportGrid): BuiltVideoSpine {
  validateTimeline(timeline);
  const norm = videoNormChain(grid);
  const captureNorm = videoNormChain(grid, 'capture');
  const totalSec = timeline[timeline.length - 1]!.endSec;

  const inputs: GraphInput[] = [];
  const parts: string[] = [];

  // Shared inputs for video-file sources (the split=N discipline).
  const videoKinds: TimelineWindowKind[] = ['video', 'clip', 'sim-capture'];
  const sharedUse = new Map<string, number[]>(); // sourcePath → window indices
  timeline.forEach((w, i) => {
    if (videoKinds.includes(w.kind)) {
      const list = sharedUse.get(w.sourcePath!) ?? [];
      list.push(i);
      sharedUse.set(w.sourcePath!, list);
    }
  });

  // window index → label of the normalised branch it trims from
  const branchOf = new Map<number, string>();

  for (const [sourcePath, windows] of sharedUse) {
    const inputIdx = inputs.length;
    inputs.push({ args: ['-i', sourcePath] });
    const srcLabel = `src${inputIdx}`;
    // A source consumed exclusively by sim-capture windows is a recording: it gets
    // the start_time=0 variant of the chain (late first frames, sparse VFR).
    const isCapture = windows.every((wIdx) => timeline[wIdx]!.kind === 'sim-capture');
    parts.push(`[${inputIdx}:v]${isCapture ? captureNorm : norm}[${srcLabel}]`);
    if (windows.length === 1) {
      branchOf.set(windows[0]!, `[${srcLabel}]`);
    } else {
      const splitLabels = windows.map((_, k) => `[${srcLabel}p${k}]`);
      parts.push(`[${srcLabel}]split=${windows.length}${splitLabels.join('')}`);
      windows.forEach((wIdx, k) => branchOf.set(wIdx, splitLabels[k]!));
    }
  }

  // Per-window image/poster/black inputs (bounded per window — durations differ per use).
  timeline.forEach((w, i) => {
    if (videoKinds.includes(w.kind)) return;
    const dur = windowDur(w);
    const inputIdx = inputs.length;
    if (w.sourcePath) {
      inputs.push({ args: ['-loop', '1', '-framerate', String(grid.fps), '-t', fmtSec(dur), '-i', w.sourcePath] });
    } else {
      // poster-fallback with no poster: black, bounded at the input.
      inputs.push({
        args: ['-f', 'lavfi', '-t', fmtSec(dur), '-i', `color=c=black:s=${grid.w}x${grid.h}:r=${grid.fps}`],
      });
    }
    // Fractional source crop (image windows), BEFORE the normalise chain.
    let crop = '';
    if (w.cropFrac) {
      const c = w.cropFrac;
      if (!(c.w > 0) || !(c.h > 0) || c.x < 0 || c.y < 0 || c.x + c.w > 1 + 1e-6 || c.y + c.h > 1 + 1e-6) {
        throw new Error(`buildVideoSpine: window ${i} has an invalid cropFrac ${JSON.stringify(c)}`);
      }
      crop = `crop=iw*${fmtSec(c.w)}:ih*${fmtSec(c.h)}:iw*${fmtSec(c.x)}:ih*${fmtSec(c.y)},`;
    }
    const srcLabel = `src${inputIdx}`;
    parts.push(`[${inputIdx}:v]${crop}${norm}[${srcLabel}]`);
    branchOf.set(i, `[${srcLabel}]`);
  });

  // Trim every window from its (normalised) branch and reset PTS.
  const windowLabels: string[] = [];
  timeline.forEach((w, i) => {
    const from = branchOf.get(i)!;
    const inSec = w.sourceInSec ?? 0;
    const dur = windowDur(w);
    const label = `[w${i}]`;
    parts.push(`${from}trim=start=${fmtSec(inSec)}:end=${fmtSec(inSec + dur)},setpts=PTS-STARTPTS${label}`);
    windowLabels.push(label);
  });

  parts.push(`${windowLabels.join('')}concat=n=${timeline.length}:v=1:a=0[vout]`);

  return {
    inputs,
    graph: parts.join(';\n'),
    outLabel: '[vout]',
    totalSec,
    frameCount: Math.round(totalSec * grid.fps),
  };
}

export interface MutedBrollAudit {
  /** plan.audio minus any window sourced from a clip-only (b-roll) file. */
  mixableAudio: AudioWindow[];
  /** One string per muted-but-stored volume and per dropped audio window. */
  warnings: string[];
}

/**
 * B-roll audio parity (product decision, 2026-08): the viewer mutes b-roll, so the
 * export must too — clip windows contribute NO audio input to the mix graph.
 *
 *   - A 'clip' window carrying a stored broll_volume > 0 yields a WARNING (the fact
 *     is surfaced, never silently absent — plan §2's rule for omissions).
 *   - Defence in depth: an audio window sourced from a file that appears on the
 *     timeline ONLY as 'clip' windows is dropped from the mix, with a warning. A
 *     file that is also a 'video'/'sim-capture' window keeps its audio (the main
 *     video's own track is an audio window over the same file — that is the normal
 *     case, not b-roll).
 *
 * Pure so the parity rule is unit-testable without an encoder. Reconciliation note:
 * if the sibling's exportPlan.ts pre-computes these warnings into plan.warnings,
 * this audit stays as the enforcement backstop (it must never double-mix).
 */
export function mutedBrollAudit(timeline: TimelineWindow[], audio: AudioWindow[]): MutedBrollAudit {
  const kindsBySource = new Map<string, Set<TimelineWindowKind>>();
  for (const w of timeline) {
    if (!w.sourcePath) continue;
    const kinds = kindsBySource.get(w.sourcePath) ?? new Set<TimelineWindowKind>();
    kinds.add(w.kind);
    kindsBySource.set(w.sourcePath, kinds);
  }
  const clipOnlySources = new Set<string>();
  for (const [src, kinds] of kindsBySource) {
    if (kinds.size === 1 && kinds.has('clip')) clipOnlySources.add(src);
  }

  const warnings: string[] = [];
  for (const w of timeline) {
    if (w.kind === 'clip' && (w.brollVolume ?? 0) > 0) {
      warnings.push(
        `b-roll muted: clip window [${fmtSec(w.startSec)}s, ${fmtSec(w.endSec)}s) has stored ` +
        `broll_volume ${w.brollVolume} but the viewer mutes b-roll, and the export matches the viewer`,
      );
    }
  }

  const mixableAudio: AudioWindow[] = [];
  for (const a of audio) {
    if (clipOnlySources.has(a.sourcePath)) {
      warnings.push(
        `b-roll muted: audio window [${fmtSec(a.startSec)}s, ${fmtSec(a.endSec)}s) over b-roll ` +
        `source ${a.sourcePath} was dropped from the mix (viewer parity)`,
      );
    } else {
      mixableAudio.push(a);
    }
  }
  return { mixableAudio, warnings };
}

/** Chunk audio windows into mix passes of at most MIX_BATCH inputs each. */
export function planAudioBatches<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += MIX_BATCH) batches.push(items.slice(i, i + MIX_BATCH));
  return batches;
}

/**
 * One audio mix pass: each asset window is trimmed from its source, normalised,
 * padded-then-trimmed to EXACTLY the window duration (one number — §5's discipline:
 * a short source becomes silence, never a shorter timeline), gained, and delayed to
 * its absolute start. Summed with `amix normalize=0`, then the WHOLE mix is
 * apad+atrim'ed to the planned total so the pass's output length is also a function
 * of one number. Poster/sim windows with no audio asset are silent by construction —
 * no per-window silence source of any kind.
 */
export function buildAudioMixBatch(
  windows: AudioWindow[],
  totalSec: number,
  opts: { limiter: boolean },
): BuiltGraph {
  if (windows.length === 0) throw new Error('buildAudioMixBatch: no audio windows');
  if (windows.length > MIX_BATCH) {
    throw new Error(`buildAudioMixBatch: ${windows.length} windows exceeds MIX_BATCH=${MIX_BATCH} — batch upstream`);
  }
  if (!(totalSec > EPS)) throw new Error('buildAudioMixBatch: non-positive totalSec');

  const anorm = audioNormChain();
  const inputs: GraphInput[] = [];
  const parts: string[] = [];
  const labels: string[] = [];

  windows.forEach((w, i) => {
    const dur = windowDur(w);
    if (!(dur > EPS)) throw new Error(`buildAudioMixBatch: window ${i} has non-positive duration`);
    if (w.startSec < -EPS) throw new Error(`buildAudioMixBatch: window ${i} has negative startSec`);
    inputs.push({ args: ['-i', w.sourcePath] });
    const inSec = w.sourceInSec ?? 0;
    const gain = w.gainDb != null && w.gainDb !== 0 ? `volume=${w.gainDb.toFixed(2)}dB,` : '';
    const delayMs = Math.max(0, Math.round(w.startSec * 1000));
    // The FIRST branch is the mix's duration anchor: `amix duration=first` ends the
    // whole mix when input 0 ends, so branch 0 is apad'ed past its window (silence)
    // and the mix is cut to the total below — still a function of one number. Without
    // this, any asset window past input 0's end is silently truncated away (measured:
    // a cutaway at [8,10) vanished when input 0 ended at 3s).
    const anchor = i === 0 ? ',apad' : '';
    parts.push(
      `[${i}:a]atrim=start=${fmtSec(inSec)}:end=${fmtSec(inSec + dur)},asetpts=PTS-STARTPTS,` +
      `${anorm},apad,atrim=end=${fmtSec(dur)},${gain}adelay=${delayMs}:all=1${anchor}[a${i}]`,
    );
    labels.push(`[a${i}]`);
  });

  parts.push(
    `${labels.join('')}amix=inputs=${windows.length}:duration=first:dropout_transition=0:normalize=0[mixed]`,
  );
  const tail = opts.limiter ? ',alimiter=limit=0.97:level=false' : '';
  parts.push(`[mixed]apad,atrim=end=${fmtSec(totalSec)}${tail}[aout]`);

  return { inputs, graph: parts.join(';\n'), outLabel: '[aout]', totalSec };
}

/**
 * Degenerate case: a project with NO audio assets anywhere still needs an audio
 * stream (the master's gates require aac 48k stereo). One bounded lavfi silence
 * input, then the same apad+atrim single-number discipline. This is the only
 * permitted use of a synthesized-silence source in the export: per-window silence
 * always comes from apad (see buildAudioMixBatch).
 */
export function buildSilenceAudio(totalSec: number): BuiltGraph {
  if (!(totalSec > EPS)) throw new Error('buildSilenceAudio: non-positive totalSec');
  return {
    inputs: [{ args: ['-f', 'lavfi', '-t', fmtSec(totalSec), '-i', `anullsrc=r=${AUDIO_RATE}:cl=stereo`] }],
    graph: `[0:a]${audioNormChain()},apad,atrim=end=${fmtSec(totalSec)}[aout]`,
    outLabel: '[aout]',
    totalSec,
  };
}

/**
 * Every filter (and lavfi source) the graphs in this module can emit, plus the
 * audio pipeline's loudnorm. Probed against `ffmpeg -filters` at job start so a
 * deficient build fails FAST with a named list, not minutes into an encode (§5:
 * "probe filter availability at job start and fail fast").
 */
export const REQUIRED_FILTERS: readonly string[] = [
  // video spine
  'scale', 'setsar', 'pad', 'fps', 'format', 'settb', 'trim', 'setpts', 'split', 'concat', 'crop', 'color',
  // audio mix + master
  'anullsrc', 'aresample', 'aformat', 'asettb', 'atrim', 'asetpts', 'apad', 'adelay', 'volume',
  'amix', 'alimiter', 'loudnorm',
];

/**
 * Output flags for the master encode, exactly per plan §7: the 1080p tier's codec
 * discipline with three deliberate departures (CRF 20 not capped bitrate; 48 kHz not
 * 44100; no -force_key_frames). GOP pinned to 2s at the grid rate.
 */
export function masterOutputArgs(grid: ExportGrid): string[] {
  const gop = grid.fps * 2;
  return [
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-profile:v', 'high',
    '-level', '4.0',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
    '-fps_mode', 'cfr',
    '-r', String(grid.fps),
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-flags', '+cgop',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', String(AUDIO_RATE),
    '-ac', '2',
    '-movflags', '+faststart',
  ];
}
