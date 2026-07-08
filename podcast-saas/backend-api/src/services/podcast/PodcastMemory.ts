/**
 * Series memory — what keeps a show continuous across episodes.
 *
 * On episode approval we summarise the episode (Memory Scribe pass) and UPSERT it
 * onto the episode, then rebuild the show's rolling memory from every approved
 * episode's summary (newest first, capped). Passes A and C of the next episode
 * read show.memory_json for callbacks and open-loop payoffs.
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { podcast_episodes, podcast_shows, podcast_scripts } from '../../db/schema.js';
import { LLMService } from '../llm/LLMService.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { loadPodcastPrompt, fillPrompt } from './prompts.js';
import { MemorySummarySchema } from './schemas.js';
import { logger } from '../../lib/logger.js';

const MAX_REMEMBERED_EPISODES = 12;

/** Summarise one approved episode and refresh the show's rolling memory. Best-effort. */
export async function writeEpisodeMemory(episodeId: string, scriptId: string, userId: string): Promise<void> {
  try {
    const episode = await db.query.podcast_episodes.findFirst({ where: eq(podcast_episodes.id, episodeId) });
    const script = await db.query.podcast_scripts.findFirst({ where: eq(podcast_scripts.id, scriptId) });
    if (!episode || !script) return;

    const llm = new LLMService(new ApiKeyService(), new UsageTrackingService());
    const sys = fillPrompt(await loadPodcastPrompt('podcast_memory_scribe'), {
      STORY_JSON: JSON.stringify(script.story_json ?? {}),
      DRAFT_TURNS: JSON.stringify((script.body_json as { turns?: unknown })?.turns ?? []),
    });
    const res = await llm.sendStructured({
      task: 'podcast_memory',
      systemPrompt: sys,
      userPrompt: 'Summarise the episode into series memory. Output only the raw JSON object.',
      schema: MemorySummarySchema,
      userId,
      projectId: null,
      abortSignal: new AbortController().signal,
    });

    // Upsert this episode's summary (keyed by episode — a re-approve REPLACES it).
    await db.update(podcast_episodes)
      .set({ memory_summary: res.data, updated_at: new Date() })
      .where(eq(podcast_episodes.id, episodeId));

    await rebuildShowMemory(episode.show_id);
  } catch (err) {
    logger.warn({ err, episodeId }, 'writeEpisodeMemory failed (non-fatal)');
  }
}

/** Rebuild show.memory_json from every episode that has a summary (never incremental append). */
export async function rebuildShowMemory(showId: string): Promise<void> {
  // NOT filtered by status: an episode keeps its memory_summary once approved, and the
  // status moves on to rendering/ready after export — filtering on status='approved'
  // would silently drop every episode the user actually produces. The memory_summary
  // presence check below is the real "has been approved at least once" gate.
  const rows = await db.query.podcast_episodes.findMany({
    where: eq(podcast_episodes.show_id, showId),
    orderBy: [desc(podcast_episodes.updated_at)],
  });

  const episodes = rows
    .filter((e) => e.memory_summary)
    .slice(0, MAX_REMEMBERED_EPISODES)
    .map((e) => ({ episode_number: e.episode_number, ...(e.memory_summary as object) }));

  await db.update(podcast_shows)
    .set({ memory_json: { episodes }, updated_at: new Date() })
    .where(eq(podcast_shows.id, showId));
}
