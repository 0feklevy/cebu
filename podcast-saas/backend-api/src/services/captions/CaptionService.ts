import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import Groq from 'groq-sdk';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { video_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';

const execFileAsync = promisify(execFile);
const inFlight = new Set<string>();
const CAPTION_STATUS = {
  none: 'none',
  processing: 'processing',
  ready: 'ready',
  failed: 'failed',
} as const;
const FAILED_RETRY_MS = 10 * 60 * 1000;
// Groq audio upload limit (~25 MB). 16 kHz mono mp3 ≈ 0.5 MB/min → ~50 min of audio.
const GROQ_MAX_BYTES = 24 * 1024 * 1024;

type VideoRow = typeof video_files.$inferSelect;

function sourceHash(video: VideoRow): string {
  return createHash('sha1')
    .update([
      video.storage_key ?? '',
      video.file_size ?? '',
      video.duration_sec ?? '',
      video.filename ?? '',
    ].join(':'))
    .digest('hex');
}

/** Whether a (re)generation should be skipped. `force` bypasses the ready/failed-window gates. */
function shouldSkip(video: VideoRow, hash: string, force = false): boolean {
  if (force) return false;
  if (video.captions_source_hash !== hash) return false; // source changed → regenerate
  if (video.captions_status === CAPTION_STATUS.ready || video.captions_status === CAPTION_STATUS.processing) return true;
  if (video.captions_status === CAPTION_STATUS.failed) {
    const updatedAt = video.captions_updated_at?.getTime() ?? 0;
    return Date.now() - updatedAt < FAILED_RETRY_MS;
  }
  return false;
}

export function captionPublicUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  const r2Public = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');
  if (process.env.R2_ACCOUNT_ID && r2Public) return `${r2Public}/${key}`;
  const base = process.env.BACKEND_API_URL ?? 'http://localhost:8080';
  return `${base}/local-storage/${key}`;
}

// ── Caption engines ────────────────────────────────────────────────────────────
// Primary: Groq Whisper over HTTPS (works on the managed host; same provider the
// audio ingester already uses). Optional fallback: a local whisper.cpp binary.

type CaptionEngine = 'groq' | 'whisper';

