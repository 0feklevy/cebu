/**
 * LinearAssembler — Phase 1 of md-files/LINEAR-VIDEO-EXPORT-PLAN.md ("THE DECISION").
 *
 * Takes a resolved ExportPlan and a work directory and produces `master.mp4`:
 *   1. audio: batched mix passes (MIX_BATCH inputs each, mixClips-style submixes),
 *      then a two-pass linear loudnorm mirroring podcast/audio/ffmpegAudio.ts
 *      (single-pass fallback when the measurement JSON cannot be parsed);
 *   2. video: the measured splice graph from ffmpegGraph.ts, written to a FILE and
 *      passed via `-/filter_complex` (the script-file spelling of old is deprecated
 *      in ffmpeg 8 — measured, plan §5);
 *   3. progress: `-progress pipe:1 -stats_period 1` parsed from STDOUT by line.
 *      `out_time_us` is MICROSECONDS — and so is the value of the `out_time_ms`
 *      key, despite its name (measured, plan §6). Only `out_time_us` is read.
 *   4. cancellation: AbortSignal → SIGTERM, SIGKILL after 5 s. SIGTERM makes ffmpeg
 *      FINALISE the container (measured: exit 255 and a valid, playable, truncated
 *      MP4 — faststart pass included), which is exactly why…
 *   5. …gates, before anything is returned: exit code 0, then ffprobe the master —
 *      duration within one frame of the plan, video/audio stream durations agree
 *      within one frame, h264 High@4.0 yuv420p at the grid rate and size, aac 48 kHz
 *      stereo, and moov-before-mdat (atom order parsed from the file, not inferred).
 *      Any failure throws ExportGateError naming the gate; a path that failed a gate
 *      is never returned.
 *
 * Every spawn goes through runFfmpegLimited (the global FFMPEG_CONCURRENCY cap),
 * spawn arrays only, no shell. The caller owns workDir (mkdtemp/rm-finally, as in
 * runPodcastRender / transcodeToHLS).
 */

import { spawn } from 'child_process';
import { open, writeFile, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import {
  buildVideoSpine,
  buildAudioMixBatch,
  buildSilenceAudio,
  mutedBrollAudit,
  planAudioBatches,
  masterOutputArgs,
  fmtSec,
  MIX_BATCH,
  AUDIO_RATE,
  REQUIRED_FILTERS,
  type ExportGrid,
  type ResolvedAssembly,
  type AudioWindow,
  type BuiltGraph,
} from './ffmpegGraph.js';
import { translateContractPlan } from './resolvePlan.js';
import type { ExportPlan, LinearAssembler } from './types.js';

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

export type GateName =
  | 'ffmpeg-exit'        // an ffmpeg pass exited non-zero
  | 'probe'              // the master could not be probed at all
  | 'duration'           // master duration vs planned timeline, one-frame tolerance
  | 'stream-agreement'   // video vs audio stream durations, one-frame tolerance
  | 'video-format'       // h264 High@4.0 yuv420p, grid size, grid rate
  | 'audio-format'       // aac 48 kHz stereo
  | 'faststart';         // moov must precede mdat

/** A gate failed. `gate` names which one; the master path is never returned past this. */
export class ExportGateError extends Error {
  constructor(readonly gate: GateName, detail: string) {
    super(`export gate "${gate}" failed: ${detail}`);
    this.name = 'ExportGateError';
  }
}

/**
 * The caller aborted the assembly (SIGTERM → SIGKILL escalation already handled).
 * `name` is 'AbortError' because that is the spelling `classifyExportFailure`
 * (ProjectExportService) recognises as "the assembler honoured the AbortSignal" —
 * anything else would classify a clean cancellation as an unknown failure.
 */
export class ExportCancelledError extends Error {
  constructor() {
    super('export assembly cancelled');
    this.name = 'AbortError';
  }
}

const KILL_ESCALATION_MS = 5000;

// ---------------------------------------------------------------------------
// Progress parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Line-oriented parser for `-progress pipe:1` output. Reads ONLY `out_time_us`
 * (microseconds). The `out_time_ms` key carries the SAME microsecond value despite
 * its name — measured in plan §6 (`out_time=00:00:00.500000` → `out_time_ms=500000`)
 * — so a parser treating it as milliseconds reports 1000× too fast. Emits percentages
 * clamped to [0, 100], strictly monotonically increasing; `progress=end` emits 100.
 */
export class ProgressParser {
  private pending = '';
  private lastPct = -1;

  constructor(
    private readonly plannedSec: number,
    private readonly emit: (pct: number) => void,
  ) {}

  feed(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const raw of lines) this.line(raw.trim());
  }

  private line(line: string): void {
    const m = /^out_time_us=(\d+)$/.exec(line);
    if (m) {
      const outSec = Number(m[1]) / 1e6;
      if (this.plannedSec > 0) this.report((outSec / this.plannedSec) * 100);
      return;
    }
    if (line === 'progress=end') this.report(100);
  }

  private report(pct: number): void {
    const clamped = Math.max(0, Math.min(100, pct));
    if (clamped > this.lastPct) {
      this.lastPct = clamped;
      this.emit(clamped);
    }
  }
}

