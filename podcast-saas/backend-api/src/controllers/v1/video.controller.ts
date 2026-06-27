import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { uploadStreamWithFallback } from '../../services/storage/uploadStreamWithFallback.js';
import { deleteWithFallback, deleteWithPrefixFallback } from '../../services/storage/deleteWithFallback.js';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';
import { runVideoTranscode } from '../../services/video/runVideoTranscode.js';
import { enqueueCropForProject } from '../../services/crop/runCropAnalysis.js';
import { enqueueCaptionsForProject } from '../../services/captions/CaptionService.js';

/**
 * Kick off all background processing for a freshly-uploaded video on the WRITE path:
 * HLS transcode, smart-crop, and captions. Captions/crop were previously triggered
 * lazily from buildPlayerConfig on every read/preview (review perf-002) — they belong
 * here, once, when the source actually arrives ("captions at processing time").
 */
function enqueueVideoProcessing(videoFileId: string, projectId: string): void {
  setImmediate(() => {
    runVideoTranscode(videoFileId).catch((err) => {
      logger.warn({ err, video_file_id: videoFileId }, 'In-process HLS transcode failed');
    });
  });
  enqueueCaptionsForProject(projectId).catch(() => { /* best-effort */ });
  enqueueCropForProject(projectId).catch(() => { /* best-effort */ });
}

