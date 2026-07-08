import { createHash } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { podcast_renders, podcast_episodes, podcast_scripts } from '../../db/schema.js';
import type { PodcastRender } from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { ownedEpisodeInShow } from '../../services/podcastAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { enqueueJob } from '../../queue/index.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { previewTurn } from '../../services/podcast/audio/previewTurn.js';
import { writeEpisodeMemory } from '../../services/podcast/PodcastMemory.js';
import type { PodcastScriptBody } from 'shared';
import { logger } from '../../lib/logger.js';

/** Same canonical hash as the script controller — drives changed-since-render. */
function hashBody(body: PodcastScriptBody): string {
  const canonical = body.turns.map((t) => `${t.speaker}|${t.overlap ? 1 : 0}|${t.text}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

const DL_TTL = 6 * 60 * 60; // presigned download URL lifetime
const ACTIVE_RENDER = ['queued', 'synthesizing', 'stitching', 'encoding'] as const;

async function withUrls(storage: ReturnType<typeof getStorageAdapter>, r: PodcastRender) {
  const [mp4, mp3, wav] = await Promise.all([
    r.master_mp4_key ? storage.getPresignedDownloadUrl(r.master_mp4_key, DL_TTL).catch(() => null) : null,
    r.master_mp3_key ? storage.getPresignedDownloadUrl(r.master_mp3_key, DL_TTL).catch(() => null) : null,
    r.master_wav_key ? storage.getPresignedDownloadUrl(r.master_wav_key, DL_TTL).catch(() => null) : null,
  ]);
  return { ...r, mp4_url: mp4, mp3_url: mp3, wav_url: wav };
}

export async function registerPodcastRenderRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // POST .../episodes/:epId/render — start an export (requires an approved script)
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/render',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      // Rate-limit: renders spend real ElevenLabs credits and saturate the ffmpeg worker.
      if (!rateLimit(`podcast-render:${request.dbUser!.id}`, 10, 60 * 60_000)) {
        return reply.code(429).send({ message: 'Too many exports — please wait a bit before exporting again.' });
      }

      // Export the NEWEST script that has a body. Approved is ideal; a 'ready'
      // edit-fork is auto-approved here — clicking Export IS approval intent, and
      // requiring a separate re-approve after every small edit was a dead-end 409.
      let script = await db.query.podcast_scripts.findFirst({
        where: and(eq(podcast_scripts.episode_id, loaded.episode.id), isNotNull(podcast_scripts.body_json)),
        orderBy: [desc(podcast_scripts.version)],
      });
      if (!script || !script.body_json || script.status === 'drafting' || script.status === 'failed') {
        return reply.code(409).send({ message: 'Approve the script before exporting audio' });
      }
      if (script.status !== 'approved') {
        const body = script.body_json as PodcastScriptBody;
        const [approved] = await db
          .update(podcast_scripts)
          .set({ status: 'approved', content_hash: hashBody(body), approved_at: new Date(), updated_at: new Date() })
          .where(eq(podcast_scripts.id, script.id))
          .returning();
        script = approved;
        await db.update(podcast_episodes)
          .set({ status: 'approved', updated_at: new Date() })
          .where(eq(podcast_episodes.id, loaded.episode.id));
        writeEpisodeMemory(loaded.episode.id, script.id, request.dbUser!.id).catch(() => {});
      }

      // Don't start a second render for the same episode while one is in flight (double cost + seed/cache races).
      const inflight = await db.query.podcast_renders.findFirst({
        where: and(eq(podcast_renders.episode_id, loaded.episode.id), inArray(podcast_renders.status, [...ACTIVE_RENDER])),
      });
      if (inflight) return reply.code(202).send({ render_id: inflight.id, already_running: true });

      // Short-circuit: if the newest ready render already matches the approved script, reuse it.
      const latestReady = await db.query.podcast_renders.findFirst({
        where: and(eq(podcast_renders.episode_id, loaded.episode.id), eq(podcast_renders.status, 'ready')),
        orderBy: [desc(podcast_renders.created_at)],
      });
      if (latestReady && latestReady.script_hash && latestReady.script_hash === script.content_hash) {
        return reply.code(202).send({ render_id: latestReady.id, unchanged: true });
      }

      const [render] = await db.insert(podcast_renders).values({
        episode_id: loaded.episode.id,
        script_version: script.version,
        status: 'queued',
        script_hash: script.content_hash,
      }).returning();

      await db.update(podcast_episodes)
        .set({ status: 'rendering', updated_at: new Date() })
        .where(eq(podcast_episodes.id, loaded.episode.id));

      enqueueJob('podcast_render', { renderId: render.id });
      return reply.code(202).send({ render_id: render.id });
    },
  );

  // GET .../episodes/:epId/renders — list renders (newest first, with download URLs + changed flag)
  app.get<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/renders',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });

      const rows = await db.query.podcast_renders.findMany({
        where: eq(podcast_renders.episode_id, loaded.episode.id),
        orderBy: [desc(podcast_renders.created_at)],
      });
      // Compare against the NEWEST script with a body regardless of its status —
      // an edit-fork ('ready') or a fresh regenerate must flip the banner too.
      const latestScript = await db.query.podcast_scripts.findFirst({
        where: and(eq(podcast_scripts.episode_id, loaded.episode.id), isNotNull(podcast_scripts.body_json)),
        orderBy: [desc(podcast_scripts.version)],
      });
      const currentHash = latestScript?.body_json
        ? (latestScript.status === 'approved' ? latestScript.content_hash : hashBody(latestScript.body_json as PodcastScriptBody))
        : null;

      const withUrl = await Promise.all(rows.map((r) => withUrls(storage, r)));
      const latestReady = rows.find((r) => r.status === 'ready');
      const changedSinceRender = Boolean(currentHash && latestReady && latestReady.script_hash !== currentHash);
      return reply.send({
        renders: withUrl,
        changed_since_render: changedSinceRender,
        latest_script_version: latestScript?.version ?? null,
        latest_script_status: latestScript?.status ?? null,
      });
    },
  );

  // GET .../episodes/:epId/render/:renderId — one render (polled while rendering)
  app.get<{ Params: { showId: string; epId: string; renderId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/render/:renderId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const render = await db.query.podcast_renders.findFirst({ where: eq(podcast_renders.id, request.params.renderId) });
      if (!render || render.episode_id !== loaded.episode.id) return reply.code(404).send({ message: 'Render not found' });
      return reply.send(await withUrls(storage, render));
    },
  );

  // POST .../episodes/:epId/script/:v/turns/:turnId/preview — single-line audio preview
  app.post<{ Params: { showId: string; epId: string; v: string; turnId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/script/:v/turns/:turnId/preview',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      // Preview the version the user is actually editing (:v), not "latest".
      const version = Number(request.params.v);
      const script = await db.query.podcast_scripts.findFirst({
        where: Number.isFinite(version)
          ? and(eq(podcast_scripts.episode_id, loaded.episode.id), eq(podcast_scripts.version, version))
          : eq(podcast_scripts.episode_id, loaded.episode.id),
        orderBy: [desc(podcast_scripts.version)],
      });
      const body = script?.body_json as PodcastScriptBody | undefined;
      if (!body) return reply.code(404).send({ message: 'Script not found' });
      const idx = body.turns.findIndex((t) => t.id === request.params.turnId);
      if (idx === -1) return reply.code(404).send({ message: 'Turn not found' });

      if (!rateLimit(`podcast-preview:${request.dbUser!.id}`, 60, 60_000)) {
        return reply.code(429).send({ message: 'Too many previews — please slow down.' });
      }

      try {
        const url = await previewTurn({ show: loaded.show, episode: loaded.episode, turns: body.turns, index: idx });
        return reply.send({ url });
      } catch (err) {
        logger.warn({ err }, 'Turn preview failed');
        return reply.code(502).send({ message: 'Could not preview this line — check the ElevenLabs voices are set.' });
      }
    },
  );
}
