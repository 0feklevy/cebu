import { spawn } from 'child_process';
import { readdir, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { StorageService } from '../storage/StorageService.js';
import { uploadWithFallback } from '../storage/uploadWithFallback.js';
import { HLS_IMMUTABLE_CACHE_CONTROL } from './hlsVersioning.js';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { aspectPreservingFitChain } from '../ffmpegAspect.js';
import { logger } from '../../lib/logger.js';

export interface QualityTier {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  bandwidth: number;   // for master playlist BANDWIDTH attribute
  /** H.264 profile this tier encodes with (and must probe back as — see the conformance gate). */
  profile: 'baseline' | 'main' | 'high';
  /** H.264 level_idc exactly as ffprobe reports it: 30 = 3.0, 31 = 3.1, 40 = 4.0. */
  level: number;
}

/**
 * The tier matrix. Per-tier profile/level instead of the old blanket baseline/3.1:
 * baseline\@3.1 cannot legally carry 1080p at these bitrates (and denied every tier B-frames
 * and CABAC), while the old master playlist claimed avc1.42e01e for all four tiers — a lie
 * players use for codec selection. Resolutions/bitrates/audio are unchanged.
 */
export const TIERS: QualityTier[] = [
  { name: '360p',  width: 640,  height: 360,  videoBitrate: '500k',  audioBitrate: '96k',  bandwidth: 700000,  profile: 'baseline', level: 30 },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: '1000k', audioBitrate: '128k', bandwidth: 1400000, profile: 'main',     level: 31 },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 3200000, profile: 'main',     level: 31 },
  { name: '1080p', width: 1920, height: 1080, videoBitrate: '5500k', audioBitrate: '192k', bandwidth: 6000000, profile: 'high',     level: 40 },
];

/** HLS target segment duration (seconds) — pinned by '-hls_time' and the keyframe cadence. */
const SEGMENT_SEC = 4;

/**
 * How far a single EXTINF may exceed the 4s target before the tier fails conformance.
 * Keyframe-aligned segments land within a frame or two of the target; anything approaching
 * a whole extra GOP (the old 8.3s segments) means keyframe placement is broken.
 */
export const SEGMENT_DURATION_TOLERANCE_SEC = 0.5;

/** Used when the input's frame rate cannot be probed — the GOP maths need SOME cadence. */
export const DEFAULT_INPUT_FPS = 30;

export interface TranscodeResult {
  masterKey: string;
  durationSec: number;
}

export interface TranscodeOpts {
  inputPath: string;
  workDir: string;
  storageKeyPrefix: string;  // e.g. "hls/{videoId}/{runId}" — a versioned, write-once run tree
  storage: StorageService;
  onTierStart?: (tierName: string) => Promise<void>;
  onTierComplete?: (tierName: string, tierKey: string) => Promise<void>;
}

function runProcess(bin: string, args: string[]): Promise<void> {
  return runFfmpegLimited(() => new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));
    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${bin} not found — install ffmpeg on the server`));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${bin} exited with code ${code}\n${stderr.slice(-20).join('')}`));
      }
    });
  }));
}

/** Run ffprobe with `-print_format json` args and return the parsed JSON, or null on any failure. */
function runFfprobeJson(args: string[]): Promise<unknown | null> {
  return runFfmpegLimited(() => new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) { resolve(null); return; }
      try {
        resolve(JSON.parse(out.join('')));
      } catch {
        resolve(null);
      }
    });
  }));
}

/**
 * Parse an ffprobe frame-rate string ("30", "30000/1001") into fps, or null when it does not
 * describe a positive finite rate ("0/0" is ffprobe's spelling of "unknown").
 */
