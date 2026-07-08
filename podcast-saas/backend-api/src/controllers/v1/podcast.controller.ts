import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  podcast_shows,
  podcast_episodes,
  podcast_sources,
} from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { rateLimit } from '../../lib/rateLimit.js';
import {
  ownedShow,
  ownedEpisodeInShow,
  showsOwnedByWhere,
  type PodcastUser,
} from '../../services/podcastAccess.js';
import { PodcastVoiceService, DEFAULT_TEACHER_VOICE_ID, DEFAULT_LEARNER_VOICE_ID } from '../../services/podcast/PodcastVoiceService.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { PDFIngester } from '../../services/ingestion/PDFIngester.js';
import { DocumentIngester } from '../../services/ingestion/DocumentIngester.js';
import { WebIngester } from '../../services/ingestion/WebIngester.js';
import {
  CreatePodcastShowSchema,
  UpdatePodcastShowSchema,
  CreatePodcastEpisodeSchema,
  UpdatePodcastEpisodeSchema,
  CreatePodcastSourceSchema,
} from 'shared';
import { logger } from '../../lib/logger.js';

/** Extract markdown from an uploaded source file (pdf → PDFIngester, else DocumentIngester). */
async function extractSourceText(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return new PDFIngester().extract(buffer, filename);
  return new DocumentIngester().extract(buffer, filename);
}

/** Sanitize a user filename for use inside a storage key (strip path/traversal chars). */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
}

/**
 * Run a source extraction in the background with a fully self-contained try/catch so
 * it can never surface an unhandled promise rejection (which is fatal on newer Node).
 * A failure only ever marks the source 'failed'; a persist error is logged, not thrown.
 */
function extractSourceInBackground(sourceId: string, run: () => Promise<string>): void {
  void (async () => {
    try {
      const md = await run();
      await db.update(podcast_sources).set({ extracted_md: md, status: 'ready' }).where(eq(podcast_sources.id, sourceId));
    } catch (err) {
      logger.warn({ err, sourceId }, 'Podcast source extraction failed');
      try {
        await db.update(podcast_sources).set({ status: 'failed' }).where(eq(podcast_sources.id, sourceId));
      } catch (persistErr) {
        logger.error({ err: persistErr, sourceId }, 'Failed to mark podcast source as failed');
      }
    }
  })();
}

