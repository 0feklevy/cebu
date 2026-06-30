import { spawn } from 'child_process';
import { readdir, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { StorageService } from '../storage/StorageService.js';
import { uploadWithFallback } from '../storage/uploadWithFallback.js';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { logger } from '../../lib/logger.js';

interface QualityTier {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  bandwidth: number;   // for master playlist BANDWIDTH attribute
}

const TIERS: QualityTier[] = [
  { name: '360p',  width: 640,  height: 360,  videoBitrate: '500k',  audioBitrate: '96k',  bandwidth: 700000  },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: '1000k', audioBitrate: '128k', bandwidth: 1400000 },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 3200000 },
  { name: '1080p', width: 1920, height: 1080, videoBitrate: '5500k', audioBitrate: '192k', bandwidth: 6000000 },
];

export interface TranscodeResult {
  masterKey: string;
  durationSec: number;
}

export interface TranscodeOpts {
  inputPath: string;
  workDir: string;
  storageKeyPrefix: string;  // e.g. "hls/{videoId}"
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

export async function probeMediaDuration(inputPath: string): Promise<number> {
  return runFfmpegLimited(() => new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet', '-print_format', 'json', '-show_format', inputPath,
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) { resolve(0); return; }
      try {
        const json = JSON.parse(out.join(''));
        resolve(parseFloat(json.format?.duration ?? '0'));
      } catch {
        resolve(0);
      }
    });
  }));
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
      // R2-first with durable local-disk fallback (read-only token → AccessDenied).
      // Locally-stored segments are served via /hls-proxy → /hls-public fallback.
      await uploadWithFallback(`${storagePrefix}/${entry.name}`, data, contentType);
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

  const durationSec = await probeMediaDuration(inputPath);
  logger.info({ durationSec, inputPath }, 'HLS transcode starting');

  for (const tier of TIERS) {
    await onTierStart?.(tier.name);

    const tierDir = join(workDir, tier.name);
    await mkdir(tierDir, { recursive: true });

    const segPattern = join(tierDir, 'seg_%03d.ts');
    const playlistPath = join(tierDir, 'index.m3u8');

    const args = [
      '-i', inputPath,
      '-vf', `scale=${tier.width}:${tier.height}:force_original_aspect_ratio=decrease,pad=${tier.width}:${tier.height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-b:v', tier.videoBitrate,
      '-maxrate', tier.videoBitrate,
      '-bufsize', `${parseInt(tier.videoBitrate.replace('k', ''), 10) * 2}k`,
      '-c:a', 'aac',
      '-b:a', tier.audioBitrate,
      '-ar', '44100',
      '-hls_time', '4',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', segPattern,
      playlistPath,
    ];

    logger.info({ tier: tier.name }, 'ffmpeg transcode pass starting');
    await runProcess('ffmpeg', ['-y', ...args]);
    logger.info({ tier: tier.name }, 'ffmpeg pass complete — uploading segments');

    const tierKey = `${storageKeyPrefix}/${tier.name}/index.m3u8`;
    await uploadDir(tierDir, `${storageKeyPrefix}/${tier.name}`, storage);
    logger.info({ tier: tier.name }, 'tier uploaded to storage');

    await onTierComplete?.(tier.name, tierKey);
  }

  // Build and upload master playlist
  const masterLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '',
    ...TIERS.flatMap((t) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${t.bandwidth},RESOLUTION=${t.width}x${t.height},CODECS="avc1.42e01e,mp4a.40.2"`,
      `${t.name}/index.m3u8`,
    ]),
  ];
  const masterContent = masterLines.join('\n') + '\n';
  const masterKey = `${storageKeyPrefix}/master.m3u8`;
  await uploadWithFallback(masterKey, Buffer.from(masterContent), 'application/vnd.apple.mpegurl');
  logger.info({ masterKey }, 'master playlist uploaded');

  return { masterKey, durationSec };
}
