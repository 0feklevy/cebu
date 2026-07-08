import { createHash } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { podcast_scripts, podcast_episodes } from '../../db/schema.js';
import type { PodcastScript } from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { ownedEpisodeInShow } from '../../services/podcastAccess.js';
import { enqueueJob } from '../../queue/index.js';
import { writeEpisodeMemory } from '../../services/podcast/PodcastMemory.js';
import { regenerateTurn } from '../../services/podcast/regenerateTurn.js';
import { PodcastEditorTurnSchema, type PodcastScriptBody, type PodcastTurn } from 'shared';
import { logger } from '../../lib/logger.js';

/** Content hash of a body's turns — drives the "changed since render" banner. */
function hashBody(body: PodcastScriptBody): string {
  const canonical = body.turns.map((t) => `${t.speaker}|${t.overlap ? 1 : 0}|${t.text}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Load a script row for an episode: a specific version, or the latest. */
async function loadScript(episodeId: string, version?: number): Promise<PodcastScript | null> {
  if (version != null) {
    const row = await db.query.podcast_scripts.findFirst({
      where: and(eq(podcast_scripts.episode_id, episodeId), eq(podcast_scripts.version, version)),
    });
    return row ?? null;
  }
  const row = await db.query.podcast_scripts.findFirst({
    where: eq(podcast_scripts.episode_id, episodeId),
    orderBy: [desc(podcast_scripts.version)],
  });
  return row ?? null;
}

/** Next version number for an episode. */
async function nextVersion(episodeId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`coalesce(max(${podcast_scripts.version}), 0) + 1` })
    .from(podcast_scripts)
    .where(eq(podcast_scripts.episode_id, episodeId));
  return n;
}

/**
 * Insert a new script version, retrying on the unique(episode_id,version) race so
 * two concurrent generate/fork calls don't 500 — the loser re-computes max+1 and
 * lands on the next free version instead of throwing.
 */
async function insertScriptVersion(
  episodeId: string,
  values: Omit<typeof podcast_scripts.$inferInsert, 'episode_id' | 'version'>,
): Promise<PodcastScript> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const version = await nextVersion(episodeId);
    try {
      const [row] = await db.insert(podcast_scripts).values({ episode_id: episodeId, version, ...values }).returning();
      return row;
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && attempt < 4) continue; // unique violation → retry
      throw err;
    }
  }
  throw new Error('Could not allocate a script version');
}

/**
 * Return a WRITABLE script for editing. Approved versions are immutable: the first
 * edit forks a copy as v(N+1) (status 'ready') and returns the episode to
 * 'script_ready'. A non-approved 'ready' version is edited in place.
 */
async function writableScript(script: PodcastScript, episodeId: string): Promise<PodcastScript> {
  if (script.status !== 'approved') return script;
  const forked = await insertScriptVersion(episodeId, {
    status: 'ready',
    story_json: script.story_json,
    materials_json: script.materials_json,
    review_json: script.review_json,
    body_json: script.body_json,
    content_hash: script.content_hash,
    telemetry: script.telemetry,
  });
  await db.update(podcast_episodes)
    .set({ status: 'script_ready', updated_at: new Date() })
    .where(and(eq(podcast_episodes.id, episodeId), eq(podcast_episodes.status, 'approved')));
  return forked;
}

async function saveBody(scriptId: string, body: PodcastScriptBody): Promise<PodcastScript> {
  const [row] = await db
    .update(podcast_scripts)
    .set({ body_json: body, content_hash: hashBody(body), updated_at: new Date() })
    .where(eq(podcast_scripts.id, scriptId))
    .returning();
  return row;
}

export async function registerPodcastScriptRoutes(app: FastifyInstance): Promise<void> {
  // POST .../episodes/:epId/script/generate — enqueue a fresh version
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script/generate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      // Rate-limit: generation is a 6-pass opus-max chain — expensive to fan out.
      if (!rateLimit(`podcast-generate:${request.dbUser!.id}`, 20, 60 * 60_000)) {
        return reply.code(429).send({ message: 'Too many generations — please wait a bit before generating again.' });
      }

      const body = z.object({ notes: z.string().max(4000).optional() }).safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const script = await insertScriptVersion(loaded.episode.id, { status: 'drafting' });

      // Only move the episode to 'scripting' if it isn't already in a good state — a
      // regenerate of an approved/ready episode must not risk masking the prior version.
      await db.update(podcast_episodes)
        .set({ status: 'scripting', error: null, updated_at: new Date() })
        .where(and(eq(podcast_episodes.id, loaded.episode.id), notInArray(podcast_episodes.status, ['approved', 'rendering', 'ready'])));

      enqueueJob('podcast_script', { scriptId: script.id, directorNotes: body.data.notes ?? null });
      return reply.code(202).send({ script_id: script.id, version: script.version });
    },
  );

  // GET .../script[?version=] — a version + the versions list
  app.get<{ Params: { showId: string; epId: string }; Querystring: { version?: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      const version = request.query.version ? Number(request.query.version) : undefined;
      const script = await loadScript(loaded.episode.id, version);
      const versions = await db.query.podcast_scripts.findMany({
        where: eq(podcast_scripts.episode_id, loaded.episode.id),
        orderBy: [desc(podcast_scripts.version)],
        columns: { id: true, version: true, status: true, approved_at: true, created_at: true },
      });
      return reply.send({ script: script ?? null, versions });
    },
  );

  // PATCH .../script/:v/turns/:turnId — edit one turn (fork if approved)
  app.patch<{ Params: { showId: string; epId: string; v: string; turnId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script/:v/turns/:turnId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const src = await loadScript(loaded.episode.id, Number(request.params.v));
      if (!src || !src.body_json) return reply.code(404).send({ message: 'Script not found' });

      const patch = z.object({
        text: z.string().min(1).max(600).optional(),
        speaker: z.enum(['teacher', 'learner']).optional(),
        overlap: z.boolean().optional(),
        pause_after_ms: z.number().int().min(0).max(5000).nullable().optional(),
        is_hook: z.boolean().optional(),
      }).safeParse(request.body ?? {});
      if (!patch.success) return reply.code(400).send({ message: patch.error.message });

      const script = await writableScript(src, loaded.episode.id);
      const body = script.body_json as PodcastScriptBody;
      const turn = body.turns.find((t) => t.id === request.params.turnId);
      if (!turn) return reply.code(404).send({ message: 'Turn not found' });
      Object.assign(turn, {
        ...(patch.data.text !== undefined ? { text: patch.data.text } : {}),
        ...(patch.data.speaker !== undefined ? { speaker: patch.data.speaker } : {}),
        ...(patch.data.overlap !== undefined ? { overlap: patch.data.overlap } : {}),
        ...(patch.data.pause_after_ms !== undefined ? { pause_after_ms: patch.data.pause_after_ms ?? undefined } : {}),
        ...(patch.data.is_hook !== undefined ? { is_hook: patch.data.is_hook } : {}),
      });
      const saved = await saveBody(script.id, body);
      return reply.send({ script: saved });
    },
  );

  // PUT .../script/:v/turns — replace the whole turns array (insert/delete/reorder/split/merge)
  app.put<{ Params: { showId: string; epId: string; v: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script/:v/turns',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const src = await loadScript(loaded.episode.id, Number(request.params.v));
      if (!src || !src.body_json) return reply.code(404).send({ message: 'Script not found' });

      // Editor schema allows blank lines (a just-inserted turn) — blanks are dropped at render.
      const parsed = z.object({ turns: z.array(PodcastEditorTurnSchema).min(1).max(400) }).safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });

      const script = await writableScript(src, loaded.episode.id);
      const prev = script.body_json as PodcastScriptBody;
      const body: PodcastScriptBody = { ...prev, turns: parsed.data.turns as PodcastTurn[] };
      const saved = await saveBody(script.id, body);
      return reply.send({ script: saved });
    },
  );

  // POST .../script/:v/turns/:turnId/regenerate — single-turn LLM rewrite with a hint
  app.post<{ Params: { showId: string; epId: string; v: string; turnId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script/:v/turns/:turnId/regenerate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const src = await loadScript(loaded.episode.id, Number(request.params.v));
      if (!src || !src.body_json) return reply.code(404).send({ message: 'Script not found' });

      const parsed = z.object({ hint: z.string().max(1000).optional() }).safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });

      const script = await writableScript(src, loaded.episode.id);
      const body = script.body_json as PodcastScriptBody;
      const idx = body.turns.findIndex((t) => t.id === request.params.turnId);
      if (idx === -1) return reply.code(404).send({ message: 'Turn not found' });

      try {
        const rewritten = await regenerateTurn({
          show: loaded.show,
          turns: body.turns,
          index: idx,
          hint: parsed.data.hint ?? '',
          userId: request.dbUser!.id,
        });
        // Preserve the original turn's identity + metadata (id/beat/pause) — the LLM
        // only rewrites the spoken content and delivery.
        const orig = body.turns[idx];
        body.turns[idx] = { ...orig, text: rewritten.text, speaker: rewritten.speaker, overlap: rewritten.overlap, is_hook: rewritten.is_hook };
        const saved = await saveBody(script.id, body);
        return reply.send({ script: saved, turn: body.turns[idx] });
      } catch (err) {
        logger.warn({ err }, 'Turn regenerate failed');
        return reply.code(502).send({ message: 'Could not regenerate this line — please try again.' });
      }
    },
  );

  // POST .../script/:v/approve — idempotent; sets content_hash + approved_at; kicks memory scribe
  app.post<{ Params: { showId: string; epId: string; v: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script/:v/approve',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const script = await loadScript(loaded.episode.id, Number(request.params.v));
      if (!script || !script.body_json) return reply.code(404).send({ message: 'Script not found' });
      if (script.status === 'drafting' || script.status === 'failed') {
        return reply.code(409).send({ message: 'Script is not ready to approve yet' });
      }

      const body = script.body_json as PodcastScriptBody;
      const [approved] = await db
        .update(podcast_scripts)
        .set({ status: 'approved', content_hash: hashBody(body), approved_at: new Date(), updated_at: new Date() })
        .where(eq(podcast_scripts.id, script.id))
        .returning();
      await db.update(podcast_episodes)
        .set({ status: 'approved', updated_at: new Date() })
        .where(eq(podcast_episodes.id, loaded.episode.id));

      // Background: refresh series memory (upsert this episode's summary).
      writeEpisodeMemory(loaded.episode.id, script.id, request.dbUser!.id).catch(() => {});

      return reply.send({ script: approved });
    },
  );
}
