// Ported from darwin-avatar/server/image/imageService.ts
// Two-stage image pipeline: instant low-quality image returned to the viewer,
// high-quality upgrade stored in the background for future cache hits. All media
// is stored in podcast-saas storage; metadata lives in the avatar_visuals library.
import type OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { avatar_visuals } from '../../db/schema.js';
import { MODELS } from './models.js';
import { findVisual, incrementUseCount, insertVisual, storeImageB64 } from './libraryService.js';
import { getOpenAIClient, isGenerationPaused, recordChatUsage, recordImageUsage } from '../llm/systemAi.js';
import { logger } from '../../lib/logger.js';

// gpt-image-1 supports params (quality:'low'/'high', size:'1536x1024') not in the
// openai@4 TS types. Call the method DIRECTLY (preserving `this`) with the params
// cast — calling a detached `openai.images.generate` reference throws
// "Cannot read properties of undefined (reading '_client')".
type ImgGenParams = Parameters<OpenAI['images']['generate']>[0];
async function genImage(client: OpenAI, params: Record<string, unknown>): Promise<string | undefined> {
  const resp = await client.images.generate(params as unknown as ImgGenParams);
  return (resp as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json;
}

export interface ImageAnalysisResult {
  shouldGenerate: boolean;
  imageUrl: string | null;
  altText: string;
  caption: string;
  imageType: 'realistic' | 'diagram';
}

interface GptClassification {
  should_generate: boolean;
  image_type: 'realistic' | 'diagram';
  caption: string;
  dalle_prompt: string;
}

const REALISTIC_STYLE: Record<string, string> = {
  darwin:     'photorealistic Victorian natural history scene, rich botanical or zoological detail, warm candlelight, mid-19th century aesthetic, highly detailed',
  einstein:   'photorealistic 1950s academic atmosphere, warm incandescent light, scholarly depth of field, highly detailed',
  napoleon:   'dramatic 19th-century French oil painting aesthetic, Napoleonic era, heroic composition, warm oil-paint texture, highly detailed',
  archimedes: 'ancient Greek Mediterranean setting, warm golden-hour sunlight, terracotta and weathered marble, Syracuse coastline, highly detailed',
};

const CHARACTER_KNOWLEDGE: Record<string, string> = {
  darwin:     'Charles Darwin, HMS Beagle voyage, Galápagos Islands, natural selection, finch beak variation, giant tortoises, marine iguanas, On the Origin of Species 1859',
  einstein:   'Albert Einstein, Princeton 1950s, special relativity E=mc², general relativity spacetime curvature, photoelectric effect, Brownian motion, quantum entanglement, thought experiments, chalkboard equations',
  napoleon:   'Napoleon Bonaparte, First French Empire, Napoleonic Wars, Battle of Austerlitz, military campaign maps, Imperial Guard, bicorne hat',
  archimedes: 'Archimedes of Syracuse, 3rd century BCE, lever and fulcrum, Archimedes screw, buoyancy and displacement, parabolic mirrors, siege engines, geometric diagrams',
};

const SYSTEM_PROMPT = `You are a visual content advisor for an educational avatar conversation app. Show a visual for almost every substantive topic discussed.

Respond ONLY with valid JSON — no markdown:
{"should_generate": boolean, "image_type": "realistic" | "diagram", "caption": string, "dalle_prompt": string}

SHOW AN IMAGE (should_generate: true) for virtually any substantive question or statement: any place, organism, scientific concept, experiment, phenomenon, geographic location, invention, instrument, machine, structure, mathematical or geometric concept, or any explanation where a visual aid would help.

SKIP (should_generate: false) ONLY for: pure meta-questions ("do you agree?", "are you real?"), simple greetings/farewells with no content, or questions genuinely impossible to visualize.

image_type rules:
- "diagram" → user needs to UNDERSTAND something conceptually (how X works, the mechanism, abstract phenomena, cross-sections)
- "realistic" → user wants to SEE or IMAGINE something real (places, organisms, events, objects, scenes)

caption: 1–2 sentences maximum. Concise. Present tense. Do not mention specific character names.

dalle_prompt:
- For "diagram": scientific illustration, dark deep-navy or black background, glowing luminous elements, no text or labels in image, hyperrealistic rendering of the concept, [specific visual content], cinematic depth
- For "realistic": [specific scene in detail], photorealistic, cinematic lighting, highly detailed, [append character style suffix given by the user], no text overlays
- Max 900 characters. No realistic human faces. No text or labels.`;

const BLANK: ImageAnalysisResult = { shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' };

function imageTypeOf(spec: unknown): 'realistic' | 'diagram' {
  const t = (spec as { imageType?: string } | null)?.imageType;
  return t === 'diagram' ? 'diagram' : 'realistic';
}

export async function analyzeAndGenerateImage(
  userMessage: string,
  characterId: string,
  conversationContext?: string,
  projectId?: string | null,
): Promise<ImageAnalysisResult> {
  // Viewer-driven + billable image gen honors the platform pause switch.
  const openai = (await isGenerationPaused()) ? null : await getOpenAIClient();
  if (!openai) return BLANK;

  const realisticStyle = REALISTIC_STYLE[characterId] ?? REALISTIC_STYLE.einstein;
  const lookupKey = (conversationContext ?? userMessage).slice(0, 300);

  try {
    // Step 0: bank lookup — skips GPT entirely on hit
    const earlyHit = await findVisual({ lookupKey, visualType: 'image', characterId, projectId }).catch(() => null);
    if (earlyHit && earlyHit.image_url) {
      incrementUseCount(earlyHit.id).catch(() => {});
      return {
        shouldGenerate: true,
        imageUrl: earlyHit.image_url,
        altText: earlyHit.alt_text ?? '',
        caption: earlyHit.caption ?? '',
        imageType: imageTypeOf(earlyHit.visual_spec),
      };
    }

    // Step 1: GPT classify — only on bank miss
    const classifyResp = await openai.chat.completions.create({
      model: MODELS.imageClassify,
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + `\n\nCharacter domain knowledge: ${CHARACTER_KNOWLEDGE[characterId] ?? ''}` },
        {
          role: 'user',
          content:
            `Character: ${characterId}\n` +
            `Content to visualize: "${userMessage}"\n` +
            `Conversation context: ${conversationContext ?? 'none'}\n` +
            `Realistic image style suffix (use only for "realistic" type): "${realisticStyle}"`,
        },
      ],
    });

    await recordChatUsage({
      userId: null, // viewer sessions are anonymous
      projectId: projectId ?? null,
      model: MODELS.imageClassify,
      task: 'avatar_image_classify',
      usage: classifyResp.usage,
    });

    let c: GptClassification;
    try {
      c = JSON.parse(classifyResp.choices[0]?.message?.content ?? '{}') as GptClassification;
    } catch {
      return BLANK;
    }
    if (!c.should_generate || !c.dalle_prompt) return BLANK;

    // Step 2: secondary bank lookup with the DALL-E prompt
    const cached = await findVisual({ lookupKey: c.dalle_prompt, visualType: 'image', characterId, projectId }).catch(() => null);
    if (cached && cached.image_url) {
      incrementUseCount(cached.id).catch(() => {});
      return {
        shouldGenerate: true,
        imageUrl: cached.image_url,
        altText: cached.alt_text ?? '',
        caption: cached.caption ?? c.caption ?? '',
        imageType: c.image_type ?? 'realistic',
      };
    }

    // Step 3: generate (low quality fast, fallback dall-e-3)
    let b64Low: string | undefined;
    try {
      b64Low = await genImage(openai, { model: MODELS.imageGeneration, prompt: c.dalle_prompt, quality: 'low', size: '1536x1024', n: 1 });
      await recordImageUsage({ userId: null, projectId: projectId ?? null, model: MODELS.imageGeneration, task: 'avatar_image', quality: 'low' });
    } catch (genErr) {
      logger.warn({ err: (genErr as Error).message }, '[AvatarImage] gpt-image-1 failed — falling back to dall-e-3');
      try {
        const resp = await openai.images.generate({ model: 'dall-e-3', prompt: c.dalle_prompt.slice(0, 4000), quality: 'standard', size: '1792x1024', n: 1, response_format: 'b64_json' });
        b64Low = resp?.data?.[0]?.b64_json;
        await recordImageUsage({ userId: null, projectId: projectId ?? null, model: 'dall-e-3', task: 'avatar_image', quality: 'standard' });
      } catch (fbErr) {
        logger.error({ err: (fbErr as Error).message }, '[AvatarImage] dall-e-3 fallback also failed');
        return BLANK;
      }
    }
    if (!b64Low) return BLANK;

    const altText = c.caption?.split('.')[0] ?? '';
    const { url: lowUrl, key } = await storeImageB64(b64Low, null);

    const result: ImageAnalysisResult = {
      shouldGenerate: true,
      imageUrl: lowUrl,
      altText,
      caption: c.caption ?? '',
      imageType: c.image_type ?? 'realistic',
    };

    // Step 4: store to the GLOBAL extended library (project_id = null) so the
    // generated image is reusable by every viewer of every video.
    const savedRow = await insertVisual({
      projectId: null, scope: 'extended', source: 'generated', characterId,
      visualType: 'image', lookupKey,
      caption: c.caption ?? '', altText,
      imageUrl: lowUrl, imageKey: key,
      dallePrompt: c.dalle_prompt,
      visualSpec: { dallePrompt: c.dalle_prompt, imageType: c.image_type ?? 'realistic' },
    }).catch(() => null);

    // Background high-quality upgrade
    if (savedRow) {
      const rowId = savedRow.id;
      const dallePrompt = c.dalle_prompt;
      setTimeout(async () => {
        try {
          const b64High = await genImage(openai, { model: MODELS.imageGeneration, prompt: dallePrompt, quality: 'high', size: '1536x1024', n: 1 });
          await recordImageUsage({ userId: null, projectId: projectId ?? null, model: MODELS.imageGeneration, task: 'avatar_image', quality: 'high' });
          if (!b64High) return;
          const high = await storeImageB64(b64High, null);
          await db.update(avatar_visuals).set({ image_url: high.url, image_key: high.key }).where(eq(avatar_visuals.id, rowId));
        } catch (err) {
          logger.warn({ err: (err as Error).message, rowId }, '[AvatarImage] BG upgrade failed');
        }
      }, 0);
    }

    return result;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[AvatarImage] generation failed (silent)');
    return BLANK;
  }
}

