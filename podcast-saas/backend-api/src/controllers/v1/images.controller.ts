import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, image_files } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { uploadWithFallback } from '../../services/storage/uploadWithFallback.js';
import { randomUUID } from 'crypto';
import { extname } from 'path';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

export async function registerImageRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/projects/:id/images — upload a still image
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/images',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });

      const mime = data.mimetype.toLowerCase().split(';')[0].trim();
      if (!ALLOWED_MIME.has(mime)) {
        return reply.code(400).send({ message: 'Only JPEG, PNG, WebP, and GIF images are supported' });
      }

      const ext  = extname(data.filename || 'image').replace(/[^a-z0-9.]/gi, '').toLowerCase() || '.jpg';
      const key  = `images/${project.id}/${randomUUID()}${ext}`;
      const buf  = await data.toBuffer();

      const publicUrl = await uploadWithFallback(key, buf, mime);

      // Auto-compute 16:9 crop from image dimensions if we can determine them.
      // We store fractions (0–1). Default to full image; frontend refines with crop editor.
      const [row] = await db
        .insert(image_files)
        .values({
          project_id:   project.id,
          filename:     data.filename || `image${ext}`,
          storage_key:  key,
          original_url: publicUrl,
          crop_x: 0,
          crop_y: 0,
          crop_w: 1,
          crop_h: 1,
        })
        .returning();

      return reply.code(201).send(row);
    },
  );

  // GET /api/v1/projects/:id/images — list images for a project
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/images',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const images = await db.query.image_files.findMany({
        where: eq(image_files.project_id, project.id),
        orderBy: (t, { desc }) => [desc(t.created_at)],
      });
      return reply.send(images);
    },
  );

  // PATCH /api/v1/projects/:id/images/:imageId — update crop region
  app.patch<{ Params: { id: string; imageId: string } }>(
    '/api/v1/projects/:id/images/:imageId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; imageId: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = z.object({
        crop_x: z.number().min(0).max(1),
        crop_y: z.number().min(0).max(1),
        crop_w: z.number().min(0.01).max(1),
        crop_h: z.number().min(0.01).max(1),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(image_files)
        .set(body.data)
        .where(and(eq(image_files.id, request.params.imageId), eq(image_files.project_id, project.id)))
        .returning();

      if (!updated) return reply.code(404).send({ message: 'Image not found' });
      return reply.send(updated);
    },
  );

  // DELETE /api/v1/projects/:id/images/:imageId
  app.delete<{ Params: { id: string; imageId: string } }>(
    '/api/v1/projects/:id/images/:imageId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; imageId: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      await db
        .delete(image_files)
        .where(and(eq(image_files.id, request.params.imageId), eq(image_files.project_id, project.id)));
      return reply.code(204).send();
    },
  );
}