const TEN_GB = 10 * 1024 * 1024 * 1024;

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // POST /api/v1/projects/:id/videos/upload — multipart stream directly to storage
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload',
    { preHandler: [firebaseAuthMiddleware], bodyLimit: TEN_GB },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      let fileSize = 0;

      // Read field parts before the file to capture file_size
      // FormData order from client: file_size field → file
      const parts = request.parts({ limits: { fileSize: TEN_GB } });

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'file_size') {
          fileSize = parseInt(part.value as string) || 0;
          continue;
        }

        if (part.type === 'file') {
          const ext = (part.filename ?? 'upload').split('.').pop() ?? 'mp4';
          const storage_key = `videos/${project.id}/${randomUUID()}.${ext}`;

          // Stream the upload to durable local disk first, then best-effort
          // re-upload to R2. A read-only R2 token (PutObject → AccessDenied) keeps
          // the local copy, which is served via /video-proxy → /video-raw, so the
          // upload never hard-fails. (A source stream can't be replayed, so we
          // can't try R2 first and fall back.)
          try {
            await uploadStreamWithFallback(storage_key, part.file, part.mimetype, fileSize || undefined);
          } catch (err) {
            logger.error({ err }, 'Video stream upload failed');
            return reply.code(500).send({ message: 'Storage upload failed' });
          }

          const [videoFile] = await db
            .insert(video_files)
            .values({
              project_id: project.id,
              filename: part.filename ?? `video.${ext}`,
              file_size: fileSize || null,
              storage_key,
              status: 'ready',
              hls_status: 'pending',
            })
            .returning();

          // Transcode + crop + captions on the write path (non-blocking).
          enqueueVideoProcessing(videoFile.id, project.id);

          // Include a presigned raw URL so the editor can play the video immediately
          // without waiting for the first HLS-status polling cycle.
          const raw_url = videoFile.storage_key
            ? await storage.getPresignedDownloadUrl(videoFile.storage_key, 3600).catch(() => null)
            : null;

          return reply.code(201).send({ ...videoFile, raw_url });
        }
      }

      return reply.code(400).send({ message: 'No file received' });
    },
  );

  // POST /api/v1/projects/:id/videos/upload-url — Phase 2: presigned direct-to-cloud upload.
  // Returns a short-lived PUT URL + the server-constructed key; the browser PUTs the file
  // straight to object storage (no bytes through Node). No DB row yet — created on confirm.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload-url',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { filename?: string; content_type?: string };
      const ext = (body.filename ?? 'upload').split('.').pop()?.toLowerCase() ?? 'mp4';
      const content_type = body.content_type || 'video/mp4';
      // Server-constructed key — the client can never choose an arbitrary path.
      const storage_key = `videos/${project.id}/${randomUUID()}.${ext}`;

      try {
        const upload_url = await storage.getPresignedUploadUrl(storage_key, content_type, 3600);
        return reply.send({ upload_url, storage_key, content_type });
      } catch (err) {
        logger.error({ err }, 'Failed to mint presigned upload URL');
        return reply.code(503).send({ message: 'Direct upload is unavailable; use multipart upload' });
      }
    },
  );

  // POST /api/v1/projects/:id/videos/confirm — Phase 2: finalize a presigned upload.
  // Verifies the object landed, creates the video_files row, and enqueues processing.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/confirm',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { storage_key?: string; filename?: string; file_size?: number };
      const storage_key = body.storage_key ?? '';
      // The key must be one we minted for THIS project (defends against confirming arbitrary keys).
      if (!storage_key.startsWith(`videos/${project.id}/`)) {
        return reply.code(400).send({ message: 'Invalid storage key' });
      }
      // Cheap existence check (LIST by exact key) — confirm the bytes actually landed.
      try {
        const found = await storage.listObjects(storage_key);
        if (!found.includes(storage_key)) {
          return reply.code(400).send({ message: 'Uploaded object not found in storage' });
        }
      } catch (err) {
        logger.error({ err, storage_key }, 'confirm: existence check failed');
        return reply.code(502).send({ message: 'Could not verify the uploaded object' });
      }

      const ext = storage_key.split('.').pop() ?? 'mp4';
      const [videoFile] = await db
        .insert(video_files)
        .values({
          project_id: project.id,
          filename: body.filename ?? `video.${ext}`,
          file_size: body.file_size ?? null,
          storage_key,
          status: 'ready',
          hls_status: 'pending',
        })
        .returning();

      enqueueVideoProcessing(videoFile.id, project.id);

      const raw_url = await storage.getPresignedDownloadUrl(storage_key, 3600).catch(() => null);
      return reply.code(201).send({ ...videoFile, raw_url });
    },
  );

  // GET /api/v1/projects/:id/videos/:videoId/hls-status
  app.get<{ Params: { id: string; videoId: string } }>(
    '/api/v1/projects/:id/videos/:videoId/hls-status',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const videoFile = await db.query.video_files.findFirst({
        where: and(
          eq(video_files.id, request.params.videoId),
          eq(video_files.project_id, project.id),
        ),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video not found' });

      // Prefer master (all tiers). Fall back to 360p URL for early playback — mirrors player-config logic.
      const hls_url = videoFile.hls_master_key
        ? storage.getPublicUrl(videoFile.hls_master_key)
        : videoFile.hls_360p_key
          ? storage.getPublicUrl(videoFile.hls_360p_key)
          : null;

      // Presigned download URL for the raw source file — lets the browser play it directly
      // without auth headers (presigned URL carries credentials in query string).
      // TTL 3600s is enough for an editing session.
      const raw_url = videoFile.storage_key
        ? await storage.getPresignedDownloadUrl(videoFile.storage_key, 3600)
        : null;

      return reply.send({
        id: videoFile.id,
        hls_status: videoFile.hls_status,
        hls_url,
        raw_url,
        duration_sec: videoFile.duration_sec,
        hls_error: videoFile.hls_error,
        hls_current_tier: videoFile.hls_current_tier ?? null,
        hls_360p_ready: !!videoFile.hls_360p_key,
      });
    },
  );

  // GET /api/v1/projects/:id/videos — list all video files
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const files = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
        orderBy: [desc(video_files.created_at)],
      });

      // Generate presigned raw URLs and HLS URLs in parallel for all videos.
      // Presigned URL generation is a local HMAC op (no outbound HTTP), so doing
      // all N in parallel adds <5ms overhead — worth it to make the editor load instantly.
      const result = await Promise.all(files.map(async (v) => ({
        ...v,
        hls_url: (v.hls_master_key && v.hls_status === 'ready')
          ? storage.getPublicUrl(v.hls_master_key)
          : null,
        raw_url: v.storage_key
          ? await storage.getPresignedDownloadUrl(v.storage_key, 3600).catch(() => null)
          : null,
      })));

      return reply.send(result);
    },
  );

  // DELETE /api/v1/projects/:id/videos/:videoId
  app.delete<{ Params: { id: string; videoId: string } }>(
    '/api/v1/projects/:id/videos/:videoId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const videoFile = await db.query.video_files.findFirst({
        where: and(
          eq(video_files.id, request.params.videoId),
          eq(video_files.project_id, project.id),
        ),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video not found' });

      // Delete raw source file (from R2 and/or local — wherever the bytes landed)
      if (videoFile.storage_key) {
        await deleteWithFallback(videoFile.storage_key);
      }
      // Delete all HLS segments and playlists (hls/{videoId}/*)
      await deleteWithPrefixFallback(`hls/${videoFile.id}`);

      await db.delete(video_files).where(eq(video_files.id, videoFile.id));

      return reply.code(204).send();
    },
  );

  // POST /api/v1/projects/:id/videos/:videoId/retranscode — re-trigger HLS for a stuck video
  app.post<{ Params: { id: string; videoId: string } }>(
    '/api/v1/projects/:id/videos/:videoId/retranscode',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const videoFile = await db.query.video_files.findFirst({
        where: and(
          eq(video_files.id, request.params.videoId),
          eq(video_files.project_id, project.id),
        ),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video not found' });
      if (!videoFile.storage_key) return reply.code(400).send({ message: 'Video has no source file' });

      // Reset HLS state so the job starts clean
      await db
        .update(video_files)
        .set({
          hls_status: 'pending',
          hls_master_key: null,
          hls_360p_key: null,
          hls_current_tier: null,
          hls_error: null,
          hls_started_at: null,
          hls_finished_at: null,
        })
        .where(eq(video_files.id, videoFile.id));

      console.log(`[HLS] Retranscode requested  video_file_id=${videoFile.id}`);
      setImmediate(() => {
        runVideoTranscode(videoFile.id).catch((err) => {
          console.error(`[HLS] Retranscode failed:`, err);
          logger.warn({ err, video_file_id: videoFile.id }, 'Retranscode failed');
        });
      });

      return reply.send({ queued: true, video_file_id: videoFile.id });
    },
  );

  // POST /api/v1/projects/:id/recrop — force re-run crop analysis for all videos
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/recrop',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Clear crop_source_hash so the idempotency check doesn't skip re-runs
      await db
        .update(video_files)
        .set({ crop_source_hash: null, crop_status: 'none', crop_error: null })
        .where(eq(video_files.project_id, project.id));

      setImmediate(() => {
        enqueueCropForProject(project.id).catch((err) => {
          logger.warn({ err, project_id: project.id }, 'recrop enqueue failed');
        });
      });

      return reply.send({ queued: true });
    },
  );
}