export async function registerPodcastRoutes(app: FastifyInstance): Promise<void> {
  const voiceService = new PodcastVoiceService();

  // ── Voice library (ElevenLabs shared voices) ────────────────────────────────

  // GET /api/v1/podcasts/voices/search — search the shared voice library with filters
  app.get<{ Querystring: Record<string, string> }>(
    '/api/v1/podcasts/voices/search',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const q = request.query;
      const result = await voiceService.searchSharedVoices({
        search: q.search || undefined,
        gender: q.gender || undefined,
        age: q.age || undefined,
        accent: q.accent || undefined,
        language: q.language || undefined,
        category: q.category || undefined,
        use_cases: q.use_case ? [q.use_case] : undefined,
        page: q.page ? Number(q.page) : 0,
        page_size: 30,
      });
      return reply.send(result);
    },
  );

  // POST /api/v1/podcasts/:showId/voices — add a shared voice + assign to teacher|learner
  app.post<{ Params: { showId: string } }>(
    '/api/v1/podcasts/:showId/voices',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      // Adding shared voices consumes finite workspace voice slots on the shared key.
      if (!rateLimit(`podcast-voice-add:${request.dbUser!.id}`, 20, 60 * 60_000)) {
        return reply.code(429).send({ message: 'Too many voice changes — please wait a bit.' });
      }
      const show = await ownedShow(request.params.showId, request.dbUser!);
      if (!show) return reply.code(404).send({ message: 'Show not found' });

      const body = z.object({
        role: z.enum(['teacher', 'learner']),
        public_owner_id: z.string().min(1),
        voice_id: z.string().min(1),
        name: z.string().max(120).optional(),
      }).safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const resolvedVoiceId = await voiceService.addSharedVoice(
        body.data.public_owner_id,
        body.data.voice_id,
        body.data.name ?? (body.data.role === 'teacher' ? show.teacher_name : show.learner_name),
      );
      if (!resolvedVoiceId) return reply.code(502).send({ message: 'Could not add that voice (check the ElevenLabs key/plan).' });

      const patch = body.data.role === 'teacher'
        ? { teacher_voice_id: resolvedVoiceId }
        : { learner_voice_id: resolvedVoiceId };
      const [updated] = await db.update(podcast_shows).set({ ...patch, updated_at: new Date() }).where(eq(podcast_shows.id, show.id)).returning();
      return reply.send(updated);
    },
  );

  // ── Shows ──────────────────────────────────────────────────────────────────

  // GET /api/v1/podcasts — list shows owned by the user (+ episode counts)
  app.get('/api/v1/podcasts', { preHandler: [firebaseAuthMiddleware] }, async (request, reply: FastifyReply) => {
    const user = request.dbUser! as PodcastUser;
    const rows = await db.query.podcast_shows.findMany({
      where: showsOwnedByWhere(user),
      orderBy: (s, { desc: d }) => [d(s.updated_at)],
    });

    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const eps = await db
        .select({ show_id: podcast_episodes.show_id, c: sql<number>`count(*)::int` })
        .from(podcast_episodes)
        .where(inArray(podcast_episodes.show_id, rows.map((r) => r.id)))
        .groupBy(podcast_episodes.show_id);
      for (const e of eps) counts.set(e.show_id, e.c);
    }

    return reply.send(rows.map((r) => ({ ...r, episode_count: counts.get(r.id) ?? 0 })));
  });

  // POST /api/v1/podcasts — create a show; resolve default voices in the background
  app.post('/api/v1/podcasts', { preHandler: [firebaseAuthMiddleware] }, async (request, reply: FastifyReply) => {
    const user = request.dbUser!;
    const orgId = user.default_org_id;
    if (!orgId) return reply.code(400).send({ message: 'User has no default org' });

    const body = CreatePodcastShowSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ message: body.error.message });

    const [row] = await db
      .insert(podcast_shows)
      .values({
        org_id: orgId,
        created_by: user.id,
        title: body.data.title ?? 'Untitled show',
        description: body.data.description ?? null,
        language: body.data.language ?? 'en',
        niche_pack: body.data.niche_pack ?? 'general',
        // Set the exact default voices up front (Brittney=teacher, Titan=learner) so they
        // are never null. The background pass adds them to the ElevenLabs workspace.
        teacher_voice_id: DEFAULT_TEACHER_VOICE_ID,
        learner_voice_id: DEFAULT_LEARNER_VOICE_ID,
      })
      .returning();

    // Best-effort: add the default voices to the workspace (never blocks creation, never
    // overwrites the exact ids above with a fuzzy match).
    voiceService
      .resolveDefaultVoices(row.teacher_name, row.learner_name)
      .catch((err) => logger.warn({ err, showId: row.id }, 'Default voice resolution failed'));

    return reply.code(201).send({ ...row, episode_count: 0 });
  });

  // GET /api/v1/podcasts/:showId
  app.get<{ Params: { showId: string } }>(
    '/api/v1/podcasts/:showId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const show = await ownedShow(request.params.showId, request.dbUser!);
      if (!show) return reply.code(404).send({ message: 'Show not found' });
      return reply.send(show);
    },
  );

  // PATCH /api/v1/podcasts/:showId
  app.patch<{ Params: { showId: string } }>(
    '/api/v1/podcasts/:showId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const show = await ownedShow(request.params.showId, request.dbUser!);
      if (!show) return reply.code(404).send({ message: 'Show not found' });

      const body = UpdatePodcastShowSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(podcast_shows)
        .set({ ...body.data, updated_at: new Date() })
        .where(eq(podcast_shows.id, show.id))
        .returning();
      return reply.send(updated);
    },
  );

  // DELETE /api/v1/podcasts/:showId
  app.delete<{ Params: { showId: string } }>(
    '/api/v1/podcasts/:showId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const show = await ownedShow(request.params.showId, request.dbUser!);
      if (!show) return reply.code(404).send({ message: 'Show not found' });
      await db.delete(podcast_shows).where(eq(podcast_shows.id, show.id));
      return reply.code(204).send();
    },
  );

  // ── Episodes ─────────────────────────────────────────────────────────────────

  // GET /api/v1/podcasts/:showId/episodes
  app.get<{ Params: { showId: string } }>(
    '/api/v1/podcasts/:showId/episodes',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const show = await ownedShow(request.params.showId, request.dbUser!);
      if (!show) return reply.code(404).send({ message: 'Show not found' });
      const rows = await db.query.podcast_episodes.findMany({
        where: eq(podcast_episodes.show_id, show.id),
        orderBy: (e, { desc: d }) => [d(e.created_at)],
      });
      return reply.send(rows);
    },
  );

  // POST /api/v1/podcasts/:showId/episodes
  app.post<{ Params: { showId: string } }>(
    '/api/v1/podcasts/:showId/episodes',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const show = await ownedShow(request.params.showId, request.dbUser!);
      if (!show) return reply.code(404).send({ message: 'Show not found' });

      const body = CreatePodcastEpisodeSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [{ next_num }] = await db
        .select({ next_num: sql<number>`coalesce(max(${podcast_episodes.episode_number}), 0) + 1` })
        .from(podcast_episodes)
        .where(eq(podcast_episodes.show_id, show.id));

      const [row] = await db
        .insert(podcast_episodes)
        .values({
          show_id: show.id,
          episode_number: next_num,
          title: body.data.title ?? `Episode ${next_num}`,
          brief: body.data.brief ?? null,
          target_minutes: body.data.target_minutes ?? 0, // 0 = auto (writers' room picks the length)
          language: body.data.language ?? null,
        })
        .returning();
      return reply.code(201).send(row);
    },
  );

  // GET /api/v1/podcasts/:showId/episodes/:epId (+ sources)
  app.get<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const sources = await db.query.podcast_sources.findMany({
        where: eq(podcast_sources.episode_id, loaded.episode.id),
        orderBy: (s, { asc }) => [asc(s.created_at)],
      });
      return reply.send({ ...loaded.episode, sources });
    },
  );

  // PATCH /api/v1/podcasts/:showId/episodes/:epId
  app.patch<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      const body = UpdatePodcastEpisodeSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const [updated] = await db
        .update(podcast_episodes)
        .set({ ...body.data, updated_at: new Date() })
        .where(eq(podcast_episodes.id, loaded.episode.id))
        .returning();
      return reply.send(updated);
    },
  );

  // DELETE /api/v1/podcasts/:showId/episodes/:epId
  app.delete<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      await db.delete(podcast_episodes).where(eq(podcast_episodes.id, loaded.episode.id));
      return reply.code(204).send();
    },
  );

  // ── Sources ──────────────────────────────────────────────────────────────────

  // GET .../episodes/:epId/sources
  app.get<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/sources',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const rows = await db.query.podcast_sources.findMany({
        where: eq(podcast_sources.episode_id, loaded.episode.id),
        orderBy: (s, { asc }) => [asc(s.created_at)],
      });
      return reply.send(rows);
    },
  );

  // POST .../episodes/:epId/sources — note (inline) or url (async extract)
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/sources',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      const body = CreatePodcastSourceSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });
      if (body.data.kind === 'file') {
        return reply.code(400).send({ message: 'Use the /sources/upload endpoint for files' });
      }

      if (body.data.kind === 'note') {
        const [row] = await db
          .insert(podcast_sources)
          .values({
            episode_id: loaded.episode.id,
            kind: 'note',
            title: body.data.title ?? 'Note',
            extracted_md: body.data.extracted_md ?? '',
            status: 'ready',
          })
          .returning();
        return reply.code(201).send(row);
      }

      // kind === 'url'
      if (!body.data.source_url) return reply.code(400).send({ message: 'source_url is required for url sources' });
      const [row] = await db
        .insert(podcast_sources)
        .values({
          episode_id: loaded.episode.id,
          kind: 'url',
          source_url: body.data.source_url,
          title: body.data.title ?? body.data.source_url,
          status: 'processing',
        })
        .returning();

      // Async extraction — SSRF-guarded inside WebIngester; crash-safe background runner.
      const url = body.data.source_url;
      extractSourceInBackground(row.id, () => new WebIngester().extract(url));

      return reply.code(201).send(row);
    },
  );

  // POST .../episodes/:epId/sources/upload — multipart file → store + extract
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/sources/upload',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file provided' });
      const buffer = await data.toBuffer();
      const filename = data.filename;
      const mime = data.mimetype;

      const storageKey = `podcasts/${loaded.show.id}/episodes/${loaded.episode.id}/sources/${Date.now()}_${safeFilename(filename)}`;
      try {
        await getStorageAdapter().uploadFile(storageKey, buffer, mime);
      } catch (err) {
        return reply.code(500).send({ message: `Failed to upload file: ${(err as Error).message}` });
      }

      const [row] = await db
        .insert(podcast_sources)
        .values({
          episode_id: loaded.episode.id,
          kind: 'file',
          storage_key: storageKey,
          title: filename,
          status: 'processing',
        })
        .returning();

      // Async extraction — crash-safe background runner.
      extractSourceInBackground(row.id, () => extractSourceText(buffer, filename));

      return reply.code(201).send(row);
    },
  );

  // DELETE .../episodes/:epId/sources/:sourceId
  app.delete<{ Params: { showId: string; epId: string; sourceId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/sources/:sourceId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      await db
        .delete(podcast_sources)
        .where(and(eq(podcast_sources.id, request.params.sourceId), eq(podcast_sources.episode_id, loaded.episode.id)));
      return reply.code(204).send();
    },
  );
}
