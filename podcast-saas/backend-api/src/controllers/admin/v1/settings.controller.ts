import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../../db/index.js';
import { invalidateRumSampleRateCache } from '../../../services/simulation/RumService.js';
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
  generation_limit_enabled: z.boolean().optional(),
  generation_daily_limit: z.number().int().min(1).max(10000).optional(),
  // ── Simulation / RUM runtime switches (migrations 048 / 051 / 052) ──────────
  // These columns existed as runtime kill switches but were only reachable with raw SQL;
  // a switch an operator cannot flip from the admin surface is not a real kill switch.
  // Enums and bounds mirror the DDL CHECKs so an out-of-range value 400s here instead of
  // surfacing as a constraint violation 500.
  sim_pool_mode: z.enum(['single', 'adaptive']).optional(),
  rum_sample_rate: z.number().min(0).max(1).optional(),
  rum_retention_days: z.number().int().min(1).max(365).optional(),
  sim_scheduler_mode: z.enum(['off', 'predictive']).optional(),
  sim_adaptive_quality: z.boolean().optional(),
  sim_boundary_sentinel: z.boolean().optional(),
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

      // The RUM sample rate is read on an unauthenticated write path, so it is cached in-process
      // rather than queried per request. Invalidating here is what keeps it a real kill switch:
      // an operator setting it to 0 during an incident sees it take effect now, not whenever the
      // cache happens to expire.
      invalidateRumSampleRateCache();

      return reply.send(updated);
    },
  );
}