export function parseFrameRate(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const m = raw.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

export interface MediaInfo {
  durationSec: number;
  /** Probed video frame rate; DEFAULT_INPUT_FPS when the input has none we can parse. */
  fps: number;
}

/** Probe the input's container duration AND its video frame rate in one ffprobe call. */
export async function probeMediaInfo(inputPath: string): Promise<MediaInfo> {
  const json = (await runFfprobeJson([
    '-show_format', '-show_streams', '-select_streams', 'v:0', inputPath,
  ])) as {
    format?: { duration?: string };
    streams?: Array<{ avg_frame_rate?: string; r_frame_rate?: string }>;
  } | null;
  const durationSec = parseFloat(json?.format?.duration ?? '0') || 0;
  const stream = json?.streams?.[0];
  const fps =
    parseFrameRate(stream?.avg_frame_rate) ??
    parseFrameRate(stream?.r_frame_rate) ??
    DEFAULT_INPUT_FPS;
  return { durationSec, fps };
}

export async function probeMediaDuration(inputPath: string): Promise<number> {
  const json = (await runFfprobeJson(['-show_format', inputPath])) as
    { format?: { duration?: string } } | null;
  return parseFloat(json?.format?.duration ?? '0') || 0;
}

export interface TierEncodeContext {
  /** Input video frame rate (probed; DEFAULT_INPUT_FPS when unknown). Drives the GOP maths. */
  fps: number;
  /** HLS target segment duration in seconds (SEGMENT_SEC). */
  segmentSec: number;
  inputPath: string;
  /** ffmpeg segment filename pattern, e.g. `{tierDir}/seg_%03d.ts`. */
  segmentPattern: string;
  /** Variant playlist output path, e.g. `{tierDir}/index.m3u8`. */
  playlistPath: string;
}

/**
 * The full ffmpeg argument list for one tier (everything except the leading '-y').
 *
 * GEOMETRY (media-002). The `-vf` comes from the shared `aspectPreservingFitChain`, which
 * squares the pixels BEFORE fitting. Fitting straight onto the coded dimensions — what this
 * builder used to do — computes the fit against the wrong shape AND lets a non-unity input
 * SAR survive into the tier, so an anamorphic source (e.g. 1440x1080 SAR 4:3, DAR 16:9)
 * came out with 160px black pillars each side AND stretched by 4/3 on top. See
 * services/ffmpegAspect.ts for the scale-filter arithmetic; the export path
 * (ffmpegGraph.videoNormChain) has always used this chain, and now both use the same one.
 *
 * GOP alignment is the other load-bearing part: `-g`/`-keyint_min` pin the keyframe cadence to one
 * segment length, `-sc_threshold 0` stops scene-cut keyframes from drifting it,
 * `-force_key_frames` puts a keyframe at every exact multiple of segmentSec regardless of fps
 * rounding, and `+cgop` closes each GOP so a segment never references frames outside itself.
 * Without these, '-hls_time 4' was only a suggestion — the muxer can only cut on keyframes, so
 * segments stretched to wherever the encoder happened to put one (8.3s at default keyint 250).
 */
export function buildTierArgs(tier: QualityTier, ctx: TierEncodeContext): string[] {
  const gop = Math.round(ctx.fps * ctx.segmentSec);
  return [
    '-i', ctx.inputPath,
    '-vf', aspectPreservingFitChain(tier.width, tier.height),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-profile:v', tier.profile,
    '-level', (tier.level / 10).toFixed(1),
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${ctx.segmentSec})`,
    '-flags', '+cgop',
    '-b:v', tier.videoBitrate,
    '-maxrate', tier.videoBitrate,
    '-bufsize', `${parseInt(tier.videoBitrate.replace('k', ''), 10) * 2}k`,
    '-c:a', 'aac',
    '-b:a', tier.audioBitrate,
    '-ar', '44100',
    '-hls_time', String(ctx.segmentSec),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', ctx.segmentPattern,
    ctx.playlistPath,
  ];
}

/**
 * RFC 6381 `avc1.PPCCLL` codec string from what ffprobe reports for an encoded stream.
 * PPCC: 42e0 (Constrained) Baseline, 4d40 Main, 6400 High; LL: level_idc in hex (30 → '1e').
 * Throws on anything else — an unknown profile in the master playlist would be a new lie.
 */
export function avc1CodecString(profile: string, level: number): string {
  const prefix =
    profile === 'Constrained Baseline' || profile === 'Baseline' ? '42e0'
    : profile === 'Main' ? '4d40'
    : profile === 'High' ? '6400'
    : null;
  if (!prefix) throw new Error(`avc1CodecString: unsupported H.264 profile "${profile}"`);
  if (!Number.isInteger(level) || level <= 0 || level > 0xff) {
    throw new Error(`avc1CodecString: H.264 level out of range: ${level}`);
  }
  return `avc1.${prefix}${level.toString(16).padStart(2, '0')}`;
}

/** ffprobe's profile spelling → our tier-matrix vocabulary, or null if unrecognised. */
function normalizeH264Profile(profile: string): QualityTier['profile'] | null {
  if (profile === 'Constrained Baseline' || profile === 'Baseline') return 'baseline';
  if (profile === 'Main') return 'main';
  if (profile === 'High') return 'high';
  return null;
}

export interface PlaylistDurationViolation {
  /** 1-based line number of the offending EXTINF in the playlist text. */
  line: number;
  /** The raw EXTINF line, for error messages. */
  extinf: string;
  /** Parsed duration in seconds, or null when the EXTINF is unparseable (also a violation). */
  durationSec: number | null;
}

/**
 * Every `#EXTINF:` in the playlist whose duration exceeds `maxSegmentSec` (or cannot be
 * parsed at all). Pure text analysis — no ffmpeg — so the conformance gate's segment-length
 * check is unit-testable against fixture playlists.
 */
export function findPlaylistDurationViolations(
  playlistText: string,
  maxSegmentSec: number,
): PlaylistDurationViolation[] {
  const violations: PlaylistDurationViolation[] = [];
  playlistText.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line.startsWith('#EXTINF:')) return;
    const durStr = line.slice('#EXTINF:'.length).split(',')[0]?.trim() ?? '';
    const duration = /^\d+(?:\.\d+)?$/.test(durStr) ? Number(durStr) : null;
    if (duration === null || !Number.isFinite(duration)) {
      violations.push({ line: idx + 1, extinf: line, durationSec: null });
    } else if (duration > maxSegmentSec) {
      violations.push({ line: idx + 1, extinf: line, durationSec: duration });
    }
  });
  return violations;
}

