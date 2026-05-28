import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../../db/index.js';
import { admin_settings } from '../../../db/schema.js';
import { eq } from 'drizzle-orm';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';

const UpdateSettingsSchema = z.object({
  billing_enabled: z.boolean().optional(),
  generation_paused: z.boolean().optional(),
  generation_paused_message: z.string().nullable().optional(),
  maintenance_mode: z.boolean().optional(),
  maintenance_message: z.string().nullable().optional(),
  anonymous_user_limit: z.number().int().min(0).optional(),
});

export async function registerAdminSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/v1/settings',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const settings = await db.query.admin_settings.findFirst();
      return reply.send(settings);
    },
  );

  app.put(
    '/api/admin/v1/settings',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = UpdateSettingsSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(admin_settings)
        .set({ ...body.data, updated_at: new Date() })
        .where(eq(admin_settings.id, 1))
        .returning();

      return reply.send(updated);
    },
  );
}
