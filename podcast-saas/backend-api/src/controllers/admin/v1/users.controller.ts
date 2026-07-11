import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../../db/index.js';
import { users, token_usage } from '../../../db/schema.js';
import { eq, sql, desc, and, gte, lte } from 'drizzle-orm';
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

      // Aggregate in Postgres (GROUP BY) instead of streaming every token_usage row to Node and
      // summing in JS — that transferred tens of thousands of rows for a 30-day window to compute
      // a handful of totals (perf-004). One grouped query per dimension + a totals query.
      const dateRange = and(gte(token_usage.occurred_at, from), lte(token_usage.occurred_at, to));
      const agg = {
        input:  sql<number>`coalesce(sum(input_tokens),0)::int`,
        output: sql<number>`coalesce(sum(output_tokens),0)::int`,
        cost:   sql<number>`coalesce(sum(cost_cents),0)::float8`, // fractional cents (migration 046)
      };
      const [totals, providerRows, modelRows, taskRows] = await Promise.all([
        db.select(agg).from(token_usage).where(dateRange),
        db.select({ provider: token_usage.provider, ...agg }).from(token_usage).where(dateRange).groupBy(token_usage.provider),
        db.select({ model: token_usage.model, ...agg }).from(token_usage).where(dateRange).groupBy(token_usage.model),
        db.select({ task: token_usage.task, input: agg.input, output: agg.output }).from(token_usage).where(dateRange).groupBy(token_usage.task),
      ]);

      const rollup = {
        total_input_tokens:  totals[0]?.input  ?? 0,
        total_output_tokens: totals[0]?.output ?? 0,
        total_cost_cents:    totals[0]?.cost   ?? 0,
        by_provider: Object.fromEntries(providerRows.map((r) => [r.provider, { input: r.input, output: r.output, cost_cents: r.cost }])),
        by_model:    Object.fromEntries(modelRows.map((r) => [r.model, { input: r.input, output: r.output, cost_cents: r.cost }])),
        by_task:     Object.fromEntries(taskRows.map((r) => [r.task, { input: r.input, output: r.output }])),
      };

      return reply.send(rollup);
    },
  );
}
