/**
 * WHAT A CHANGE TO ONE VIDEO DOES TO THE ROWS PLACED AGAINST IT — computed here, applied nowhere.
 *
 * THE THREE CASES D-01b SEPARATES, AND WHY THEY ARE NOT ONE CASE
 * -------------------------------------------------------------
 * `placement.ts` answers "what second is this row at?". This module answers the question that comes
 * next: the host's media just changed — what, if anything, does an author now have to decide? The
 * ruling draws three lines, and the whole point is that they get DIFFERENT answers:
 *
 *   1. A DURATION CORRECTION — the transcode probe writes the real length over a client-measured
 *      guess, or a re-transcode of the SAME media lands a slightly different number. Nothing is
 *      rewritten. An anchored row's absolute second ripples out of the new layout by itself, which
 *      is the entire reason the anchor exists. This module never returns a rewrite for any case,
 *      but for this one it usually returns nothing at all.
 *   2. A MEDIA REPLACE — different bytes behind the same logical segment. The anchor is KEPT: the
 *      author placed a clip 12 s into "the intro", and it is still 12 s into the intro. But the new
 *      intro may be shorter than 12 s, and then there is no honest answer — so the row goes on an
 *      IMPACT-REVIEW list for a person to settle. It is NOT clamped to the new end, NOT zeroed, and
 *      NOT attached to the neighbouring segment. Clamping is the failure mode this replaces: it
 *      looks like a fix, destroys the authored value in place, and tells nobody.
 *   3. A DELETE — the host is going away entirely. There is no derivation that can stand in for a
 *      missing host, so the caller must present a CHOICE. `planHostDeleteImpact` lists what depends
 *      on the host and names the legal choices; it deliberately cannot express "re-anchor it to the
 *      next video", because "the next video" is a guess about intent that happens to type-check.
 *
 * NOTHING HERE WRITES, and every rule it applies is one `placement.ts` already owns —
 * `anchorPlacementViolations` decides what "outside the new duration" means, so the legality of an
 * anchor and the trigger for a review cannot drift apart into two different definitions of the same
 * boundary.
 *
 * WHICH WINDOW BELONGS TO WHICH VIDEO
 * -----------------------------------
 * `video_file_id` does not mean the same thing on every lane, and a rewrite that assumed it did
 * silently truncated a 60-second music bed to 12 seconds the day its host was replaced. On a
 * `main` row it is the host whose length bounds `start_sec`/`end_sec`; on a `broll` row it is the
 * b-roll SOURCE, and the same two columns are in/out points into THAT file; on an audio cutaway it
 * is only the host the cutaway hangs from, and start/end address the AUDIO file, which this host's
 * duration has nothing to say about. `sourceWindowFor` is that distinction, written once.
 */

import {
  laneForTimelineSection,
  type TimelineSectionLike,
} from './sectionShape.js';
import {
  anchorPlacementViolations,
  placementModeOf,
  resolveSectionPlacement,
  type MainSegmentTimeline,
  type PlacementSectionLike,
} from './placement.js';

/** Which of D-01b's first two cases produced this assessment. Recorded, never inferred later. */
export type HostChangeKind = 'duration_correction' | 'media_replace';

export type PlacementImpactReason =
  /**
   * The row is ANCHORED to this host and its `anchor_offset_sec` no longer lands inside it — past
   * the end of a non-last segment, or past the last segment's bounded post-roll tail. The anchor is
   * kept exactly as the author left it; what is in question is where it should now point.
   */
  | 'anchor_out_of_range'
  /**
   * The row's in/out WINDOW addresses media that just got shorter than the window. Distinct from
   * the anchor case: a b-roll's window is a span of its own source file, so this can be true while
   * the row's position on the main timeline is perfectly fine (and vice versa).
   */
  | 'source_window_out_of_range'
  /**
   * Recorded by the DELETE path when the author explicitly chose to keep an orphaned row. Not
   * produced by `planHostMediaImpact` — it is here because it is the same review queue, and the
   * whole point of that queue is that a row never leaves it silently.
   */
  | 'host_deleted_detached';

export interface PlacementImpact {
  sectionId: string | null;
  reason: PlacementImpactReason;
  changeKind: HostChangeKind;
  hostVideoFileId: string;
  /** The host's duration before the change. Null when it was never known. */
  hostDurationSecBefore: number | null;
  hostDurationSecAfter: number;
  /** The row's anchor offset, as stored. Null on a window-only impact. */
  anchorOffsetSec: number | null;
  /** The in/out window that no longer fits, in the source's own seconds. Null on an anchor impact. */
  windowStartSec: number | null;
  windowEndSec: number | null;
  /** Where the row resolves under the timeline AS IT IS NOW — what a viewer would see today. */
  absoluteSec: number;
  /** One sentence an author can act on, in the units they authored in. */
  detail: string;
}

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const isSet = (v: string | null | undefined): v is string => typeof v === 'string' && v.length > 0;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The span of THIS video that the row addresses, or null when the row addresses something else.
 *
 * The lane decides, never the column: see the header. `null` is the answer for every row whose
 * `start_sec`/`end_sec` are offsets into an audio file, an image, or nothing at all — and it is the
 * answer that keeps a music bed the length its author made it.
 */
