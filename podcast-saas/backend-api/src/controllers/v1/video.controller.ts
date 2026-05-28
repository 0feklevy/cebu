import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // POST /api/v1/projects/:id/videos/upload-url — get presigned PUT URL for direct upload
  app.post<{
    Params: { id: string };
    Body: { filename: string; file_size: number; content_type: string };
  }>(
    '/api/v1/projects/:id/videos/upload-url',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { filename, file_size, content_type } = request.body;
      if (!filename || !content_type) {
        return reply.code(400).send({ message: 'filename and content_type are required' });
      }

      const ext = filename.split('.').pop() ?? 'bin';
      const storage_key = `videos/${project.id}/${randomUUID()}.${ext}`;

      const upload_url = await storage.getPresignedUploadUrl(storage_key, content_type, 3600);

      return reply.send({ upload_url, storage_key });
    },
  );

  // POST /api/v1/projects/:id/videos/confirm — confirm upload complete, create record
  app.post<{
    Params: { id: string };
    Body: { storage_key: string; filename: string; file_size: number };
  }>(
    '/api/v1/projects/:id/videos/confirm',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { storage_key, filename, file_size } = request.body;
      if (!storage_key || !filename) {
        return reply.code(400).send({ message: 'storage_key and filename are required' });
      }

      const [videoFile] = await db
        .insert(video_files)
        .values({
          project_id: project.id,
          filename,
          file_size: file_size ?? null,
          storage_key,
          status: 'ready',
        })
        .returning();

      return reply.code(201).send(videoFile);
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

      return reply.send(files);
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

      if (videoFile.storage_key) {
        await storage.deleteFile(videoFile.storage_key).catch((err) => {
          logger.warn({ err }, 'Failed to delete video from storage');
        });
      }

      await db.delete(video_files).where(eq(video_files.id, videoFile.id));

      return reply.code(204).send();
    },
  );
}