/** The encoded video stream's profile/level, probed from an emitted segment. */
async function probeSegmentProfileLevel(segPath: string): Promise<{ profile: string; level: number }> {
  const json = (await runFfprobeJson(['-select_streams', 'v:0', '-show_streams', segPath])) as
    { streams?: Array<{ profile?: unknown; level?: unknown }> } | null;
  const stream = json?.streams?.[0];
  const profile = typeof stream?.profile === 'string' ? stream.profile : null;
  const level = typeof stream?.level === 'number' ? stream.level : NaN;
  if (!profile || !Number.isFinite(level)) {
    throw new Error(`HLS conformance: could not probe video profile/level from ${segPath}`);
  }
  return { profile, level };
}

/** True when the FIRST frame of the segment is a keyframe (ffprobe reads exactly one frame). */
async function probeFirstFrameIsKeyframe(segPath: string): Promise<boolean> {
  const json = (await runFfprobeJson([
    '-select_streams', 'v:0', '-show_frames', '-read_intervals', '%+#1', segPath,
  ])) as { frames?: Array<{ key_frame?: unknown }> } | null;
  const kf = json?.frames?.[0]?.key_frame;
  return kf === 1 || kf === '1' || kf === true;
}

/**
 * The per-tier conformance gate. Runs after the encode and BEFORE anything of the tier is
 * uploaded (and therefore before the master playlist exists): a violation throws, the job
 * fails, and runVideoTranscode never flips the DB pointer — a non-conformant tree is never
 * the one viewers see. Returns the probed profile/level so the master playlist's CODECS is
 * built from what was OBSERVED, not from what was requested.
 */