export function sourceWindowFor(
  row: TimelineSectionLike,
  videoFileId: string,
): { startSec: number; endSec: number } | null {
  const start = finite(row.start_sec) ?? 0;
  const end = finite(row.end_sec);
  if (end === null) return null;

  switch (laneForTimelineSection(row)) {
    // `video_file_id` IS the media these two lanes' in/out points address.
    case 'main':
    case 'broll':
      return row.video_file_id === videoFileId ? { startSec: start, endSec: end } : null;
    // A clip overlay trims its own source: the window is `[clip_in, clip_in + shown duration)`,
    // because `start_sec`/`end_sec` here are positions on the HOST's timeline, not in the source.
    case 'clip_video': {
      if (row.clip_source_video_id !== videoFileId) return null;
      const clipIn = finite(row.clip_in_sec) ?? 0;
      return { startSec: clipIn, endSec: clipIn + Math.max(0, end - start) };
    }
    // An audio cutaway's start/end are offsets into the AUDIO file; an image has no duration at
    // all. Neither is bounded by any video's length.
    default:
      return null;
  }
}

export interface HostMediaChange {
  hostVideoFileId: string;
  /** The authoritative duration AFTER the change — the probe's number, not the client's guess. */
  afterDurationSec: number;
  /** Before the change, when it was known. Reported so a review reads as "60 s → 12 s". */
  beforeDurationSec?: number | null;
  kind: HostChangeKind;
  /** Every section of the project. Rows that do not depend on this host are skipped, not filtered. */
  rows: readonly PlacementSectionLike[];
  /** The main timeline AS IT IS AFTER the change — anchors are judged against the new layout. */
  timelineAfter: MainSegmentTimeline;
}

/**
 * Everything the author must be shown after this host's media changed. Writes nothing, clamps
 * nothing, and returns an EMPTY list when the change hurt no row — which is the normal outcome of a
 * duration correction and the outcome the anchor was built to produce.
 *
 * An unknown or non-positive new duration returns nothing: there is no number to measure against,
 * and inventing one (the old code's implicit "0") would nominate every row in the project.
 */
export function planHostMediaImpact(change: HostMediaChange): PlacementImpact[] {
  const { hostVideoFileId, kind, rows, timelineAfter } = change;
  const after = finite(change.afterDurationSec);
  if (after === null || after <= 0) return [];
  const before = finite(change.beforeDurationSec ?? null);

  const impacts: PlacementImpact[] = [];

  for (const row of rows) {
    const sectionId = row.id ?? null;
    const absoluteSec = resolveSectionPlacement(row, timelineAfter).absoluteSec;

    // ── The anchor ────────────────────────────────────────────────────────────
    //
    // Legality is `anchorPlacementViolations`' call and only its call. It is the same function the
    // write endpoints validate against, so "an offset the editor would refuse to write" and "an
    // offset that lands on the review list" are one rule rather than two that drift.
    if (
      placementModeOf(row) === 'segment' &&
      row.anchor_video_file_id === hostVideoFileId &&
      anchorPlacementViolations(row, timelineAfter).length > 0
    ) {
      const offset = finite(row.anchor_offset_sec);
      impacts.push({
        sectionId,
        reason: 'anchor_out_of_range',
        changeKind: kind,
        hostVideoFileId,
        hostDurationSecBefore: before,
        hostDurationSecAfter: after,
        anchorOffsetSec: offset,
        windowStartSec: null,
        windowEndSec: null,
        absoluteSec,
        detail:
          `anchored ${round2(offset ?? 0)}s into a host that is now ${round2(after)}s long` +
          (before !== null ? ` (was ${round2(before)}s)` : '') +
          ' — the anchor is kept as authored and needs an explicit decision',
      });
    }

    // ── The window ────────────────────────────────────────────────────────────
    const win = sourceWindowFor(row, hostVideoFileId);
    if (win && win.endSec > after) {
      impacts.push({
        sectionId,
        reason: 'source_window_out_of_range',
        changeKind: kind,
        hostVideoFileId,
        hostDurationSecBefore: before,
        hostDurationSecAfter: after,
        anchorOffsetSec: null,
        windowStartSec: win.startSec,
        windowEndSec: win.endSec,
        absoluteSec,
        detail:
          `plays ${round2(win.startSec)}s–${round2(win.endSec)}s of media that is now ` +
          `${round2(after)}s long` + (before !== null ? ` (was ${round2(before)}s)` : '') +
          ' — the stored window is kept and needs an explicit decision',
      });
    }
  }

  return impacts;
}

