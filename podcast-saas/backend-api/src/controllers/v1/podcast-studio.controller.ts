/**
 * Audio Studio API — the Premiere-style multitrack editor for an episode.
 *
 * All routes are gated by `ownedEpisodeInShow` (the single ownership seam).
 *   GET    /studio                       — mix draft + persisted clips + snapshots
 *   POST   /studio/generate              — (re)build clips + initial timeline (job)
 *   PUT    /studio/timeline              — autosave the draft (optimistic `rev` CAS)
 *   POST   /studio/turns/:turnId/clip    — re-voice one line (sync) + swap take
 *   GET    /studio/snapshots             — list named versions
 *   POST   /studio/snapshots             — manual save version
 *   POST   /studio/snapshots/:id/restore — restore a version into the draft
 *   POST   /studio/export                — freeze a snapshot + render a master (job)
 */

import { createHash } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import {
  podcast_scripts, podcast_episodes, podcast_mixes, podcast_clips, podcast_mix_snapshots, podcast_renders,
} from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { ownedEpisodeInShow } from '../../services/podcastAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { enqueueJob } from '../../queue/index.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { revoicePodcastTurn } from '../../services/podcast/audio/revoiceTurn.js';
import { MixTimelineSchema, layoutMix, type PodcastScriptBody, type MixTimeline } from 'shared';
import { logger } from '../../lib/logger.js';

const ACTIVE_RENDER = ['queued', 'synthesizing', 'stitching', 'encoding'] as const;

