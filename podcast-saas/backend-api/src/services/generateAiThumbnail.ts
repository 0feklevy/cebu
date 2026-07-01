/**
 * Generates a brand-new thumbnail IMAGE for a project with an image model
 * (gpt-image-1, dall-e-3 fallback) — as opposed to extracting a frame from the
 * video. The image prompt is built from everything we already know about the
 * video (title, description/topic, the SEO summary + keywords produced from the
 * transcript) plus an optional creator hint.
 *
 * Requires OPENAI_API_KEY. The result is uploaded under a UNIQUE key so the
 * persisted thumbnail_url changes every time (no stale browser/CDN cache).
 */

import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects } from '../db/schema.js';
import { uploadWithFallback } from './storage/uploadWithFallback.js';
import { MODELS } from './avatar/models.js';
import { logger } from '../lib/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

// gpt-image-1 accepts params (quality:'low'|'medium'|'high', size:'1536x1024')
// not in the openai@4 TS types — call DIRECTLY (preserve `this`) with a cast.
type ImgGenParams = Parameters<typeof openai.images.generate>[0];
async function genImage(params: Record<string, unknown>): Promise<string | undefined> {
  const resp = await openai.images.generate(params as unknown as ImgGenParams);
  return (resp as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json;
}

const THUMB_PROMPT_SYSTEM = `You are a thumbnail art director for educational videos. Given what is known about a video, write ONE image-generation prompt for an eye-catching 16:9 thumbnail that would earn clicks.
Rules:
- Visually capture the video's core subject. Cinematic, high-contrast, vibrant, professional.
- Choose photorealistic OR clean scientific illustration, whichever fits the topic.
- NO text, words, letters, numbers, logos or watermarks in the image. NO realistic human faces.
- Compose for a SMALL thumbnail: one clear focal subject, uncluttered background, bold dramatic lighting.
- Max 800 characters. Respond with ONLY the prompt text — no preamble, no quotes.`;

export interface AiThumbnailOptions {
  hint?: string;        // optional creator guidance for the image
  model?: string;       // override the image model (default gpt-image-1)
}

const YT_THUMB_ENHANCE_SYSTEM = `You are a YouTube thumbnail prompt engineer. Rewrite the creator's idea into ONE vivid image-generation prompt for a scroll-stopping, YouTube-style 16:9 thumbnail.
Rules:
- YouTube thumbnail energy: bold, ultra-high-contrast, vibrant saturated colors, dramatic lighting, strong depth, ONE larger-than-life focal subject, punchy uncluttered composition that reads clearly at tiny size.
- Cinematic photo OR clean illustration, whichever fits the topic; exaggerate scale and drama for clicks.
- Weave in the video's actual subject so the thumbnail is relevant.
- NO text, words, letters, numbers, logos or watermarks in the image. NO realistic human faces.
- Max 800 characters. Respond with ONLY the prompt text — no preamble, no quotes.`;

/**
 * Turn a creator's rough thumbnail idea into an enhanced, YouTube-thumbnail-style image prompt,
 * grounded in what we know about the video. Fast/low model, no extended thinking.
 */
export async function enhanceThumbnailPrompt(projectId: string, userPrompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  const info = project ? [
    project.title ? `Title: ${project.title}` : '',
    project.topic ? `About: ${project.topic}` : '',
    project.seo_description ? `Summary: ${project.seo_description}` : '',
    project.seo_keywords ? `Keywords: ${project.seo_keywords}` : '',
  ].filter(Boolean).join('\n') : '';

  const idea = userPrompt.trim();
  const r = await openai.chat.completions.create({
    model: MODELS.adminPromptBuilder,   // gpt-4.1-mini — fast, no thinking
    max_tokens: 320,
    temperature: 0.8,
    messages: [
      { role: 'system', content: YT_THUMB_ENHANCE_SYSTEM },
      { role: 'user', content: `Video:\n${info || '(unknown)'}\n\nCreator's thumbnail idea: ${idea || '(none — invent a strong one from the video)'}\n\nWrite the enhanced YouTube-thumbnail image prompt.` },
    ],
  });
  return r.choices[0]?.message?.content?.trim() || idea;
}

/** Build a thumbnail image from the video's known info. Returns the public URL. */
export async function generateAiThumbnail(projectId: string, opts: AiThumbnailOptions = {}): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error('Project not found');

  // 1. Everything we know about the video (reuses the transcript→SEO summary).
  const info = [
    project.title ? `Title: ${project.title}` : '',
    project.topic ? `Description: ${project.topic}` : '',
    project.seo_description ? `Summary: ${project.seo_description}` : '',
    project.seo_keywords ? `Keywords: ${project.seo_keywords}` : '',
    opts.hint?.trim() ? `Creator hint: ${opts.hint.trim()}` : '',
  ].filter(Boolean).join('\n');
  const subject = info || `A video titled "${project.title ?? 'Untitled'}"`;

  // 2. Turn that into a strong thumbnail image prompt.
  let imagePrompt = subject;
  try {
    const r = await openai.chat.completions.create({
      model: MODELS.adminPromptBuilder,
      max_tokens: 320,
      temperature: 0.7,
      messages: [
        { role: 'system', content: THUMB_PROMPT_SYSTEM },
        { role: 'user', content: `Write a thumbnail image prompt for this video:\n\n${subject}` },
      ],
    });
    imagePrompt = r.choices[0]?.message?.content?.trim() || subject;
  } catch (err) {
    logger.warn({ err: (err as Error).message, projectId }, '[ai-thumbnail] prompt build failed — using raw info');
  }

  // 3. Generate the image (landscape). gpt-image-1 first, dall-e-3 fallback.
  const model = opts.model || MODELS.imageGeneration;
  let b64: string | undefined;
  try {
    b64 = await genImage({ model, prompt: imagePrompt.slice(0, 4000), quality: 'high', size: '1536x1024', n: 1 });
  } catch (genErr) {
    logger.warn({ err: (genErr as Error).message, projectId }, '[ai-thumbnail] gpt-image-1 failed — falling back to dall-e-3');
    const resp = await openai.images.generate({
      model: 'dall-e-3', prompt: imagePrompt.slice(0, 4000), quality: 'standard', size: '1792x1024', n: 1, response_format: 'b64_json',
    });
    b64 = resp?.data?.[0]?.b64_json;
  }
  if (!b64) throw new Error('Image generation returned no data');

  // 4. Store under a unique key (so the URL changes → no stale cache) + persist.
  const thumbKey = `thumbnails/${projectId}/${randomUUID()}.png`;
  const thumbnailUrl = await uploadWithFallback(thumbKey, Buffer.from(b64, 'base64'), 'image/png');

  await db.update(projects)
    .set({ thumbnail_url: thumbnailUrl, thumbnail_key: thumbKey, metadata_status: 'ready', updated_at: new Date() })
    .where(eq(projects.id, projectId));

  logger.info({ projectId, thumbnailUrl }, '[ai-thumbnail] ✓ generated');
  return thumbnailUrl;
}
