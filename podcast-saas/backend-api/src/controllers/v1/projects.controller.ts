import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, hosts, video_files } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
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

  // PATCH /api/v1/projects/:id — rename (update title)
  app.patch<{ Params: { id: string } }>(
    '/api/v1/projects/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const body = z.object({ title: z.string().min(1).max(200) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const [updated] = await db
        .update(projects)
        .set({ title: body.data.title })
        .where(eq(projects.id, project.id))
        .returning();
      return reply.send(updated);
    },
  );

  // PATCH /api/v1/projects/:id/meta — update title + description together
  app.patch<{ Params: { id: string } }>(
    '/api/v1/projects/:id/meta',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const body = z.object({
        title:       z.string().max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const set: Record<string, unknown> = {};
      if (body.data.title !== undefined) set.title = body.data.title;
      if (body.data.description !== undefined) set.topic = body.data.description;

      const [updated] = await db.update(projects).set(set).where(eq(projects.id, project.id)).returning();
      return reply.send(updated);
    },
  );

  // POST /api/v1/projects/:id/generate-metadata — (re-)generate thumbnail + title + description
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/generate-metadata',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Pick first ready video file for the project
      const { video_files: vf } = await import('../../db/schema.js');
      const { eq: eqDrizzle, and: andDrizzle } = await import('drizzle-orm');
      const video = await db.query.video_files.findFirst({
        where: andDrizzle(eqDrizzle(vf.project_id, project.id), eqDrizzle(vf.is_broll, false)),
      });
      if (!video) return reply.code(400).send({ message: 'No video uploaded yet' });

      const optBody = z.object({
        prompt: z.string().max(500).optional(),
        model: z.enum(['gpt-4o-mini', 'gpt-4o']).optional(),
      }).safeParse(request.body ?? {});

      // Reset status so the generator runs even if already ready
      await db.update(projects).set({ metadata_status: 'none' }).where(eq(projects.id, project.id));

      const { enqueueVideoMetadata } = await import('../../services/generateVideoMetadata.js');
      enqueueVideoMetadata(project.id, video.id, {
        promptHint: optBody.success ? optBody.data.prompt : undefined,
        model:      optBody.success ? optBody.data.model  : undefined,
      });

      return reply.send({ status: 'processing' });
    },
  );

  // POST /api/v1/projects/:id/thumbnail-from-timeline — extract frame at given time
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/thumbnail-from-timeline',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = z.object({ time_seconds: z.number().min(0).max(86400) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: 'time_seconds required' });

      const video = await db.query.video_files.findFirst({
        where: and(eq(video_files.project_id, project.id), eq(video_files.is_broll, false)),
      });
      if (!video) return reply.code(400).send({ message: 'No video uploaded yet' });

      const { extractThumbnailAtTime } = await import('../../services/generateVideoMetadata.js');
      const thumbnailUrl = await extractThumbnailAtTime(project.id, video.id, body.data.time_seconds);

      return reply.send({ thumbnail_url: thumbnailUrl });
    },
  );

  // GET /api/v1/projects/:id/frame-preview — returns JPEG of frame at given time (no storage)
  app.get<{ Params: { id: string }; Querystring: { time_seconds?: string } }>(
    '/api/v1/projects/:id/frame-preview',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Not found' });

      const timeSec = Math.max(0, parseFloat(request.query.time_seconds ?? '0') || 0);

      const video = await db.query.video_files.findFirst({
        where: and(eq(video_files.project_id, project.id), eq(video_files.is_broll, false)),
      });
      if (!video) return reply.code(400).send({ message: 'No video uploaded yet' });

      const { extractFrameAsBuffer } = await import('../../services/generateVideoMetadata.js');
      const buf = await extractFrameAsBuffer(video.id, timeSec);

      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'no-cache')
        .send(buf);
    },
  );

  // DELETE /api/v1/projects/:id
  app.delete<{ Params: { id: string } }>(
    '/api/v1/projects/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Best-effort storage cleanup before DB delete
      const storage = getStorageAdapter();
      const videos = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
      });
      await Promise.all(
        videos.flatMap(v => [
          v.storage_key ? storage.deleteFile(v.storage_key).catch(err => logger.warn({ err }, 'delete raw')) : null,
          storage.deleteWithPrefix(`hls/${v.id}`).catch(err => logger.warn({ err }, 'delete hls')),
        ].filter(Boolean)),
      );

      // DB delete — cascades to video_files and timeline_sections
      await db.delete(projects).where(eq(projects.id, project.id));
      return reply.code(204).send();
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