function scriptHash(body: PodcastScriptBody): string {
  const canonical = body.turns.map((t) => `${t.speaker}|${t.overlap ? 1 : 0}|${t.text}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Newest script (any status) that has a body — the studio is downstream of it. */
async function latestScriptWithBody(episodeId: string) {
  return db.query.podcast_scripts.findFirst({
    where: and(eq(podcast_scripts.episode_id, episodeId), isNotNull(podcast_scripts.body_json)),
    orderBy: [desc(podcast_scripts.version)],
  });
}

export async function registerPodcastStudioRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // GET /studio — the whole editor payload.
  app.get<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const episodeId = loaded.episode.id;

      const [mix, clips, latest] = await Promise.all([
        db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, episodeId) }),
        db.query.podcast_clips.findMany({ where: eq(podcast_clips.episode_id, episodeId), orderBy: [desc(podcast_clips.created_at)] }),
        latestScriptWithBody(episodeId),
      ]);
      const snapshots = mix
        ? await db.query.podcast_mix_snapshots.findMany({ where: eq(podcast_mix_snapshots.mix_id, mix.id), orderBy: [desc(podcast_mix_snapshots.created_at)] })
        : [];

      const clipDtos = clips.map((c) => ({
        id: c.id, turn_id: c.turn_id, take_hash: c.take_hash, text_hash: c.text_hash,
        script_version: c.script_version, duration_ms: c.duration_ms,
        peaks: (c.peaks_json as number[] | null) ?? null,
        url: storage.getPublicUrl(c.storage_key), source: c.source, created_at: c.created_at,
      }));

      const latestHash = latest?.body_json
        ? (latest.status === 'approved' ? latest.content_hash : scriptHash(latest.body_json as PodcastScriptBody))
        : null;

      return reply.send({
        mix: mix ? {
          id: mix.id, episode_id: mix.episode_id, script_version: mix.script_version, script_hash: mix.script_hash,
          status: mix.status, progress: mix.progress, timeline: mix.timeline_json, rev: mix.rev, error: mix.error, updated_at: mix.updated_at,
        } : null,
        clips: clipDtos,
        snapshots: snapshots.map((s) => ({ id: s.id, name: s.name, kind: s.kind, script_version: s.script_version, render_id: s.render_id, created_at: s.created_at })),
        latest_script_version: latest?.version ?? null,
        latest_script_hash: latestHash,
      });
    },
  );

  // POST /studio/generate — (re)build the clips + initial timeline. Auto-snapshots
  // an existing draft first so a rebuild is never destructive.
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/generate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const episodeId = loaded.episode.id;

      if (!rateLimit(`podcast-studio-gen:${request.dbUser!.id}`, 10, 60 * 60_000)) {
        return reply.code(429).send({ message: 'Too many audio builds — please wait a bit before rebuilding.' });
      }
      const latest = await latestScriptWithBody(episodeId);
      if (!latest?.body_json) return reply.code(409).send({ message: 'Generate and approve a script first.' });

      const existing = await db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, episodeId) });
      if (existing?.status === 'generating') return reply.code(202).send({ mix_id: existing.id, already_running: true });

      // Upsert the mix row; snapshot the current draft before rebuilding over it.
      let mixId: string;
      if (existing) {
        mixId = existing.id;
        if (existing.timeline_json) {
          await db.insert(podcast_mix_snapshots).values({
            mix_id: existing.id, name: `Before rebuild · ${new Date().toISOString().slice(0, 10)}`,
            kind: 'pre_rebuild', script_version: existing.script_version, timeline_json: existing.timeline_json,
          });
        }
        await db.update(podcast_mixes).set({ status: 'generating', progress: null, error: null, claimed_at: null, updated_at: new Date() }).where(eq(podcast_mixes.id, existing.id));
      } else {
        const [row] = await db.insert(podcast_mixes).values({ episode_id: episodeId, status: 'generating' }).returning({ id: podcast_mixes.id });
        mixId = row.id;
      }

      enqueueJob('podcast_clips', { mixId });
      return reply.code(202).send({ mix_id: mixId });
    },
  );

  // PUT /studio/timeline — autosave with optimistic concurrency.
  app.put<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/timeline',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const episodeId = loaded.episode.id;

      const parsed = z.object({ timeline: MixTimelineSchema, base_rev: z.number().int().min(0) }).safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });

      const mix = await db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, episodeId) });
      if (!mix) return reply.code(404).send({ message: 'No mix to save' });

      // Every referenced clip must belong to this episode (no cross-episode splicing).
      const owned = new Set((await db.query.podcast_clips.findMany({ where: eq(podcast_clips.episode_id, episodeId), columns: { id: true } })).map((c) => c.id));
      if (!parsed.data.timeline.clips.every((c) => owned.has(c.clipId))) {
        return reply.code(400).send({ message: 'Timeline references a clip that is not part of this episode' });
      }

      const [updated] = await db.update(podcast_mixes)
        .set({ timeline_json: parsed.data.timeline, rev: mix.rev + 1, updated_at: new Date() })
        .where(and(eq(podcast_mixes.id, mix.id), eq(podcast_mixes.rev, parsed.data.base_rev)))
        .returning({ rev: podcast_mixes.rev });
      if (!updated) return reply.code(409).send({ message: 'The draft changed elsewhere — reload to continue.', current_rev: mix.rev });
      return reply.send({ rev: updated.rev });
    },
  );

  // POST /studio/turns/:turnId/clip — re-voice ONE line and swap the take (sync).
  app.post<{ Params: { showId: string; epId: string; turnId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/turns/:turnId/clip',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const episodeId = loaded.episode.id;

      if (!rateLimit(`podcast-studio-revoice:${request.dbUser!.id}`, 20, 10 * 60_000)) {
        return reply.code(429).send({ message: 'Too many re-voices — please slow down.' });
      }
      const latest = await latestScriptWithBody(episodeId);
      const body = latest?.body_json as PodcastScriptBody | undefined;
      if (!body) return reply.code(404).send({ message: 'Script not found' });
      const idx = body.turns.findIndex((t) => t.id === request.params.turnId);
      if (idx === -1) return reply.code(404).send({ message: 'Turn not found' });

      try {
        const clip = await revoicePodcastTurn({ show: loaded.show, episode: loaded.episode, turns: body.turns, index: idx, scriptVersion: latest?.version ?? null });
        // Keep the mix's script binding fresh so the "changed" banner clears for this line.
        await db.update(podcast_mixes)
          .set({ script_version: latest?.version ?? null, script_hash: latest ? (latest.status === 'approved' ? latest.content_hash : scriptHash(body)) : null, updated_at: new Date() })
          .where(eq(podcast_mixes.episode_id, episodeId));
        return reply.send({ clip: { ...clip, url: storage.getPublicUrl(clip.storage_key) } });
      } catch (err) {
        logger.warn({ err }, 'Studio re-voice failed');
        return reply.code(502).send({ message: 'Could not re-voice this line — check the ElevenLabs voices are set.' });
      }
    },
  );

  // GET /studio/snapshots
  app.get<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/snapshots',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const mix = await db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, loaded.episode.id) });
      if (!mix) return reply.send({ snapshots: [] });
      const rows = await db.query.podcast_mix_snapshots.findMany({ where: eq(podcast_mix_snapshots.mix_id, mix.id), orderBy: [desc(podcast_mix_snapshots.created_at)] });
      return reply.send({ snapshots: rows.map((s) => ({ id: s.id, name: s.name, kind: s.kind, script_version: s.script_version, render_id: s.render_id, created_at: s.created_at })) });
    },
  );

  // POST /studio/snapshots — manual save of the current draft.
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/snapshots',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });
      const mix = await db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, loaded.episode.id) });
      if (!mix?.timeline_json) return reply.code(409).send({ message: 'Nothing to save yet' });
      const [row] = await db.insert(podcast_mix_snapshots).values({
        mix_id: mix.id, name: parsed.data.name, kind: 'manual', script_version: mix.script_version, timeline_json: mix.timeline_json,
      }).returning();
      return reply.send({ snapshot: { id: row.id, name: row.name, kind: row.kind, script_version: row.script_version, render_id: row.render_id, created_at: row.created_at } });
    },
  );

  // POST /studio/snapshots/:id/restore — copy a snapshot's timeline into the draft.
  app.post<{ Params: { showId: string; epId: string; id: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/snapshots/:id/restore',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const mix = await db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, loaded.episode.id) });
      if (!mix) return reply.code(404).send({ message: 'No mix' });
      const snap = await db.query.podcast_mix_snapshots.findFirst({ where: and(eq(podcast_mix_snapshots.id, request.params.id), eq(podcast_mix_snapshots.mix_id, mix.id)) });
      if (!snap) return reply.code(404).send({ message: 'Snapshot not found' });
      const [updated] = await db.update(podcast_mixes)
        .set({ timeline_json: snap.timeline_json, rev: mix.rev + 1, updated_at: new Date() })
        .where(eq(podcast_mixes.id, mix.id))
        .returning({ rev: podcast_mixes.rev });
      return reply.send({ rev: updated.rev, timeline: snap.timeline_json });
    },
  );

  // POST /studio/export — freeze a snapshot + render a master honoring the edit.
  app.post<{ Params: { showId: string; epId: string } }>(
    '/api/v1/podcasts/:showId/episodes/:epId/studio/export',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const loaded = await ownedEpisodeInShow(request.params.showId, request.params.epId, request.dbUser!);
      if (!loaded) return reply.code(404).send({ message: 'Episode not found' });
      const episodeId = loaded.episode.id;
      const parsed = z.object({ format: z.enum(['mp4', 'mp3', 'wav']) }).safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });

      if (!rateLimit(`podcast-render:${request.dbUser!.id}`, 10, 60 * 60_000)) {
        return reply.code(429).send({ message: 'Too many exports — please wait a bit before exporting again.' });
      }
      const mix = await db.query.podcast_mixes.findFirst({ where: eq(podcast_mixes.episode_id, episodeId) });
      if (!mix?.timeline_json) return reply.code(409).send({ message: 'Build the audio before exporting.' });

      // Validate the draft resolves to something audible before spending a job.
      const timeline = MixTimelineSchema.parse(mix.timeline_json) as MixTimeline;
      const clips = await db.query.podcast_clips.findMany({ where: eq(podcast_clips.episode_id, episodeId), columns: { id: true, duration_ms: true } });
      const durById = new Map(clips.map((c) => [c.id, c.duration_ms]));
      const { totalMs } = layoutMix(timeline, (id) => durById.get(id) ?? 0);
      if (totalMs <= 0) return reply.code(409).send({ message: 'The mix is empty.' });

      const inflight = await db.query.podcast_renders.findFirst({
        where: and(eq(podcast_renders.episode_id, episodeId), eq(podcast_renders.kind, 'mix')),
        orderBy: [desc(podcast_renders.created_at)],
      });
      if (inflight && ACTIVE_RENDER.includes(inflight.status as typeof ACTIVE_RENDER[number])) {
        return reply.code(202).send({ render_id: inflight.id, already_running: true });
      }

      const [snapshot] = await db.insert(podcast_mix_snapshots).values({
        mix_id: mix.id, name: `Export · ${parsed.data.format.toUpperCase()} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        kind: 'export', script_version: mix.script_version, timeline_json: mix.timeline_json,
      }).returning({ id: podcast_mix_snapshots.id });

      const [render] = await db.insert(podcast_renders).values({
        episode_id: episodeId, script_version: mix.script_version, status: 'queued',
        script_hash: mix.script_hash, kind: 'mix', format: parsed.data.format, mix_snapshot_id: snapshot.id,
      }).returning({ id: podcast_renders.id });
      await db.update(podcast_mix_snapshots).set({ render_id: render.id }).where(eq(podcast_mix_snapshots.id, snapshot.id));

      enqueueJob('podcast_mix_export', { renderId: render.id });
      return reply.code(202).send({ render_id: render.id });
    },
  );
}
