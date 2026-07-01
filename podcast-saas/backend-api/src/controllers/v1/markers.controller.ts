import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, timeline_markers } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';

// Editor timeline markers (Focus 5b). Premiere-style flags dropped at a point on the timeline
// (Flag button or "m" hotkey) to leave a note for the editor. Owner-only, scoped to the project.

export async function registerMarkersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/projects/:id/markers
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/markers',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const markers = await db.query.timeline_markers.findMany({
        where: eq(timeline_markers.project_id, project.id),
        orderBy: [asc(timeline_markers.at_sec)],
      });
      return markers;
    },
  );

  // POST /api/v1/projects/:id/markers
  app.post<{ Params: { id: string }; Body: { at_sec?: number; label?: string | null; notes?: string | null; color?: string | null } }>(
    '/api/v1/projects/:id/markers',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { at_sec, label, notes, color } = request.body;
      if (at_sec == null || !Number.isFinite(at_sec) || at_sec < 0) {
        return reply.code(400).send({ message: 'at_sec (a non-negative number) is required' });
      }

      const [marker] = await db
        .insert(timeline_markers)
        .values({
          project_id: project.id,
          at_sec,
          label: label ?? null,
          notes: notes ?? null,
          color: color || '#ef4444',
        })
        .returning();

      return reply.code(201).send(marker);
    },
  );

  // PATCH /api/v1/projects/:id/markers/:mid
  app.patch<{ Params: { id: string; mid: string }; Body: { at_sec?: number; label?: string | null; notes?: string | null; color?: string | null } }>(
    '/api/v1/projects/:id/markers/:mid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_markers.findFirst({
        where: and(eq(timeline_markers.id, request.params.mid), eq(timeline_markers.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Marker not found' });

      const { at_sec, label, notes, color } = request.body;
      const patch: Partial<typeof timeline_markers.$inferInsert> = {};
      if (at_sec != null && Number.isFinite(at_sec) && at_sec >= 0) patch.at_sec = at_sec;
      if (label !== undefined) patch.label = label;
      if (notes !== undefined) patch.notes = notes;
      if (color) patch.color = color;

      const [marker] = await db
        .update(timeline_markers)
        .set(patch)
        .where(eq(timeline_markers.id, existing.id))
        .returning();

      return marker;
    },
  );

  // DELETE /api/v1/projects/:id/markers/:mid
  app.delete<{ Params: { id: string; mid: string } }>(
    '/api/v1/projects/:id/markers/:mid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_markers.findFirst({
        where: and(eq(timeline_markers.id, request.params.mid), eq(timeline_markers.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Marker not found' });

      await db.delete(timeline_markers).where(eq(timeline_markers.id, existing.id));
      return reply.code(204).send();
    },
  );
}
