/**
 * WHERE A SECTION SITS ON THE GLOBAL TIMELINE — the single place that answer is computed (D-01).
 *
 * THE BUG THIS EXISTS TO END
 * -------------------------
 * A b-roll's position is an ABSOLUTE SECOND stored on the row. Re-transcode a main video to a
 * slightly different length and the clip still fires at second 47 — but second 47 is now a
 * different moment. The number was never wrong; it stopped meaning what the author intended.
 *
 * There are TWO drift mechanisms, not one, and they pull in opposite directions:
 *
 *   • A TRUE B-ROLL (or audio cutaway) uses its STORED `global_offset_sec` unchanged. It is pinned
 *     to a wall-clock second and does NOT follow the content. Shorten video #1 by two seconds and
 *     every frame after it slides two seconds earlier while the b-roll stays put — it now fires two
 *     seconds late, over different words.
 *   • A CLIP OVERLAY has no stored absolute at all. Its position is DERIVED, every read, as
 *     `(cumulative sum of the durations of the preceding main videos) + start_sec`. It therefore
 *     tracks its own host perfectly — and moves under any change to a video BEFORE it, including a
 *     `duration_sec` that is merely stale, NULL, or being backfilled by the transcode worker.
 *
 * So the same authored moment is expressed two incompatible ways, and a re-transcode separates
 * them. Worse, the derivation was written out by hand at each read site, so "what second is this
 * section at?" had one implementation in the player build, one in the export planner, and one in
 * the editor's timeline component. THE BUG CLASS IS THAT EACH SURFACE ANSWERS DIFFERENTLY. A second
 * resolver recreates it, which is why everything below is exported from one module and every reader
 * is expected to call it rather than re-derive.
 *
 * THE MODEL
 * ---------
 * A project's main timeline is a CONCATENATION of its main (non-b-roll) videos in `created_at ASC`
 * order. Segment `i` owns the HALF-OPEN interval `[start_i, start_i + duration_i)`. Half-open is
 * load-bearing: the instant `start_i + duration_i` is the FIRST instant of segment `i+1`, never the
 * last of `i`, so a placement exactly on a seam has one answer instead of two.
 *
 * A section is anchored to `(anchor_video_file_id, anchor_offset_sec)` — a SEGMENT plus a time
 * INSIDE that segment — and its absolute second is recomputed from the live timeline on every read.
 * Re-transcoding the host now moves the clip WITH its content, which is what the author meant.
 *
 * WHY A SEGMENT AND NOT A `timeline_sections.section_id`
 * -----------------------------------------------------
 * Sections are sparse annotations: a project can have long stretches with no section row at all, so
 * a section-relative anchor cannot express every point on the timeline. Video segments tile it
 * completely and without gaps (see `MAIN_TIMELINE_HAS_NO_GAPS` below). The anchor also gets its OWN
 * column pair rather than overloading `video_file_id`, because on a b-roll row `video_file_id`
 * already means something else entirely — the b-roll SOURCE asset, which is not a main segment and
 * has no position on the main timeline at all.
 *
 * ROLLOUT — EXPAND/CONTRACT, AND THE DUAL READ
 * --------------------------------------------
 * `placement_mode` is `'legacy_absolute'` for every row that exists today and `'segment'` for a row
 * that has been anchored. `resolveSectionPlacement` reads THE ANCHOR FIRST and falls back to the
 * stored absolute, so one deploy serves both populations and a rollback of the application code
 * needs no schema change. Nothing is silently converted: see `planAnchorBackfill`.
 */

import {
  MAX_TIMELINE_SEC,
  laneForTimelineSection,
  type TimelineSectionLike,
} from './sectionShape.js';

// ── The main segment timeline ─────────────────────────────────────────────────

/**
 * THE MAIN TIMELINE HAS NO GAPS, AND THAT IS A PROPERTY OF THE MODEL, NOT AN ASSUMPTION.
 *
 * Every layout of the main track — the player build, the export planner and the editor's
 * `buildClips` — is the same three lines: sort by `created_at`, `offset = running total`,
 * `running total += duration`. There is no per-video start column anywhere in the schema and no UI
 * that could set one, so an INTERIOR GAP between two main videos is not merely absent from the
 * data, it is unrepresentable. A video with an unknown duration contributes zero width and the next
 * one begins exactly where it did; that is a zero-width segment, not a hole.
 *
 * A placement PAST THE END of the last video is a different matter and is entirely producible — see
 * `POST_ROLL_TAIL_SEC`.
 */