async function assertTierConformance(
  tier: QualityTier,
  tierDir: string,
  segmentSec: number,
): Promise<{ profile: string; level: number }> {
  const segPath = join(tierDir, 'seg_000.ts');

  // (i) The emitted stream carries exactly the tier matrix's profile/level.
  const probed = await probeSegmentProfileLevel(segPath);
  if (normalizeH264Profile(probed.profile) !== tier.profile || probed.level !== tier.level) {
    throw new Error(
      `HLS conformance (${tier.name}): encoded as ${probed.profile}@L${probed.level} ` +
      `but the tier matrix requires ${tier.profile}@L${tier.level} — ${segPath}`,
    );
  }

  // (ii) Segments must be independently decodable: the first frame must be a keyframe.
  if (!(await probeFirstFrameIsKeyframe(segPath))) {
    throw new Error(
      `HLS conformance (${tier.name}): first frame of ${segPath} is not a keyframe — ` +
      `segments are not independently decodable`,
    );
  }

  // (iii) Every EXTINF must sit at the 4s target (± a frame), never a whole extra GOP.
  const maxSeg = segmentSec + SEGMENT_DURATION_TOLERANCE_SEC;
  const playlistText = await readFile(join(tierDir, 'index.m3u8'), 'utf8');
  const violations = findPlaylistDurationViolations(playlistText, maxSeg);
  if (violations.length > 0) {
    const first = violations[0]!;
    throw new Error(
      `HLS conformance (${tier.name}): ${violations.length} segment(s) exceed ${maxSeg}s ` +
      `(or have unparseable EXTINF) — first at playlist line ${first.line}: "${first.extinf}"`,
    );
  }

  return probed;
}

// Run `fn` over `items` with at most `limit` in flight, collecting settled results in order.
// Used to bound the HLS segment-upload fan-out: a long video's tier can be ~900 segments, and
// reading+uploading them all at once held ~2.5 GB in heap and risked OOM (perf-002).
async function mapSettledLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let idx = next++; idx < items.length; idx = next++) {
      try { await fn(items[idx]); results[idx] = { status: 'fulfilled', value: undefined }; }
      catch (reason) { results[idx] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function uploadDir(
  dir: string,
  storagePrefix: string,
  storage: StorageService,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  // Bounded fan-out (not Promise.all over every entry): wait for every upload to finish so no
  // in-flight upload races the caller's rm(workDir) cleanup, but cap concurrency so a big tier
  // doesn't buffer hundreds of segments into heap at once (perf-002).
  const results = await mapSettledLimited(entries, 12, async (entry) => {
    if (entry.isDirectory()) {
      await uploadDir(join(dir, entry.name), `${storagePrefix}/${entry.name}`, storage);
    } else {
      const data = await readFile(join(dir, entry.name));
      const contentType = entry.name.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t';
      // Cloud-only upload with retries (uploadWithFallback; a persistent failure throws).
      // Everything under the versioned run prefix (hls/{id}/{runId}/…) is write-once — a
      // re-transcode writes a NEW run tree and flips the DB pointer — so segments and
      // playlists alike carry the immutable Cache-Control.
      await uploadWithFallback(
        `${storagePrefix}/${entry.name}`, data, contentType, HLS_IMMUTABLE_CACHE_CONTROL,
      );
    }
  });
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    const reasons = failed.slice(0, 3).map((r) => String(r.reason)).join('; ');
    throw new Error(`HLS upload failed for ${failed.length}/${results.length} entries in ${storagePrefix}: ${reasons}`);
  }
}

/**
 * Extract 200 normalised RMS waveform peaks from the audio track of a video file.
 * Pipes raw PCM from ffmpeg at 8 kHz mono, computes peak-per-block, normalises to [0, 1].
 * Returns [] if ffmpeg fails or the file has no audio.
 */
export function extractWaveformPeaks(inputPath: string, numPeaks = 200): Promise<number[]> {
  return runFfmpegLimited(() => new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '8000',
      '-ac', '1',
      '-f', 's16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', () => resolve([]));
    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) { resolve([]); return; }
      const raw = Buffer.concat(chunks);
      const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
      if (samples.length === 0) { resolve([]); return; }

      const blockSize = Math.max(1, Math.floor(samples.length / numPeaks));
      const raw_peaks: number[] = [];
      for (let i = 0; i < numPeaks; i++) {
        let peak = 0;
        const start = i * blockSize;
        const end = Math.min(start + blockSize, samples.length);
        for (let j = start; j < end; j++) {
          const abs = Math.abs(samples[j]!);
          if (abs > peak) peak = abs;
        }
        raw_peaks.push(peak);
      }
      const globalMax = Math.max(...raw_peaks, 1);
      resolve(raw_peaks.map(p => p / globalMax));
    });
  }));
}

