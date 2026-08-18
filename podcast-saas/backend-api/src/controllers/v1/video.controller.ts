import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { video_files } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, type CollabUser } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { uploadStreamWithFallback } from '../../services/storage/uploadStreamWithFallback.js';
import { deleteWithFallback, deleteWithPrefixFallback } from '../../services/storage/deleteWithFallback.js';
import { deleteHlsRetirementRowsForVideo } from '../../services/video/hlsRetention.js';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';
import { enqueueCropForProject } from '../../services/crop/runCropAnalysis.js';
import { enqueueJob } from '../../queue/index.js';
import {
  humanBytes,
  parseNginxSize,
  PROXY_BODY_LIMIT_BYTES,
  streamUploadMaxFileBytes,
} from '../../services/security/uploadLimits.js';

/**
 * Kick off background processing for a freshly-uploaded (or replaced) video on the WRITE
 * path. Transcode runs first; it then decides — post-transcode — whether to (re)run
 * captions + smart-crop, skipping them when a replacement's media is essentially unchanged
 * (see runVideoTranscode's skip-if-similar). Captions/crop used to be triggered lazily from
 * buildPlayerConfig on every read/preview (review perf-002); they belong on the write path.
 */
function enqueueVideoProcessing(videoFileId: string): void {
  enqueueJob('transcode', { videoFileId });
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

// ── The proxied streaming route's REAL ceiling ────────────────────────────────
//
// `MAX_UPLOAD_BYTES` above is the bucket's cap, and it applies to the paths where the
// browser talks to storage directly (presigned PUT, S3 multipart) — those never touch our
// reverse proxy. The multipart STREAMING route does: every byte crosses nginx, whose
// `client_max_body_size` is `MAX_UPLOAD_SIZE` (deploy/.env, default `2g`; the http-level
// safety default in deploy/nginx/nginx.conf is `2g` too). Advertising 10 GB on a route
// nginx refuses above 2 GB means the client uploads and then dies at the proxy with a 413
// it cannot explain.
//
// nginx is the honest constraint here, and it is not raised, for three reasons:
//   1. `proxy_request_buffering` is on (nginx default; nothing in deploy/nginx disables it),
//      so nginx spools the WHOLE body to VM disk before the backend sees a byte — and
//      uploadStreamWithFallback then writes a second copy to local disk. A 10 GB proxied
//      upload needs ~20 GB of transient VM disk this host does not have.
//   2. Files that big already have a path that never crosses nginx: presigned single-PUT
//      and S3 multipart go browser→bucket, and keep the full MAX_UPLOAD_BYTES cap.
//   3. This route is the client's documented *fallback* (client-web VideoUploader:
//      "Legacy path: stream the file through the API … Used as a fallback"), so it does not
//      need to carry the largest uploads.
//
// So the route's limit is derived from the proxy's, and the over-limit answer is an
// immediate 413 with a message that names the number — never bytes accepted and dropped.

// The derivation itself now lives in services/security/uploadLimits.ts, where the other four
// upload routes read it too — one derivation, so the proxy limit and every app limit cannot
// drift apart. Re-exported here because this is where it was introduced and where its tests
// (videoUploadLimits.test.ts) still address it.
export { parseNginxSize, streamUploadMaxFileBytes, PROXY_BODY_LIMIT_BYTES, humanBytes };

const STREAM_MAX_FILE_BYTES = streamUploadMaxFileBytes({
  proxyBodyLimitBytes: PROXY_BODY_LIMIT_BYTES,
  appMaxBytes: MAX_UPLOAD_BYTES,
});

/** One wording for every streaming-route rejection, so the client can show the real number. */
function tooLargeForProxy(observed: number): { message: string } {
  return {
    message:
      `Video is too large for the upload proxy (${humanBytes(observed)}). ` +
      `The maximum for this route is ${humanBytes(STREAM_MAX_FILE_BYTES)}. ` +
      'Larger videos must use the direct-to-storage upload.',
  };
}

// Accept a client-measured duration only when it's a sane, positive number of seconds (≤24h).
// The transcode probe remains authoritative; this just seeds a good value at insert so the editor
// timeline and published player are correct immediately instead of null-until-transcode. A bad or
// hostile value is dropped (undefined → stored null, as before). (timeline-50s-cap fix)
function sanitizeDurationSec(d: unknown): number | undefined {
  return typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= 86400 ? d : undefined;
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // Resolve the project the authenticated user may edit (creator OR invited collaborator),
  // or undefined if it isn't editable by them / absent.
  async function findOwnedProject(projectId: string, user: CollabUser) {
    return editableProject(projectId, user);
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
    durationSec?: number,
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
        // Seed the client-measured length so the timeline/player are correct pre-transcode; the
        // transcode probe overwrites it with the authoritative value (runVideoTranscode). (timeline-50s-cap fix)
        duration_sec: durationSec ?? null,
      })
      .returning();

    enqueueVideoProcessing(videoFile.id);

    const raw_url = await storage.getPresignedDownloadUrl(storage_key, 3600).catch(() => null);
    return { ...videoFile, raw_url };
  }

  // POST /api/v1/projects/:id/videos/upload — multipart stream directly to storage
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/videos/upload',
    { preHandler: [firebaseAuthMiddleware], bodyLimit: PROXY_BODY_LIMIT_BYTES },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Earliest possible refusal: the declared envelope size, before a single part is read.
      // nginx would 413 this same request; answering here means the client gets a message
      // that names the limit instead of a proxy error page, and we never start spooling a
      // body we cannot keep.
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > PROXY_BODY_LIMIT_BYTES) {
        return reply.code(413).send(tooLargeForProxy(declared));
      }

      let fileSize = 0;

      // Read field parts before the file to capture file_size
      // FormData order from client: file_size field → file
      const parts = request.parts({ limits: { fileSize: STREAM_MAX_FILE_BYTES } });

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'file_size') {
          fileSize = parseInt(part.value as string) || 0;
          // The client sends file_size BEFORE the file part, so this refuses while the body
          // is still arriving rather than after the whole transfer.
          if (fileSize > STREAM_MAX_FILE_BYTES) {
            return reply.code(413).send(tooLargeForProxy(fileSize));
          }
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
      const project = await findOwnedProject(request.params.id, user);
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
      const project = await findOwnedProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as { storage_key?: string; filename?: string; file_size?: number; replace_video_id?: string; duration_sec?: number };
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

      const videoFile = await finalizeUpload(project.id, storage_key, body.filename, body.file_size, body.replace_video_id, sanitizeDurationSec(body.duration_sec));
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
      const project = await findOwnedProject(request.params.id, user);
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
      const project = await findOwnedProject(request.params.id, user);
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
      const project = await findOwnedProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = (request.body ?? {}) as {
        storage_key?: string;
        upload_id?: string;
        filename?: string;
        file_size?: number;
        replace_video_id?: string;
        duration_sec?: number;
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

      const videoFile = await finalizeUpload(project.id, storage_key, body.filename, body.file_size, body.replace_video_id, sanitizeDurationSec(body.duration_sec));
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
      const project = await findOwnedProject(request.params.id, user);
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
      const project = await editableProject(request.params.id, user);
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
      const project = await editableProject(request.params.id, user);
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
      const project = await editableProject(request.params.id, user);
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
      // The whole hls/{id}/ tree is gone — drop any pending grace-period retirement rows so
      // the retention sweep (migration 053) isn't left pointing at already-deleted prefixes.
      await deleteHlsRetirementRowsForVideo(videoFile.id);

      await db.delete(video_files).where(eq(video_files.id, videoFile.id));

      return reply.code(204).send();
    },
  );

  // POST /api/v1/projects/:id/videos/:videoId/retranscode — re-trigger HLS for a stuck video.
  //
  // NO IN-REPO CALLER, DELIBERATELY (types-008). An audit flagged this as dead weight; it is not.
  // Unlike a dead type, a registered route is REACHABLE — this is the operator escape hatch for a
  // video whose `hls_status` is wedged, invoked by hand against the API. Its sibling `/recrop`
  // reached a UI button and this one never did, which is what makes it look accidental rather
  // than intentional. Deleting it would remove the only repair path for a failure mode this
  // service demonstrably has, so it stays and says so here instead.
  app.post<{ Params: { id: string; videoId: string } }>(
    '/api/v1/projects/:id/videos/:videoId/retranscode',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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
      enqueueJob('transcode', { videoFileId: videoFile.id });

      return reply.send({ queued: true, video_file_id: videoFile.id });
    },
  );

  // POST /api/v1/projects/:id/recrop — force re-run crop analysis for all videos
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/recrop',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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