export const MAIN_TIMELINE_HAS_NO_GAPS = true;

/**
 * HOW FAR PAST THE LAST FRAME A PLACEMENT MAY LEGALLY SIT — the "post-roll tail" the half-open rule
 * needs in order to be total.
 *
 * The tail is not a nicety. The editor's timeline width is
 * `max(content end, longest overlay end, 50)`, so on a project whose main videos total 30 s the
 * ruler still runs to 50 s and a b-roll can be dragged — and saved — to second 45. There is no host
 * video there. The editor already resolves that case: `findClipAtGlobalSec` scans for the segment
 * whose `[offset, offset+dur)` contains the point and, finding none, RETURNS THE LAST CLIP. This
 * module adopts exactly that rule rather than inventing a second one, so "which segment is second
 * 45 in?" has the same answer in the editor and on the server.
 *
 * The MAGNITUDE, 60 s, covers the editor's 50 s display floor with a margin. It bounds only what is
 * accepted as a NEW anchored write and what the backfill report will nominate — resolution itself
 * never refuses, because refusing to place a row that already exists would blank it out of the
 * viewer. See the report to the owner: the number is a product decision, this is a defensible
 * default and not a ruling.
 */
export const POST_ROLL_TAIL_SEC = 60;

/** The columns a segment layout depends on. Structural, so a Drizzle `video_files` row fits. */
export interface MainSegmentLike {
  id: string;
  duration_sec?: number | null;
  is_broll?: boolean | null;
}

/** One main video's window on the global timeline. `[startSec, endSec)` — half-open. */
export interface MainSegment {
  id: string;
  /** Position in the concatenation, 0-based. */
  index: number;
  /** Absolute second this segment begins at. Inclusive. */
  startSec: number;
  /** Absolute second the NEXT segment begins at. EXCLUSIVE — this instant is not in this segment. */
  endSec: number;
  durationSec: number;
  /**
   * False when `duration_sec` was NULL, non-finite or ≤ 0 — the transcode worker has not written it
   * yet, or never will. Such a segment is zero-width: it hosts nothing, and every segment after it
   * is at an offset that will MOVE once the real duration lands. That is why the backfill report
   * refuses to nominate anything at or after one.
   */
  durationKnown: boolean;
  isLast: boolean;
}

export interface MainSegmentTimeline {
  /** In `created_at ASC` order, which is the order the concatenation is defined by. */
  segments: readonly MainSegment[];
  byId: ReadonlyMap<string, MainSegment>;
  /** Sum of the known durations — the end of the last segment. */
  totalSec: number;
  /** True when any segment's duration is unknown: every offset after it is provisional. */
  hasUnknownDuration: boolean;
}

const EMPTY_TIMELINE: MainSegmentTimeline = {
  segments: [], byId: new Map(), totalSec: 0, hasUnknownDuration: false,
};

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Lay the main videos out end to end.
 *
 * The b-roll FILTER lives here rather than at each call site on purpose. "Which videos make up the
 * main timeline?" is part of the same question this module answers, and a caller that filtered
 * differently would compute different offsets for every section in the project — which is the exact
 * shape of the bug being fixed.
 *
 * ORDER IS THE CALLER'S: pass the project's videos in `created_at ASC`. Both server readers already
 * query them that way, and re-sorting here would need a `created_at` this interface does not carry.
 */
