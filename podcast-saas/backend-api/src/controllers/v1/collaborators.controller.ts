import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { collaborators, projects, playlists, users } from '../../db/schema.js';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, editablePlaylist } from '../../services/collabAccess.js';

/**
 * Collaboration endpoints (GitHub-style invites by email).
 *
 * Listing is allowed for anyone who can edit the content (owner or collaborator);
 * inviting/removing is owner-only, except a collaborator may remove themself (leave).
 * Invites are matched by lowercased email, so they work before the invitee signs up.
 */

const InviteSchema = z.object({ email: z.string().trim().email().max(320) });

type ContentType = 'project' | 'playlist';

async function loadContent(type: ContentType, id: string) {
  return type === 'project'
    ? db.query.projects.findFirst({ where: eq(projects.id, id) })
    : db.query.playlists.findFirst({ where: eq(playlists.id, id) });
}

async function loadEditable(type: ContentType, id: string, user: { id: string; email: string | null }) {
  return type === 'project' ? editableProject(id, user) : editablePlaylist(id, user);
}

/** Collaborator rows for a content item, enriched with the resolved user's profile. */
async function listRows(type: ContentType, contentId: string) {
  const rows = await db.query.collaborators.findMany({
    where: and(eq(collaborators.content_type, type), eq(collaborators.content_id, contentId)),
    orderBy: [asc(collaborators.created_at)],
  });
  const userIds = rows.map((r) => r.user_id).filter((v): v is string => !!v);
  const userRows = userIds.length > 0
    ? await db.query.users.findMany({ where: inArray(users.id, userIds) })
    : [];
  const byId = new Map(userRows.map((u) => [u.id, u]));
  return rows.map((r) => {
    const u = r.user_id ? byId.get(r.user_id) : undefined;
    return {
      id:           r.id,
      email:        r.invited_email,
      user_id:      r.user_id,
      display_name: u?.display_name ?? null,
      // "pending" until the invited email maps to a real account (GitHub-style)
      status:       r.user_id ? 'active' : 'pending',
      created_at:   r.created_at,
    };
  });
}

function registerFor(app: FastifyInstance, type: ContentType, base: string) {
  // GET  {base}/:id/collaborators — owner or collaborator
  app.get<{ Params: { id: string } }>(
    `${base}/:id/collaborators`,
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const content = await loadEditable(type, request.params.id, user);
      if (!content) return reply.code(404).send({ message: 'Not found' });

      const owner = content.created_by
        ? await db.query.users.findFirst({ where: eq(users.id, content.created_by) })
        : null;
      return reply.send({
        owner: owner
          ? { user_id: owner.id, email: owner.email, display_name: owner.display_name }
          : null,
        viewer_role:   content.created_by === user.id ? 'owner' : 'collaborator',
        collaborators: await listRows(type, content.id),
      });
    },
  );

  // POST {base}/:id/collaborators { email } — owner only, idempotent
  app.post<{ Params: { id: string } }>(
    `${base}/:id/collaborators`,
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const content = await loadContent(type, request.params.id);
      // 404 (not 403) on both missing and non-owned so existence isn't leaked.
      if (!content || content.created_by !== user.id) {
        return reply.code(404).send({ message: 'Not found' });
      }

      const body = InviteSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: 'A valid email is required' });
      const email = body.data.email.toLowerCase();

      if (user.email && email === user.email.toLowerCase()) {
        return reply.code(400).send({ message: 'You are the owner of this ' + type });
      }

      // Resolve to an existing account when possible (email match is case-insensitive).
      const invitee = await db.query.users.findFirst({
        where: sql`lower(${users.email}) = ${email}`,
      });

      const [row] = await db
        .insert(collaborators)
        .values({
          content_type:  type,
          content_id:    content.id,
          invited_email: email,
          user_id:       invitee?.id ?? null,
          invited_by:    user.id,
        })
        .onConflictDoNothing()
        .returning();

      // Conflict → invite already exists; treat as idempotent success.
      return reply.code(row ? 201 : 200).send({ collaborators: await listRows(type, content.id) });
    },
  );

  // DELETE {base}/:id/collaborators/:collabId — owner, or the collaborator themself (leave)
  app.delete<{ Params: { id: string; collabId: string } }>(
    `${base}/:id/collaborators/:collabId`,
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const content = await loadContent(type, request.params.id);
      if (!content) return reply.code(404).send({ message: 'Not found' });

      const row = await db.query.collaborators.findFirst({
        where: and(
          eq(collaborators.id, request.params.collabId),
          eq(collaborators.content_type, type),
          eq(collaborators.content_id, content.id),
        ),
      });
      if (!row) return reply.code(404).send({ message: 'Not found' });

      const isOwner = content.created_by === user.id;
      const isSelf =
        row.user_id === user.id ||
        (!!user.email && row.invited_email === user.email.toLowerCase());
      if (!isOwner && !isSelf) return reply.code(404).send({ message: 'Not found' });

      await db.delete(collaborators).where(eq(collaborators.id, row.id));
      return reply.code(204).send();
    },
  );
}

export async function registerCollaboratorRoutes(app: FastifyInstance): Promise<void> {
  registerFor(app, 'project', '/api/v1/projects');
  registerFor(app, 'playlist', '/api/v1/playlists');
}
