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

/**
 * Kick off background processing for a freshly-uploaded (or replaced) video on the WRITE
 * path. Transcode runs first; it then decides — post-transcode — whether to (re)run
 * captions + smart-crop, skipping them when a replacement's media is essentially unchanged
 * (see runVideoTranscode's skip-if-similar). Captions/crop used to be triggered lazily from
 * buildPlayerConfig on every read/preview (review perf-002); they belong on the write path.
 */
function enqueueVideoProcessing(videoFileId: string): void {
  setImmediate(() => {
    runVideoTranscode(videoFileId).catch((err) => {
      logger.warn({ err, video_file_id: videoFileId }, 'In-process HLS transcode failed');
    });
  });
}

const TEN_GB = 10 * 1024 * 1024 * 1024;

// Multipart part size: 8 MiB. Comfortably above S3's 5 MiB per-part minimum (every part
// except the last must be ≥5 MiB) and small enough to keep memory/retries cheap in the
// browser. A 5 GB video → ~640 parts, well under the 10,000-part S3 limit.
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

// Hard ceiling we advertise/accept for a single upload. The REAL cap is the Supabase
// bucket's file_size_limit (set in the dashboard — see the solution doc); this is a
// fast, friendly pre-check so an over-limit upload fails immediately with a clear
// message instead of a cryptic storage 4xx mid-transfer. Overridable via env if the
// bucket limit is raised/lowered. Keep these in sync with the dashboard value.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || TEN_GB;