export function buildMainSegmentTimeline(
  videos: readonly MainSegmentLike[],
): MainSegmentTimeline {
  const mains = videos.filter((v) => !v.is_broll);
  if (mains.length === 0) return EMPTY_TIMELINE;

  const segments: MainSegment[] = [];
  const byId = new Map<string, MainSegment>();
  let cursor = 0;
  let hasUnknownDuration = false;

  mains.forEach((v, index) => {
    const raw = finite(v.duration_sec);
    const durationKnown = raw !== null && raw > 0;
    const durationSec = durationKnown ? raw! : 0;
    if (!durationKnown) hasUnknownDuration = true;
    const seg: MainSegment = {
      id: v.id,
      index,
      startSec: cursor,
      endSec: cursor + durationSec,
      durationSec,
      durationKnown,
      isLast: index === mains.length - 1,
    };
    cursor += durationSec;
    segments.push(seg);
    // FIRST WINS on a duplicate id. The layout is what it is; a duplicate id would be a corrupt
    // read, and silently letting the later row shadow the earlier one would move every offset.
    if (!byId.has(seg.id)) byId.set(seg.id, seg);
  });

  return { segments, byId, totalSec: cursor, hasUnknownDuration };
}

/**
 * The segment an ABSOLUTE second falls in, by the half-open rule — and by the editor's rule for
 * everything past the end.
 *
 *   • `[start_i, end_i)` contains the point → segment `i`. A point exactly on a seam belongs to the
 *     LATER segment, never the earlier one.
 *   • past the end of the last segment → THE LAST SEGMENT (the post-roll tail). This mirrors
 *     `findClipAtGlobalSec` in the editor, which is what makes second 45 of a 30 s project mean the
 *     same thing on both sides of the wire.
 *   • negative, non-finite, or a project with no main video → null.
 *
 * ZERO-WIDTH SEGMENTS ARE NEVER RETURNED for an interior point, because `[x, x)` contains nothing.
 * That is correct: a segment with no known duration cannot host a placement.
 */
export function segmentAtAbsoluteSec(
  timeline: MainSegmentTimeline,
  absoluteSec: number,
): MainSegment | null {
  const t = finite(absoluteSec);
  if (t === null || t < 0 || timeline.segments.length === 0) return null;
  for (const seg of timeline.segments) {
    if (t >= seg.startSec && t < seg.endSec) return seg;
  }
  // Past the last frame — the post-roll tail. Unbounded here BY DESIGN: this function answers
  // "where is this row?", and a row that already exists must resolve somewhere. Legality is a
  // separate question, asked by `anchorPlacementViolations` and by the backfill report.
  return timeline.segments[timeline.segments.length - 1] ?? null;
}

// ── Resolution ────────────────────────────────────────────────────────────────

export type PlacementMode = 'segment' | 'legacy_absolute';

/** Which rule produced the absolute second. */
export type PlacementSource =
  /** From the row's own `(anchor_video_file_id, anchor_offset_sec)` pair. The intended path. */
  | 'anchor'
  /** From the stored `global_offset_sec`. Every row that predates the anchor columns. */
  | 'absolute'
  /**
   * From the row's HOST: `segmentStart(video_file_id) + start_sec`. Main-track rows — clip and
   * image overlays, plain segments, simulations — have always been placed this way and are already
   * segment-relative by construction. They do NOT get an anchor pair; `video_file_id` IS the anchor
   * for them, and giving them a second one would create two answers again.
   */
  | 'native_host';

/** Why a resolution had to fall back. Null on the happy path. */
export type PlacementDegradation =
  /**
   * `placement_mode='segment'` but there is no anchor id. The FK is `ON DELETE SET NULL`, so this
   * is what a deleted host video leaves behind: a row that KNOWS it was anchored and no longer
   * knows to what. Distinguishable from a never-anchored row only because the mode survives, which
   * is the whole reason the mode is a column rather than a computed `anchor_video_file_id != null`.
   */
  | 'anchor_missing'
  /** The anchor points at a video that is not a main segment of this project (b-roll, or foreign). */
  | 'anchor_not_a_segment'
  /** The anchor id is set but the offset is absent or non-finite — half a pair places nothing. */
  | 'anchor_offset_missing'
  /** A main-track row whose host video is not in the main timeline. Was silently second 0 before. */
  | 'host_not_a_segment'
  /**
   * The fallback itself is absent. FOUR separate read sites used to coerce this NULL to zero, so a
   * positionless b-roll played silently over the opening frames instead of failing. Still resolves
   * to 0 — changing where those rows play is not this module's call — but it is now NAMED.
   */
  | 'absolute_missing';

