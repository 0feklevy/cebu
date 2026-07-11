import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../../db/index.js';
import { admin_settings } from '../../../db/schema.js';
import { eq } from 'drizzle-orm';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';
import { ApiKeyService } from '../../../services/secrets/ApiKeyService.js';
import { LLMService } from '../../../services/llm/LLMService.js';
import { UsageTrackingService } from '../../../services/usage/UsageTrackingService.js';
import { invalidateSystemAiClients } from '../../../services/llm/systemAi.js';

const apiKeyService = new ApiKeyService();

const LlmConfigSchema = z.object({
  default_provider: z.enum(['claude', 'openai', 'gemini']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(256).max(32768).optional(),
  extended_thinking_enabled: z.boolean().optional(),
  thinking_budget_tokens: z.number().int().min(1000).optional(),
  utility_model: z.string().optional(),
  generation_model: z.string().optional(),
  complex_model: z.string().optional(),
  complex_min_corpus_tokens: z.number().int().optional(),
  complex_min_retries: z.number().int().optional(),
  // TTS settings
  tts_provider: z.enum(['elevenlabs', 'gemini']).optional(),
  elevenlabs_model: z.string().optional(),
  default_voice_id_a: z.string().optional(),
  default_voice_id_b: z.string().optional(),
  // Podcast Studio writers'-room model + effort (migration 044).
  podcast_model: z.string().optional(),
  podcast_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export async function registerAdminLlmConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/v1/llm-config',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const settings = await db.query.admin_settings.findFirst();
      return reply.send(settings);
    },
  );

  app.put(
    '/api/admin/v1/llm-config',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = LlmConfigSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(admin_settings)
        .set({ ...body.data, updated_at: new Date() })
        .where(eq(admin_settings.id, 1))
        .returning();

      return reply.send(updated);
    },
  );

  // GET /api/admin/v1/api-keys
  app.get(
    '/api/admin/v1/api-keys',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const statuses = await apiKeyService.getKeyStatus();
      return reply.send(statuses);
    },
  );

  // POST /api/admin/v1/api-keys
  app.post(
    '/api/admin/v1/api-keys',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ provider: z.enum(['claude', 'openai', 'gemini', 'elevenlabs']), api_key: z.string().min(1) })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      await apiKeyService.setSystemKey(body.data.provider, body.data.api_key, request.dbUser!.id);
      // Other ApiKeyService instances pick the rotation up via their cache TTL;
      // the shared aux-path clients are refreshed immediately.
      invalidateSystemAiClients();
      return reply.send({ success: true });
    },
  );

  // POST /api/admin/v1/api-keys/test
  app.post(
    '/api/admin/v1/api-keys/test',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ provider: z.enum(['claude', 'openai', 'gemini', 'elevenlabs']), api_key: z.string().min(1) })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      try {
        // Test by making a minimal API call per provider
        if (body.data.provider === 'elevenlabs') {
          const resp = await fetch('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': body.data.api_key },
          });
          if (!resp.ok) throw new Error(`ElevenLabs API returned ${resp.status}`);
          const user = await resp.json() as { subscription?: { tier?: string } };
          return reply.send({ valid: true, tier: user.subscription?.tier ?? 'unknown' });
        } else if (body.data.provider === 'claude') {
          const Anthropic = (await import('@anthropic-ai/sdk')).default;
          const client = new Anthropic({ apiKey: body.data.api_key });
          const models = await client.models.list();
          return reply.send({ valid: true, model: models.data[0]?.id });
        } else if (body.data.provider === 'openai') {
          const OpenAI = (await import('openai')).default;
          const client = new OpenAI({ apiKey: body.data.api_key });
          const models = await client.models.list();
          return reply.send({ valid: true, model: models.data[0]?.id });
        } else {
          const { GoogleGenAI } = await import('@google/genai');
          const client = new GoogleGenAI({ apiKey: body.data.api_key });
          const models = await client.models.list();
          return reply.send({ valid: true, model: 'gemini-2.5-pro' });
        }
      } catch (err) {
        return reply.code(400).send({ valid: false, error: (err as Error).message });
      }
    },
  );

  // DELETE /api/admin/v1/api-keys/:provider
  app.delete<{ Params: { provider: string } }>(
    '/api/admin/v1/api-keys/:provider',
    { preHandler: [firebaseAdminRequired] },
    async (request, reply: FastifyReply) => {
      const provider = request.params.provider as 'claude' | 'openai' | 'gemini' | 'elevenlabs';
      await apiKeyService.removeSystemKey(provider);
      invalidateSystemAiClients();
      return reply.send({ success: true });
    },
  );
}