function pickEngine(): CaptionEngine {
  const forced = process.env.CAPTIONS_ENGINE?.toLowerCase();
  if (forced === 'groq' || forced === 'whisper') return forced;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.WHISPER_CPP_MODEL || process.env.WHISPER_MODEL_PATH) return 'whisper';
  throw new Error('No caption engine configured: set GROQ_API_KEY (recommended) or WHISPER_CPP_MODEL.');
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }
function vttTimestamp(sec: number): string {
  const s = Math.max(0, sec);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const t = Math.floor(s);
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}.${pad(ms, 3)}`;
}

interface VttSegment { start: number; end: number; text: string }
function segmentsToVtt(segments: VttSegment[]): string {
  const cues = segments
    .filter((s) => s.text && s.text.trim().length > 0 && Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s, i) => `${i + 1}\n${vttTimestamp(s.start)} --> ${vttTimestamp(Math.max(s.end, s.start + 0.1))}\n${s.text.trim()}`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function normalizeVtt(raw: string): string {
  const body = raw.trimStart();
  return body.startsWith('WEBVTT') ? body : `WEBVTT\n\n${body}`;
}

/** Run ffmpeg to extract mono 16 kHz audio from one input URL into `out`. */
async function ffmpegExtract(inputUrl: string, out: string, format: 'wav' | 'mp3'): Promise<void> {
  const codecArgs = format === 'wav' ? ['-f', 'wav'] : ['-b:a', '64k', '-f', 'mp3'];
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputUrl,
    '-vn', '-ac', '1', '-ar', '16000',
    ...codecArgs, out,
  ], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 });
}

/**
 * Extract audio, trying each candidate input in order (source first, then the HLS
 * stream). The original source can be unavailable (e.g. pruned), but the HLS
 * rendition is always public — so captions stay generatable.
 */
async function extractAudioWithFallback(candidates: string[], workDir: string, format: 'wav' | 'mp3'): Promise<string> {
  const out = join(workDir, `audio.${format}`);
  let lastErr: unknown;
  for (const url of candidates.filter(Boolean)) {
    try {
      await ffmpegExtract(url, out, format);
      return out;
    } catch (err) {
      lastErr = err;
      logger.warn({ err: (err as Error).message?.slice(0, 160) }, '[captions] audio extraction candidate failed, trying next');
    }
  }
  throw new Error(`Could not extract audio from any source (${candidates.length} candidate(s)): ${(lastErr as Error)?.message?.slice(0, 200) ?? 'unknown'}`);
}

/** Groq Whisper → VTT (built from verbose_json segments). */
async function transcribeWithGroq(audioPath: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');
  const { size } = await stat(audioPath);
  if (size > GROQ_MAX_BYTES) {
    throw new Error(`Extracted audio is ${(size / 1048576).toFixed(1)} MB, over the ${GROQ_MAX_BYTES / 1048576} MB transcription limit (video too long for single-shot captioning).`);
  }
  const groq = new Groq({ apiKey });
  const model = process.env.CAPTIONS_GROQ_MODEL || 'whisper-large-v3';
  const file = new File([await readFile(audioPath)], 'audio.mp3', { type: 'audio/mpeg' });
  const language = process.env.WHISPER_CPP_LANGUAGE || process.env.WHISPER_LANGUAGE;
  const res = await groq.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json',
    ...(language ? { language } : {}),
  } as Parameters<typeof groq.audio.transcriptions.create>[0]);

  const segments = (res as unknown as { segments?: VttSegment[]; text?: string }).segments;
  if (Array.isArray(segments) && segments.length > 0) return segmentsToVtt(segments);
  // No timestamps returned → single full-length cue as a last resort.
  const text = (res as unknown as { text?: string }).text?.trim();
  if (text) return `WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n${text}\n`;
  throw new Error('Transcription returned no text');
}

/** Local whisper.cpp → VTT (optional fallback). */
async function transcribeWithWhisperCpp(wavPath: string, workDir: string): Promise<string> {
  const bin = process.env.WHISPER_CPP_BIN || process.env.WHISPER_BIN || 'whisper-cli';
  const model = process.env.WHISPER_CPP_MODEL || process.env.WHISPER_MODEL_PATH || '';
  if (!model) throw new Error('Auto captions need WHISPER_CPP_MODEL set to a local whisper.cpp model path.');
  const outBase = join(workDir, 'captions');
  const args = ['-m', model, '-f', wavPath, '-ovtt', '-of', outBase];
  const language = process.env.WHISPER_CPP_LANGUAGE || process.env.WHISPER_LANGUAGE;
  if (language) args.push('-l', language);
  if (process.env.WHISPER_CPP_THREADS) args.push('-t', process.env.WHISPER_CPP_THREADS);
  await execFileAsync(bin, args, { timeout: 2 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 * 16 });
  return normalizeVtt(await readFile(`${outBase}.vtt`, 'utf8'));
}

async function generateVtt(candidates: string[], workDir: string): Promise<string> {
  const engine = pickEngine();
  const format = engine === 'groq' ? 'mp3' : 'wav';
  const audioPath = await extractAudioWithFallback(candidates, workDir, format);
  return engine === 'groq'
    ? transcribeWithGroq(audioPath)
    : transcribeWithWhisperCpp(audioPath, workDir);
}

async function runCaptionJob(videoId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight.has(videoId)) return;
  inFlight.add(videoId);
  const storage = getStorageAdapter();
  const workDir = await mkdtemp(join(tmpdir(), 'captions-'));

  try {
    const video = await db.query.video_files.findFirst({ where: eq(video_files.id, videoId) });
    if (!video || video.is_broll || !video.storage_key) return;

    const hash = sourceHash(video);
    if (shouldSkip(video, hash, opts.force)) return;

    await db.update(video_files).set({
      captions_status: CAPTION_STATUS.processing,
      captions_error: null,
      captions_source_hash: hash,
      captions_updated_at: new Date(),
    }).where(eq(video_files.id, video.id));

    // Prefer the original source; fall back to the HLS rendition (always public)
    // so captions still generate when the source has been pruned.
    const candidates: string[] = [await storage.getPresignedDownloadUrl(video.storage_key, 3600)];
    const hlsKey = video.hls_master_key ?? video.hls_360p_key;
    if (hlsKey) candidates.push(storage.getPublicUrl(hlsKey));
    const vtt = generateVttValidate(await generateVtt(candidates, workDir));

    const key = `captions/${video.project_id}/${video.id}/${randomUUID()}.vtt`;
    await storage.uploadFile(key, Buffer.from(vtt, 'utf8'), 'text/vtt; charset=utf-8');

    await db.update(video_files).set({
      captions_status: CAPTION_STATUS.ready,
      captions_vtt_key: key,
      captions_error: null,
      captions_source_hash: hash,
      captions_updated_at: new Date(),
    }).where(eq(video_files.id, video.id));
    logger.info({ videoId: video.id }, '[captions] ready');
  } catch (err) {
    const message = (err as Error).message || 'Caption generation failed';
    logger.warn({ videoId, err: message.slice(0, 400) }, '[captions] generation failed');
    await db.update(video_files).set({
      captions_status: CAPTION_STATUS.failed,
      captions_error: message.slice(0, 1000),
      captions_updated_at: new Date(),
    }).where(eq(video_files.id, videoId)).catch(() => {});
  } finally {
    inFlight.delete(videoId);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reject obviously-invalid VTT before persisting (must start with WEBVTT and have a cue). */
function generateVttValidate(vtt: string): string {
  const v = vtt.trimStart();
  if (!v.startsWith('WEBVTT')) throw new Error('Generated captions are not valid WebVTT');
  if (!v.includes('-->')) throw new Error('Generated captions contain no cues');
  return v;
}

/** Await a single caption job (used by retry tooling/scripts; enqueue is fire-and-forget). */
export function runCaptionJobNow(videoId: string, opts: { force?: boolean } = {}): Promise<void> {
  return runCaptionJob(videoId, opts);
}

export function enqueueCaptionsForVideo(video: VideoRow, opts: { force?: boolean } = {}): void {
  if (video.is_broll || !video.storage_key) return;
  const hash = sourceHash(video);
  if (shouldSkip(video, hash, opts.force)) return;
  setImmediate(() => {
    runCaptionJob(video.id, opts).catch((err) => {
      logger.warn({ videoId: video.id, err }, '[captions] background job crashed');
    });
  });
}

export async function enqueueCaptionsForProject(projectId: string, opts: { force?: boolean } = {}): Promise<void> {
  const videos = await db.query.video_files.findMany({ where: eq(video_files.project_id, projectId) });
  for (const video of videos) enqueueCaptionsForVideo(video, opts);
}

export async function getCaptionStatusForProject(projectId: string) {
  const videos = await db.query.video_files.findMany({ where: eq(video_files.project_id, projectId) });
  return {
    segments: videos
      .filter((video) => !video.is_broll)
      .map((video) => ({
        id: video.id,
        status: video.captions_status ?? CAPTION_STATUS.none,
        vtt_url: video.captions_status === CAPTION_STATUS.ready ? captionPublicUrl(video.captions_vtt_key) : null,
        error: video.captions_status === CAPTION_STATUS.failed ? video.captions_error : null,
        updated_at: video.captions_updated_at,
      })),
  };
}

// Exported for tests.
export const __test = { sourceHash, shouldSkip, segmentsToVtt, vttTimestamp, generateVttValidate, pickEngine };
