/**
 * podcastAccess — ownership gating for Podcast Studio (migration 044).
 *
 * Shows are personal for v1 (owned by `created_by`); episodes/sources/scripts/
 * renders inherit access from their show. This is the ONE place ownership is
 * checked — controllers must never inline `eq(podcast_shows.created_by, …)`, so
 * the later collaboration retrofit (mirroring collabAccess.ts) has a single seam.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { podcast_shows, podcast_episodes } from '../db/schema.js';

export type PodcastUser = { id: string };

/** WHERE: this specific show is owned by the user. */
export function showOwnedWhere(showId: string, user: PodcastUser): SQL {
  return and(eq(podcast_shows.id, showId), eq(podcast_shows.created_by, user.id))!;
}

/** WHERE fragment for listing: any show owned by the user. */
export function showsOwnedByWhere(user: PodcastUser): SQL {
  return eq(podcast_shows.created_by, user.id);
}

/** Load a show the user owns, or null. */
export async function ownedShow(showId: string, user: PodcastUser) {
  const row = await db.query.podcast_shows.findFirst({ where: showOwnedWhere(showId, user) });
  return row ?? null;
}

/**
 * Load an episode + its parent show, gated by ownership. Returns null if the
 * episode does not exist or the show is not owned by the user.
 */
export async function ownedEpisode(episodeId: string, user: PodcastUser) {
  const episode = await db.query.podcast_episodes.findFirst({
    where: eq(podcast_episodes.id, episodeId),
  });
  if (!episode) return null;
  const show = await ownedShow(episode.show_id, user);
  if (!show) return null;
  return { episode, show };
}

/**
 * Same as ownedEpisode but also asserts the episode belongs to `showId`
 * (so a nested route /shows/:showId/episodes/:epId can't be crossed).
 */
export async function ownedEpisodeInShow(showId: string, episodeId: string, user: PodcastUser) {
  const loaded = await ownedEpisode(episodeId, user);
  if (!loaded || loaded.show.id !== showId) return null;
  return loaded;
}