export async function transcodeToHLS(opts: TranscodeOpts): Promise<TranscodeResult> {
  const { inputPath, workDir, storageKeyPrefix, storage, onTierStart, onTierComplete } = opts;

  const { durationSec, fps } = await probeMediaInfo(inputPath);
  logger.info({ durationSec, fps, inputPath }, 'HLS transcode starting');

  // Per-tier CODECS strings for the master playlist, from PROBED bytes (see the gate).
  const tierCodecs = new Map<string, string>();

  for (const tier of TIERS) {
    await onTierStart?.(tier.name);

    const tierDir = join(workDir, tier.name);
    await mkdir(tierDir, { recursive: true });

    const segPattern = join(tierDir, 'seg_%03d.ts');
    const playlistPath = join(tierDir, 'index.m3u8');

    const args = buildTierArgs(tier, {
      fps, segmentSec: SEGMENT_SEC, inputPath, segmentPattern: segPattern, playlistPath,
    });

    logger.info({ tier: tier.name, fps }, 'ffmpeg transcode pass starting');
    await runProcess('ffmpeg', ['-y', ...args]);

    // Gate BEFORE upload: a non-conformant tier throws here, so nothing of it (and no
    // master) is ever uploaded, and the caller's DB pointer never flips to this run.
    const probed = await assertTierConformance(tier, tierDir, SEGMENT_SEC);
    tierCodecs.set(tier.name, avc1CodecString(probed.profile, probed.level));
    logger.info(
      { tier: tier.name, profile: probed.profile, level: probed.level },
      'ffmpeg pass complete + conformance verified — uploading segments',
    );

    const tierKey = `${storageKeyPrefix}/${tier.name}/index.m3u8`;
    await uploadDir(tierDir, `${storageKeyPrefix}/${tier.name}`, storage);
    logger.info({ tier: tier.name }, 'tier uploaded to storage');

    await onTierComplete?.(tier.name, tierKey);
  }

  // Build and upload master playlist. CODECS comes from the per-tier probe — the master
  // describes what each tier actually contains, never a hard-coded guess.
  const masterLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '',
    ...TIERS.flatMap((t) => {
      const codec = tierCodecs.get(t.name);
      if (!codec) throw new Error(`HLS master: missing probed codec for tier ${t.name}`);
      return [
        `#EXT-X-STREAM-INF:BANDWIDTH=${t.bandwidth},RESOLUTION=${t.width}x${t.height},CODECS="${codec},mp4a.40.2"`,
        `${t.name}/index.m3u8`,
      ];
    }),
  ];
  const masterContent = masterLines.join('\n') + '\n';
  const masterKey = `${storageKeyPrefix}/master.m3u8`;
  // The master lives INSIDE the versioned run tree, so it is write-once too (the mutable
  // pointer is the DB row) — it gets the same immutable Cache-Control as the segments.
  await uploadWithFallback(
    masterKey, Buffer.from(masterContent), 'application/vnd.apple.mpegurl', HLS_IMMUTABLE_CACHE_CONTROL,
  );
  logger.info({ masterKey }, 'master playlist uploaded');

  return { masterKey, durationSec };
}
