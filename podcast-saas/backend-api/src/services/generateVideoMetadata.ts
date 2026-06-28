/**
 * Auto-generates thumbnail, title, and description for a project's video.
 *
 * Flow (runs in the background after HLS transcoding):
 *   1. Extract a JPEG frame at ~12% of the video duration via ffmpeg.
 *   2. Upload the thumbnail to storage (falls back to local if R2 is denied).
 *   3. Send the frame to GPT-4o-mini vision → get title + description.
 *   4. Update the project row: thumbnail_url, title (if still empty), topic.
 *
 * Requires OPENAI_API_KEY. Skips gracefully when the key is absent.
 */

import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { runFfmpegLimited } from './ffmpegLimit.js';
import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, video_files } from '../db/schema.js';
import { getStorageAdapter } from './storage/getStorageAdapter.js';
import { LocalStorageAdapter } from './storage/LocalStorageAdapter.js';
import { logger } from '../lib/logger.js';
import { enqueueJob } from '../queue/index.js';

// In-process guard against concurrent runs for the same project.
const _inFlight = new Set<string>();

/** Fire-and-forget entry point — safe to call from runVideoTranscode. */
export function enqueueVideoMetadata(projectId: string, videoFileId: string, opts?: MetadataOptions): void {
  enqueueJob('metadata', { projectId, videoFileId, ...(opts ?? {}) });
}

export interface MetadataOptions {
  promptHint?: string;     // optional context to guide the AI title/description
  model?: 'gpt-4o-mini' | 'gpt-4o'; // override the default model
  skipVision?: boolean;    // only grab a placeholder frame (no GPT title/description) — cheap backfill
  force?: boolean;         // explicit user-initiated regenerate: always (re)upload the thumbnail
}

export async function generateVideoMetadata(projectId: string, videoFileId: string, opts: MetadataOptions = {}): Promise<void> {
  // Process-local guard against concurrent runs for the same project; moved here (from the
  // producer) so the queue producer stays a thin enqueue and the dedup follows the job.
  if (_inFlight.has(projectId)) return;
  _inFlight.add(projectId);
  try {
    await generateVideoMetadataInner(projectId, videoFileId, opts);
  } finally {
    _inFlight.delete(projectId);
  }
}

