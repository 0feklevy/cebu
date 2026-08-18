/**
 * episodeJobClaim — the serialisation point for every BILLABLE job an episode can start.
 *
 * WHAT WAS WRONG (database-008 / backend-007)
 * Three endpoints guarded a paid job with a READ followed by a WRITE and nothing in between:
 *
 *     const inflight = await db.query.podcast_renders.findFirst({ … status IN active … });
 *     if (inflight) return 202 already_running;
 *     await db.insert(podcast_renders).values({ … });        // ← a second caller is already here
 *
 * A double-click, a retried fetch or two open tabs put two requests in that window, both observe
 * an empty in-flight set, and both insert. The worker's own CAS cannot save it: `runPodcastRender`
 * claims per ROW (`podcast_renders.claimed_at`), so two rows are two legitimate claims and the
 * episode is synthesised twice against ElevenLabs. One click, two bills, and the second master
 * silently wins whichever poll looks last.
 *
 * THE PRIMITIVE, AND WHY THIS ONE
 * Every one of these jobs belongs to exactly one episode, and `podcast_episodes` already has
 * exactly one row per episode. That row is therefore the serialisation point — the same move
 * migration 062 documents for `video_generation_jobs` ("the job row is the serialisation point"):
 * lock it with SELECT … FOR UPDATE, re-check the in-flight set AFTER the wait, and write inside the
 * same transaction. A second delivery blocks on the lock and then OBSERVES the winner instead of
 * racing it, and a body that throws rolls its half-written snapshot back with it.
 *
 *   • NOT `pg_advisory_lock`. Production runs against Supabase's TRANSACTION pooler on 6543, where
 *     a session-scoped lock is taken on whichever backend the pool handed out for that statement
 *     and is NOT released when the transaction ends. Row locks are transaction-scoped, so they are
 *     the ones that survive transaction pooling.
 *
 *   • NOT a new partial unique index on `podcast_renders`. Three reasons, in order of weight:
 *     (1) the table may ALREADY hold duplicate in-flight rows written by this very bug, so the
 *     index build would fail the deploy on exactly the data the fix exists for; (2) it could only
 *     be built NON-concurrently — `db/migrate.ts` wraps every file in one transaction and says so
 *     under "KNOWN LIMITATION: CREATE INDEX CONCURRENTLY … cannot be used under this runner" — so
 *     it would also take an ACCESS EXCLUSIVE lock on a table the studio polls, and migration 062
 *     rules this shape out by name ("never code first, index second"); (3) the two studio paths
 *     need conditions (`kind`, and `podcast_mixes.status`, a different table) that no one index
 *     expresses. A schema-level backstop is still worth having one day, after a de-duplication
 *     backfill and once the runner can issue CONCURRENTLY — it just cannot be what this fix stands
 *     on today.
 *
 *   • NOT a lock on the render/mix row: for the first delivery there IS no such row yet, which is
 *     precisely the race. The parent must be the thing that is locked.
 *
 * WHAT IS DELIBERATELY LEFT OUTSIDE THE CLAIM
 * Ownership, rate limiting, script approval, and the "is this mix audible?" arithmetic all stay in
 * the caller. The transaction holds one row and does the smallest amount of work that has to be
 * atomic; anything else in here would hold an episode's lock across an LLM call. Enqueueing is the
 * caller's job too, and must happen AFTER the commit — a job delivered for a row that then rolls
 * back is a worker chasing a render that does not exist.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { podcast_episodes, podcast_mixes, podcast_mix_snapshots, podcast_renders } from '../../db/schema.js';

/** The statuses that mean "a worker is, or is about to be, spending money on this row". */
export const ACTIVE_RENDER_STATUSES = ['queued', 'synthesizing', 'stitching', 'encoding'] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The episode was deleted between the ownership check and the claim. It propagates, and the route's
 * error handler answers 500 — deliberately the same outcome the old code produced (the insert's
 * episode_id FK would have failed), because inventing a 404 here would be a behaviour change
 * dressed up as a race fix, on a path no test can reach.
 */
export class EpisodeVanished extends Error {
  constructor(public readonly episodeId: string) {
    super(`podcast episode ${episodeId} vanished before its job could be claimed`);
    this.name = 'EpisodeVanished';
  }
}

/**
 * Run `body` with this episode's row held under a transaction-scoped exclusive lock.
 *
 * The lock is taken FIRST and the re-check happens INSIDE, never before: the row we blocked on may
 * have acquired an in-flight job while we waited, and a decision made before the wait is a decision
 * about a state that no longer exists.
 */
export async function withEpisodeJobClaim<T>(episodeId: string, body: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: podcast_episodes.id })
      .from(podcast_episodes)
      .where(eq(podcast_episodes.id, episodeId))
      .for('update');
    if (!locked) throw new EpisodeVanished(episodeId);
    return body(tx);
  });
}

export type EpisodeRenderClaim =
  | { outcome: 'started'; renderId: string }
  | { outcome: 'already_running'; renderId: string }
  | { outcome: 'unchanged'; renderId: string };

/**
 * Claim the one-click episode export. `unchanged` means the newest READY master already matches the
 * approved script, so the honest answer is to hand back the master rather than pay for an identical
 * one — that check lives in here rather than in the caller because it reads the same table the
 * claim protects, and a decision taken outside the lock could be invalidated by the winner.
 */
