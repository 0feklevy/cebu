import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { video_generation_jobs, timeline_sections, video_files } from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { enqueueJob } from '../../queue/index.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { assertGenerationAllowed } from '../../services/llm/systemAi.js';
import { moderateGenerationInput } from '../../services/llm/ContentModerationService.js';
import {
  AppError, MAX_TIMELINE_SEC, timelineSectionViolations,
  buildMainSegmentTimeline, deriveAnchorForAbsoluteSec,
} from 'shared';
import { logger } from '../../lib/logger.js';

const ALLOWED_MODELS = ['kling', 'veo'] as const;

/**
 * A position on the timeline, in seconds.
 *
 * `.finite()` is the load-bearing word. `z.number()` accepts Infinity, and `JSON.parse('1e400')`
 * IS Infinity — so `z.number().min(0)`, which is what these fields used to be, waved an infinite
 * offset straight through (`Infinity >= 0`), past the interval guard, and into a Postgres `real`
 * column, which stores infinities without complaint. The upper bound is the same 24 h ceiling the
 * shared row rules use, so this endpoint and the generic sections endpoint agree on what a
 * plausible time is.
 */
const zTimelineSeconds = z.number().finite().min(0).max(MAX_TIMELINE_SEC);

const GenerateBodySchema = z.object({
  prompt: z.string().min(1).max(500),
  model: z.enum(ALLOWED_MODELS).default('kling'),
  enhance: z.boolean().default(true),
  target_duration_sec: z.number().finite().min(4).max(15),
  target_global_offset_sec: zTimelineSeconds,
});

const InsertExistingSchema = z.object({
  video_file_id: z.string().uuid(),
  global_offset_sec: zTimelineSeconds,
  start_sec: zTimelineSeconds.default(0),
  end_sec: zTimelineSeconds.optional(),
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

      // ── WHERE THE FINISHED CLIP GOES, decided NOW (D-01) ────────────────────
      //
      // `target_global_offset_sec` is an absolute second on the concatenated main timeline, and
      // this job runs for up to twenty-five minutes. The timeline is editable that whole time: a
      // re-transcode of any main video slides every frame after it, and the second the author aimed
      // at stops being the moment they aimed at. Resolving the anchor at COMPLETION would read the
      // moved timeline and reproduce exactly that drift with a wider window, so it is resolved ONCE,
      // here, against the timeline the author was looking at when they pressed the button — and the
      // finaliser copies it onto the published section verbatim.
      //
      // Null when the project has no main video yet: there is nothing to anchor to, the job still
      // runs, and the section it publishes falls back to the absolute second exactly as before.
      const projectVideos = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
        orderBy: [asc(video_files.created_at)],
        columns: { id: true, duration_sec: true, is_broll: true },
      });
      const anchor = deriveAnchorForAbsoluteSec(
        buildMainSegmentTimeline(projectVideos ?? []),
        target_global_offset_sec,
      );

      // Create job record
      const [job] = await db.insert(video_generation_jobs).values({
        project_id: project.id,
        model,
        original_prompt: prompt,
        enhance_enabled: enhance,
        target_duration_sec,
        target_global_offset_sec,
        target_anchor_video_file_id: anchor?.anchor_video_file_id ?? null,
        target_anchor_offset_sec: anchor?.anchor_offset_sec ?? null,
        status: 'queued',
      }).returning();

      // Trigger generation through the job queue — durable when QUEUE_DRIVER=pgboss
      // (survives restarts via startup recovery), bounded inline otherwise.
      enqueueJob('video_generate', { jobId: job.id });

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

      // Determine end_sec: use provided value or full video duration. `duration_sec` is
      // client-seeded on upload and only later overwritten by ffprobe, so it is not necessarily a
      // sane number yet — which is why the row is checked below rather than trusted here.
      const end_sec = body.data.end_sec ?? (videoFile.duration_sec ?? 30);

      const row = {
        project_id: project.id,
        video_file_id,
        start_sec,
        end_sec,
        type: 'broll',
        label: videoFile.filename,
        track: 'broll',
        global_offset_sec,
      };

      // The census credits this endpoint with being able to produce exactly ONE shape — a true
      // b-roll with a real position — which is what lets a malformed row in the wild be attributed
      // to the generic sections API instead. Checking the row against the SHARED rule set makes
      // that a guarantee rather than a reading of the code, and one that cannot drift away from the
      // definition the player and the sections endpoints use. It subsumes the hand-rolled
      // `start_sec >= end_sec` guard this replaces.
      const violations = timelineSectionViolations(row);
      if (violations.length > 0) return reply.code(400).send({ message: violations[0]!.message });

      // NEW WRITES ARE ANCHORED (D-01). "Use Existing" places a clip at a second the author is
      // looking at right now, so expressing that as a segment offset records an intent rather than
      // canonising a drift — the distinction the ruling draws between this and a backfill. Null
      // anchor when the project has no main video: nothing to anchor to, and the row keeps working
      // exactly as it does today.
      const projectVideos = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
        orderBy: [asc(video_files.created_at)],
        columns: { id: true, duration_sec: true, is_broll: true },
      });
      const anchor = deriveAnchorForAbsoluteSec(
        buildMainSegmentTimeline(projectVideos ?? []),
        global_offset_sec,
      );

      const [section] = await db.insert(timeline_sections).values({
        ...row,
        anchor_video_file_id: anchor?.anchor_video_file_id ?? null,
        anchor_offset_sec: anchor?.anchor_offset_sec ?? null,
        placement_mode: anchor ? 'segment' : 'legacy_absolute',
      }).returning();

      return reply.code(201).send(section);
    },
  );
}
