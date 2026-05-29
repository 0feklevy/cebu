import { createHmac } from 'crypto';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { StorageService } from '../storage/StorageService.js';
import { db } from '../../db/index.js';
import { video_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

export type VideoModel = 'kling' | 'seedance' | 'veo';

export interface GenerationResult {
  status: 'completed' | 'generating' | 'failed';
  videoUrl?: string;
  error?: string;
}

const ENHANCE_SYSTEM_PROMPT = `You are a professional cinematographer and video director. Given a short description and target duration, rewrite it into a detailed video generation prompt.

Include:
- Specific camera movement (push in, dolly, crane, handheld shake, static, orbit, etc.)
- Shot composition (extreme close-up, close-up, medium, wide, aerial, POV, etc.)
- Lighting (golden hour, soft diffused, harsh dramatic, studio, practical lamps, etc.)
- Subject motion details (speed, direction, energy)
- Background/environment atmosphere
- Visual mood and color palette
- Cinematic style (documentary, commercial, cinematic, etc.)

Keep the enhanced prompt under 180 words. Output only the enhanced prompt, no commentary.`;

// ── JWT helper for Kling (HS256) ──────────────────────────────────────────────

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeKlingJwt(accessKey: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }));
  const sig = base64url(
    createHmac('sha256', secretKey).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

// ── VideoGenerationService ────────────────────────────────────────────────────

export class VideoGenerationService {
  constructor(
    private readonly storage: StorageService,
    private readonly anthropicKey: string | null,
    private readonly klingAccessKey: string | null,
    private readonly klingSecretKey: string | null,
    private readonly seedanceKey: string | null,
    private readonly googleAiKey: string | null,
  ) {}

  // ── Prompt enhancement ──────────────────────────────────────────────────────

  async enhancePrompt(prompt: string, durationSec: number): Promise<string> {
    if (!this.anthropicKey) return prompt;
    try {
      const client = new Anthropic({ apiKey: this.anthropicKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        temperature: 0.7,
        system: ENHANCE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Duration: ${durationSec} seconds\nDescription: ${prompt}` }],
      });
      const text = msg.content.find((c) => c.type === 'text');
      return text?.type === 'text' ? text.text.trim() : prompt;
    } catch (err) {
      logger.warn({ err }, 'VideoGenerationService: prompt enhancement failed, using original');
      return prompt;
    }
  }

  // ── Kling ───────────────────────────────────────────────────────────────────

  async submitKling(prompt: string, durationSec: number): Promise<string> {
    if (!this.klingAccessKey || !this.klingSecretKey) {
      throw new Error('Kling API credentials not configured');
    }
    const jwt = makeKlingJwt(this.klingAccessKey, this.klingSecretKey);
    // Kling API only accepts "5" or "10" (as strings)
    const duration = durationSec <= 7 ? '5' : '10';

    const res = await fetch('https://api.klingai.com/v1/videos/text2video', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_name: 'kling-v2-master',
        prompt,
        duration,
        aspect_ratio: '16:9',
      }),
    });
    const text = await res.text();
    let data: { task_id?: string; data?: { task_id?: string }; code?: number; message?: string };
    try { data = JSON.parse(text); } catch { throw new Error(`Kling submit: non-JSON response (${res.status}): ${text.slice(0, 300)}`); }
    const taskId = data.task_id ?? data.data?.task_id;
    if (!res.ok || !taskId) {
      throw new Error(`Kling submit failed: ${data.message ?? res.statusText} (${res.status})`);
    }
    return taskId;
  }

  async pollKling(taskId: string): Promise<GenerationResult> {
    if (!this.klingAccessKey || !this.klingSecretKey) throw new Error('Kling not configured');
    const jwt = makeKlingJwt(this.klingAccessKey, this.klingSecretKey);

    const res = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const text = await res.text();
    let data: {
      data?: {
        task_status?: string;
        task_status_msg?: string;
        task_result?: { videos?: Array<{ url: string }> };
        videos?: Array<{ url: string }>;
      };
    };
    try { data = JSON.parse(text); } catch { return { status: 'generating' }; }

    // Kling response: data.data.task_status, videos at data.data.task_result.videos
    const inner = data.data;
    if (!inner) return { status: 'generating' };
    const st = inner.task_status ?? '';
    if (st === 'succeed' || st === 'completed') {
      const url = inner.task_result?.videos?.[0]?.url ?? inner.videos?.[0]?.url;
      if (!url) return { status: 'failed', error: 'No video URL in Kling response' };
      return { status: 'completed', videoUrl: url };
    }
    if (st === 'failed') return { status: 'failed', error: inner.task_status_msg ?? 'Kling generation failed' };
    return { status: 'generating' };
  }

  // ── Seedance ────────────────────────────────────────────────────────────────

  async submitSeedance(prompt: string, durationSec: number): Promise<string> {
    if (!this.seedanceKey) throw new Error('Seedance API key not configured');
    const duration = Math.min(15, Math.max(4, Math.round(durationSec)));

    const res = await fetch(
      'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.seedanceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'seedance-2.0',
          content: [{ type: 'text', text: prompt }],
          parameters: { duration, aspect_ratio: '16:9', resolution: '1080p' },
        }),
      },
    );
    const data = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !data.id) {
      throw new Error(`Seedance submit failed: ${data.error?.message ?? res.statusText}`);
    }
    return data.id;
  }

  async pollSeedance(taskId: string): Promise<GenerationResult> {
    if (!this.seedanceKey) throw new Error('Seedance not configured');

    const res = await fetch(
      `https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${this.seedanceKey}` } },
    );
    const data = (await res.json()) as {
      status?: string;
      content?: Array<{ video_url?: string }>;
      error?: { message?: string };
    };

    const st = data.status ?? '';
    if (st === 'succeeded' || st === 'Succeeded') {
      const url = data.content?.[0]?.video_url;
      if (!url) return { status: 'failed', error: 'No video URL in Seedance response' };
      return { status: 'completed', videoUrl: url };
    }
    if (st === 'failed' || st === 'Failed') {
      return { status: 'failed', error: data.error?.message ?? 'Seedance generation failed' };
    }
    return { status: 'generating' };
  }

  // ── Veo 3 (raw fetch — SDK hardcodes predictLongRunning which Veo 3 doesn't support) ──

  async submitVeo(prompt: string, durationSec: number): Promise<string> {
    if (!this.googleAiKey) throw new Error('Google AI key not configured');
    const duration = Math.min(8, Math.max(5, Math.round(durationSec)));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-preview:generateVideos?key=${this.googleAiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount: 1,
            durationSeconds: duration,
            aspectRatio: '16:9',
          },
        }),
      },
    );

    const responseText = await res.text();
    if (!res.ok) {
      throw new Error(`Veo submit failed (${res.status}): ${responseText.slice(0, 400)}`);
    }
    let data: { name?: string };
    try { data = JSON.parse(responseText); } catch {
      throw new Error(`Veo submit: non-JSON response: ${responseText.slice(0, 200)}`);
    }
    if (!data.name) throw new Error(`Veo submit: no operation name. Response: ${responseText.slice(0, 200)}`);
    return data.name;
  }

  async pollVeo(operationName: string): Promise<GenerationResult> {
    if (!this.googleAiKey) throw new Error('Google AI key not configured');

    // operationName is the full path returned by generateVideos, e.g. "operations/abc123"
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${this.googleAiKey}`,
    );

    if (!res.ok) {
      const errText = await res.text();
      return { status: 'failed', error: `Veo poll failed (${res.status}): ${errText.slice(0, 200)}` };
    }

    const data = (await res.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: {
        generatedSamples?: Array<{ video?: { uri?: string } }>;
        generatedVideos?:  Array<{ video?: { uri?: string } }>;
      };
    };

    if (data.error) return { status: 'failed', error: data.error.message ?? 'Veo error' };
    if (!data.done)  return { status: 'generating' };

    const uri = data.response?.generatedSamples?.[0]?.video?.uri
             ?? data.response?.generatedVideos?.[0]?.video?.uri;
    if (!uri) return { status: 'failed', error: `No video URI in Veo response: ${JSON.stringify(data.response ?? {}).slice(0, 200)}` };
    return { status: 'completed', videoUrl: uri };
  }

  // ── Unified submit / poll ───────────────────────────────────────────────────

  async submit(model: VideoModel, prompt: string, durationSec: number): Promise<string> {
    if (model === 'kling') return this.submitKling(prompt, durationSec);
    if (model === 'seedance') return this.submitSeedance(prompt, durationSec);
    return this.submitVeo(prompt, durationSec);
  }

  async poll(model: VideoModel, externalTaskId: string): Promise<GenerationResult> {
    if (model === 'kling') return this.pollKling(externalTaskId);
    if (model === 'seedance') return this.pollSeedance(externalTaskId);
    return this.pollVeo(externalTaskId);
  }

  // ── Download and store to R2 ────────────────────────────────────────────────

  async downloadAndStore(
    videoUrl: string,
    projectId: string,
  ): Promise<typeof video_files.$inferSelect> {
    const ext = 'mp4';
    const storageKey = `videos/${projectId}/${randomUUID()}.${ext}`;
    const workDir = await mkdtemp(join(tmpdir(), 'broll-dl-'));
    const tmpFile = join(workDir, `source.${ext}`);

    try {
      const res = await fetch(videoUrl);
      if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
      if (!res.body) throw new Error('No response body');

      // Stream to temp file
      await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tmpFile));

      // Upload to storage
      const { createReadStream, statSync } = await import('fs');
      const fileSize = statSync(tmpFile).size;
      const stream = createReadStream(tmpFile);
      await this.storage.uploadStream(storageKey, stream, 'video/mp4', fileSize);

      // Create video_files record
      const [row] = await db
        .insert(video_files)
        .values({
          project_id: projectId,
          filename: `broll-${Date.now()}.mp4`,
          file_size: fileSize,
          storage_key: storageKey,
          status: 'ready',
          hls_status: 'pending',
          is_broll: true,
        })
        .returning();

      logger.info({ projectId, storageKey, fileSize }, 'B-roll video stored');
      return row;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createVideoGenerationService(storage: StorageService): VideoGenerationService {
  return new VideoGenerationService(
    storage,
    process.env.ANTHROPIC_API_KEY ?? null,
    process.env.KLING_ACCESS_KEY ?? null,
    process.env.KLING_SECRET_KEY ?? null,
    process.env.SEEDANCE_API_KEY ?? null,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
  );
}