// ---------------------------------------------------------------------------
// Process runners (spawn arrays, no shell, global concurrency cap)
// ---------------------------------------------------------------------------

interface RunFfmpegOpts {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  /** Resolve with stderr text (loudnorm measurement prints its JSON there). */
  wantStderr?: boolean;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

/**
 * Run one ffmpeg pass. Non-zero exit → ExportGateError('ffmpeg-exit') — the plan's
 * gate #1, because a SIGTERM'd encode exits 255 while leaving a VALID truncated MP4
 * behind, so "output exists and parses" must never be the success test.
 */
function runFfmpegPass(args: string[], opts: RunFfmpegOpts = {}): Promise<string> {
  throwIfCancelled(opts.signal);
  return runFfmpegLimited(() => new Promise<string>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    let killTimer: NodeJS.Timeout | null = null;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      proc.kill('SIGTERM'); // ffmpeg finalises the container and exits 255 (measured)
      killTimer = setTimeout(() => proc.kill('SIGKILL'), KILL_ESCALATION_MS);
      killTimer.unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (d: Buffer) => opts.onStdout?.(d.toString()));
    proc.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-16384);
    });
    proc.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      reject((err as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('ffmpeg not found — install ffmpeg on the server')
        : err);
    });
    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted || opts.signal?.aborted) {
        reject(new ExportCancelledError());
      } else if (code === 0) {
        resolve(opts.wantStderr ? stderrTail : '');
      } else {
        reject(new ExportGateError('ffmpeg-exit', `ffmpeg exited ${code}: ${stderrTail.slice(-600)}`));
      }
    });
  }));
}

/** ffprobe → parsed JSON. Any failure is the 'probe' gate. */
function runFfprobeJson(args: string[]): Promise<Record<string, unknown>> {
  return runFfmpegLimited(() => new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    let stderrTail = '';
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2048); });
    proc.on('error', (err) => {
      reject((err as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('ffprobe not found — install ffmpeg on the server')
        : err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new ExportGateError('probe', `ffprobe exited ${code}: ${stderrTail}`));
        return;
      }
      try {
        resolve(JSON.parse(out.join('')) as Record<string, unknown>);
      } catch {
        reject(new ExportGateError('probe', 'ffprobe emitted unparseable JSON'));
      }
    });
  }));
}

// ---------------------------------------------------------------------------
// Filter availability — probed once, at job start (§5: fail fast, not mid-encode)
// ---------------------------------------------------------------------------

/**
 * Parse `ffmpeg -filters` output into the set of available filter names. Lines
 * look like ` .. settb  V->V  Set timebase …` (flags, name, io, description) —
 * ffmpeg 8 prints a two-character flags column, older builds three — and source
 * filters (color, anullsrc) appear in the same listing with a `|->` io shape.
 */
