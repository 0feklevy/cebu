import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, hosts, orgs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { CreateProjectSchema } from 'shared';

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/projects
  app.post(
    '/api/v1/projects',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.dbUser!;
      const orgId = user.default_org_id;
      if (!orgId) return reply.code(400).send({ message: 'User has no default org' });

      const body = CreateProjectSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const data = body.data;

      // If host_a/host_b inline definitions were given, create hosts
      let hostAId = data.host_a_id;
      let hostBId = data.host_b_id;

      if (data.host_a && !hostAId) {
        const [h] = await db
          .insert(hosts)
          .values({ ...data.host_a, org_id: orgId })
          .returning();
        hostAId = h.id;
      }
      if (data.host_b && !hostBId) {
        const [h] = await db
          .insert(hosts)
          .values({ ...data.host_b, org_id: orgId })
          .returning();
        hostBId = h.id;
      }

      const [project] = await db
        .insert(projects)
        .values({
          org_id: orgId,
          created_by: user.id,
          topic: data.topic,
          style_preset: data.style_preset,
          host_a_id: hostAId,
          host_b_id: hostBId,
          format: data.format,
          target_duration_min: data.target_duration_min,
          pacing: data.pacing,
          emotional_style: data.emotional_style,
        })
        .returning();

      return reply.code(201).send({ id: project.id, status: project.status });
    },
  );

  // GET /api/v1/projects
  app.get(
    '/api/v1/projects',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.dbUser!;
      const all = await db.query.projects.findMany({
        where: eq(projects.created_by, user.id),
        orderBy: (p, { desc }) => [desc(p.created_at)],
      });
      return reply.send(all);
    },
  );

  // GET /api/v1/projects/:id
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(
          eq(projects.id, request.params.id),
          eq(projects.created_by, user.id),
        ),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const [allCorpora, latestScript, hostA, hostB] = await Promise.all([
        db.query.corpora.findMany({
          where: (c) => eq(c.project_id, project.id),
        }),
        db.query.scripts.findFirst({
          where: (s) => eq(s.project_id, project.id),
          orderBy: (s, { desc }) => [desc(s.version)],
        }),
        project.host_a_id
          ? db.query.hosts.findFirst({ where: eq(hosts.id, project.host_a_id) })
          : Promise.resolve(null),
        project.host_b_id
          ? db.query.hosts.findFirst({ where: eq(hosts.id, project.host_b_id) })
          : Promise.resolve(null),
      ]);

      return reply.send({ ...project, corpora: allCorpora, latest_script: latestScript ?? null, host_a: hostA, host_b: hostB });
    },
  );

  // GET /api/v1/hosts
  app.get(
    '/api/v1/hosts',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.dbUser!;
      const orgId = user.default_org_id;
      const all = await db.query.hosts.findMany({
        where: eq(hosts.org_id, orgId!),
      });
      return reply.send(all);
    },
  );

  // POST /api/v1/hosts
  app.post(
    '/api/v1/hosts',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.dbUser!;
      const body = z
        .object({
          name: z.string().min(1),
          role: z.string().min(1),
          persona_text: z.string().min(1),
          voice_id: z.string().optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [host] = await db
        .insert(hosts)
        .values({ ...body.data, org_id: user.default_org_id! })
        .returning();
      return reply.code(201).send(host);
    },
  );
}