async function generateVideoMetadataInner(projectId: string, videoFileId: string, opts: MetadataOptions = {}): Promise<void> {
  const storage = getStorageAdapter();

  // Get project + first ready video file
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return;

  // Skip if metadata is already ready
  if (project.metadata_status === 'ready') return;

  const video = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
  if (!video?.storage_key) return;

  await db.update(projects).set({ metadata_status: 'processing' }).where(eq(projects.id, projectId));

  const workDir = await mkdtemp(join(tmpdir(), 'vmeta-'));
  try {
    // ── 1. Resolve a frame input — prefer the HLS rendition (always reachable
    //      post-transcode), fall back to the raw source. ffmpeg reads the HTTP
    //      URL directly, so we never depend on the source object still existing
    //      in object storage (which may have gone to local fallback). ──────────
    const hlsKey = video.hls_master_key ?? video.hls_360p_key;
    let inputArg: string;
    if (video.hls_status === 'ready' && hlsKey) {
      inputArg = storage.getPublicUrl(hlsKey);
    } else {
      inputArg = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
    }

    // ── 2. Extract frame at 12% of duration ──────────────────────────────────
    const durationSec = video.duration_sec ?? 30;
    const seekSec = Math.max(1, Math.round(durationSec * 0.12));
    const thumbPath = join(workDir, 'thumb.jpg');
    await extractFrame(inputArg, thumbPath, seekSec);

    // ── 3. Upload thumbnail (placeholder frame) ──────────────────────────────
    // Only auto-set a thumbnail when the user hasn't already provided one — the
    // extracted frame is the placeholder for videos with no custom thumbnail.
    // (The frame is still read here so the vision step can describe the video.)
    const thumbBuf = await readFile(thumbPath);
    // Unique key per write so the persisted thumbnail_url changes every time —
    // otherwise the browser/CDN serves the cached previous image (identical URL).
    const thumbKey = `thumbnails/${projectId}/${randomUUID()}.jpg`;
    const hasUserThumbnail = Boolean(project.thumbnail_url);
    // Re-upload when the user explicitly (re)generated (force), or when there is
    // no thumbnail yet. The auto-on-transcode run (no force) leaves a user
    // thumbnail untouched.
    const shouldWriteThumbnail = opts.force || !hasUserThumbnail;
    let thumbnailUrl: string | null = project.thumbnail_url ?? null;
    if (shouldWriteThumbnail) {
      try {
        thumbnailUrl = await storage.uploadFile(thumbKey, thumbBuf, 'image/jpeg');
      } catch {
        thumbnailUrl = await new LocalStorageAdapter().uploadFile(thumbKey, thumbBuf, 'image/jpeg');
      }
    }

    // ── 4. GPT-4o-mini vision → title + description ───────────────────────────
    let title = project.title?.trim() || null;
    let description = project.topic?.trim() || null;

    const apiKey = opts.skipVision ? undefined : process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        const gptResult = await generateTitleAndDescription(thumbBuf, video.filename, apiKey, opts.promptHint, opts.model);
        // Only set title if not already given by the user
        if (!title && gptResult.title) title = gptResult.title;
        if (gptResult.description) description = gptResult.description;
      } catch (visionErr) {
        logger.warn({ err: visionErr, projectId }, '[metadata] vision failed — using filename');
        if (!title) title = humaniseFilename(video.filename);
      }
    } else {
      if (!title) title = humaniseFilename(video.filename);
    }

    // ── 5. Persist ─────────────────────────────────────────────────────────────
    await db.update(projects).set({
      // Persist the new thumbnail when we actually wrote one (explicit regenerate
      // or first-time auto). Otherwise leave the user's thumbnail untouched.
      ...(shouldWriteThumbnail ? { thumbnail_url: thumbnailUrl, thumbnail_key: thumbKey } : {}),
      metadata_status: 'ready',
      ...(title       ? { title }       : {}),
      ...(description ? { topic: description } : {}),
    }).where(eq(projects.id, projectId));

    logger.info({ projectId, title, thumbnailUrl }, '[metadata] ✓ complete');
  } catch (err) {
    logger.error({ err, projectId }, '[metadata] failed');
    await db.update(projects)
      .set({ metadata_status: 'failed' })
      .where(eq(projects.id, projectId));
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ── thumbnail from timeline (called from controller) ──────────────────────────

export async function extractThumbnailAtTime(
  projectId: string,
  videoFileId: string,
  timeSec: number,
): Promise<string> {
  const storage = getStorageAdapter();
  const video = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
  if (!video) throw new Error('Video not found');

  // Prefer HLS stream (always available post-transcode); ffmpeg reads HTTP URLs natively.
  // Fall back to presigned raw URL if HLS not yet ready.
  const hlsKey = video.hls_master_key ?? video.hls_360p_key;
  let inputArg: string;
  if (video.hls_status === 'ready' && hlsKey) {
    inputArg = storage.getPublicUrl(hlsKey);
  } else if (video.storage_key) {
    inputArg = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
  } else {
    throw new Error('No video source available — wait for transcoding to finish');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'vthumb-'));
  try {
    const thumbPath = join(workDir, 'thumb.jpg');
    await extractFrame(inputArg, thumbPath, Math.max(0, timeSec));

    const thumbBuf = await readFile(thumbPath);
    // Unique key per write so the persisted thumbnail_url changes every time —
    // otherwise the browser/CDN serves the cached previous image (identical URL).
    const thumbKey = `thumbnails/${projectId}/${randomUUID()}.jpg`;
    let thumbnailUrl: string;
    try {
      thumbnailUrl = await storage.uploadFile(thumbKey, thumbBuf, 'image/jpeg');
    } catch {
      thumbnailUrl = await new LocalStorageAdapter().uploadFile(thumbKey, thumbBuf, 'image/jpeg');
    }

    await db.update(projects)
      .set({ thumbnail_url: thumbnailUrl, thumbnail_key: thumbKey })
      .where(eq(projects.id, projectId));

    return thumbnailUrl;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ── frame as buffer (preview only — no storage upload) ────────────────────────

export async function extractFrameAsBuffer(
  videoFileId: string,
  timeSec: number,
): Promise<Buffer> {
  const storage = getStorageAdapter();
  const video = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
  if (!video) throw new Error('Video not found');

  const hlsKey = video.hls_master_key ?? video.hls_360p_key;
  let inputArg: string;
  if (video.hls_status === 'ready' && hlsKey) {
    inputArg = storage.getPublicUrl(hlsKey);
  } else if (video.storage_key) {
    inputArg = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
  } else {
    throw new Error('No video source available — wait for transcoding to finish');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'vprev-'));
  try {
    const framePath = join(workDir, 'preview.jpg');
    await extractFrame(inputArg, framePath, Math.max(0, timeSec));
    return await readFile(framePath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ── ffmpeg frame extractor ─────────────────────────────────────────────────────

function extractFrame(inputPath: string, outputPath: string, seekSec: number): Promise<void> {
  return runFfmpegLimited(() => new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-ss', String(seekSec),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=1280:-2',
      '-q:v', '3',
      outputPath,
      '-loglevel', 'error',
    ]);
    const err: string[] = [];
    proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-3).join('')}`));
    });
    proc.on('error', reject);
  }));
}

// ── GPT-4o-mini vision ────────────────────────────────────────────────────────

async function generateTitleAndDescription(
  thumbBuf: Buffer,
  filename: string,
  apiKey: string,
  promptHint?: string,
  model?: string,
): Promise<{ title: string; description: string }> {
  const client = new OpenAI({ apiKey });
  const b64 = thumbBuf.toString('base64');
  const hintText = promptHint?.trim() ? `\nExtra context from the user: "${promptHint}"` : '';

  const response = await client.chat.completions.create({
    model: model ?? 'gpt-4o-mini',
    max_tokens: 200,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a video content analyzer. Given a video thumbnail frame and filename, ' +
          'generate a concise title and a one-sentence description of what the video is about. ' +
          'Respond ONLY with valid JSON: {"title": string, "description": string}. ' +
          'Title: max 8 words, title-case. Description: max 25 words, plain sentence.' +
          (hintText ? hintText : ''),
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' },
          },
          { type: 'text', text: `Filename: ${filename}` },
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as { title?: string; description?: string };
  return {
    title: (parsed.title ?? '').slice(0, 120).trim(),
    description: (parsed.description ?? '').slice(0, 400).trim(),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────

function humaniseFilename(filename: string): string {
  return (filename ?? '')
    .replace(/\.[^.]+$/, '')           // strip extension
    .replace(/[-_]+/g, ' ')            // dashes/underscores → spaces
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → spaces
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) // Title Case
    .slice(0, 120) || 'Untitled';
}
