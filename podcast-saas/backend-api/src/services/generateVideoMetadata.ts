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
import { readFile } from 'fs/promises';
import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, video_files } from '../db/schema.js';
import { getStorageAdapter } from './storage/getStorageAdapter.js';
import { LocalStorageAdapter } from './storage/LocalStorageAdapter.js';
import { logger } from '../lib/logger.js';

// In-process guard against concurrent runs for the same project.
const _inFlight = new Set<string>();

/** Fire-and-forget entry point — safe to call from runVideoTranscode. */
export function enqueueVideoMetadata(projectId: string, videoFileId: string, opts?: MetadataOptions): void {
  if (_inFlight.has(projectId)) return;
  _inFlight.add(projectId);
  setImmediate(() => {
    generateVideoMetadata(projectId, videoFileId, opts ?? {})
      .catch((err) => logger.warn({ err, projectId }, '[metadata] generation failed'))
      .finally(() => _inFlight.delete(projectId));
  });
}

export interface MetadataOptions {
  promptHint?: string;     // optional context to guide the AI title/description
  model?: 'gpt-4o-mini' | 'gpt-4o'; // override the default model
}

export async function generateVideoMetadata(projectId: string, videoFileId: string, opts: MetadataOptions = {}): Promise<void> {
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
    // ── 1. Download source video ──────────────────────────────────────────────
    const ext = video.storage_key.split('.').pop() ?? 'mp4';
    const srcPath = join(workDir, `source.${ext}`);
    const downloadUrl = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await (await import('fs/promises')).writeFile(srcPath, buf);

    // ── 2. Extract frame at 12% of duration ──────────────────────────────────
    const durationSec = video.duration_sec ?? 30;
    const seekSec = Math.max(1, Math.round(durationSec * 0.12));
    const thumbPath = join(workDir, 'thumb.jpg');
    await extractFrame(srcPath, thumbPath, seekSec);

    // ── 3. Upload thumbnail ───────────────────────────────────────────────────
    const thumbBuf = await readFile(thumbPath);
    const thumbKey = `thumbnails/${projectId}.jpg`;
    let thumbnailUrl: string;
    try {
      thumbnailUrl = await storage.uploadFile(thumbKey, thumbBuf, 'image/jpeg');
    } catch {
      thumbnailUrl = await new LocalStorageAdapter().uploadFile(thumbKey, thumbBuf, 'image/jpeg');
    }

    // ── 4. GPT-4o-mini vision → title + description ───────────────────────────
    let title = project.title?.trim() || null;
    let description = project.topic?.trim() || null;

    const apiKey = process.env.OPENAI_API_KEY;
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
      thumbnail_url:   thumbnailUrl,
      thumbnail_key:   thumbKey,
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
  if (!video?.storage_key) throw new Error('Video not found or not uploaded');

  const workDir = await mkdtemp(join(tmpdir(), 'vthumb-'));
  try {
    const ext = video.storage_key.split('.').pop() ?? 'mp4';
    const srcPath = join(workDir, `source.${ext}`);
    const downloadUrl = await storage.getPresignedDownloadUrl(video.storage_key, 3600);
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    await (await import('fs/promises')).writeFile(srcPath, Buffer.from(await res.arrayBuffer()));

    const thumbPath = join(workDir, 'thumb.jpg');
    await extractFrame(srcPath, thumbPath, Math.max(0, timeSec));

    const thumbBuf = await readFile(thumbPath);
    const thumbKey = `thumbnails/${projectId}.jpg`;
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

// ── ffmpeg frame extractor ─────────────────────────────────────────────────────

function extractFrame(inputPath: string, outputPath: string, seekSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
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
  });
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
