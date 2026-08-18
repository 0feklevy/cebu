/**
 * podcast_render job — synthesize + stitch one export. CAS-claimed on claimed_at
 * (the status is a multi-stage lifecycle). Idempotent; startup recovery fails
 * genuinely-stuck renders and re-drives ones that were only ever queued.
 */

import { and, asc, eq, or, isNull, lt, notInArray } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_renders, podcast_episodes } from '../../../db/schema.js';
import { PodcastRenderer } from './PodcastRenderer.js';
import { enqueueJob } from '../../../queue/index.js';
import { logger } from '../../../lib/logger.js';

const STALE_MS = 30 * 60 * 1000; // a render (synth + ffmpeg) shouldn't exceed ~30 min

/** How many untouched queued renders one recovery pass will re-drive. A backlog is bounded. */
const REDRIVE_LIMIT = 200;

/**
 * Spacing between re-driven renders. 200 x 250ms ≈ 50s to hand out a full page, which is nothing
 * against a render measured in minutes, and it keeps the boot path from starting the whole backlog
 * at once on a 2-vCPU host. See the loop for why this is a stagger and not a limiter.
 */
export const REDRIVE_STAGGER_MS = 250;

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

/**
 * Startup recovery. Two DIFFERENT states wear the same "not finished" clothes, and conflating
 * them is what made every deploy destroy work that had not gone wrong (database-003).
 *
 *   CLAIMED AND ABANDONED — `claimed_at` is set and older than the stale window. A process took
 *   this row and died. Nothing is coming back for it, so it is failed and the episode released.
 *
 *   CLAIMED AND RECENT — `claimed_at` is inside the window. Another instance may be rendering it
 *   right now. Left alone; the next pass will collect it once the lease genuinely expires.
 *
 *   QUEUED AND UNTOUCHED — `claimed_at IS NULL`. The controller inserted the row seconds ago and
 *   the delivery has not landed yet. THIS IS NOT A FAILURE. The previous predicate
 *   (`claimed_at IS NULL OR claimed_at < stale`) matched it on every boot and flipped it to
 *   `failed`, which is also terminal — so the delivery that arrived afterwards was refused by
 *   `runPodcastRenderJob`'s CAS (`status NOT IN ('ready','failed')`) and the render was gone.
 *
 * The queued row is left QUEUED and re-driven instead. Re-driving is not optional: neither
 * `podcast_render` nor `podcast_mix_export` is in `PGBOSS_JOB_NAMES`, so both always run on the
 * inline driver, whose `setImmediate` dies with the process — merely sparing the row would trade
 * "killed on every deploy" for "waits forever". The re-delivery is safe to duplicate because the
 * job body claims by CAS: a second delivery for a row someone already claimed does nothing.
 */
export async function recoverStuckPodcastRenders(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_MS);

  // NOTE the absence of `or(isNull(claimed_at), …)`. `claimed_at < threshold` is NULL-false in SQL,
  // which is precisely the wanted behaviour: a row nobody ever claimed is not an abandoned run.
  const stuck = await db
    .update(podcast_renders)
    .set({ status: 'failed', error: 'Render was interrupted — please try again.', claimed_at: null, updated_at: new Date() })
    .where(
      and(
        notInArray(podcast_renders.status, ['ready', 'failed']),
        lt(podcast_renders.claimed_at, staleThreshold),
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

  // Queued and untouched: the row is fine, only its in-memory delivery is gone. Re-drive it.
  //
  // ORDERED, and the ORDER BY is not cosmetic. The re-drive is capped, and a capped SELECT with no
  // ORDER BY lets Postgres return an arbitrary — and plausibly identical — page every boot, which
  // would starve everything outside it indefinitely. Oldest-first means a backlog drains in a
  // defined order and the tail is reached.
  const orphaned = await db
    .select({ id: podcast_renders.id, kind: podcast_renders.kind })
    .from(podcast_renders)
    .where(
      and(
        notInArray(podcast_renders.status, ['ready', 'failed']),
        isNull(podcast_renders.claimed_at),
      )!,
    )
    .orderBy(asc(podcast_renders.created_at))
    .limit(REDRIVE_LIMIT);

  // DRIP, DO NOT DUMP. `enqueueJob` on the inline driver is `setImmediate` with no concurrency
  // limiter (queue/inlineDriver.ts), and neither podcast job is in PGBOSS_JOB_NAMES — so this loop
  // runs in the API process. Firing the whole page at once would start up to REDRIVE_LIMIT
  // simultaneous TTS + ffmpeg renders on a 2-vCPU host, during boot, before the server is even
  // listening: a self-inflicted outage triggered by the recovery path that exists to prevent one.
  //
  // The stagger is deliberately dumb rather than clever. A real concurrency limiter belongs in the
  // driver, where it would cover every caller; putting one here would only hide the driver's gap
  // from the next person who needs it. Spacing the enqueues keeps the boot storm bounded without
  // pretending the underlying limitation is solved — it is recorded as a follow-up on the driver.
  for (const [i, r] of orphaned.entries()) {
    const name = r.kind === 'mix' ? 'podcast_mix_export' : 'podcast_render';
    if (i === 0) {
      enqueueJob(name, { renderId: r.id });
      continue;
    }
    const t = setTimeout(() => enqueueJob(name, { renderId: r.id }), i * REDRIVE_STAGGER_MS);
    // Unref'd: a pending re-drive must never hold the process open during a shutdown.
    if (typeof t.unref === 'function') t.unref();
  }
  if (orphaned.length) {
    logger.warn(
      { count: orphaned.length, staggerMs: REDRIVE_STAGGER_MS, spanMs: (orphaned.length - 1) * REDRIVE_STAGGER_MS },
      'Re-drove queued podcast renders left by a restart',
    );
  }
}