export function parseFfmpegFilters(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\s*[A-Z.]{2,4}\s+(\S+)\s+\S*->/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

let filtersProbe: Promise<Set<string>> | null = null;

/** The build's filter set, probed once per process. */
function probeAvailableFilters(): Promise<Set<string>> {
  filtersProbe ??= runFfmpegLimited(() => new Promise<Set<string>>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.on('error', (err) => {
      filtersProbe = null;
      reject((err as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('ffmpeg not found — install ffmpeg on the server')
        : err);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(parseFfmpegFilters(out.join('')));
      } else {
        filtersProbe = null;
        reject(new Error(`ffmpeg -filters exited ${code}`));
      }
    });
  }));
  return filtersProbe;
}

async function assertRequiredFilters(): Promise<void> {
  const have = await probeAvailableFilters();
  const missing = REQUIRED_FILTERS.filter((f) => !have.has(f));
  if (missing.length > 0) {
    throw new Error(
      `this ffmpeg build is missing required filters: ${missing.join(', ')} — ` +
      'the export cannot run on this machine (probed at job start, before any encode)',
    );
  }
}

// ---------------------------------------------------------------------------
// faststart: top-level atom order, parsed from the file (pure walker, unit-tested)
// ---------------------------------------------------------------------------

export type ReadAt = (position: number, length: number) => Promise<Buffer>;

/**
 * Walk top-level MP4 boxes and return the byte offsets of the first `moov` and the
 * first `mdat`. Handles 64-bit largesize (size==1) and to-end-of-file (size==0)
 * boxes. Only headers are read — the file is never loaded into memory.
 */
