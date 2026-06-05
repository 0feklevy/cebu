import { randomBytes } from 'crypto';
import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { playlists, playlist_items, projects } from '../../db/schema.js';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { LocalStorageAdapter } from '../../services/storage/LocalStorageAdapter.js';
import { extname } from 'path';
import { logger } from '../../lib/logger.js';

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

/**
 * OpenAI banner generation — adapted from darwin-avatar imageService.ts.
 * Key pattern: cast `generate` as `any` (bypasses SDK type restrictions on
 * gpt-image-1 params), quality: 'low' for speed, no response_format needed
 * (gpt-image-1 returns b64_json by default).
 */
async function generateOpenAiBanner(prompt: string): Promise<{ buffer: Buffer; mime: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';

  // Cast as any — same pattern used in darwin-avatar/server/image/imageService.ts.
  // gpt-image-1 parameters differ from dall-e-3; the SDK types reflect the older API.
  const resp = await (client.images.generate as any)({
    model,
    prompt: prompt.slice(0, 4000),
    quality: 'low',        // 'low' is valid for gpt-image-1 and generates fast
    size:    '1536x1024',
    n: 1,
  });

  const item = resp?.data?.[0] as Record<string, unknown> | undefined;
  if (!item) throw new Error('OpenAI returned no image data');

  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json as string, 'base64'), mime: 'image/png' };
  }
  if (item.url) {
    const imgRes = await fetch(item.url as string);
    if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
    return { buffer: Buffer.from(await imgRes.arrayBuffer()), mime: 'image/png' };
  }
  throw new Error('OpenAI returned an item with neither b64_json nor url');
}

/**
 * Gemini banner generation — tries Imagen 4 first, falls back to
 * gemini-2.5-flash-image (content generation API with IMAGE modality).
 */
async function generateGeminiBanner(prompt: string): Promise<{ buffer: Buffer; mime: string }> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured');

  const client = new GoogleGenAI({ apiKey });

  // Try Imagen 4 (generateImages / predict method).
  const imagenModel = process.env.GOOGLE_IMAGE_MODEL ?? 'imagen-4.0-fast-generate-001';
  try {
    const response = await client.models.generateImages({
      model: imagenModel,
      prompt,
      config: { numberOfImages: 1, aspectRatio: '16:9', outputMimeType: 'image/jpeg' },
    });
    const image = response.generatedImages?.[0]?.image;
    if (image?.imageBytes) {
      return { buffer: Buffer.from(image.imageBytes as string, 'base64'), mime: image.mimeType ?? 'image/jpeg' };
    }
  } catch (imagenErr: unknown) {
    logger.warn({ imagenModel, err: (imagenErr as Error).message?.slice(0, 200) }, '[banner] Imagen failed, trying Gemini content API');
  }

  // Fallback: gemini-2.5-flash-image (generateContent with IMAGE response modality).
  const geminiImageModel = 'gemini-2.5-flash-image';
  const response = await (client.models.generateContent as any)({
    model: geminiImageModel,
    contents: `Generate a cinematic, wide 16:9 banner image. ${prompt}`,
    config: { responseModalities: ['IMAGE', 'TEXT'] },
  });

  const parts = (response?.candidates?.[0]?.content?.parts ?? []) as Array<Record<string, unknown>>;
  const imgPart = parts.find((p) => p.inlineData);
  const inlineData = imgPart?.inlineData as Record<string, unknown> | undefined;
  if (inlineData?.data) {
    return {
      buffer: Buffer.from(inlineData.data as string, 'base64'),
      mime: (inlineData.mimeType as string) ?? 'image/jpeg',
    };
  }
  throw new Error('Gemini did not return image data from either Imagen or generateContent');
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
      // Fire-and-forget view count increment
      db.update(playlists)
        .set({ view_count: sql`${playlists.view_count} + 1` })
        .where(eq(playlists.id, playlist.id))
        .catch(() => {});

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
      const buf = await data.toBuffer();
      let publicUrl: string;
      try {
        publicUrl = await storage.uploadFile(key, buf, mime);
      } catch (uploadErr: unknown) {
        logger.warn({ key, err: (uploadErr as Error).message?.slice(0, 120) }, '[banner] primary storage upload failed — falling back to local storage');
        publicUrl = await new LocalStorageAdapter().uploadFile(key, buf, mime);
      }

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

        // Try primary storage (R2 if configured); fall back to local disk when
        // the upload is rejected (e.g. wrong R2 credentials or missing bucket).
        let publicUrl: string;
        try {
          publicUrl = await storage.uploadFile(key, generated.buffer, generated.mime);
        } catch (uploadErr: unknown) {
          logger.warn({ key, err: (uploadErr as Error).message?.slice(0, 120) }, '[banner] primary storage upload failed — falling back to local storage');
          publicUrl = await new LocalStorageAdapter().uploadFile(key, generated.buffer, generated.mime);
        }

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
        const raw = (err as Error).message || 'Banner generation failed';
        // Surface helpful messages; strip verbose SDK noise.
        const clean = raw.split('\n')[0].slice(0, 300);
        const missingKey = raw.includes('API_KEY') || raw.includes('not configured');
        const code = missingKey ? 400 : 502;
        logger.warn({ err, provider, code }, '[banner] generation failed');
        return reply.code(code).send({ message: clean });
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

  const [configs, projectRows] = await Promise.all([
    Promise.all(items.map((i) => buildPlayerConfig(i.project_id))),
    items.length > 0
      ? db.query.projects.findMany({ where: inArray(projects.id, items.map((i) => i.project_id)) })
      : Promise.resolve([]),
  ]);
  const projectMap = new Map(projectRows.map((p) => [p.id, p]));

  const playItems = items
    .map((i, idx) => {
      const config = configs[idx];
      if (!config) return null;
      const proj = projectMap.get(i.project_id);
      return {
        project_id:    i.project_id,
        title:         config.title,
        description:   config.description,
        thumbnail_url: proj?.thumbnail_url ?? null,
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
