import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { timeline_markers, video_files } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { buildMainSegmentTimeline, anchorForAbsoluteSec } from 'shared';

// Input bounds for markers (backend-206 / security-403): a 3- or 6-digit hex color, a sane
// upper bound on at_sec (matching the thumbnail-from-timeline cap), and length caps on the
// free-text label/notes columns so they can't be stuffed with oversized values.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const AT_SEC_MAX = 86400; // 24h — same ceiling used by thumbnail-from-timeline
const LABEL_MAX = 200;
const NOTES_MAX = 2000;

// Editor timeline markers (Focus 5b). Premiere-style flags dropped at a point on the timeline
// (Flag button or "m" hotkey) to leave a note for the editor. Editable by the project owner or
// an invited collaborator, scoped to the project.

export async function registerMarkersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/projects/:id/markers
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/markers',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const markers = await db.query.timeline_markers.findMany({
        where: eq(timeline_markers.project_id, project.id),
        orderBy: [asc(timeline_markers.at_sec)],
      });
      return markers;
    },
  );


/**
 * The anchor to store for a marker at `atSec`, or an empty patch when one cannot be chosen.
 *
 * ANCHORING HAPPENS ON WRITE, never as a backfill. An old marker's absolute second cannot tell you
 * which segment its author MEANT — the drift this fixes is precisely the case where that second no
 * longer points where they intended — so guessing would write a measurement-shaped guess into the
 * table. Rows gain an anchor the next time somebody moves them, which is the moment the intent is
 * known.
 *
 * Returns `{}` rather than throwing when the project has no main timeline yet: the marker is still
 * worth storing at its absolute second, and a row that claims to be anchored while resolving
 * through the fallback forever is strictly worse than an honest absolute.
 */
async function anchorPatchFor(projectId: string, atSec: number) {
  const videos = await db.query.video_files.findMany({ where: eq(video_files.project_id, projectId) });
  const timeline = buildMainSegmentTimeline(videos);
  return anchorForAbsoluteSec(timeline, atSec) ?? {};
}

  // POST /api/v1/projects/:id/markers
  app.post<{ Params: { id: string }; Body: { at_sec?: number; label?: string | null; notes?: string | null; color?: string | null } }>(
    '/api/v1/projects/:id/markers',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { at_sec, label, notes, color } = request.body;
      if (at_sec == null || !Number.isFinite(at_sec) || at_sec < 0 || at_sec > AT_SEC_MAX) {
        return reply.code(400).send({ message: `at_sec must be a number between 0 and ${AT_SEC_MAX}` });
      }
      if (color != null && !HEX_COLOR.test(color)) {
        return reply.code(400).send({ message: 'color must be a hex color (e.g. #ef4444)' });
      }
      if (label != null && label.length > LABEL_MAX) {
        return reply.code(400).send({ message: `label must be at most ${LABEL_MAX} characters` });
      }
      if (notes != null && notes.length > NOTES_MAX) {
        return reply.code(400).send({ message: `notes must be at most ${NOTES_MAX} characters` });
      }

      const [marker] = await db
        .insert(timeline_markers)
        .values({
          project_id: project.id,
          at_sec,
          // Both representations: the absolute second stays the fallback, and the anchor is what
          // makes the marker follow its content when an earlier clip changes length (migration 074).
          ...(await anchorPatchFor(project.id, at_sec)),
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
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_markers.findFirst({
        where: and(eq(timeline_markers.id, request.params.mid), eq(timeline_markers.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Marker not found' });

      const { at_sec, label, notes, color } = request.body;
      if (at_sec != null && (!Number.isFinite(at_sec) || at_sec < 0 || at_sec > AT_SEC_MAX)) {
        return reply.code(400).send({ message: `at_sec must be a number between 0 and ${AT_SEC_MAX}` });
      }
      if (color != null && color !== '' && !HEX_COLOR.test(color)) {
        return reply.code(400).send({ message: 'color must be a hex color (e.g. #ef4444)' });
      }
      if (label != null && label.length > LABEL_MAX) {
        return reply.code(400).send({ message: `label must be at most ${LABEL_MAX} characters` });
      }
      if (notes != null && notes.length > NOTES_MAX) {
        return reply.code(400).send({ message: `notes must be at most ${NOTES_MAX} characters` });
      }

      const patch: Partial<typeof timeline_markers.$inferInsert> = {};
      if (at_sec != null) {
        patch.at_sec = at_sec;
        // MOVING A MARKER RE-ANCHORS IT. This is the moment the author's intent is known — they
        // just pointed at a place — so it is the only moment an anchor can be chosen honestly.
        // A move that cannot be anchored (no main timeline yet) leaves the columns alone rather
        // than writing a stale pair from wherever the marker used to be.
        Object.assign(patch, await anchorPatchFor(project.id, at_sec));
      }
      if (label !== undefined) patch.label = label;
      if (notes !== undefined) patch.notes = notes;
      if (color) patch.color = color;

      if (Object.keys(patch).length === 0) return reply.send(existing);

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
      const project = await editableProject(request.params.id, user);
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
