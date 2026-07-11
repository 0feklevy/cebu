// Shared system-AI access for the auxiliary AI paths (vision metadata, image
// generation, SEO summaries, avatar visuals, ingestion captions) that call the
// OpenAI/Google SDKs directly rather than the tiered LLMService providers.
//
// Restores fiji's invariant for those paths:
//   - ONE key source: the admin-managed encrypted api_keys table (ApiKeyService),
//     with process.env.* only as a bootstrap fallback.
//   - ONE cost ledger: every call records a token_usage row (recordChatUsage /
//     recordImageUsage) so the per-user quota and cost reports see them.
//   - ONE pause switch: assertGenerationAllowed() honors
//     admin_settings.generation_paused and the rolling-24h generation cap.

import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { token_usage } from '../../db/schema.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { QUOTA_EXEMPT_TASKS } from './LLMService.js';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../lib/logger.js';

const apiKeyService = new ApiKeyService();
const usageTracking = new UsageTrackingService();

// Clients are cached per key, so when an admin rotates the key (ApiKeyService
// returns the new value after its TTL/invalidation) the client is rebuilt.
let _openai: { key: string; client: OpenAI } | null = null;
let _gemini: { key: string; client: GoogleGenAI } | null = null;

/** System OpenAI client — admin-managed key first, env fallback. Null when unconfigured. */
export async function getOpenAIClient(): Promise<OpenAI | null> {
  const key = (await apiKeyService.getSystemKey('openai')) ?? process.env.OPENAI_API_KEY ?? null;
  if (!key) return null;
  if (_openai?.key !== key) _openai = { key, client: new OpenAI({ apiKey: key }) };
  return _openai.client;
}

/** System Google GenAI client — admin-managed key first, env fallback. Null when unconfigured. */
export async function getGeminiClient(): Promise<GoogleGenAI | null> {
  const key = (await apiKeyService.getSystemKey('gemini')) ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null;
  if (!key) return null;
  if (_gemini?.key !== key) _gemini = { key, client: new GoogleGenAI({ apiKey: key }) };
  return _gemini.client;
}

/** Drop cached clients + keys so a just-rotated admin key takes effect immediately. */
export function invalidateSystemAiClients(): void {
  _openai = null;
  _gemini = null;
  apiKeyService.invalidateCache();
}

// ── Generation gating ─────────────────────────────────────────────────────────

/**
 * Gate a user-initiated aux generation the same way LLMService gates its calls:
 * throws GENERATION_PAUSED when the platform pause switch is on, and
 * LIMIT_EXCEEDED when the user is over the rolling-24h generation cap.
 */
export async function assertGenerationAllowed(userId: string | null): Promise<void> {
  const settings = await db.query.admin_settings.findFirst();
  if (!settings) return;
  if (settings.generation_paused) {
    throw new AppError(
      LLMErrorType.GENERATION_PAUSED,
      settings.generation_paused_message ?? 'Generation is paused',
      503,
    );
  }
  if (settings.generation_limit_enabled && userId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Background/utility rows are exempt from the cap (mirrors LLMService).
    const [usage] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(token_usage)
      .where(and(
        eq(token_usage.user_id, userId),
        gte(token_usage.occurred_at, since),
        notInArray(token_usage.task, QUOTA_EXEMPT_TASKS),
      ));
    if ((usage?.count ?? 0) >= settings.generation_daily_limit) {
      throw new AppError(
        LLMErrorType.LIMIT_EXCEEDED,
        'You have reached the generation limit for now. Please try again later.',
        429,
      );
    }
  }
}

/** Soft pause check for best-effort background paths (skip the AI step, keep the pipeline going). */
export async function isGenerationPaused(): Promise<boolean> {
  const settings = await db.query.admin_settings.findFirst();
  return Boolean(settings?.generation_paused);
}

// ── Usage recording ───────────────────────────────────────────────────────────

