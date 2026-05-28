import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, audio_renders, scenes, camera_plans } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { initSSE } from '../../lib/sse.js';
import { AudioPipeline } from '../../services/audio/AudioPipeline.js';
import { logger } from '../../lib/logger.js';

export async function registerAudioRoutes(app: FastifyInstance): Promise<void> {
  const pipeline = new AudioPipeline();

  // POST /api/v1/projects/:id/audio — trigger audio pipeline (requires approved script)
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      if (project.status !== 'approved') {
        return reply.code(400).send({ message: `Script must be approved first (status: ${project.status})` });
      }

      return reply.code(202).send({ message: 'Audio generation started', project_id: project.id });
    },
  );

  // GET /api/v1/projects/:id/audio/stream — SSE stream for audio pipeline progress
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sse = initSSE(reply);
      sse.emit({ type: 'connected', project_id: project.id });

      const abortController = new AbortController();
      request.raw.on('close', () => abortController.abort());

      try {
        await pipeline.run(project.id, sse, abortController.signal);
      } catch (err: unknown) {
        const msg = (err as Error).message ?? 'Audio pipeline failed';
        logger.error({ err, projectId: project.id }, 'Audio pipeline error');
        sse.emit({ type: 'error', error_type: 'audio_error', message: msg });
      } finally {
        sse.close();
      }
    },
  );

  // GET /api/v1/projects/:id/audio — latest render status
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const render = await db.query.audio_renders.findFirst({
        where: eq(audio_renders.project_id, project.id),
        orderBy: [desc(audio_renders.created_at)],
      });
      if (!render) return reply.code(404).send({ message: 'No audio render yet' });

      return reply.send(render);
    },
  );

  // GET /api/v1/projects/:id/scenes — list all scenes for the latest render
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/api/v1/projects/:id/scenes',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Resolve script version
      let scriptVersion: number;
      if (request.query.version) {
        scriptVersion = parseInt(request.query.version, 10);
      } else {
        const render = await db.query.audio_renders.findFirst({
          where: eq(audio_renders.project_id, project.id),
          orderBy: [desc(audio_renders.created_at)],
        });
        if (!render) return reply.code(404).send({ message: 'No audio render yet' });
        scriptVersion = render.script_version;
      }

      const sceneRows = await db.query.scenes.findMany({
        where: and(
          eq(scenes.project_id, project.id),
          eq(scenes.script_version, scriptVersion),
        ),
        orderBy: [scenes.idx],
      });

      return reply.send(sceneRows);
    },
  );

  // GET /api/v1/projects/:id/camera-plan — camera plan for latest render
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/api/v1/projects/:id/camera-plan',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      let scriptVersion: number;
      if (request.query.version) {
        scriptVersion = parseInt(request.query.version, 10);
      } else {
        const render = await db.query.audio_renders.findFirst({
          where: eq(audio_renders.project_id, project.id),
          orderBy: [desc(audio_renders.created_at)],
        });
        if (!render) return reply.code(404).send({ message: 'No audio render yet' });
        scriptVersion = render.script_version;
      }

      const plan = await db.query.camera_plans.findFirst({
        where: and(
          eq(camera_plans.project_id, project.id),
          eq(camera_plans.script_version, scriptVersion),
        ),
      });
      if (!plan) return reply.code(404).send({ message: 'No camera plan yet' });

      return reply.send(plan);
    },
  );
}
