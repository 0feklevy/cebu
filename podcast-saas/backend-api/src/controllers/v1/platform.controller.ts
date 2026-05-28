import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { admin_settings } from '../../db/schema.js';

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/platform/settings
  // Returns public-safe feature flags — no auth required
  app.get('/api/v1/platform/settings', async (_req: FastifyRequest, reply: FastifyReply) => {
    const settings = await db.query.admin_settings.findFirst();
    if (!settings) return reply.code(503).send({ message: 'Settings not initialized' });

    return reply.send({
      billing_enabled: settings.billing_enabled,
      maintenance_mode: settings.maintenance_mode,
      maintenance_message: settings.maintenance_message,
      generation_paused: settings.generation_paused,
      generation_paused_message: settings.generation_paused_message,
      anonymous_user_limit: settings.anonymous_user_limit,
    });
  });
}
