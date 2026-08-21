/**
 * THE IMPACT-REVIEW QUEUE — the only thing this service is allowed to do about a broken placement.
 *
 * D-01b's ruling in one sentence: when a media change leaves a placement with no honest answer, the
 * row is KEPT EXACTLY AS AUTHORED and a person is told. Nothing here writes to
 * `timeline_sections`. That restraint is the entire point — the code this replaces "fixed" the same
 * situation with `SET end_sec = LEAST(end_sec, $new)` from a background job, which destroyed the
 * authored value in place, kept no copy of it, and surfaced nothing.
 *
 * WHAT COUNTS AS AN IMPACT is decided by `planHostMediaImpact` in shared/timeline, against the same
 * boundary rules the write endpoints validate with. This file is the database half only: load the
 * project, ask, and upsert the findings.
 *
 * IDEMPOTENT BY CONSTRUCTION. The transcode job that calls this is delivered at least once, so the
 * insert targets `uniq_placement_impact_open` — at most one OPEN review per (section, reason) — and
 * REFRESHES the numbers on conflict rather than appending. A re-driven job therefore updates a
 * finding instead of handing the author the same one twice.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  placement_impact_reviews,
  timeline_sections,
  video_files,
  type NewPlacementImpactReview,
} from '../../db/schema.js';
import {
  buildMainSegmentTimeline,
  planHostMediaImpact,
  type HostChangeKind,
  type PlacementImpact,
} from 'shared';
import { logger } from '../../lib/logger.js';

/** The vocabulary of a resolution. There is deliberately no value meaning "the system fixed it". */
export type PlacementReviewResolution = 're_placed' | 'accepted' | 'dismissed';

export function isPlacementReviewResolution(v: unknown): v is PlacementReviewResolution {
  return v === 're_placed' || v === 'accepted' || v === 'dismissed';
}

/** A row shaped for the queue. Exported so the delete path can write its own reason code. */
function reviewRow(
  projectId: string,
  impact: PlacementImpact,
  changeKind: HostChangeKind | 'host_delete' | 'generation_published',
): NewPlacementImpactReview | null {
  if (!impact.sectionId) return null;
  return {
    project_id: projectId,
    section_id: impact.sectionId,
    host_video_file_id: impact.hostVideoFileId,
    reason: impact.reason,
    change_kind: changeKind,
    host_duration_before_sec: impact.hostDurationSecBefore,
    host_duration_after_sec: impact.hostDurationSecAfter,
    anchor_offset_sec: impact.anchorOffsetSec,
    window_start_sec: impact.windowStartSec,
    window_end_sec: impact.windowEndSec,
    absolute_sec: impact.absoluteSec,
    detail: impact.detail,
  };
}

/**
 * Open (or refresh) a review for every row this media change left outside its host.
 *
 * Called AFTER the new duration has been written, because the anchors are judged against the
 * timeline as it now is — the same layout the viewer is about to serve.
 *
 * NON-FATAL by contract: it is called from the transcode job, and a bookkeeping failure must not
 * fail a transcode that has already produced a playable rendition. A failure is logged loudly
 * because it means an author is not being told something they are owed.
 */
export async function recordHostMediaImpacts(opts: {
  projectId: string;
  hostVideoFileId: string;
  afterDurationSec: number;
  beforeDurationSec: number | null;
  kind: HostChangeKind;
}): Promise<PlacementImpact[]> {
  const { projectId, hostVideoFileId, afterDurationSec, beforeDurationSec, kind } = opts;
  try {
    const [videos, rows] = await Promise.all([
      db.query.video_files.findMany({
        where: eq(video_files.project_id, projectId),
        orderBy: [asc(video_files.created_at)],
        columns: { id: true, duration_sec: true, is_broll: true },
      }),
      db.query.timeline_sections.findMany({
        where: eq(timeline_sections.project_id, projectId),
      }),
    ]);

    const impacts = planHostMediaImpact({
      hostVideoFileId,
      afterDurationSec,
      beforeDurationSec,
      kind,
      rows: rows ?? [],
      timelineAfter: buildMainSegmentTimeline(videos ?? []),
    });
    if (impacts.length === 0) return [];

    const values = impacts
      .map((i) => reviewRow(projectId, i, kind))
      .filter((v): v is NewPlacementImpactReview => v !== null);
    if (values.length === 0) return impacts;

    await db
      .insert(placement_impact_reviews)
      .values(values)
      .onConflictDoUpdate({
        target: [placement_impact_reviews.section_id, placement_impact_reviews.reason],
        // The conflict target is the PARTIAL index, so the predicate has to be named for Postgres
        // to infer it. Without this the statement raises "no unique or exclusion constraint
        // matching the ON CONFLICT specification" — silently, from a background job.
        targetWhere: isNull(placement_impact_reviews.resolved_at),
        set: {
          change_kind: sql`excluded.change_kind`,
          host_video_file_id: sql`excluded.host_video_file_id`,
          host_duration_before_sec: sql`excluded.host_duration_before_sec`,
          host_duration_after_sec: sql`excluded.host_duration_after_sec`,
          anchor_offset_sec: sql`excluded.anchor_offset_sec`,
          window_start_sec: sql`excluded.window_start_sec`,
          window_end_sec: sql`excluded.window_end_sec`,
          absolute_sec: sql`excluded.absolute_sec`,
          detail: sql`excluded.detail`,
          detected_at: sql`now()`,
        },
      });

    logger.warn(
      { projectId, hostVideoFileId, kind, count: impacts.length,
        sectionIds: impacts.map((i) => i.sectionId) },
      'placement impact: rows kept as authored and queued for review — nothing was clamped',
    );
    return impacts;
  } catch (err) {
    logger.error(
      { err, projectId, hostVideoFileId, kind },
      'placement impact: could not record the review queue — an author will not be told about a placement this change broke',
    );
    return [];
  }
}

