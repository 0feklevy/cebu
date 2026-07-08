/**
 * podcast_script job — runs the writers' room for one script version.
 *
 * CAS-claimed on `claimed_at` (the status is a multi-stage lifecycle, so we treat
 * "non-terminal status + stale/empty claim" as claimable). Idempotent: a second
 * worker that finds the row already claimed bows out. Startup recovery
 * (recoverStuckPodcastScripts in server.ts) flips genuinely-stuck rows to failed.
 */

import { and, eq, or, isNull, lt, notInArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { podcast_scripts, podcast_episodes, podcast_shows, podcast_sources } from '../../db/schema.js';
import { ScriptRoom } from './ScriptRoom.js';
import { logger } from '../../lib/logger.js';

const STALE_MS = 50 * 60 * 1000; // opus-max passes can run long; 50 min before a claim is considered dead

export async function runPodcastScriptJob(payload: { scriptId: string; directorNotes?: string | null }): Promise<void> {
  const { scriptId, directorNotes } = payload;
  const staleThreshold = new Date(Date.now() - STALE_MS);

  // Atomic CAS claim: only if not terminal (ready/approved/failed) and the claim is empty or stale.
  const claimed = await db
    .update(podcast_scripts)
    .set({ status: 'drafting', claimed_at: new Date() })
    .where(
      and(
        eq(podcast_scripts.id, scriptId),
        notInArray(podcast_scripts.status, ['ready', 'approved', 'failed']),
        or(isNull(podcast_scripts.claimed_at), lt(podcast_scripts.claimed_at, staleThreshold)),
      )!,
    )
    .returning({ id: podcast_scripts.id, episode_id: podcast_scripts.episode_id });

  if (claimed.length === 0) {
    logger.info({ scriptId }, 'podcast_script: already claimed or terminal — skipping');
    return;
  }

  const episodeId = claimed[0].episode_id;
  const episode = await db.query.podcast_episodes.findFirst({ where: eq(podcast_episodes.id, episodeId) });
  if (!episode) {
    logger.error({ scriptId, episodeId }, 'podcast_script: episode gone');
    await failScript(scriptId, episodeId, 'Episode not found');
    return;
  }
  const show = await db.query.podcast_shows.findFirst({ where: eq(podcast_shows.id, episode.show_id) });
  if (!show) {
    await failScript(scriptId, episodeId, 'Show not found');
    return;
  }
  const sources = await db.query.podcast_sources.findMany({ where: eq(podcast_sources.episode_id, episodeId) });

  try {
    await new ScriptRoom().run({
      scriptId,
      episode,
      show,
      sources,
      userId: show.created_by ?? '',
      directorNotes,
      onStage: (stage) => logger.info({ scriptId, stage }, 'podcast_script stage'),
    });
    logger.info({ scriptId }, 'podcast_script: complete');
  } catch (err) {
    logger.error({ err, scriptId }, 'podcast_script: failed');
    await failScript(scriptId, episodeId, err instanceof Error ? err.message : String(err));
  }
}

async function failScript(scriptId: string, episodeId: string, message: string): Promise<void> {
  await db.update(podcast_scripts)
    .set({ status: 'failed', claimed_at: null, updated_at: new Date() })
    .where(eq(podcast_scripts.id, scriptId));
  // Only mark the episode failed if it was mid-first-scripting — never clobber an
  // episode that already has an approved/ready version (a failed regenerate must not
  // hide a good prior script/render).
  await db.update(podcast_episodes)
    .set({ status: 'failed', error: message.slice(0, 1000), updated_at: new Date() })
    .where(and(eq(podcast_episodes.id, episodeId), eq(podcast_episodes.status, 'scripting'))!);
}

/** Startup recovery: fail scripts stuck mid-generation past the stale window. */
export async function recoverStuckPodcastScripts(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_MS);
  const stuck = await db
    .update(podcast_scripts)
    .set({ status: 'failed', claimed_at: null, updated_at: new Date() })
    .where(
      and(
        notInArray(podcast_scripts.status, ['ready', 'approved', 'failed']),
        or(isNull(podcast_scripts.claimed_at), lt(podcast_scripts.claimed_at, staleThreshold)),
      )!,
    )
    .returning({ id: podcast_scripts.id, episode_id: podcast_scripts.episode_id });

  for (const s of stuck) {
    await db.update(podcast_episodes)
      .set({ status: 'failed', error: 'Script generation was interrupted — please try again.', updated_at: new Date() })
      .where(and(eq(podcast_episodes.id, s.episode_id), eq(podcast_episodes.status, 'scripting'))!);
  }
  if (stuck.length) logger.warn({ count: stuck.length }, 'Recovered stuck podcast scripts');
}
