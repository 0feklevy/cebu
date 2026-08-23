import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { extname } from 'path';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, hosts, video_files, simulations, audio_files, image_files, collaborators, project_duplications, avatar_visuals } from '../../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, projectsEditableByWhere } from '../../services/collabAccess.js';

import { uploadWithFallback } from '../../services/storage/uploadWithFallback.js';
import { deleteSupersededThumbnail } from '../../services/storage/deleteSupersededThumbnail.js';
import { deleteWithFallback, deleteWithPrefixFallback } from '../../services/storage/deleteWithFallback.js';
import { deleteHlsRetirementRowsForVideo } from '../../services/video/hlsRetention.js';
import { getOpenAIClient } from '../../services/llm/systemAi.js';
import { moderateGenerationInput } from '../../services/llm/ContentModerationService.js';
import { enqueueJob } from '../../queue/index.js';
import { logger } from '../../lib/logger.js';
import {
  UPLOAD_MAX_BYTES,
  declaredTooLarge,
  readStreamBounded,
  tooLargeMessage,
} from '../../services/security/uploadLimits.js';
import { AppError, CreateProjectSchema } from 'shared';

const ALLOWED_THUMBNAIL_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function thumbnailExt(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

type ProjectRow = typeof projects.$inferSelect;

/**
 * Fire-and-forget: for projects with no thumbnail yet, grab a placeholder frame
 * from their source video. Bounded per call (the in-process guard in
 * generateVideoMetadata dedupes); only acts on projects whose auto-metadata has
 * not completed, so it never clobbers a user-chosen thumbnail.
 */
async function backfillMissingThumbnails(rows: ProjectRow[]): Promise<void> {
  try {
    const missing = rows
      .filter((p) => !p.thumbnail_url && p.metadata_status === 'none')  // skip ready/processing/failed
      .slice(0, 8);
    if (missing.length === 0) return;

    const vids = await db.query.video_files.findMany({
      where: and(inArray(video_files.project_id, missing.map((p) => p.id)), eq(video_files.is_broll, false)),
    });
    const firstVideo = new Map<string, typeof vids[number]>();
    for (const v of vids) {
      if (v.storage_key && !firstVideo.has(v.project_id)) firstVideo.set(v.project_id, v);
    }

    const { enqueueVideoMetadata } = await import('../../services/generateVideoMetadata.js');
    for (const p of missing) {
      const v = firstVideo.get(p.id);
      if (v) enqueueVideoMetadata(p.id, v.id, { skipVision: true });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message?.slice(0, 120) }, '[thumbnail] backfill skipped');
  }
}

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
      // Own projects + projects shared with this user (collaboration, migration 042).
      const all = await db.query.projects.findMany({
        where: projectsEditableByWhere(user),
        orderBy: (p, { desc }) => [desc(p.created_at)],
      });
      // Best-effort: backfill a frame-placeholder thumbnail for videos that don't
      // have one yet (older videos predate auto-generation, or it never ran).
      void backfillMissingThumbnails(all);
      return reply.send(all.map((p) => ({
        ...p,
        collab_role: p.created_by === user.id ? 'owner' : 'collaborator',
      })));
    },
  );

  // GET /api/v1/projects/:id
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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
      const body = z.object({
        title: z.string().min(1).max(200).optional(),
        visibility: z.enum(['private', 'unlisted', 'public']).optional(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const patch: { title?: string; visibility?: 'private' | 'unlisted' | 'public' } = {};
      if (body.data.title !== undefined) patch.title = body.data.title;
      if (body.data.visibility !== undefined) patch.visibility = body.data.visibility;
      if (Object.keys(patch).length === 0) return reply.send(project);

      const [updated] = await db
        .update(projects)
        .set(patch)
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

      const project = await editableProject(request.params.id, user);
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
      const project = await editableProject(request.params.id, user);
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
        force:      true, // explicit user (re)generate — always produce a fresh thumbnail
      });

      return reply.send({ status: 'processing' });
    },
  );

  // POST /api/v1/projects/:id/enhance-thumbnail-prompt — rewrite the creator's idea into a
  // YouTube-thumbnail-style image prompt (fast/low model). Returns { prompt }.
  app.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    '/api/v1/projects/:id/enhance-thumbnail-prompt',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const parsed = z.object({ prompt: z.string().max(500).optional() }).safeParse(request.body ?? {});
      const userPrompt = parsed.success ? (parsed.data.prompt ?? '') : '';
      try {
        if (userPrompt.trim()) await moderateGenerationInput(userPrompt, { userId: user.id });
        const { enhanceThumbnailPrompt } = await import('../../services/generateAiThumbnail.js');
        const enhanced = await enhanceThumbnailPrompt(project.id, userPrompt, user.id);
        return reply.send({ prompt: enhanced });
      } catch (err) {
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({ message: err.message });
        }
        // Log the real (possibly upstream) error server-side; return a generic message so
        // provider/internal detail isn't surfaced to the client (backend-204 / security-404).
        //
        // NOT `request.log` (observability-001). `server.ts` builds Fastify with `logger: false`,
        // and Fastify then installs `abstract-logging`, whose every method is literally
        // `function noop () {}` — so `request.log.error(...)` compiled, read like logging, and
        // wrote nowhere. This path returns a deliberately generic 502, which made that discarded
        // line the ONLY record the real cause was ever going to have.
        logger.error({ err, projectId: project.id }, 'enhance-thumbnail-prompt failed');
        return reply.code(502).send({ message: 'Failed to enhance prompt. Please try again.' });
      }
    },
  );

  // POST /api/v1/projects/:id/thumbnail-from-timeline — extract frame at given time
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/thumbnail-from-timeline',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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

  // POST /api/v1/projects/:id/thumbnail/generate-ai — generate a NEW thumbnail
  // IMAGE with an image model (gpt-image-1) from the video's known info
  // (title + topic + SEO summary/keywords) plus an optional creator hint.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/thumbnail/generate-ai',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      if (!(await getOpenAIClient())) {
        return reply.code(400).send({ message: 'AI image generation requires an OpenAI API key' });
      }

      const body = z.object({ hint: z.string().max(500).optional() }).safeParse(request.body ?? {});
      const hint = body.success ? body.data.hint : undefined;

      try {
        if (hint?.trim()) await moderateGenerationInput(hint, { userId: user.id });
        const { generateAiThumbnail } = await import('../../services/generateAiThumbnail.js');
        const thumbnail_url = await generateAiThumbnail(project.id, { hint, userId: user.id });
        const updated = await db.query.projects.findFirst({ where: eq(projects.id, project.id) });
        // `project` is the owned row guaranteed above; fall back to it so the response
        // `project` is never undefined (client types it non-null, reads `.title`).
        return reply.send({ thumbnail_url, project: updated ?? project });
      } catch (err) {
        // Pause / quota / moderation rejections carry their own status + message.
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({ message: err.message });
        }
        logger.error({ err, projectId: project.id }, '[ai-thumbnail] generation failed');
        return reply.code(500).send({ message: (err as Error).message?.slice(0, 200) || 'AI thumbnail generation failed' });
      }
    },
  );

  // POST /api/v1/projects/:id/thumbnail — upload a custom thumbnail image
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/thumbnail',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // DECLARED SIZE FIRST (security-007): free, exact enough, and available before a byte of body
      // is read — so we never begin buffering something already decided against. It is not the real
      // guard (Content-Length can be absent or a lie); `readStreamBounded` below is.
      const declared = declaredTooLarge(request.headers['content-length'], UPLOAD_MAX_BYTES.thumbnail);
      if (declared !== null) {
        return reply.code(413).send({ message: tooLargeMessage('Thumbnail', declared, UPLOAD_MAX_BYTES.thumbnail) });
      }

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });

      const mime = data.mimetype.toLowerCase().split(';')[0].trim();
      if (!ALLOWED_THUMBNAIL_MIME.has(mime)) {
        return reply.code(400).send({ message: 'Only JPEG, PNG, and WebP thumbnails are supported' });
      }

      // The 10 MB limit is unchanged; what changed is WHEN it applies. `buf.length` can only be
      // consulted once the entire file is already in the heap, so the old check refused the
      // request after paying its full memory cost (security-007).
      const buf = await readStreamBounded(data.file, UPLOAD_MAX_BYTES.thumbnail, 'Thumbnail');

      const sourceExt = extname(data.filename || '').replace(/[^a-z0-9.]/gi, '').toLowerCase();
      const ext = ['.jpg', '.jpeg', '.png', '.webp'].includes(sourceExt) ? sourceExt : thumbnailExt(mime);
      const key = `thumbnails/${project.id}/${randomUUID()}${ext}`;

      const thumbnailUrl = await uploadWithFallback(key, buf, mime);

      const [updated] = await db
        .update(projects)
        .set({
          thumbnail_url: thumbnailUrl,
          thumbnail_key: key,
          metadata_status: 'ready',
          updated_at: new Date(),
        })
        .where(eq(projects.id, project.id))
        .returning();
      // `project` was loaded before the update, so its thumbnail_key is the superseded one.
      await deleteSupersededThumbnail(project.thumbnail_key, key);

      return reply.code(201).send(updated);
    },
  );

  // GET /api/v1/projects/:id/frame-preview — returns JPEG of frame at given time (no storage)
  app.get<{ Params: { id: string }; Querystring: { time_seconds?: string } }>(
    '/api/v1/projects/:id/frame-preview',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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
      // Deleting is owner-only — collaborators can edit but not destroy (collab-042).
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Collect child media references BEFORE deleting (the cascade removes the rows).
      const [videos, sims, audios, images, visuals] = await Promise.all([
        db.query.video_files.findMany({ where: eq(video_files.project_id, project.id) }),
        db.query.simulations.findMany({ where: eq(simulations.project_id, project.id) }),
        db.query.audio_files.findMany({ where: eq(audio_files.project_id, project.id) }),
        db.query.image_files.findMany({ where: eq(image_files.project_id, project.id) }),
        // avatar_visuals cascades too, and its rows name real bytes: generated images under
        // images/avatar/{projectId}/ and generated simulations under simulations/avatar/{uuid}/ —
        // the latter deliberately NOT under any project-scoped prefix, so once the row is gone the
        // bytes are unreachable by every sweep that will ever exist. Collected here or lost.
        db.query.avatar_visuals.findMany({ where: eq(avatar_visuals.project_id, project.id) }),
      ]);

      // DB delete FIRST (cascades to child tables). Doing this before storage GC means a
      // DB failure can't leave rows pointing at already-deleted media (review db-003).
      await db.delete(projects).where(eq(projects.id, project.id));
      // No FK on the polymorphic collaborators table — clean up invites explicitly.
      await db.delete(collaborators).where(
        and(eq(collaborators.content_type, 'project'), eq(collaborators.content_id, project.id)),
      );

      // Best-effort storage GC — from R2 and/or local disk, wherever the bytes landed
      // (review backend-003). Helpers swallow + log their own errors.
      await Promise.all([
        // Raw video files + HLS segments (plus the grace-period retirement bookkeeping —
        // the whole hls/{id}/ tree is purged here, so the retention sweep must forget it)
        ...videos.flatMap(v => [
          v.storage_key ? deleteWithFallback(v.storage_key) : null,
          deleteWithPrefixFallback(`hls/${v.id}`),
          deleteHlsRetirementRowsForVideo(v.id),
        ].filter(Boolean)),
        // Simulation file trees
        ...sims.map(s => deleteWithPrefixFallback(s.storage_prefix)),
        // Audio files
        ...audios.map(a => deleteWithFallback(a.storage_key)),
        // Image files
        ...images.map(i => deleteWithFallback(i.storage_key)),
        // Crop analysis artifacts — crop/{videoId}.json, deterministic single objects that no
        // delete path collected. Orphaned forever once the video rows are gone.
        ...videos.map(v => deleteWithFallback(`crop/${v.id}.json`)),
        // Avatar-visual bytes. The `source !== 'editor'` guard is the same one deleteVisual
        // applies: editor-sourced ("basic") rows only MIRROR the project's own media, whose real
        // keys are already being deleted via image_files/simulations above — deleting them twice
        // is harmless, but deleting a mirror that pointed at media the project still legitimately
        // owns would not be, so the guard stays load-bearing.
        ...visuals.filter(av => av.source !== 'editor').flatMap(av => [
          av.image_key ? deleteWithFallback(av.image_key) : null,
          av.sim_storage_prefix ? deleteWithPrefixFallback(av.sim_storage_prefix) : null,
        ].filter(Boolean)),
        // Whole-prefix sweeps for the classes whose writers mint fresh uuids and never delete
        // predecessors. The thumbnail prefix REPLACES the old single-key delete: four writers
        // overwrite projects.thumbnail_key without GC, so the prefix holds every thumbnail the
        // project ever had, and deleting only the current one stranded the rest.
        deleteWithPrefixFallback(`thumbnails/${project.id}`),
        // Caption VTT backups — captions/{projectId}/{videoId}/{uuid}.vtt, re-minted per run.
        deleteWithPrefixFallback(`captions/${project.id}`),
        // Uploaded corpus source documents.
        deleteWithPrefixFallback(`projects/${project.id}/corpus`),
        // Export masters and section intermediates. There is no per-export delete route, and the
        // project_exports rows cascade — after this delete nothing will ever name these keys.
        deleteWithPrefixFallback(`exports/${project.id}`),
        // Avatar b-roll circle images (avatar-circles/{projectId}/*) — previously never deleted.
        deleteWithPrefixFallback(`avatar-circles/${project.id}`),
      ]);

      return reply.code(204).send();
    },
  );

  // POST /api/v1/projects/:id/duplicate — start an independent copy of the whole project.
  //
  // ASYNC, and it returns the DUPLICATION id, not a project id. A full HLS ladder is hundreds of
  // megabytes, so the copy cannot run inside a request; and the destination project row is written
  // only at the very end, in one transaction, so that a failed copy leaves no half-built project to
  // find. The client polls the GET below and navigates when `target_project_id` appears.
  //
  // Owner-only, exactly like DELETE: duplication reads every byte of the project and mints a new
  // one that the requester will own. Collaborators can edit but not fork (collab-042's line).
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/duplicate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { ProjectDuplicationService, duplicateMaxBytes, liveDuplicationFor } =
        await import('../../services/project/ProjectDuplicationService.js');

      // Already running? Return the in-flight job rather than starting a second full media copy —
      // the partial unique index would reject the insert anyway, but answering with the existing
      // job makes a double-click idempotent instead of an error.
      //
      // …unless it is not actually running, which `liveDuplicationFor` is what decides. The copy
      // takes minutes on a driver with no durability, so a deploy or a crash strands the row in
      // `copying`, where the index makes it a PERMANENT block on duplicating this project and the
      // client's poll follows it forever at frozen progress. Answering `already_running` for a row
      // nothing is running is how that became unrecoverable.
      // 42P01 = `project_duplications` does not exist, i.e. migration 056 has been rolled back
      // under an image that still serves this route. That is a DEPLOYED-FEATURE-REMOVED state, not
      // a bug in the request, and it is what 056's rollback notes promise answers cleanly — so it
      // has to be caught HERE and not only around the insert, because this read reaches the table
      // first. Without it the route 500s and the client's poll treats it as a transient failure.
      let inflight: Awaited<ReturnType<typeof liveDuplicationFor>>;
      try {
        inflight = await liveDuplicationFor(project.id);
      } catch (err) {
        if ((err as { code?: string } | null)?.code === '42P01') {
          return reply.code(503).send({ message: 'Duplicating projects is temporarily unavailable.' });
        }
        throw err;
      }
      if (inflight) {
        return reply.code(202).send({ duplication_id: inflight.id, status: inflight.status, already_running: true });
      }

      // The quota check runs HERE, synchronously, so an over-budget project is refused with a
      // reason the user sees instead of a job that fails a minute later in a poll response.
      const plan = await new ProjectDuplicationService().dryRun(project.id);
      if (!plan) return reply.code(404).send({ message: 'Project not found' });
      const cap = duplicateMaxBytes();
      if (plan.estimatedBytes > cap) {
        return reply.code(413).send({
          message: `This project stores about ${Math.round(plan.estimatedBytes / 1e9)} GB of media, which is over the ${Math.round(cap / 1e9)} GB duplication limit.`,
        });
      }
      // Same posture for an object the storage layer cannot copy at all: refused up front with the
      // file named, rather than a job that spends minutes reaching a 400 no retry can pass.
      const tooBig = ProjectDuplicationService.oversizeRefusal(plan);
      if (tooBig) return reply.code(tooBig.statusCode).send({ message: tooBig.message });

      try {
        const [row] = await db.insert(project_duplications).values({
          source_project_id: project.id,
          requested_by: user.id,
          status: 'queued',
          objects_total: plan.storage.length,
          bytes_total: plan.estimatedBytes,
        }).returning();
        enqueueJob('project_duplicate', { duplicationId: row.id });
        return reply.code(202).send({ duplication_id: row.id, status: 'queued' });
      } catch (err) {
        // 23505 = the in-flight partial unique index; someone else won the race between the read
        // above and this insert.
        if ((err as { code?: string } | null)?.code === '23505') {
          const [existing] = await db.select().from(project_duplications).where(and(
            eq(project_duplications.source_project_id, project.id),
            inArray(project_duplications.status, ['queued', 'copying', 'committing']),
          ));
          if (existing) {
            return reply.code(202).send({ duplication_id: existing.id, status: existing.status, already_running: true });
          }
        }
        // Same rolled-back-migration case as the read above: the table can also vanish between
        // that read and this insert.
        if ((err as { code?: string } | null)?.code === '42P01') {
          return reply.code(503).send({ message: 'Duplicating projects is temporarily unavailable.' });
        }
        // See the note on the shared `logger` in the enhance-thumbnail handler above:
        // `request.log` is a no-op under `logger: false` (observability-001).
        logger.error({ err, projectId: project.id }, 'failed to start project duplication');
        return reply.code(500).send({ message: 'Could not start the duplication. Please try again.' });
      }
    },
  );

  // GET /api/v1/projects/:id/duplications/:duplicationId — progress for one duplication.
  app.get<{ Params: { id: string; duplicationId: string } }>(
    '/api/v1/projects/:id/duplications/:duplicationId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Same rolled-back-056 case the POST handles. It matters more here: the client polls this
      // route, and an unhandled 500 would spend its whole consecutive-failure budget before
      // reporting anything. A 503 spends the same budget but ends on a statement that is true —
      // the copy may well have finished; what is gone is our ability to say so.
      let row: typeof project_duplications.$inferSelect | undefined;
      try {
        [row] = await db.select().from(project_duplications).where(and(
          eq(project_duplications.id, request.params.duplicationId),
          eq(project_duplications.source_project_id, project.id),
        ));
      } catch (err) {
        if ((err as { code?: string } | null)?.code === '42P01') {
          return reply.code(503).send({ message: 'Duplicating projects is temporarily unavailable.' });
        }
        throw err;
      }
      if (!row) return reply.code(404).send({ message: 'Duplication not found' });

      return reply.send({
        id: row.id,
        status: row.status,
        target_project_id: row.target_project_id,
        objects_total: row.objects_total,
        objects_copied: row.objects_copied,
        error: row.error,
      });
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