/**
 * A GENERATED CLIP LANDING ON A TIMELINE THAT MOVED WHILE IT RENDERED.
 *
 * The anchor is captured at ENQUEUE and copied onto the published section verbatim — re-deriving it
 * at completion would read a timeline the author never saw, which is the race the anchor exists to
 * end. That is right, and it leaves one case open: if the host was REPLACED with shorter media
 * during the twenty-five minutes the vendor took, the section is published onto a host it no longer
 * fits. The transcode-time detector cannot catch it, because the row did not exist yet.
 *
 * So the check happens once, at publish, and its only power is to file a review. The section is
 * published either way: dropping an author's generated clip, or quietly moving it, would each be
 * worse than showing it at a second they can correct.
 *
 * NON-FATAL and OUTSIDE the publish transaction, deliberately — a generation that produced a video
 * and a row has succeeded, and no bookkeeping failure may turn that into a retry.
 */
export async function recordPublishedAnchorImpact(opts: {
  projectId: string;
  sectionId: string;
}): Promise<void> {
  const { projectId, sectionId } = opts;
  try {
    const [row, videos] = await Promise.all([
      db.query.timeline_sections.findFirst({ where: eq(timeline_sections.id, sectionId) }),
      db.query.video_files.findMany({
        where: eq(video_files.project_id, projectId),
        orderBy: [asc(video_files.created_at)],
        columns: { id: true, duration_sec: true, is_broll: true },
      }),
    ]);
    if (!row || !row.anchor_video_file_id) return;

    const timeline = buildMainSegmentTimeline(videos ?? []);
    const impacts = planHostMediaImpact({
      hostVideoFileId: row.anchor_video_file_id,
      // The host as it is NOW. "Before" is unknown from here — the change happened while the job
      // ran — and inventing a number for it would put a fiction in front of the reviewer.
      afterDurationSec: timeline.byId.get(row.anchor_video_file_id)?.durationSec ?? 0,
      beforeDurationSec: null,
      kind: 'media_replace',
      rows: [row],
      timelineAfter: timeline,
    });
    const anchorImpact = impacts.find((i) => i.reason === 'anchor_out_of_range');
    if (!anchorImpact) return;

    await db
      .insert(placement_impact_reviews)
      .values({
        ...reviewRow(projectId, anchorImpact, 'generation_published')!,
        detail:
          'this clip was generated for a spot in a video that was replaced while it rendered — ' +
          `it was published exactly where it was asked for (${anchorImpact.detail})`,
      })
      .onConflictDoNothing({
        target: [placement_impact_reviews.section_id, placement_impact_reviews.reason],
        where: isNull(placement_impact_reviews.resolved_at),
      });

    logger.warn(
      { projectId, sectionId, hostVideoFileId: row.anchor_video_file_id },
      'placement impact: a generated clip published onto a host that changed while it rendered — queued for review',
    );
  } catch (err) {
    logger.warn({ err, projectId, sectionId }, 'placement impact: could not check a freshly published anchor');
  }
}

/**
 * Close every open review for these sections.
 *
 * The caller decides what happened; this cannot invent `re_placed`, because "the author moved it"
 * is a fact only a write path knows. Runs inside the caller's transaction when one is given, so a
 * detach that fails rolls its reviews back with it.
 */
export async function resolveOpenReviewsForSections(
  sectionIds: readonly string[],
  resolution: PlacementReviewResolution,
  tx: Pick<typeof db, 'update'> = db,
): Promise<void> {
  if (sectionIds.length === 0) return;
  await tx
    .update(placement_impact_reviews)
    .set({ resolved_at: new Date(), resolution })
    .where(and(
      inArray(placement_impact_reviews.section_id, [...sectionIds]),
      isNull(placement_impact_reviews.resolved_at),
    ));
}

/**
 * Best-effort resolution for the editor's write path: an author who drags an impacted clip has just
 * answered the question the review was asking, so the item closes itself.
 *
 * SWALLOWS ITS ERRORS. A section PATCH that succeeded must not report failure because the queue
 * could not be tidied; the worst case is a stale review the author can dismiss by hand.
 */
export async function resolveReviewsAfterReplacement(sectionId: string | null | undefined): Promise<void> {
  if (!sectionId) return;
  try {
    await resolveOpenReviewsForSections([sectionId], 're_placed');
  } catch (err) {
    logger.warn({ err, sectionId }, 'placement impact: could not close the review this edit answered');
  }
}
