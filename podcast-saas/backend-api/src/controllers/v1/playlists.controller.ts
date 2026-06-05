import { randomBytes } from 'crypto';
import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { playlists, playlist_items, projects } from '../../db/schema.js';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { extname } from 'path';

const ALLOWED_BANNER_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
type BannerProvider = 'openai' | 'gemini';

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

function bannerExt(mime: string): string {
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

function buildBannerPrompt(
  playlist: typeof playlists.$inferSelect,
  items: Awaited<ReturnType<typeof playlistItemsWithProjects>>,
  prompt?: string | null,
): string {
  const playlistTitle = playlist.title?.trim() || 'Untitled playlist';
  const playlistDescription = playlist.description?.trim();
  const itemTitles = items.map((item) => item.title).filter(Boolean).slice(0, 8).join(', ');
  const custom = prompt?.trim();

  return [
    custom || `Create a premium cinematic 16:9 banner for a video playlist titled "${playlistTitle}".`,
    playlistDescription ? `Playlist description: ${playlistDescription}` : null,
    itemTitles ? `Videos in this playlist: ${itemTitles}.` : null,
    'Style: editorial streaming platform hero art, sophisticated, high contrast, no text, no logos, no UI elements.',
    'The image must work as a full-screen darkened background behind white title text.',
  ].filter(Boolean).join('\n');
}

async function generateOpenAiBanner(prompt: string): Promise<{ buffer: Buffer; mime: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const client = new OpenAI({ apiKey });
  const response = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1536x1024',
    quality: 'medium',
    output_format: 'webp',
    n: 1,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI did not return image bytes');
  return { buffer: Buffer.from(b64, 'base64'), mime: 'image/webp' };
}

async function generateGeminiBanner(prompt: string): Promise<{ buffer: Buffer; mime: string }> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured');

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateImages({
    model: process.env.GOOGLE_IMAGE_MODEL ?? 'imagen-4.0-generate-001',
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: '16:9',
      outputMimeType: 'image/png',
      enhancePrompt: true,
    },
  });

  const image = response.generatedImages?.[0]?.image;
  if (!image?.imageBytes) throw new Error('Google did not return image bytes');
  return { buffer: Buffer.from(image.imageBytes, 'base64'), mime: image.mimeType ?? 'image/png' };
}

export async function registerPlaylistRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // ── Public (optional auth): GET /api/v1/playlist-share/:shareToken ────────
  // Returns the full play-config, or a `locked` paywall stub for paid playlists.
  app.get<{ Params: { shareToken: string } }>(
    '/api/v1/playlist-share/:shareToken',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const playlist = await db.query.playlists.findFirst({
        where: eq(playlists.share_token, request.params.shareToken),
      });
      if (!playlist || !playlist.share_token) {
        return reply.code(404).send({ message: 'Playlist not found or link has been revoked' });
      }
      if (playlist.access_type === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'playlist', playlist.id);
        if (!hasAccess) {
          return reply.send({
            locked: true, content_type: 'playlist', content_id: playlist.id,
            title: playlist.title, price_cents: playlist.price_cents, currency: playlist.currency,
          });
        }
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
        banner_url: z.string().url().nullable().optional(),
        banner_prompt: z.string().max(2000).nullable().optional(),
        banner_provider: z.string().max(64).nullable().optional(),
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

  // ── Auth: POST /api/v1/playlists/:id/banner — upload a banner image ───────
  app.post<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/banner',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });

      const mime = data.mimetype.toLowerCase().split(';')[0].trim();
      if (!ALLOWED_BANNER_MIME.has(mime)) {
        return reply.code(400).send({ message: 'Only JPEG, PNG, WebP, and GIF banners are supported' });
      }

      const ext = extname(data.filename || 'banner').replace(/[^a-z0-9.]/gi, '').toLowerCase() || bannerExt(mime);
      const key = `playlist-banners/${playlist.id}/${randomUUID()}${ext}`;
      const publicUrl = await storage.uploadFile(key, await data.toBuffer(), mime);

      const [updated] = await db
        .update(playlists)
        .set({
          banner_url: publicUrl,
          banner_storage_key: key,
          banner_provider: 'upload',
          banner_prompt: null,
          updated_at: new Date(),
        })
        .where(eq(playlists.id, playlist.id))
        .returning();

      const items = await playlistItemsWithProjects(updated.id);
      return reply.code(201).send({ ...updated, items });
    },
  );

  // ── Auth: POST /api/v1/playlists/:id/banner/generate — AI banner ──────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/banner/generate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const playlist = await ownedPlaylist(request.params.id, user.id);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });

      const body = z.object({
        provider: z.enum(['openai', 'gemini']).default('openai'),
        prompt: z.string().max(2000).nullable().optional(),
      }).safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const items = await playlistItemsWithProjects(playlist.id);
      const prompt = buildBannerPrompt(playlist, items, body.data.prompt);
      const provider = body.data.provider as BannerProvider;

      try {
        const generated = provider === 'gemini'
          ? await generateGeminiBanner(prompt)
          : await generateOpenAiBanner(prompt);
        const ext = bannerExt(generated.mime);
        const key = `playlist-banners/${playlist.id}/${randomUUID()}${ext}`;
        const publicUrl = await storage.uploadFile(key, generated.buffer, generated.mime);

        const [updated] = await db
          .update(playlists)
          .set({
            banner_url: publicUrl,
            banner_storage_key: key,
            banner_provider: provider,
            banner_prompt: prompt,
            updated_at: new Date(),
          })
          .where(eq(playlists.id, playlist.id))
          .returning();

        return reply.send({ ...updated, items });
      } catch (err) {
        const message = (err as Error).message || 'Banner generation failed';
        const missingKey = message.includes('API_KEY') || message.includes('not configured');
        return reply.code(missingKey ? 400 : 502).send({ message });
      }
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
    banner_url:    playlist.banner_url,
    banner_prompt: playlist.banner_prompt,
    banner_provider: playlist.banner_provider,
    items:         playItems,
  };
}
