import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { playlists, playlist_items, projects } from '../../db/schema.js';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

/** Load a playlist owned by the user, or null. */
async function ownedPlaylist(playlistId: string, userId: string) {
  return db.query.playlists.findFirst({
    where: and(eq(playlists.id, playlistId), eq(playlists.created_by, userId)),
  });
}

/** Ordered items for a playlist, each joined with its project's title/status. */
async function playlistItemsWithProjects(playlistId: string) {
  const items = await db.query.playlist_items.findMany({
    where: eq(playlist_items.playlist_id, playlistId),
    orderBy: [asc(playlist_items.position)],
  });
  if (items.length === 0) return [];

  const projectIds = items.map((i) => i.project_id);
  const projs = await db.query.projects.findMany({ where: inArray(projects.id, projectIds) });
  const projMap = new Map(projs.map((p) => [p.id, p]));

  return items.map((i) => {
    const p = projMap.get(i.project_id);
    return {
      id:          i.id,
      project_id:  i.project_id,
      position:    i.position,
      title:       p?.title ?? null,
      description: p?.topic ?? null,
      status:      p?.status ?? 'failed',
    };
  });
}

export async function registerPlaylistRoutes(app: FastifyInstance): Promise<void> {

  // ── Public: GET /api/v1/playlist-share/:shareToken ────────────────────────
  // Returns the full play-config for a shared playlist — no auth required.
  app.get<{ Params: { shareToken: string } }>(
    '/api/v1/playlist-share/:shareToken',
    async (request, reply: FastifyReply) => {
      const playlist = await db.query.playlists.findFirst({
        where: eq(playlists.share_token, request.params.shareToken),
      });
      if (!playlist || !playlist.share_token) {
        return reply.code(404).send({ message: 'Playlist not found or link has been revoked' });
      }
      return reply.send(await buildPlaylistPlayConfig(playlist));
    },
  );

  // ── Auth: GET /api/v1/playlists ───────────────────────────────────────────
  app.get(
    '/api/v1/playlists',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.dbUser!;
      const rows = await db.query.playlists.findMany({
        where: eq(playlists.created_by, user.id),
        orderBy: (p, { desc }) => [desc(p.updated_at)],
      });
      // attach item counts
      const counts = new Map<string, number>();
      if (rows.length > 0) {
        const allItems = await db.query.playlist_items.findMany({
          where: inArray(playlist_items.playlist_id, rows.map((r) => r.id)),
        });
        for (const it of allItems) counts.set(it.playlist_id, (counts.get(it.playlist_id) ?? 0) + 1);
      }
      return reply.send(rows.map((r) => ({ ...r, item_count: counts.get(r.id) ?? 0 })));
    },
  );

  // ── Auth: POST /api/v1/playlists ──────────────────────────────────────────
  app.post(
    '/api/v1/playlists',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.dbUser!;
      const orgId = user.default_org_id;
      if (!orgId) return reply.code(400).send({ message: 'User has no default org' });

      const body = z.object({
        title:       z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
      }).safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [row] = await db
        .insert(playlists)
        .values({
          org_id:      orgId,
          created_by:  user.id,
          title:       body.data.title ?? 'Untitled playlist',
          description: body.data.description ?? null,
        })
        .returning();

      return reply.code(201).send({ ...row, items: [] });
    },
  );

  // ── Auth: GET /api/v1/playlists/:id ───────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/playlists/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      const items = await playlistItemsWithProjects(playlist.id);
      return reply.send({ ...playlist, items });
    },
  );

  // ── Auth: PATCH /api/v1/playlists/:id ─────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/api/v1/playlists/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });

      const body = z.object({
        title:         z.string().max(200).nullable().optional(),
        description:   z.string().max(2000).nullable().optional(),
        autoplay:      z.boolean().optional(),
        show_sidebar:  z.boolean().optional(),
        allow_shuffle: z.boolean().optional(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(playlists)
        .set({ ...body.data, updated_at: new Date() })
        .where(eq(playlists.id, playlist.id))
        .returning();
      const items = await playlistItemsWithProjects(updated.id);
      return reply.send({ ...updated, items });
    },
  );

  // ── Auth: DELETE /api/v1/playlists/:id ────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/playlists/:id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      await db.delete(playlists).where(eq(playlists.id, playlist.id));
      return reply.code(204).send();
    },
  );

  // ── Auth: PUT /api/v1/playlists/:id/items — replace-all ordered set ────────
  app.put<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/items',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });

      const body = z.object({
        items: z.array(z.object({ project_id: z.string().uuid() })),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      // De-dupe while preserving order; only keep projects the user owns
      const seen = new Set<string>();
      const orderedIds = body.data.items.map((i) => i.project_id).filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const owned = orderedIds.length > 0
        ? await db.query.projects.findMany({
            where: and(inArray(projects.id, orderedIds), eq(projects.created_by, user.id)),
          })
        : [];
      const ownedSet = new Set(owned.map((p) => p.id));
      const finalIds = orderedIds.filter((id) => ownedSet.has(id));

      await db.delete(playlist_items).where(eq(playlist_items.playlist_id, playlist.id));
      if (finalIds.length > 0) {
        await db.insert(playlist_items).values(
          finalIds.map((project_id, idx) => ({
            playlist_id: playlist.id,
            project_id,
            position:    idx,
          })),
        );
      }
      await db.update(playlists).set({ updated_at: new Date() }).where(eq(playlists.id, playlist.id));

      const items = await playlistItemsWithProjects(playlist.id);
      return reply.send({ ...playlist, items });
    },
  );

  // ── Auth: GET /api/v1/playlists/:id/share ─────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      if (!playlist.share_token) return reply.send({ shareToken: null, shareUrl: null });
      return reply.send({
        shareToken: playlist.share_token,
        shareUrl:   `${appUrl()}/pl/${playlist.share_token}`,
      });
    },
  );

  // ── Auth: POST /api/v1/playlists/:id/share — idempotent ───────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });

      if (playlist.share_token) {
        return reply.send({
          shareToken: playlist.share_token,
          shareUrl:   `${appUrl()}/pl/${playlist.share_token}`,
        });
      }
      const shareToken = randomBytes(16).toString('base64url');
      await db
        .update(playlists)
        .set({ share_token: shareToken, share_enabled_at: new Date() })
        .where(eq(playlists.id, playlist.id));
      return reply.code(201).send({ shareToken, shareUrl: `${appUrl()}/pl/${shareToken}` });
    },
  );

  // ── Auth: DELETE /api/v1/playlists/:id/share — revoke ─────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      await db
        .update(playlists)
        .set({ share_token: null, share_enabled_at: null })
        .where(eq(playlists.id, playlist.id));
      return reply.code(204).send();
    },
  );

  // ── Auth: GET /api/v1/playlists/:id/play-config — owner preview ───────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/play-config',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      return reply.send(await buildPlaylistPlayConfig(playlist));
    },
  );
}

/** Assemble playlist metadata + each ordered item's full PlayerConfig. */
async function buildPlaylistPlayConfig(playlist: typeof playlists.$inferSelect) {
  const items = await db.query.playlist_items.findMany({
    where: eq(playlist_items.playlist_id, playlist.id),
    orderBy: [asc(playlist_items.position)],
  });

  const configs = await Promise.all(items.map((i) => buildPlayerConfig(i.project_id)));

  const playItems = items
    .map((i, idx) => {
      const config = configs[idx];
      if (!config) return null;
      return {
        project_id:  i.project_id,
        title:       config.title,
        description: config.description,
        config,
      };
    })
    .filter(Boolean);

  return {
    id:            playlist.id,
    title:         playlist.title,
    description:   playlist.description,
    autoplay:      playlist.autoplay,
    show_sidebar:  playlist.show_sidebar,
    allow_shuffle: playlist.allow_shuffle,
    items:         playItems,
  };
}
