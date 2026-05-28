import { z } from 'zod';
import { LLMService } from './LLMService.js';
import { AppError, LLMErrorType } from 'shared';
import { db } from '../../db/index.js';
import { system_prompts } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

const ModerationResultSchema = z.object({
  flagged: z.boolean(),
  reason: z.string().nullable(),
});

export class ContentModerationService {
  constructor(private readonly llm: LLMService) {}

  async check(text: string, userId: string, projectId: string): Promise<void> {
    try {
      const promptRow = await db.query.system_prompts.findFirst({
        where: eq(system_prompts.key, 'content_moderation'),
      });

      const systemPrompt =
        promptRow?.content ??
        'You are a content moderation system. Review the text and output JSON: {"flagged": boolean, "reason": string | null}';

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 10_000);

      try {
        const result = await this.llm.sendStructured({
          task: 'content_moderation',
          systemPrompt,
          userPrompt: `Review this content for policy violations:\n\n${text.slice(0, 8000)}`,
          schema: ModerationResultSchema,
          userId,
          projectId,
          abortSignal: abortController.signal,
        });

        if (result.data.flagged) {
          throw new AppError(
            LLMErrorType.CONTENT_REJECTED,
            result.data.reason ?? 'Content policy violation',
            422,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof AppError && err.error_type === LLMErrorType.CONTENT_REJECTED) {
        throw err;
      }
      // Fail-open: log but don't block on moderation errors
      logger.warn({ err }, 'Content moderation check failed — allowing through (fail-open)');
    }
  }
}
