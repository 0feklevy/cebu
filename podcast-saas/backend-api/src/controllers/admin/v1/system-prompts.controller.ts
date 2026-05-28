import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../../db/index.js';
import { system_prompts } from '../../../db/schema.js';
import { eq } from 'drizzle-orm';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';

export async function registerAdminSystemPromptRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/v1/system-prompts',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const all = await db.query.system_prompts.findMany({
        orderBy: (s, { asc }) => [asc(s.key)],
      });
      return reply.send(all);
    },
  );

  app.put<{ Params: { key: string } }>(
    '/api/admin/v1/system-prompts/:key',
    { preHandler: [firebaseAdminRequired] },
    async (request, reply: FastifyReply) => {
      const body = z.object({ content: z.string().min(1) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const user = request.dbUser!;
      const [updated] = await db
        .update(system_prompts)
        .set({
          content: body.data.content,
          is_customized: true,
          updated_by: user.id,
          updated_at: new Date(),
        })
        .where(eq(system_prompts.key, request.params.key))
        .returning();

      if (!updated) return reply.code(404).send({ message: 'System prompt not found' });
      return reply.send(updated);
    },
  );
}
