/**
 * podcast_render job — synthesize + stitch one export. CAS-claimed on claimed_at
 * (the status is a multi-stage lifecycle). Idempotent; startup recovery fails
 * genuinely-stuck renders.
 */

import { and, eq, or, isNull, lt, notInArray } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_renders, podcast_episodes } from '../../../db/schema.js';
import { PodcastRenderer } from './PodcastRenderer.js';
import { logger } from '../../../lib/logger.js';

const STALE_MS = 30 * 60 * 1000; // a render (synth + ffmpeg) shouldn't exceed ~30 min

export async function runPodcastRenderJob(payload: { renderId: string }): Promise<void> {
  const { renderId } = payload;
  const staleThreshold = new Date(Date.now() - STALE_MS);

  const claimed = await db
    .update(podcast_renders)
    .set({ status: 'synthesizing', claimed_at: new Date() })
    .where(
      and(
        eq(podcast_renders.id, renderId),
        notInArray(podcast_renders.status, ['ready', 'failed']),
        or(isNull(podcast_renders.claimed_at), lt(podcast_renders.claimed_at, staleThreshold)),
      )!,
    )
    .returning({ id: podcast_renders.id, episode_id: podcast_renders.episode_id });

  if (claimed.length === 0) {
    logger.info({ renderId }, 'podcast_render: already claimed or terminal — skipping');
    return;
  }
  const episodeId = claimed[0].episode_id;

  try {
    await new PodcastRenderer().render(renderId, episodeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, renderId }, 'podcast_render: failed');
    await db.update(podcast_renders)
      .set({ status: 'failed', error: message.slice(0, 1000), claimed_at: null, updated_at: new Date() })
      .where(eq(podcast_renders.id, renderId));
    // The episode stays whatever it was (a previous ready render is still playable);
    // only flip to failed if it was mid-render with no prior success.
    await db.update(podcast_episodes)
      .set({ status: 'approved', updated_at: new Date() })
      .where(and(eq(podcast_episodes.id, episodeId), eq(podcast_episodes.status, 'rendering'))!);
  }
}

/** Startup recovery: fail renders stuck past the stale window. */
export async function recoverStuckPodcastRenders(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_MS);
  const stuck = await db
    .update(podcast_renders)
    .set({ status: 'failed', error: 'Render was interrupted — please try again.', claimed_at: null, updated_at: new Date() })
    .where(
      and(
        notInArray(podcast_renders.status, ['ready', 'failed']),
        or(isNull(podcast_renders.claimed_at), lt(podcast_renders.claimed_at, staleThreshold)),
      )!,
    )
    .returning({ id: podcast_renders.id, episode_id: podcast_renders.episode_id });

  // Un-stick each episode left at 'rendering' — otherwise the UI shows "Rendering…"
  // forever even though the render row is now failed. Revert to 'approved' unless a
  // prior ready render exists, in which case the episode is playable → 'ready'.
  for (const r of stuck) {
    const priorReady = await db.query.podcast_renders.findFirst({
      where: and(eq(podcast_renders.episode_id, r.episode_id), eq(podcast_renders.status, 'ready'))!,
    });
    await db.update(podcast_episodes)
      .set({ status: priorReady ? 'ready' : 'approved', updated_at: new Date() })
      .where(and(eq(podcast_episodes.id, r.episode_id), eq(podcast_episodes.status, 'rendering'))!);
  }
  if (stuck.length) logger.warn({ count: stuck.length }, 'Recovered stuck podcast renders');
}