export interface PlacementResolution {
  /** The absolute second on the global main timeline. Always finite and ≥ 0. */
  absoluteSec: number;
  source: PlacementSource;
  /** The segment `absoluteSec` falls in, by `segmentAtAbsoluteSec`. Null when there is no timeline. */
  containingSegmentId: string | null;
  /** Seconds past the end of the whole main timeline. 0 when the placement is inside it. */
  postRollSec: number;
  degradation: PlacementDegradation | null;
}

/** The columns placement depends on, on top of the shape columns. */
export interface PlacementSectionLike extends TimelineSectionLike {
  placement_mode?: string | null;
  anchor_video_file_id?: string | null;
  anchor_offset_sec?: number | null;
}

const isSet = (v: string | null | undefined): v is string => typeof v === 'string' && v.length > 0;

/**
 * Is this row POSITIONED BY ITS OWN OFFSET — and therefore the kind of row an anchor applies to?
 *
 * Keyed on the LANE rather than the track, so it agrees with `groupTimelineSectionsByLane` by
 * construction: the b-roll and audio-cutaway lanes are the two that carry `global_offset_sec`, and
 * they are exactly the two the D-01 drift affects through the "stored absolute" mechanism.
 */
export function isAnchorable(row: TimelineSectionLike): boolean {
  const lane = laneForTimelineSection(row);
  return lane === 'broll' || lane === 'audio_cutaway';
}

/** `'segment'` only when the column says so; anything else — including NULL — is legacy. */
export function placementModeOf(row: PlacementSectionLike): PlacementMode {
  return row.placement_mode === 'segment' ? 'segment' : 'legacy_absolute';
}

const clampToTimeline = (v: number): number =>
  !Number.isFinite(v) || v < 0 ? 0 : v > MAX_TIMELINE_SEC ? MAX_TIMELINE_SEC : v;

function finish(
  timeline: MainSegmentTimeline,
  absoluteSec: number,
  source: PlacementSource,
  degradation: PlacementDegradation | null,
): PlacementResolution {
  const at = clampToTimeline(absoluteSec);
  return {
    absoluteSec: at,
    source,
    containingSegmentId: segmentAtAbsoluteSec(timeline, at)?.id ?? null,
    postRollSec: at > timeline.totalSec ? at - timeline.totalSec : 0,
    degradation,
  };
}

/**
 * THE RESOLVER. One function, every surface: the editor read, the player build, the export planner
 * and the prewarm/marker maths all place a row by calling this and nothing else.
 *
 * TOTAL — it always returns a finite second. A row that cannot be placed correctly is placed where
 * it is placed TODAY and the reason is reported in `degradation`; it is never dropped and never
 * throws. That is deliberate: this change is a rollout, and a resolver that could refuse would turn
 * every malformed legacy row into a section that vanishes from the viewer the day it ships.
 *
 * DUAL READ, anchor first:
 *   1. A main-track row is `native_host` — it has always been host-relative and needs no migration.
 *   2. An anchorable row in `'segment'` mode resolves through its anchor pair.
 *   3. Anything else — and any anchored row whose anchor no longer resolves — falls back to the
 *      stored `global_offset_sec`, which is exactly today's behaviour.
 */
export function resolveSectionPlacement(
  row: PlacementSectionLike,
  timeline: MainSegmentTimeline,
): PlacementResolution {
  if (!isAnchorable(row)) {
    // Main-track rows: `segmentStart(host) + start_sec`. This is the cumulative-sum derivation the
    // player build and the export planner each wrote out by hand, moved here unchanged, with the
    // one difference that a host outside the main timeline is now NAMED instead of silently 0.
    const host = isSet(row.video_file_id) ? timeline.byId.get(row.video_file_id) : undefined;
    const local = finite(row.start_sec) ?? 0;
    if (!host) return finish(timeline, local, 'native_host', 'host_not_a_segment');
    return finish(timeline, host.startSec + local, 'native_host', null);
  }

  const absolute = finite(row.global_offset_sec);

  if (placementModeOf(row) !== 'segment') {
    return absolute === null
      ? finish(timeline, 0, 'absolute', 'absolute_missing')
      : finish(timeline, absolute, 'absolute', null);
  }

  // The anchor failed on a row that says it is anchored. Fall back to the stored absolute — today's
  // behaviour, and the only value that keeps the row visible — and report THE ANCHOR's fault rather
  // than the fallback's: "the offset is also missing" is a second-order fact about a row whose real
  // problem is that its host is gone, and reporting the lesser one would send the reader elsewhere.
  const fallback = (degradation: PlacementDegradation): PlacementResolution =>
    finish(timeline, absolute ?? 0, 'absolute', degradation);

  if (!isSet(row.anchor_video_file_id)) return fallback('anchor_missing');
  const seg = timeline.byId.get(row.anchor_video_file_id);
  if (!seg) return fallback('anchor_not_a_segment');
  const offset = finite(row.anchor_offset_sec);
  if (offset === null || offset < 0) return fallback('anchor_offset_missing');

  return finish(timeline, seg.startSec + offset, 'anchor', null);
}