function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // Resolve the project for the authenticated user, or null if it isn't theirs / absent.
  async function findOwnedProject(projectId: string, userId: string) {
    return db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.created_by, userId)),
    });
  }

  // Create the video_files row for an upload that has fully landed in cloud storage,
  // kick off processing, and return the row + a presigned raw URL (shared by the
  // single-PUT /confirm path and the multipart /complete path).
  async function finalizeUpload(
    projectId: string,
    storage_key: string,
    filename: string | undefined,
    file_size: number | undefined,
    replaceVideoId?: string,
  ) {
    const ext = storage_key.split('.').pop() ?? 'mp4';

    // REPLACE: swap the media onto an EXISTING video, keeping its id so timeline clips
    // that reference it stay attached. The old raw file is GC'd now; the old HLS tree is
    // left for runVideoTranscode to flip+GC atomically once the new transcode is ready
    // (so playback keeps working during re-processing). Re-crop runs from scratch.
    if (replaceVideoId) {
      const existing = await db.query.video_files.findFirst({
        where: and(eq(video_files.id, replaceVideoId), eq(video_files.project_id, projectId)),
      });
      if (!existing) return null;

      const oldStorageKey = existing.storage_key;
      const [updated] = await db
        .update(video_files)
        .set({
          storage_key,
          filename: filename ?? existing.filename,
          file_size: file_size ?? existing.file_size,
          status: 'ready',
          hls_status: 'pending',
          hls_error: null,
          crop_status: 'none',
          crop_source_hash: null,
        })
        .where(eq(video_files.id, replaceVideoId))
        .returning();

      if (oldStorageKey && oldStorageKey !== storage_key) deleteWithFallback(oldStorageKey).catch(() => {});
      enqueueVideoProcessing(updated.id);
      const raw_url = await storage.getPresignedDownloadUrl(storage_key, 3600).catch(() => null);
      return { ...updated, raw_url };
    }

    const [videoFile] = await db
      .insert(video_files)
      .values({
        project_id: projectId,
        filename: filename ?? `video.${ext}`,
        file_size: file_size ?? null,
        storage_key,
        status: 'ready',
        hls_status: 'pending',
      })
      .returning();

    enqueueVideoProcessing(videoFile.id);

    const raw_url = await storage.getPresignedDownloadUrl(storage_key, 3600).catch(() => null);
    return { ...videoFile, raw_url };
  }

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

          // Transcode (+ post-transcode captions/crop) on the write path (non-blocking).
          enqueueVideoProcessing(videoFile.id);

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
  // straight to object storage (no bytes through Node). For SMALL files only — large files
  // use the multipart routes below (a single PUT is capped by the bucket's file_size_limit).
  // No DB row yet — created on confirm.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload-url',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await findOwnedProject(request.params.id, user.id);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { filename?: string; content_type?: string; file_size?: number };

      // Friendly, immediate over-limit error (no local-disk fallback exists, so we must
      // not let an over-cap upload fail silently / cryptically against storage).
      if (typeof body.file_size === 'number' && body.file_size > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          message: `Video is too large (${humanBytes(body.file_size)}). The maximum is ${humanBytes(MAX_UPLOAD_BYTES)}.`,
        });
      }

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

  // POST /api/v1/projects/:id/videos/confirm — Phase 2: finalize a presigned single-PUT upload.
  // Verifies the object landed, creates the video_files row, and enqueues processing.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/confirm',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await findOwnedProject(request.params.id, user.id);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { storage_key?: string; filename?: string; file_size?: number; replace_video_id?: string };
      const storage_key = body.storage_key ?? '';
      // The key must be one we minted for THIS project (defends against confirming arbitrary keys).
      if (!storage_key.startsWith(`videos/${project.id}/`)) {
        return reply.code(400).send({ message: 'Invalid storage key' });
      }
      // Cheap existence check (LIST by exact key) — confirm the bytes actually landed.
      // Non-fatal on a storage API hiccup: the client only confirms after a successful
      // PUT, so proceed and let transcode surface a genuine miss rather than rejecting.
      try {
        const found = await storage.listObjects(storage_key);
        if (!found.includes(storage_key)) {
          return reply.code(400).send({ message: 'Uploaded object not found in storage' });
        }
      } catch (err) {
        logger.warn({ err, storage_key }, 'confirm: existence check errored — proceeding');
      }

      const videoFile = await finalizeUpload(project.id, storage_key, body.filename, body.file_size, body.replace_video_id);
      if (!videoFile) return reply.code(404).send({ message: 'Video to replace not found' });
      return reply.code(201).send(videoFile);
    },
  );

  // ── Multipart upload (large videos) ────────────────────────────────────────────
  // A single presigned PUT is capped by Supabase's bucket file_size_limit, so big
  // videos upload in parts the way fiji handles large files: start → presign each part
  // → browser PUTs parts straight to storage → complete (or abort). Everything is
  // server-key-scoped and cloud-only; no bytes pass through Node.

  // POST /…/videos/upload/multipart/start — begin a multipart upload.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload/multipart/start',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await findOwnedProject(request.params.id, user.id);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { filename?: string; content_type?: string; file_size?: number };

      // Same friendly over-limit guard as the single-PUT path — there is no local fallback.
      if (typeof body.file_size === 'number' && body.file_size > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          message: `Video is too large (${humanBytes(body.file_size)}). The maximum is ${humanBytes(MAX_UPLOAD_BYTES)}.`,
        });
      }

      const ext = (body.filename ?? 'upload').split('.').pop()?.toLowerCase() ?? 'mp4';
      const content_type = body.content_type || 'video/mp4';
      const storage_key = `videos/${project.id}/${randomUUID()}.${ext}`;

      try {
        const upload_id = await storage.createMultipartUpload(storage_key, content_type);
        return reply.send({ upload_id, storage_key, content_type, part_size: MULTIPART_PART_SIZE });
      } catch (err) {
        // The local-disk adapter throws here (multipart unsupported) — 501 tells the
        // client to fall back to the single-PUT path (used in local dev only).
        const message = err instanceof Error ? err.message : String(err);
        if (/not supported/i.test(message)) {
          return reply.code(501).send({ message: 'Multipart upload is not supported by this storage backend' });
        }
        logger.error({ err, storage_key }, 'Failed to start multipart upload');
        return reply.code(503).send({ message: 'Could not start the upload. Please try again.' });
      }
    },
  );

  // POST /…/videos/upload/multipart/part-url — presign one part PUT.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload/multipart/part-url',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await findOwnedProject(request.params.id, user.id);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { storage_key?: string; upload_id?: string; part_number?: number };
      const storage_key = body.storage_key ?? '';
      const part_number = Number(body.part_number);
      if (!storage_key.startsWith(`videos/${project.id}/`) || !body.upload_id) {
        return reply.code(400).send({ message: 'Invalid storage key or upload id' });
      }
      if (!Number.isInteger(part_number) || part_number < 1 || part_number > 10000) {
        return reply.code(400).send({ message: 'Invalid part number' });
      }

      try {
        const url = await storage.getPresignedUploadPartUrl(storage_key, body.upload_id, part_number, 3600);
        return reply.send({ url, part_number });
      } catch (err) {
        logger.error({ err, storage_key }, 'Failed to presign upload part');
        return reply.code(503).send({ message: 'Could not sign the upload part. Please retry.' });
      }
    },
  );

  // POST /…/videos/upload/multipart/complete — stitch the parts + finalize.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload/multipart/complete',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await findOwnedProject(request.params.id, user.id);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as {
        storage_key?: string;
        upload_id?: string;
        filename?: string;
        file_size?: number;
        replace_video_id?: string;
        parts?: { partNumber?: number; etag?: string }[];
      };
      const storage_key = body.storage_key ?? '';
      if (!storage_key.startsWith(`videos/${project.id}/`) || !body.upload_id) {
        return reply.code(400).send({ message: 'Invalid storage key or upload id' });
      }
      const parts = (body.parts ?? [])
        .filter((p): p is { partNumber: number; etag: string } =>
          typeof p?.partNumber === 'number' && typeof p?.etag === 'string' && p.etag.length > 0)
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
      if (parts.length === 0) {
        return reply.code(400).send({ message: 'No uploaded parts to complete' });
      }

      try {
        await storage.completeMultipartUpload(storage_key, body.upload_id, parts);
      } catch (err) {
        // A size-limit breach surfaces here (or on the part PUT) when the bucket cap is
        // exceeded; report it clearly since there's no local-disk fallback to absorb it.
        logger.error({ err, storage_key }, 'Failed to complete multipart upload');
        return reply.code(502).send({
          message: 'The upload could not be finalized. The file may exceed the storage size limit.',
        });
      }

      const videoFile = await finalizeUpload(project.id, storage_key, body.filename, body.file_size, body.replace_video_id);
      if (!videoFile) return reply.code(404).send({ message: 'Video to replace not found' });
      return reply.code(201).send(videoFile);
    },
  );

  // POST /…/videos/upload/multipart/abort — drop an in-progress multipart upload.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload/multipart/abort',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await findOwnedProject(request.params.id, user.id);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { storage_key?: string; upload_id?: string };
      const storage_key = body.storage_key ?? '';
      if (!storage_key.startsWith(`videos/${project.id}/`) || !body.upload_id) {
        return reply.code(400).send({ message: 'Invalid storage key or upload id' });
      }

      // Best-effort cleanup — never fail the client over an abort.
      await storage.abortMultipartUpload(storage_key, body.upload_id).catch((err) => {
        logger.warn({ err, storage_key }, 'multipart abort failed (orphaned parts may linger)');
      });
      return reply.code(204).send();
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
