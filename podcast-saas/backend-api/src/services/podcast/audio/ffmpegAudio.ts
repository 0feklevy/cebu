/**
 * ffmpeg audio primitives for the podcast stitcher. Every spawn goes through
 * runFfmpegLimited (the global concurrency cap). All intermediate audio is
 * 44.1 kHz mono WAV so there is no resample churn until the final encode.
 *
 * The pipeline these compose into (see PodcastRenderer):
 *   decode chunk → measure loudness (per chunk) → extract each line with guard
 *   bands + edge-trim + intra-silence compression + per-chunk gain → place on an
 *   absolute timeline (adelay) → sum (amix normalize=0) over a faint room-tone bed
 *   → limiter → two-pass EBU R128 loudnorm → encode mp4 (AAC mono) + mp3.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { runFfmpegLimited } from '../../ffmpegLimit.js';

export const SAMPLE_RATE = 44100;
const PER_CLIP_TARGET_LUFS = -19;   // pre-mix per-chunk target — leaves overlap headroom
const SILENCE_DB = '-45dB';         // TTS noise floor is near-digital-black; -45 is safe
const EDGE_PAD = 0.045;             // keep 45ms so releases aren't clipped, but less dead air at the seams
// Intra-turn pauses are trimodal in real speech (~150/~500/~1500ms) and the ~500ms
// clause-boundary pause is part of natural rhythm — only true dead air gets squeezed.
const INTRA_MAX_SILENCE = 0.9;      // compress internal gaps longer than this…
const INTRA_KEEP = 0.6;             // …down to this

function ff(args: string[], wantStderr = false): Promise<string> {
  return runFfmpegLimited(() => new Promise<string>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      const stderr = Buffer.concat(err).toString();
      if (code === 0) resolve(wantStderr ? stderr : '');
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
    proc.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('ffmpeg not found on server') : e));
  }));
}

export async function probeDurationMs(path: string): Promise<number> {
  const out = await runFfmpegLimited(() => new Promise<string>((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => code === 0 ? resolve(Buffer.concat(out).toString().trim()) : reject(new Error(`ffprobe ${code}: ${Buffer.concat(err).toString().slice(-300)}`)));
    proc.on('error', reject);
  }));
  const sec = Number(out);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
}

/** Decode any chunk audio (mp3/pcm) to a normalized 44.1 kHz mono WAV. */
export async function decodeToWav(srcPath: string, outWav: string, opts?: { pcm?: boolean; pcmRate?: number }): Promise<void> {
  const inArgs = opts?.pcm
    ? ['-f', 's16le', '-ar', String(opts.pcmRate ?? SAMPLE_RATE), '-ac', '1', '-i', srcPath]
    : ['-i', srcPath];
  await ff([...inArgs, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-y', outWav]);
}

/** Measure integrated loudness (LUFS) of a wav via loudnorm's analysis pass. */
export async function measureLufs(wavPath: string): Promise<number> {
  const stderr = await ff(['-i', wavPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], true);
  const m = stderr.match(/\{[\s\S]*?"input_i"\s*:\s*"(-?[\d.]+)"[\s\S]*?\}/);
  const val = m ? Number(m[1]) : NaN;
  return Number.isFinite(val) ? val : PER_CLIP_TARGET_LUFS;
}

function gainToTarget(measuredLufs: number): number {
  const g = PER_CLIP_TARGET_LUFS - measuredLufs;
  return Math.max(-12, Math.min(12, Number.isFinite(g) ? g : 0)); // clamp
}

export { gainToTarget };

/**
 * Extract one line from a decoded chunk wav: atrim to [start,end] (guard-banded by
 * the caller), then edge-trim leading/internal/trailing silence and apply the
 * chunk's leveling gain. Output is a self-contained 44.1 kHz mono wav.
 */
export async function extractClip(chunkWav: string, outWav: string, startSec: number, endSec: number, gainDb: number): Promise<void> {
  const start = Math.max(0, startSec);
  const dur = Math.max(0.05, endSec - start);
  // 1) leading trim + internal-silence compression (stop_periods=-1), 2) reverse, 3) trailing trim,
  // 4) reverse, 5) gain, 6) micro edge fades (kill clicks at seams — clips now overlap on the
  // timeline for latching, so clean edges matter), 7) format.
  const chain = [
    `atrim=start=${start.toFixed(3)}:duration=${dur.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    `silenceremove=start_periods=1:start_duration=0.02:start_threshold=${SILENCE_DB}:start_silence=${EDGE_PAD}:stop_periods=-1:stop_duration=${INTRA_MAX_SILENCE}:stop_threshold=${SILENCE_DB}:stop_silence=${INTRA_KEEP}:detection=rms`,
    'areverse',
    `silenceremove=start_periods=1:start_duration=0.02:start_threshold=${SILENCE_DB}:start_silence=${EDGE_PAD}:detection=rms`,
    'areverse',
    `volume=${gainDb.toFixed(2)}dB`,
    'afade=t=in:d=0.012,areverse,afade=t=in:d=0.025,areverse',
    `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=mono`,
  ].join(',');
  await ff(['-i', chunkWav, '-af', chain, '-c:a', 'pcm_s16le', '-y', outWav]);
}

export interface TimelineClip {
  path: string;
  delayMs: number;
  gainDb?: number;
  /** Optional PURE in/out trim (ms, source-local) — used by studio exports to honor
   *  user edge-trims. No silence-removal/fades here; clips are already clean. */
  inMs?: number;
  outMs?: number;
}

const MIX_BATCH = 40; // max ffmpeg -i inputs per mix pass (keeps well under any fd limit)

/**
 * Hierarchical mix: places up to `MIX_BATCH` clips per ffmpeg pass so the process
 * never opens ~hundreds of input fds (a long episode has hundreds of turn clips).
 * ≤ MIX_BATCH clips → one pass; otherwise submix batches (no bed/limiter), each
 * spanning the full timeline, then sum the submixes at delay 0 with the bed + limiter.
 */
export async function mixClips(clips: TimelineClip[], totalMs: number, outWav: string, workDir: string, roomTone = true): Promise<void> {
  if (clips.length === 0) throw new Error('mixClips: no clips');
  if (clips.length <= MIX_BATCH) {
    await mixTimeline(clips, totalMs, outWav, { roomTone, limiter: true });
    return;
  }
  const submixes: TimelineClip[] = [];
  for (let i = 0; i < clips.length; i += MIX_BATCH) {
    const sub = join(workDir, `submix_${i}.wav`);
    await mixTimeline(clips.slice(i, i + MIX_BATCH), totalMs, sub, { roomTone: false, limiter: false });
    submixes.push({ path: sub, delayMs: 0 });
  }
  // Submixes already carry absolute timing; sum them (delay 0) with the bed + limiter.
  await mixTimeline(submixes, totalMs, outWav, { roomTone, limiter: true });
}

/**
 * Sum clips onto one absolute timeline in a single ffmpeg graph. Each clip is
 * delayed to its start time and mixed with `normalize=0` (pure summation — no
 * pumping). Optional faint brown-noise bed + limiter. Writes a 44.1 kHz mono wav.
 * Callers with many clips should use `mixClips` (batched) instead.
 */
export async function mixTimeline(
  clips: TimelineClip[], totalMs: number, outWav: string,
  opts: { roomTone?: boolean; limiter?: boolean } = {},
): Promise<void> {
  const roomTone = opts.roomTone ?? true;
  const limiter = opts.limiter ?? true;
  if (clips.length === 0) throw new Error('mixTimeline: no clips');
  const totalSec = (totalMs + 400) / 1000; // small tail
  const inputs: string[] = [];
  clips.forEach((c) => { inputs.push('-i', c.path); });

  const parts: string[] = [];
  const labels: string[] = [];
  clips.forEach((c, i) => {
    const g = c.gainDb ? `,volume=${c.gainDb.toFixed(2)}dB` : '';
    // Pure user trim (studio edits) — atrim + PTS reset BEFORE the delay placement.
    const trim = c.inMs != null || c.outMs != null
      ? `atrim=start=${((c.inMs ?? 0) / 1000).toFixed(3)}${c.outMs != null ? `:end=${(c.outMs / 1000).toFixed(3)}` : ''},asetpts=PTS-STARTPTS,`
      : '';
    parts.push(`[${i}:a]${trim}aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=mono,adelay=${Math.max(0, Math.round(c.delayMs))}:all=1${g}[c${i}]`);
    labels.push(`[c${i}]`);
  });

  if (roomTone) {
    const bedIdx = clips.length;
    // ~-56dB shared-room bed — inter-turn gaps must never be digitally dead.
    inputs.push('-f', 'lavfi', '-t', totalSec.toFixed(2), '-i', `anoisesrc=color=brown:amplitude=0.0015:sample_rate=${SAMPLE_RATE}`);
    parts.push(`[${bedIdx}:a]aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=mono[bed]`);
    labels.push('[bed]');
  }

  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[mixed]`);
  parts.push(limiter ? '[mixed]alimiter=limit=0.97:level=false[out]' : '[mixed]anull[out]');

  // Write the graph to a file (-filter_complex_script) so a long graph never hits argv limits.
  const graphPath = `${outWav}.graph.txt`;
  await writeFile(graphPath, parts.join(';'));
  await ff([...inputs, '-filter_complex_script', graphPath, '-map', '[out]', '-c:a', 'pcm_s16le', '-y', outWav]);
}

/**
 * Global playback tempo for the final mix (pitch-preserving `atempo`). Owner-tuned:
 * a gentle lift only — the pace mostly comes from the tightened gap engine. 1.18
 * made the naturally-fast learner voice sound sped-up (~1.5x perceived), so the
 * default sits at 1.06. Applied BEFORE loudnorm. Env-tunable via PODCAST_TEMPO.
 */
export const PODCAST_TEMPO = Math.min(1.25, Math.max(0.9, Number(process.env.PODCAST_TEMPO ?? '1.06') || 1.06));

/** Speed the whole mix up/down without changing pitch. No-op copy when factor ≈ 1. */
export async function applyTempo(inWav: string, outWav: string, factor = PODCAST_TEMPO): Promise<void> {
  if (Math.abs(factor - 1) < 0.005) {
    await ff(['-i', inWav, '-c:a', 'pcm_s16le', '-y', outWav]);
    return;
  }
  await ff(['-i', inWav, '-af', `atempo=${factor.toFixed(3)}`, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-y', outWav]);
}

/** Two-pass EBU R128 loudnorm to the podcast standard (I=-16, TP=-1.5, LRA=11). */
export async function loudnormTwoPass(inWav: string, outWav: string): Promise<void> {
  const stderr = await ff(['-i', inWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], true);
  const j = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  let measured: { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string } | null;
  try { measured = j ? JSON.parse(j[0]) : null; } catch { measured = null; }

  if (measured) {
    const af = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
    await ff(['-i', inWav, '-af', af, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-y', outWav]);
  } else {
    // Fallback: single-pass (dynamic) if the measure JSON couldn't be parsed.
    await ff(['-i', inWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-y', outWav]);
  }
}

/** Encode the final wav as a single-channel MP4 (AAC mono, faststart) — the deliverable. */
export async function encodeMp4(inWav: string, outPath: string): Promise<void> {
  await ff(['-i', inWav, '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-ar', String(SAMPLE_RATE), '-movflags', '+faststart', '-y', outPath]);
}

/** Encode a bonus MP3 (mono, 96k). */
export async function encodeMp3(inWav: string, outPath: string): Promise<void> {
  await ff(['-i', inWav, '-c:a', 'libmp3lame', '-b:a', '96k', '-ac', '1', '-ar', String(SAMPLE_RATE), '-id3v2_version', '3', '-y', outPath]);
}

/** Lossless WAV master (mono s16) — the studio's third export format. */
export async function encodeWav(inWav: string, outPath: string): Promise<void> {
  await ff(['-i', inWav, '-c:a', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-y', outPath]);
}

/**
 * Normalized max-amplitude peaks (0..1) for a clip's waveform preview. Decodes to
 * 8kHz mono PCM and takes the per-block peak. Returns [] on any failure (the UI
 * falls back to a flat block). Mirrors the video pipeline's peaks extractor.
 */
export function extractPeaks(inputPath: string, numPeaks = 200): Promise<number[]> {
  return runFfmpegLimited(() => new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-i', inputPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', () => resolve([]));
    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) { resolve([]); return; }
      const buf = Buffer.concat(chunks);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      if (samples.length === 0) { resolve([]); return; }
      const n = Math.max(1, Math.min(numPeaks, samples.length));
      const block = Math.max(1, Math.floor(samples.length / n));
      const peaks: number[] = [];
      for (let i = 0; i < n; i++) {
        let peak = 0;
        const start = i * block;
        const end = Math.min(start + block, samples.length);
        for (let j = start; j < end; j++) { const a = Math.abs(samples[j]!); if (a > peak) peak = a; }
        peaks.push(peak);
      }
      const max = Math.max(...peaks, 1);
      resolve(peaks.map((p) => Number((p / max).toFixed(3))));
    });
  }));
}