/** The absolute second alone, for the many call sites that want only the number. */
export function resolveSectionStartSec(
  row: PlacementSectionLike,
  timeline: MainSegmentTimeline,
): number {
  return resolveSectionPlacement(row, timeline).absoluteSec;
}

// ── Deriving an anchor from an absolute second ────────────────────────────────

export interface DerivedAnchor {
  anchor_video_file_id: string;
  anchor_offset_sec: number;
  /** Seconds past the end of the whole main timeline — non-zero only in the post-roll tail. */
  postRollSec: number;
}

/**
 * Express an absolute second as `(segment, offset within that segment)`.
 *
 * This is the ONLY direction that can lose information, and it is why the ruling forbids a silent
 * backfill: the mapping is computed from the timeline AS IT IS RIGHT NOW, so applying it to a row
 * whose absolute second has ALREADY drifted canonises the drift — it makes today's wrong moment the
 * row's permanent intent, and the mistake stops being recoverable. Legitimate callers are the two
 * where the author is asserting the position at this instant: a NEW write, and an author drag
 * ("keep it where I can see it").
 *
 * Returns null when there is no segment to anchor to at all — an empty project.
 */
export function deriveAnchorForAbsoluteSec(
  timeline: MainSegmentTimeline,
  absoluteSec: number,
): DerivedAnchor | null {
  const at = finite(absoluteSec);
  if (at === null || at < 0) return null;
  const seg = segmentAtAbsoluteSec(timeline, at);
  if (!seg) return null;
  return {
    anchor_video_file_id: seg.id,
    // Round-trips exactly: `seg.startSec + (at - seg.startSec) === at`.
    anchor_offset_sec: at - seg.startSec,
    postRollSec: at > timeline.totalSec ? at - timeline.totalSec : 0,
  };
}

// ── Legality of an anchor ─────────────────────────────────────────────────────

export type AnchorViolationCode =
  /** Only half the pair is present. Half a pair places nothing, so it is never a legal write. */
  | 'anchor_incomplete'
  /** The offset is absent, non-finite, negative, or past the 24 h ceiling. */
  | 'anchor_offset_out_of_range'
  /**
   * The offset reaches at or past the end of a NON-LAST segment — which, under the half-open rule,
   * is a point that belongs to the NEXT segment. The row would claim a host it does not sit in, and
   * the next re-transcode of either video would move it somewhere neither the author nor the anchor
   * intended. Only the LAST segment has a legal tail past its end.
   */
  | 'anchor_offset_past_segment'
  /** The post-roll tail is bounded; this write is past the end of it. */
  | 'anchor_offset_past_tail'
  /**
   * An anchor pair on a MAIN-TRACK row. Those are placed by `video_file_id + start_sec` and always
   * have been; a second anchor on the same row is two answers to one question, which is the defect
   * this whole module exists to remove.
   */
  | 'anchor_on_unanchorable_row';

export interface AnchorViolation {
  code: AnchorViolationCode;
  field: string;
  message: string;
}

/**
 * Every rule an anchor pair has, checked against the live timeline.
 *
 * SEPARATE from `timelineSectionViolations` and deliberately so: those rules are pure row shape and
 * hold with no other data loaded, whereas these need the project's video durations. Keeping the
 * pure set pure is what lets the write endpoints validate a body before they touch the database.
 *
 * A row whose anchor names a segment this timeline does not contain is NOT a violation here. The
 * write path checks tenancy itself, and the read path degrades loudly; failing the write as well
 * would refuse an author's drag because some unrelated video is mid-transcode.
 */