export async function claimEpisodeRender(
  episodeId: string,
  script: { version: number | null; contentHash: string | null },
): Promise<EpisodeRenderClaim> {
  return withEpisodeJobClaim(episodeId, async (tx) => {
    const inflight = await tx.query.podcast_renders.findFirst({
      where: and(
        eq(podcast_renders.episode_id, episodeId),
        inArray(podcast_renders.status, [...ACTIVE_RENDER_STATUSES]),
      ),
    });
    if (inflight) return { outcome: 'already_running', renderId: inflight.id };

    const latestReady = await tx.query.podcast_renders.findFirst({
      where: and(eq(podcast_renders.episode_id, episodeId), eq(podcast_renders.status, 'ready')),
      orderBy: [desc(podcast_renders.created_at)],
    });
    if (latestReady?.script_hash && latestReady.script_hash === script.contentHash) {
      return { outcome: 'unchanged', renderId: latestReady.id };
    }

    const [render] = await tx.insert(podcast_renders).values({
      episode_id: episodeId,
      script_version: script.version,
      status: 'queued',
      script_hash: script.contentHash,
    }).returning({ id: podcast_renders.id });

    await tx.update(podcast_episodes)
      .set({ status: 'rendering', updated_at: new Date() })
      .where(eq(podcast_episodes.id, episodeId));

    return { outcome: 'started', renderId: render!.id };
  });
}

export type MixExportClaim =
  | { outcome: 'started'; renderId: string }
  | { outcome: 'already_running'; renderId: string };

/**
 * Claim a studio master export. The freeze snapshot is created INSIDE the claim on purpose: it and
 * the render row are one fact ("this master was rendered from exactly these edits"), and the old
 * code could leave an orphan snapshot behind whenever the render insert failed.
 */
export async function claimMixExport(
  episodeId: string,
  mix: { id: string; script_version: number | null; script_hash: string | null; timeline_json: unknown },
  format: 'mp4' | 'mp3' | 'wav',
): Promise<MixExportClaim> {
  return withEpisodeJobClaim(episodeId, async (tx) => {
    const inflight = await tx.query.podcast_renders.findFirst({
      where: and(eq(podcast_renders.episode_id, episodeId), eq(podcast_renders.kind, 'mix')),
      orderBy: [desc(podcast_renders.created_at)],
    });
    if (inflight && (ACTIVE_RENDER_STATUSES as readonly string[]).includes(inflight.status)) {
      return { outcome: 'already_running', renderId: inflight.id };
    }

    const [snapshot] = await tx.insert(podcast_mix_snapshots).values({
      mix_id: mix.id,
      name: `Export · ${format.toUpperCase()} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      kind: 'export',
      script_version: mix.script_version,
      timeline_json: mix.timeline_json,
    }).returning({ id: podcast_mix_snapshots.id });

    const [render] = await tx.insert(podcast_renders).values({
      episode_id: episodeId,
      script_version: mix.script_version,
      status: 'queued',
      script_hash: mix.script_hash,
      kind: 'mix',
      format,
      mix_snapshot_id: snapshot!.id,
    }).returning({ id: podcast_renders.id });

    await tx.update(podcast_mix_snapshots)
      .set({ render_id: render!.id })
      .where(eq(podcast_mix_snapshots.id, snapshot!.id));

    return { outcome: 'started', renderId: render!.id };
  });
}

export type MixGenerationClaim =
  | { outcome: 'started'; mixId: string }
  | { outcome: 'already_running'; mixId: string };

/**
 * Claim a clip rebuild. Two callers used to be able to flip one mix to `generating` and enqueue two
 * `podcast_clips` jobs — a second full per-turn TTS pass — and on a FIRST build they raced the
 * `podcast_mixes(episode_id)` unique constraint instead, turning a double click into a raw 23505
 * and a 500. Under the episode lock the loser adopts the winner's row.
 */
export async function claimMixGeneration(episodeId: string): Promise<MixGenerationClaim> {
  return withEpisodeJobClaim(episodeId, async (tx) => {
    const existing = await tx.query.podcast_mixes.findFirst({
      where: eq(podcast_mixes.episode_id, episodeId),
    });
    if (existing?.status === 'generating') return { outcome: 'already_running', mixId: existing.id };

    if (existing) {
      // Snapshot the current draft before rebuilding over it, so a rebuild is never destructive.
      if (existing.timeline_json) {
        await tx.insert(podcast_mix_snapshots).values({
          mix_id: existing.id,
          name: `Before rebuild · ${new Date().toISOString().slice(0, 10)}`,
          kind: 'pre_rebuild',
          script_version: existing.script_version,
          timeline_json: existing.timeline_json,
        });
      }
      await tx.update(podcast_mixes)
        .set({ status: 'generating', progress: null, error: null, claimed_at: null, updated_at: new Date() })
        .where(eq(podcast_mixes.id, existing.id));
      return { outcome: 'started', mixId: existing.id };
    }

    const [row] = await tx.insert(podcast_mixes)
      .values({ episode_id: episodeId, status: 'generating' })
      .returning({ id: podcast_mixes.id });
    return { outcome: 'started', mixId: row!.id };
  });
}
