import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../../db/index.js';
import { users, token_usage } from '../../../db/schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';

export async function registerAdminUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/v1/users',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query as { page?: string; limit?: string });
      const page = parseInt(query.page ?? '1', 10);
      const limit = Math.min(parseInt(query.limit ?? '50', 10), 200);
      const offset = (page - 1) * limit;

      const allUsers = await db.query.users.findMany({
        orderBy: [desc(users.created_at)],
        limit,
        offset,
      });

      const total = await db.select({ count: sql<number>`count(*)` }).from(users);

      return reply.send({ users: allUsers, total: total[0].count, page, limit });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/admin/v1/users/:id/limits',
    { preHandler: [firebaseAdminRequired] },
    async (request, reply: FastifyReply) => {
      const body = z
        .object({
          weekly_token_limit: z.number().int().min(0).optional(),
          monthly_token_limit: z.number().int().min(0).optional(),
          is_admin: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(users)
        .set(body.data)
        .where(eq(users.id, request.params.id))
        .returning();

      if (!updated) return reply.code(404).send({ message: 'User not found' });
      return reply.send(updated);
    },
  );

  app.get(
    '/api/admin/v1/usage',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query as { from?: string; to?: string });
      const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = query.to ? new Date(query.to) : new Date();

      const rows = await db.query.token_usage.findMany({
        where: (t, { and, gte, lte }) => and(gte(t.occurred_at, from), lte(t.occurred_at, to)),
      });

      const rollup = {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
        by_provider: {} as Record<string, { input: number; output: number; cost_cents: number }>,
        by_model: {} as Record<string, { input: number; output: number; cost_cents: number }>,
        by_task: {} as Record<string, { input: number; output: number }>,
      };

      for (const r of rows) {
        rollup.total_input_tokens += r.input_tokens;
        rollup.total_output_tokens += r.output_tokens;
        rollup.total_cost_cents += r.cost_cents;

        rollup.by_provider[r.provider] ??= { input: 0, output: 0, cost_cents: 0 };
        rollup.by_provider[r.provider].input += r.input_tokens;
        rollup.by_provider[r.provider].output += r.output_tokens;
        rollup.by_provider[r.provider].cost_cents += r.cost_cents;

        rollup.by_model[r.model] ??= { input: 0, output: 0, cost_cents: 0 };
        rollup.by_model[r.model].input += r.input_tokens;
        rollup.by_model[r.model].output += r.output_tokens;
        rollup.by_model[r.model].cost_cents += r.cost_cents;

        rollup.by_task[r.task] ??= { input: 0, output: 0 };
        rollup.by_task[r.task].input += r.input_tokens;
        rollup.by_task[r.task].output += r.output_tokens;
      }

      return reply.send(rollup);
    },
  );
}
