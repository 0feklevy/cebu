import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { video_generation_jobs, timeline_sections, video_files } from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { runVideoGenerateInProcess } from '../../jobs/video.generate.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { assertGenerationAllowed } from '../../services/llm/systemAi.js';
import { moderateGenerationInput } from '../../services/llm/ContentModerationService.js';
import { AppError } from 'shared';
import { logger } from '../../lib/logger.js';

const ALLOWED_MODELS = ['kling', 'veo'] as const;

const GenerateBodySchema = z.object({
  prompt: z.string().min(1).max(500),
  model: z.enum(ALLOWED_MODELS).default('kling'),
  enhance: z.boolean().default(true),
  target_duration_sec: z.number().min(4).max(15),
  target_global_offset_sec: z.number().min(0),
});

const InsertExistingSchema = z.object({
  video_file_id: z.string().uuid(),
  global_offset_sec: z.number().min(0),
  start_sec: z.number().min(0).default(0),
  end_sec: z.number().min(0).optional(),
});

export async function registerBrollRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /api/v1/projects/:id/broll/generate ─────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/broll/generate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = GenerateBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const { prompt, model, enhance, target_duration_sec, target_global_offset_sec } = body.data;

      // External video generation is the priciest per-call surface in the app and
      // has no provider-side quota: rate-limit, honor the platform pause/user cap,
      // and safety-screen the prompt before submitting (mirrors podcast generate).
      if (!rateLimit(`broll-generate:${user.id}`, 20, 60 * 60_000)) {
        return reply.code(429).send({ message: 'Too many video generations — please wait a bit before generating again.' });
      }
      try {
        // Independent checks — run concurrently to keep submit latency down.
        await Promise.all([
          assertGenerationAllowed(user.id),
          moderateGenerationInput(prompt, { userId: user.id }),
        ]);
      } catch (err) {
        if (err instanceof AppError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }

      // Create job record
      const [job] = await db.insert(video_generation_jobs).values({
        project_id: project.id,
        model,
        original_prompt: prompt,
        enhance_enabled: enhance,
        target_duration_sec,
        target_global_offset_sec,
        status: 'queued',
      }).returning();

      // Trigger generation — runVideoGenerateInProcess is fire-and-forget (void)
      runVideoGenerateInProcess(job.id);

      logger.info({ jobId: job.id, model, prompt }, 'B-roll generation queued');
      return reply.code(201).send({ jobId: job.id, status: 'queued' });
    },
  );

  // ── GET /api/v1/projects/:id/broll/jobs ──────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/broll/jobs',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const jobs = await db.query.video_generation_jobs.findMany({
        where: eq(video_generation_jobs.project_id, project.id),
        orderBy: [desc(video_generation_jobs.created_at)],
      });
      return reply.send(jobs);
    },
  );

  // ── GET /api/v1/projects/:id/broll/jobs/:jobId ───────────────────────────
  app.get<{ Params: { id: string; jobId: string } }>(
    '/api/v1/projects/:id/broll/jobs/:jobId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const job = await db.query.video_generation_jobs.findFirst({
        where: and(
          eq(video_generation_jobs.id, request.params.jobId),
          eq(video_generation_jobs.project_id, project.id),
        ),
      });
      if (!job) return reply.code(404).send({ message: 'Job not found' });

      return reply.send(job);
    },
  );

  // ── DELETE /api/v1/projects/:id/broll/jobs/:jobId ────────────────────────
  app.delete<{ Params: { id: string; jobId: string } }>(
    '/api/v1/projects/:id/broll/jobs/:jobId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const [deleted] = await db.delete(video_generation_jobs)
        .where(and(
          eq(video_generation_jobs.id, request.params.jobId),
          eq(video_generation_jobs.project_id, project.id),
        ))
        .returning();

      if (!deleted) return reply.code(404).send({ message: 'Job not found' });
      return reply.code(204).send();
    },
  );

  // ── POST /api/v1/projects/:id/broll/insert-existing ──────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/broll/insert-existing',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = InsertExistingSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const { video_file_id, global_offset_sec, start_sec } = body.data;

      // Verify video belongs to project
      const videoFile = await db.query.video_files.findFirst({
        where: and(eq(video_files.id, video_file_id), eq(video_files.project_id, project.id)),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video not found' });

      // Determine end_sec: use provided value or full video duration
      const end_sec = body.data.end_sec ?? (videoFile.duration_sec ?? 30);

      if (start_sec >= end_sec) {
        return reply.code(400).send({ message: 'start_sec must be less than end_sec' });
      }

      const [section] = await db.insert(timeline_sections).values({
        project_id: project.id,
        video_file_id,
        start_sec,
        end_sec,
        type: 'broll',
        label: videoFile.filename,
        track: 'broll',
        global_offset_sec,
      }).returning();

      return reply.code(201).send(section);
    },
  );
}