// Cents per token (= $/1M tokens ÷ 10,000) for the aux chat/vision models.
// Mirrors LLMProvider.estimateCostCents; unknown models get a conservative default.
const CHAT_PRICING: Record<string, { input: number; output: number; cached: number }> = {
  'gpt-4o':           { input: 0.00025,  output: 0.001,   cached: 0.0000125 },
  'gpt-4o-mini':      { input: 0.000015, output: 0.00006, cached: 0.0000075 },
  'gpt-4.1':          { input: 0.0002,   output: 0.0008,  cached: 0.00005   },
  'gpt-4.1-mini':     { input: 0.00004,  output: 0.00016, cached: 0.00001   },
  'gpt-4.1-nano':     { input: 0.00001,  output: 0.00004, cached: 0.0000025 },
  'gemini-2.5-flash': { input: 0.0000375, output: 0.00015, cached: 0.0000094 },
};

export interface ChatUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Record a direct-SDK chat/vision call in the shared token_usage ledger. Never throws. */
export async function recordChatUsage(opts: {
  userId: string | null;
  projectId: string | null;
  provider?: 'openai' | 'gemini';
  model: string;
  task: string;
  usage: ChatUsageLike | null | undefined;
}): Promise<void> {
  try {
    const input = opts.usage?.prompt_tokens ?? 0;
    const output = opts.usage?.completion_tokens ?? 0;
    const cached = opts.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const p = CHAT_PRICING[opts.model] ?? { input: 0.0001, output: 0.0001, cached: 0.00001 };
    const costCents = Math.round((input - cached) * p.input + cached * p.cached + output * p.output);
    await usageTracking.record({
      userId: opts.userId,
      projectId: opts.projectId,
      provider: opts.provider ?? 'openai',
      model: opts.model,
      task: opts.task,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      costCents,
      usedPersonalKey: false,
    });
  } catch (err) {
    logger.warn({ err, task: opts.task }, '[systemAi] chat usage record failed');
  }
}

// Flat per-image cost estimates in cents ("model" or "model:quality").
const IMAGE_PRICING: Record<string, number> = {
  'gpt-image-1:low': 2,
  'gpt-image-1:medium': 7,
  'gpt-image-1:high': 25,
  'gpt-image-1': 7,
  'dall-e-3': 8,
  'imagen-4.0-fast-generate-001': 2,
  'gemini-2.5-flash-image': 4,
};

// Rough per-job cost estimates in cents for external video-generation providers.
// Refine against real provider billing; the point is that b-roll spend shows up
// in the ledger at all instead of reading as free.
const VIDEO_PRICING: Record<string, number> = {
  kling: 100,
  seedance: 50,
  veo: 150,
};

/** Record an external video-generation job in the shared token_usage ledger. Never throws. */
export async function recordVideoUsage(opts: {
  userId: string | null;
  projectId: string | null;
  model: string;
  task: string;
}): Promise<void> {
  try {
    await usageTracking.record({
      userId: opts.userId,
      projectId: opts.projectId,
      provider: 'video-gen',
      model: opts.model,
      task: opts.task,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: VIDEO_PRICING[opts.model] ?? 100,
      usedPersonalKey: false,
    });
  } catch (err) {
    logger.warn({ err, task: opts.task }, '[systemAi] video usage record failed');
  }
}

/** Record an image-generation call in the shared token_usage ledger. Never throws. */
export async function recordImageUsage(opts: {
  userId: string | null;
  projectId: string | null;
  provider?: 'openai' | 'gemini';
  model: string;
  task: string;
  quality?: string;
  count?: number;
}): Promise<void> {
  try {
    const perImage =
      IMAGE_PRICING[`${opts.model}:${opts.quality ?? ''}`] ?? IMAGE_PRICING[opts.model] ?? 5;
    await usageTracking.record({
      userId: opts.userId,
      projectId: opts.projectId,
      provider: opts.provider ?? 'openai',
      model: opts.model,
      task: opts.task,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: perImage * (opts.count ?? 1),
      usedPersonalKey: false,
    });
  } catch (err) {
    logger.warn({ err, task: opts.task }, '[systemAi] image usage record failed');
  }
}
