import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { admin_settings } from '../db/schema.js';
import { LLMErrorType } from 'shared';

export async function scriptGenerationRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Check global generation pause only — per-user rate limits disabled
  const settings = await db.query.admin_settings.findFirst();
  if (settings?.generation_paused) {
    return reply.code(503).send({
      error_type: LLMErrorType.GENERATION_PAUSED,
      message: settings.generation_paused_message ?? 'Script generation is temporarily paused.',
    });
  }
}