// Admin/editor: build a DALL-E prompt from free text, generate a high-quality image,
// and save it to the library. Returns the saved row.
export async function generateLibraryImage(params: {
  prompt: string;
  dallePrompt?: string;
  characterId: string;
  caption?: string;
  projectId?: string | null;
  createdBy?: string | null;
  scope?: 'basic' | 'extended';
}): Promise<{ row: typeof avatar_visuals.$inferSelect; imageUrl: string } | null> {
  const openai = await getOpenAIClient();
  if (!openai) throw new Error('OpenAI API key is not configured');
  let dallePrompt = params.dallePrompt;
  if (!dallePrompt) {
    const promptResp = await openai.chat.completions.create({
      model: MODELS.adminPromptBuilder,
      max_tokens: 500,
      temperature: 0.6,
      messages: [
        { role: 'system', content: "You are a DALL-E prompt engineer. Convert the user's description into a vivid, detailed image generation prompt. Rules: photorealistic or scientific-illustration style, no human faces, no text in image, cinematic lighting, max 800 chars. Respond with ONLY the prompt." },
        { role: 'user', content: `Generate a DALL-E prompt for: "${params.prompt.slice(0, 400)}"` },
      ],
    });
    await recordChatUsage({
      userId: params.createdBy ?? null,
      projectId: params.projectId ?? null,
      model: MODELS.adminPromptBuilder,
      task: 'avatar_image_prompt',
      usage: promptResp.usage,
    });
    dallePrompt = promptResp.choices[0]?.message?.content?.trim() ?? params.prompt;
  }
  const caption = params.caption || params.prompt || dallePrompt;
  const b64 = await genImage(openai, { model: MODELS.imageGeneration, prompt: dallePrompt, quality: 'high', size: '1536x1024', n: 1 });
  await recordImageUsage({ userId: params.createdBy ?? null, projectId: params.projectId ?? null, model: MODELS.imageGeneration, task: 'avatar_image', quality: 'high' });
  if (!b64) throw new Error('Image generation returned no data');
  // Library-generated images are scoped to the project that created them (each project has its
  // own Extended Library) — was global, which leaked visuals across projects.
  const { url, key } = await storeImageB64(b64, null);
  const row = await insertVisual({
    projectId: params.projectId ?? null, scope: 'extended', source: 'generated',
    characterId: params.characterId, visualType: 'image', lookupKey: caption,
    caption, altText: caption.split('.')[0] ?? '', imageUrl: url, imageKey: key,
    dallePrompt, visualSpec: { dallePrompt, imageType: 'realistic' }, createdBy: params.createdBy,
  });
  if (!row) throw new Error('Failed to save image to library');
  return { row, imageUrl: url };
}