export function anchorPlacementViolations(
  row: PlacementSectionLike,
  timeline: MainSegmentTimeline,
): AnchorViolation[] {
  const out: AnchorViolation[] = [];
  const hasId = isSet(row.anchor_video_file_id);
  const rawOffset = row.anchor_offset_sec;
  const hasOffset = rawOffset !== null && rawOffset !== undefined;

  if (!hasId && !hasOffset) return out;

  if (!isAnchorable(row)) {
    out.push({
      code: 'anchor_on_unanchorable_row', field: 'anchor_video_file_id',
      message: 'only a broll or audio section carries an anchor — a main-track section is positioned by its host video and start_sec',
    });
    return out;
  }

  if (!hasId || !hasOffset) {
    out.push({
      code: 'anchor_incomplete', field: hasId ? 'anchor_offset_sec' : 'anchor_video_file_id',
      message: 'anchor_video_file_id and anchor_offset_sec must be set together — half an anchor positions nothing',
    });
    return out;
  }

  const offset = finite(rawOffset);
  if (offset === null || offset < 0 || offset > MAX_TIMELINE_SEC) {
    out.push({
      code: 'anchor_offset_out_of_range', field: 'anchor_offset_sec',
      message: `anchor_offset_sec must be a finite number between 0 and ${MAX_TIMELINE_SEC}`,
    });
    return out;
  }

  const seg = timeline.byId.get(row.anchor_video_file_id!);
  // Unknown segment, or one whose duration has not landed yet: nothing to measure the offset
  // against. Not an error — see the header note.
  if (!seg || !seg.durationKnown) return out;

  // The offset is bounded and the segment's start is bounded, but their SUM is not — and it is the
  // sum that gets written back to `global_offset_sec` as the dual read's fallback. Checking it here
  // is what stops a legal-looking pair from producing an out-of-range absolute the row rules would
  // have refused had it been sent directly.
  if (seg.startSec + offset > MAX_TIMELINE_SEC) {
    out.push({
      code: 'anchor_offset_out_of_range', field: 'anchor_offset_sec',
      message: `this anchor resolves to ${seg.startSec + offset}s, past the ${MAX_TIMELINE_SEC}s ceiling`,
    });
    return out;
  }

  if (!seg.isLast) {
    if (offset >= seg.durationSec) {
      out.push({
        code: 'anchor_offset_past_segment', field: 'anchor_offset_sec',
        message: `anchor_offset_sec (${offset}) is at or past the end of its segment (${seg.durationSec}) — that instant belongs to the next segment, so anchor it there instead`,
      });
    }
    return out;
  }

  if (offset >= seg.durationSec + POST_ROLL_TAIL_SEC) {
    out.push({
      code: 'anchor_offset_past_tail', field: 'anchor_offset_sec',
      message: `anchor_offset_sec (${offset}) is more than ${POST_ROLL_TAIL_SEC}s past the end of the last segment (${seg.durationSec})`,
    });
  }
  return out;
}

// ── The backfill DRY RUN ──────────────────────────────────────────────────────

/**
 * NO SILENT BACKFILL — the ruling, and the reason for it.
 *
 * Converting a row means reading its absolute second, asking today's timeline which segment that
 * lands in, and writing that down as the author's intent. If the row has already drifted — which is
 * the entire premise of D-01 — then what gets written down is the drifted position, permanently, and
 * the original intent becomes unrecoverable. A migration that "fixed" every row would in fact
 * FREEZE every row's current mistake.
 *
 * So this produces a REPORT and converts nothing. Three populations are excluded from the candidate
 * list outright, per the ruling, because for them the mapping is not merely risky but meaningless:
 *
 *   • UNKNOWN DURATION — the row sits at or after a segment whose `duration_sec` has not landed.
 *     Every offset from there on is provisional and will move when it does.
 *   • OUT OF RANGE — the absolute second is absent, negative, or past the end of the main timeline
 *     plus its legal tail. There is no honest host for it.
 *   • BRANCHED — the project has branch sequences, so its playback order is a graph, not one
 *     concatenation, and "the cumulative sum of durations" is not its timeline at all.
 */