// ── Deleting a host ───────────────────────────────────────────────────────────

/**
 * What an author may do with the rows that depend on a host they are deleting.
 *
 * TWO CHOICES, AND NEITHER OF THEM IS A GUESS. `detach` keeps the content and drops the anchor —
 * the row stays at the second it plays at today and is put on the review list, so the author is
 * told it needs re-placing rather than discovering it later. `delete` removes the dependents with
 * the host.
 *
 * THERE IS DELIBERATELY NO `reanchor`. Moving a row to "the next" video is a guess about what the
 * author meant, made by a machine, that would be indistinguishable afterwards from a placement they
 * chose. The ruling forbids it, and the way to keep it forbidden is for the vocabulary not to
 * contain it.
 */
export type HostDeleteChoice = 'detach' | 'delete';

export const HOST_DELETE_CHOICES: readonly HostDeleteChoice[] = ['detach', 'delete'];

export function isHostDeleteChoice(v: unknown): v is HostDeleteChoice {
  return v === 'detach' || v === 'delete';
}

export type HostDependencyKind =
  /** `placement_mode='segment'` pointing at this host: the row's POSITION depends on it. */
  | 'anchor'
  /** The row's media — its own in/out window — is this video. Deleting it leaves nothing to play. */
  | 'source';

export interface HostDependent {
  sectionId: string | null;
  kind: HostDependencyKind;
  label: string | null;
  /** Where the row plays today, so the list reads in the units the author sees. */
  absoluteSec: number;
  anchorOffsetSec: number | null;
}

/** A section as the delete list reads it: placement columns, plus the name the author gave it. */
export interface LabelledSectionLike extends PlacementSectionLike {
  label?: string | null;
}

export interface HostDeletePlan {
  hostVideoFileId: string;
  dependents: HostDependent[];
  /** True when the delete must not proceed without the author naming a choice. */
  requiresChoice: boolean;
  choices: readonly HostDeleteChoice[];
}

/**
 * List what would break, and refuse to decide. Pure: the caller does the transaction.
 *
 * Both dependency kinds are reported because both are real, and they are reported SEPARATELY
 * because they are not interchangeable: an anchored row loses its position, a sourced row loses its
 * media, and an author who is told only the count cannot tell which of their clips is about to go
 * blank.
 */
export function planHostDeleteImpact(opts: {
  hostVideoFileId: string;
  rows: readonly LabelledSectionLike[];
  timeline: MainSegmentTimeline;
}): HostDeletePlan {
  const { hostVideoFileId, rows, timeline } = opts;
  const dependents: HostDependent[] = [];

  for (const row of rows) {
    const sectionId = row.id ?? null;
    const label = row.label ?? null;
    const absoluteSec = resolveSectionPlacement(row, timeline).absoluteSec;

    if (placementModeOf(row) === 'segment' && row.anchor_video_file_id === hostVideoFileId) {
      dependents.push({
        sectionId, kind: 'anchor', label, absoluteSec,
        anchorOffsetSec: finite(row.anchor_offset_sec),
      });
    }
    if (sourceWindowFor(row, hostVideoFileId) !== null) {
      dependents.push({ sectionId, kind: 'source', label, absoluteSec, anchorOffsetSec: null });
    }
  }

  return {
    hostVideoFileId,
    dependents,
    requiresChoice: dependents.length > 0,
    choices: HOST_DELETE_CHOICES,
  };
}

/**
 * The rows a `detach` must orphan — the anchored ones, and only those.
 *
 * A SOURCE dependent is not detachable: its media is the video being deleted, so there is nothing
 * to keep it pointing at. Separating the two here is what stops a caller from "detaching" a row
 * that would then reference a video_files id that no longer exists.
 */
export function anchoredSectionIdsFor(plan: HostDeletePlan): string[] {
  const out: string[] = [];
  for (const d of plan.dependents) {
    if (d.kind === 'anchor' && isSet(d.sectionId)) out.push(d.sectionId);
  }
  return [...new Set(out)];
}

/** Every section id the plan names, in either role — what a `delete` choice removes. */
export function dependentSectionIdsFor(plan: HostDeletePlan): string[] {
  const out: string[] = [];
  for (const d of plan.dependents) if (isSet(d.sectionId)) out.push(d.sectionId);
  return [...new Set(out)];
}
