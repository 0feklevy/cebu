// Utility-tier content-safety pre-screen run BEFORE expensive generation
// (podcast scripts on the creative tier, thumbnail/banner image models) — a port
// of fiji's ContentModerationService. Fail-open: an error in the screen itself
// never blocks generation; only an explicit "allowed: false" verdict does.

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { system_prompts } from '../../db/schema.js';
import { LLMService } from './LLMService.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../lib/logger.js';

const MAX_INPUT_CHARS = 8000;

const VerdictSchema = z.object({
  allowed: z.boolean().optional(),
  reason: z.string().optional(),
});

// Module-level singleton — a fresh LLMService per call would defeat the
// key/provider caches and re-hit the DB for every screened request.
const llm = new LLMService(new ApiKeyService(), new UsageTrackingService());

// Admin-customizable via system_prompts key 'content_moderation'.
const DEFAULT_MODERATION_PROMPT = `You are a content-safety pre-screen for an educational content platform. Judge ONLY whether the user-provided text below is acceptable input for AI content generation (podcast scripts, video thumbnails, playlist banners).

Reject (allowed=false) ONLY when the text requests or contains: sexual content involving minors, instructions for serious violence or weapons, hate or harassment targeting people or groups, encouragement of self-harm, or clearly illegal activity.
Everything else is allowed — including edgy, political, medical, religious, or controversial educational topics.

Respond ONLY with JSON: {"allowed": boolean, "reason": string (one short sentence, empty when allowed)}`;

/**
 * Screen user-supplied generation input. Throws AppError(CONTENT_REJECTED, 400)
 * when the screen explicitly rejects; returns silently when allowed, when the
 * input is empty, or when the screen itself fails (fail-open).
 */
export async function moderateGenerationInput(
  text: string,
  opts: { userId: string | null },
): Promise<void> {
  const input = text.trim();
  if (!input) return;

  let verdict: { allowed?: boolean; reason?: string } | null = null;
  try {
    const row = await db.query.system_prompts.findFirst({
      where: eq(system_prompts.key, 'content_moderation'),
    });
    const systemPrompt = row?.content?.trim() || DEFAULT_MODERATION_PROMPT;

    const res = await llm.sendText({
      task: 'content_moderation',
      systemPrompt,
      userPrompt: input.slice(0, MAX_INPUT_CHARS),
      userId: opts.userId,
      projectId: null,
      abortSignal: AbortSignal.timeout(20_000),
    });

    const match = res.text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = VerdictSchema.safeParse(JSON.parse(match[0]));
      verdict = parsed.success ? parsed.data : null; // malformed verdict → fail open
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 160) },
      '[moderation] pre-screen failed — failing open',
    );
    return;
  }

  if (verdict && verdict.allowed === false) {
    logger.info({ reason: verdict.reason }, '[moderation] generation input rejected');
    throw new AppError(
      LLMErrorType.CONTENT_REJECTED,
      'This request was declined by the content-safety check. Please adjust your text and try again.',
      400,
      { moderation: true, reason: verdict.reason ?? '' },
    );
  }
}