export type BackfillExclusionReason =
  | 'already_anchored'
  | 'not_anchorable'
  | 'unknown_duration'
  | 'out_of_range'
  | 'branched';

export interface AnchorBackfillCandidate {
  sectionId: string | null;
  absoluteSec: number;
  anchor_video_file_id: string;
  anchor_offset_sec: number;
  /** Non-zero when the candidate sits in the last segment's post-roll tail. Review these first. */
  postRollSec: number;
}

export interface AnchorBackfillExclusion {
  sectionId: string | null;
  reason: BackfillExclusionReason;
  absoluteSec: number;
}

export interface AnchorBackfillReport {
  /** Rows in the two anchorable lanes — the denominator for everything below. */
  anchorableRows: number;
  /** Already `placement_mode='segment'`. Nothing to do. */
  alreadyAnchored: number;
  /** Safe to convert ON REVIEW. Never applied by this function, which writes nothing. */
  candidates: AnchorBackfillCandidate[];
  excluded: AnchorBackfillExclusion[];
  /** Counts by reason, so a report over a large project is readable without reading every row. */
  excludedByReason: Record<BackfillExclusionReason, number>;
  /** True when the whole project was excluded because it branches. */
  branched: boolean;
}

const ZERO_REASONS = (): Record<BackfillExclusionReason, number> => ({
  already_anchored: 0, not_anchorable: 0, unknown_duration: 0, out_of_range: 0, branched: 0,
});

/**
 * The dry run. Reads rows, writes nothing, and is the ONLY thing that decides what is convertible.
 *
 * `branched` is the caller's to supply — it is a property of the project (does it have branch
 * sequences?), not of any row — and when true EVERY anchorable row is excluded, because a branching
 * project's playback order is not the linear concatenation this module models.
 */
export function planAnchorBackfill(
  rows: readonly PlacementSectionLike[],
  timeline: MainSegmentTimeline,
  opts: { branched?: boolean } = {},
): AnchorBackfillReport {
  const branched = opts.branched === true;
  const candidates: AnchorBackfillCandidate[] = [];
  const excluded: AnchorBackfillExclusion[] = [];
  const excludedByReason = ZERO_REASONS();
  let anchorableRows = 0;
  let alreadyAnchored = 0;

  // The first segment whose duration is unknown. Everything from its START onward sits at an offset
  // that is going to move, so nothing there can be mapped honestly — including rows inside the
  // zero-width segment itself, which is why this is `startSec` and not `endSec`.
  const firstUnknown = timeline.segments.find((s) => !s.durationKnown);
  const provisionalFromSec = firstUnknown ? firstUnknown.startSec : Infinity;

  const exclude = (sectionId: string | null, reason: BackfillExclusionReason, absoluteSec: number) => {
    excluded.push({ sectionId, reason, absoluteSec });
    excludedByReason[reason] += 1;
  };

  for (const row of rows) {
    const id = row.id ?? null;
    if (!isAnchorable(row)) continue;      // not counted: a main-track row is not in this population
    anchorableRows += 1;

    if (placementModeOf(row) === 'segment') {
      alreadyAnchored += 1;
      exclude(id, 'already_anchored', resolveSectionPlacement(row, timeline).absoluteSec);
      continue;
    }

    const absolute = finite(row.global_offset_sec);

    if (branched) { exclude(id, 'branched', absolute ?? 0); continue; }

    if (absolute === null || absolute < 0 || absolute > timeline.totalSec + POST_ROLL_TAIL_SEC) {
      exclude(id, 'out_of_range', absolute ?? 0);
      continue;
    }
    if (absolute >= provisionalFromSec) { exclude(id, 'unknown_duration', absolute); continue; }

    const derived = deriveAnchorForAbsoluteSec(timeline, absolute);
    // No segment at all — an anchorable row in a project with no main video. Nothing to anchor to.
    if (!derived) { exclude(id, 'out_of_range', absolute); continue; }

    candidates.push({
      sectionId: id,
      absoluteSec: absolute,
      anchor_video_file_id: derived.anchor_video_file_id,
      anchor_offset_sec: derived.anchor_offset_sec,
      postRollSec: derived.postRollSec,
    });
  }

  return { anchorableRows, alreadyAnchored, candidates, excluded, excludedByReason, branched };
}