export async function findMoovMdatOffsets(
  readAt: ReadAt,
  fileSize: number,
): Promise<{ moov: number | null; mdat: number | null }> {
  let moov: number | null = null;
  let mdat: number | null = null;
  let off = 0;
  while (off + 8 <= fileSize) {
    const hdr = await readAt(off, 16);
    if (hdr.length < 8) break;
    let size: number = hdr.readUInt32BE(0);
    const type = hdr.toString('latin1', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      if (hdr.length < 16) break;
      size = Number(hdr.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      size = fileSize - off;
    }
    if (size < headerLen) {
      throw new ExportGateError('faststart', `invalid mp4: box "${type}" at ${off} declares size ${size}`);
    }
    if (type === 'moov' && moov === null) moov = off;
    if (type === 'mdat' && mdat === null) mdat = off;
    if (moov !== null && mdat !== null) break;
    off += size;
  }
  return { moov, mdat };
}

async function assertFastStart(masterPath: string): Promise<void> {
  const fh = await open(masterPath, 'r');
  try {
    const { size } = await fh.stat();
    const readAt: ReadAt = async (position, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    };
    const { moov, mdat } = await findMoovMdatOffsets(readAt, size);
    if (moov === null || mdat === null) {
      throw new ExportGateError('faststart', `master is missing ${moov === null ? 'moov' : 'mdat'}`);
    }
    if (moov > mdat) {
      throw new ExportGateError('faststart', `moov (@${moov}) sits after mdat (@${mdat}) — not faststart`);
    }
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Master gates
// ---------------------------------------------------------------------------

interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

function parseRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(raw);
  if (!m) return null;
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (den === 0) return null;
  return Number(m[1]) / den;
}

/**
 * The plan's non-negotiable discipline (§6, §9.1–2): assert the finished file against
 * the PLAN, not against "does it parse" — a cancelled encode leaves a valid, playable,
 * truncated MP4 (measured, faststart pass included). Duration is checked FIRST: it is
 * the only gate a SIGTERM-finalised file reliably fails.
 *
 * Exported separately from assemble() so callers (and the cancellation tests) can
 * prove a truncated master is rejected.
 */
export async function assertMasterGates(
  masterPath: string,
  grid: ExportGrid,
  plannedSec: number,
): Promise<{ durationSec: number }> {
  if (!(plannedSec > 0)) throw new Error('assertMasterGates: non-positive planned duration');
  const frameTol = 1 / grid.fps + 1e-3; // one frame, plus float/mux rounding headroom

  const json = await runFfprobeJson(['-show_format', '-show_streams', masterPath]);
  const format = (json.format ?? {}) as { duration?: string };
  const streams = (json.streams ?? []) as ProbedStream[];

  // Gate: container duration within one frame of the planned timeline.
  const duration = parseFloat(format.duration ?? '');
  if (!Number.isFinite(duration)) {
    throw new ExportGateError('duration', `master has no parseable duration (planned ${fmtSec(plannedSec)}s)`);
  }
  if (Math.abs(duration - plannedSec) > frameTol) {
    throw new ExportGateError(
      'duration',
      `master is ${duration.toFixed(6)}s but the plan is ${fmtSec(plannedSec)}s (tolerance ${frameTol.toFixed(4)}s)`,
    );
  }

  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new ExportGateError('video-format', 'master has no video stream');
  if (!a) throw new ExportGateError('audio-format', 'master has no audio stream');

  // Gate: video and audio stream durations agree within one frame (§9.1 — a short
  // audio track desyncs everything after the first silent capture).
  const vDur = parseFloat(v.duration ?? '');
  const aDur = parseFloat(a.duration ?? '');
  if (!Number.isFinite(vDur) || !Number.isFinite(aDur)) {
    throw new ExportGateError('stream-agreement', 'video/audio stream durations are unreadable');
  }
  if (Math.abs(vDur - aDur) > frameTol) {
    throw new ExportGateError(
      'stream-agreement',
      `video ${vDur.toFixed(6)}s vs audio ${aDur.toFixed(6)}s — drift exceeds one frame`,
    );
  }

  // Gate: h264 High@4.0 yuv420p, grid geometry, grid rate (§7).
  const fps = parseRate(v.avg_frame_rate);
  const videoProblems: string[] = [];
  if (v.codec_name !== 'h264') videoProblems.push(`codec ${v.codec_name}`);
  if (v.profile !== 'High') videoProblems.push(`profile ${v.profile}`);
  if (v.level !== 40) videoProblems.push(`level ${v.level}`);
  if (v.pix_fmt !== 'yuv420p') videoProblems.push(`pix_fmt ${v.pix_fmt}`);
  if (v.width !== grid.w || v.height !== grid.h) {
    videoProblems.push(`geometry ${v.width}x${v.height} (grid ${grid.w}x${grid.h})`);
  }
  if (fps === null || Math.abs(fps - grid.fps) > 1e-6) {
    videoProblems.push(`frame rate ${v.avg_frame_rate} (grid ${grid.fps})`);
  }
  if (videoProblems.length > 0) {
    throw new ExportGateError('video-format', videoProblems.join('; '));
  }

  // Gate: aac 48 kHz stereo (§7).
  const audioProblems: string[] = [];
  if (a.codec_name !== 'aac') audioProblems.push(`codec ${a.codec_name}`);
  if (Number(a.sample_rate) !== AUDIO_RATE) audioProblems.push(`sample rate ${a.sample_rate}`);
  if (a.channels !== 2) audioProblems.push(`channels ${a.channels}`);
  if (audioProblems.length > 0) {
    throw new ExportGateError('audio-format', audioProblems.join('; '));
  }

  // Gate: moov before mdat, from the bytes.
  await assertFastStart(masterPath);

  return { durationSec: duration };
}

// ---------------------------------------------------------------------------
// Audio pipeline: batched mixes → two-pass loudnorm (mirrors ffmpegAudio.ts)
// ---------------------------------------------------------------------------

const LOUDNORM_TARGET = 'I=-16:TP=-1.5:LRA=11';

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

async function runGraphToWav(
  built: BuiltGraph,
  graphPath: string,
  outWav: string,
  signal?: AbortSignal,
): Promise<void> {
  await writeFile(graphPath, built.graph);
  await runFfmpegPass([
    ...built.inputs.flatMap((i) => i.args),
    '-/filter_complex', graphPath,
    '-map', built.outLabel,
    '-ar', String(AUDIO_RATE), '-ac', '2', '-c:a', 'pcm_s16le',
    '-y', outWav,
  ], { signal });
}

/**
 * Two-pass EBU R128 loudnorm at 48 kHz stereo — the same measure-then-linear-apply
 * shape as podcast/audio/ffmpegAudio.ts#loudnormTwoPass (which is 44.1 kHz mono and
 * therefore mirrored here rather than reused). Two-pass because single-pass is
 * DYNAMIC and pumps on material that swings narration → sim silence → music
 * (measured, §5); the single-pass form remains the fallback when the measurement
 * JSON cannot be parsed. Output length stays pinned to the plan via apad+atrim.
 */
export async function loudnormTwoPass48kStereo(
  inWav: string,
  outWav: string,
  totalSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const stderr = await runFfmpegPass(
    ['-i', inWav, '-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-'],
    { signal, wantStderr: true },
  );
  const jsonMatch = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  let measured: LoudnormMeasurement | null;
  try {
    measured = jsonMatch ? (JSON.parse(jsonMatch[0]) as LoudnormMeasurement) : null;
  } catch {
    measured = null;
  }
  if (measured && [measured.input_i, measured.input_tp, measured.input_lra, measured.input_thresh, measured.target_offset]
    .some((f) => typeof f !== 'string' || f.length === 0)) {
    measured = null;
  }

  // Digital silence (a project with no audio assets, or nothing above the gate)
  // measures input_i = -inf, which the apply pass REJECTS (measured_I must be in
  // [-99, 0]). There is nothing to normalise — copy through, length still pinned.
  const inputI = measured ? Number(measured.input_i) : NaN;
  const silent = measured !== null && (measured.input_i === '-inf' || (Number.isFinite(inputI) && inputI <= -70));
  // A measurement the apply pass would reject (out-of-range/unparseable numbers)
  // degrades to the single-pass dynamic form, same as ffmpegAudio.loudnormTwoPass.
  if (measured && !silent && !(
    Number.isFinite(inputI) && inputI <= 0 && inputI >= -99 &&
    Number.isFinite(Number(measured.input_tp)) &&
    Number.isFinite(Number(measured.input_lra)) &&
    Number.isFinite(Number(measured.input_thresh)) &&
    Number.isFinite(Number(measured.target_offset))
  )) {
    measured = null;
  }

  const filters = silent
    ? `apad,atrim=end=${fmtSec(totalSec)}`
    : measured
      ? `loudnorm=${LOUDNORM_TARGET}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
        `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}:linear=true,apad,atrim=end=${fmtSec(totalSec)}`
      : `loudnorm=${LOUDNORM_TARGET},apad,atrim=end=${fmtSec(totalSec)}`; // single-pass (dynamic) fallback

  await runFfmpegPass([
    '-i', inWav,
    '-af', filters,
    '-ar', String(AUDIO_RATE), '-ac', '2', '-c:a', 'pcm_s16le',
    '-y', outWav,
  ], { signal });
}

async function buildAudioTrack(
  audio: AudioWindow[],
  totalSec: number,
  workDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const mixWav = join(workDir, 'audio-mix.wav');

  for (const [i, w] of audio.entries()) {
    if (w.endSec > totalSec + 1e-6) {
      throw new Error(
        `assemble: audio window ${i} ends at ${w.endSec}s, past the video timeline end (${totalSec}s)`,
      );
    }
  }

  if (audio.length === 0) {
    // No audio assets anywhere: one bounded silence track (the gates require audio).
    await runGraphToWav(buildSilenceAudio(totalSec), join(workDir, 'audio-mix.graph.txt'), mixWav, signal);
  } else {
    const batches = planAudioBatches(audio);
    if (batches.length === 1) {
      await runGraphToWav(
        buildAudioMixBatch(batches[0]!, totalSec, { limiter: true }),
        join(workDir, 'audio-mix.graph.txt'), mixWav, signal,
      );
    } else {
      // mixClips discipline: submixes spanning the full timeline (no limiter), then
      // one summing pass at delay 0 with the limiter.
      if (batches.length > MIX_BATCH) {
        throw new Error(`assemble: ${audio.length} audio windows exceeds ${MIX_BATCH * MIX_BATCH}`);
      }
      const submixes: AudioWindow[] = [];
      for (const [b, batch] of batches.entries()) {
        const submixWav = join(workDir, `audio-submix-${b}.wav`);
        await runGraphToWav(
          buildAudioMixBatch(batch, totalSec, { limiter: false }),
          join(workDir, `audio-submix-${b}.graph.txt`), submixWav, signal,
        );
        submixes.push({ sourcePath: submixWav, startSec: 0, endSec: totalSec });
      }
      await runGraphToWav(
        buildAudioMixBatch(submixes, totalSec, { limiter: true }),
        join(workDir, 'audio-mix.graph.txt'), mixWav, signal,
      );
    }
  }

  throwIfCancelled(signal);
  const masterWav = join(workDir, 'audio-master.wav');
  await loudnormTwoPass48kStereo(mixWav, masterWav, totalSec, signal);
  return masterWav;
}

// ---------------------------------------------------------------------------
// assembleResolved() — the ffmpeg half, over local files
// ---------------------------------------------------------------------------

export interface AssembleResult {
  /** Absolute path of the gated master. Never returned unless every gate passed. */
  masterPath: string;
  /** Probed container duration (seconds) — already asserted within a frame of the plan. */
  durationSec: number;
  /** Exact frame count the spine was built for: round(totalSec × fps). */
  frameCount: number;
  /**
   * Assembly-time warnings (currently the muted-b-roll audit: stored broll_volume
   * that the export deliberately does not play, and any dropped b-roll audio
   * window). Reconciliation note: upstream should merge these into the export row's
   * plan.warnings for the honest per-warning display.
   */
  warnings: string[];
}

/**
 * Assemble `master.mp4` in workDir from a RESOLVED plan (flattened splice windows
 * over local files — see resolvePlan.ts). This is the ffmpeg half in isolation;
 * the contract-facing entry point is `createLinearAssembler().assemble`, which
 * materialises storage keys and flattens the layered contract timeline first.
 */
export async function assembleResolved(
  plan: ResolvedAssembly,
  workDir: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<AssembleResult> {
  throwIfCancelled(signal);
  if (!plan || !Array.isArray(plan.timeline) || plan.timeline.length === 0) {
    throw new Error('assemble: plan has an empty timeline');
  }
  const grid = plan.grid;
  if (!grid || !(grid.w > 0) || !(grid.h > 0) || !(grid.fps > 0)) {
    throw new Error(`assemble: invalid grid ${JSON.stringify(grid)}`);
  }
  await mkdir(workDir, { recursive: true });

  // Fail-fast preflight (§5): a build missing a filter must refuse the job NOW, by
  // name, never minutes into an encode.
  await assertRequiredFilters();

  // Build the spine FIRST: it validates the timeline and fixes totalSec, and a plan
  // that cannot produce a graph must fail before any ffmpeg time is spent.
  const spine = buildVideoSpine(plan.timeline, grid);
  const totalSec = spine.totalSec;

  // Progress contract: the encode maps onto [0, 99]; 100 is emitted only after every
  // gate has passed — "done" must never precede "verified".
  let lastPct = -1;
  const push = (pct: number) => {
    const v = Math.min(99, pct);
    if (onProgress && v > lastPct) {
      lastPct = v;
      onProgress(v);
    }
  };

  // 1) Audio track (batched mixes → two-pass loudnorm), exactly totalSec long.
  //    B-roll parity first: clip windows contribute NO audio to the mix — the viewer
  //    mutes b-roll, and the export matches the viewer. Stored volumes surface as
  //    warnings, never as sound.
  const { mixableAudio, warnings } = mutedBrollAudit(plan.timeline, plan.audio ?? []);
  const audioWav = await buildAudioTrack(mixableAudio, totalSec, workDir, signal);
  throwIfCancelled(signal);

  // 2) Main encode: graph to a file, `-/filter_complex`, §7 output flags, progress
  //    from stdout.
  const graphPath = join(workDir, 'video-graph.txt');
  await writeFile(graphPath, spine.graph);
  const masterPath = join(workDir, 'master.mp4');
  const audioInputIdx = spine.inputs.length;

  push(0);
  const parser = new ProgressParser(totalSec, push);
  await runFfmpegPass([
    ...spine.inputs.flatMap((i) => i.args),
    '-i', audioWav,
    '-/filter_complex', graphPath,
    '-map', spine.outLabel,
    '-map', `${audioInputIdx}:a`,
    ...masterOutputArgs(grid),
    '-progress', 'pipe:1', '-stats_period', '1',
    '-y', masterPath,
  ], { signal, onStdout: (chunk) => parser.feed(chunk) });

  // 3) Gates. Exit 0 already gated by runFfmpegPass; now the file itself.
  const { durationSec } = await assertMasterGates(masterPath, grid, totalSec);

  onProgress?.(100);
  return { masterPath, durationSec, frameCount: spine.frameCount, warnings };
}

// ---------------------------------------------------------------------------
// The contract seam: createLinearAssembler()
// ---------------------------------------------------------------------------

/** The one storage capability the assembler needs — injectable for tests. */
export interface AssemblerStorage {
  readObject(key: string): Promise<Buffer>;
}

/** A storage key's extension, when it is a sane one — ffmpeg sniffs formats from it. */
function extFor(key: string): string {
  const ext = extname(key);
  return /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * The `LinearAssembler` implementation `ProjectExportService.loadAssembler()`
 * expects (services/export/types.ts): consume the CONTRACT plan — storage keys,
 * layered timeline — and produce the gated master:
 *
 *   1. flatten the layered timeline into contiguous splice windows and translate
 *      audio windows (resolvePlan.ts, pure);
 *   2. materialise every referenced storage key under workDir/sources
 *      (source IDENTITY was already re-HEADed by the service's ingest gate);
 *   3. run assembleResolved — the measured graph, the runner, and every gate,
 *      including duration against `plan.totalDurationSec` (the flattened timeline
 *      ends exactly on its frame-snapped value by construction).
 *
 * The returned object satisfies `{ masterPath }`; the extra AssembleResult fields
 * (probed duration, frame count, assembly warnings) ride along for callers that
 * want them — the service currently persists only the plan's own warnings.
 */
export function createLinearAssembler(
  storage: AssemblerStorage = getStorageAdapter(),
): LinearAssembler {
  return {
    async assemble(
      plan: ExportPlan,
      workDir: string,
      onProgress: (pct: number) => void,
      signal: AbortSignal,
    ): Promise<AssembleResult> {
      throwIfCancelled(signal);

      const sourcesDir = join(workDir, 'sources');
      await mkdir(sourcesDir, { recursive: true });
      const keyPaths = new Map<string, string>();
      const localPathOf = (key: string): string => {
        let p = keyPaths.get(key);
        if (!p) {
          p = join(sourcesDir, `s${keyPaths.size}${extFor(key)}`);
          keyPaths.set(key, p);
        }
        return p;
      };

      const translated = translateContractPlan(plan, localPathOf);

      // Materialise sources sequentially — the encode dominates the wall clock, and
      // sequential downloads keep peak memory to one object.
      for (const key of translated.keys) {
        throwIfCancelled(signal);
        const bytes = await storage.readObject(key);
        await writeFile(keyPaths.get(key)!, bytes);
      }

      const result = await assembleResolved(
        { grid: plan.grid, timeline: translated.timeline, audio: translated.audio },
        workDir,
        onProgress,
        signal,
      );
      return { ...result, warnings: [...translated.warnings, ...result.warnings] };
    },
  };
}
