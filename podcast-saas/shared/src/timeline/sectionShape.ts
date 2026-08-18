/**
 * WHAT A `timeline_sections` ROW IS — the single place that knowledge lives.
 *
 * There is no discriminator column and no CHECK constraint on the table: the three real shapes are
 * told apart only by a combination of `track`, `type` and the three `clip_source_*` pointers. That
 * knowledge used to be re-derived, slightly differently, at every read site — and the differences
 * were the bug:
 *
 *   • `buildPlayerConfig` filtered the b-roll lane on `track==='broll' && !clip_source_audio_id`
 *     and the clip lane on `type==='clip' && clip_source_video_id`. Those two predicates are NOT
 *     disjoint. A row that is `track='broll' AND type='clip' AND clip_source_video_id IS NOT NULL`
 *     satisfies both and was emitted TWICE, at two different offsets, into the one array the viewer
 *     `.find()`s over — so it played twice.
 *   • The export's if/`continue` chain tested the clip branch first, so the SAME row rendered once,
 *     as a clip.
 *   • The editor preview resolved b-roll first, so it previewed as b-roll.
 *
 * Three surfaces, three answers, one row. This module makes the answer a function.
 *
 * THE DECISION THIS MODULE MAKES EXPLICITLY: on a `track='broll'` row, **`track` wins over `type`**.
 *
 * That is not a coin flip. `type` is provably unreliable on the b-roll track — the section editor
 * forces its type state to `'video'` for any `track='broll'` row and posts that back on save, so
 * merely opening and saving a generated b-roll rewrites `type` from `'broll'` to `'video'`. Every
 * other consumer already keys the b-roll lane on `track` alone. Choosing `track` therefore (a)
 * preserves what the viewer shows today — the b-roll copy was first in the concatenation and won
 * the `.find()` — (b) matches what the editor previews today, and (c) makes a row's behaviour
 * independent of the one column a round-trip through the editor is known to rewrite. A hybrid stops
 * being a live/dormant time bomb that re-arms whenever something sets `type` back to `'clip'`.
 *
 * NOT DECIDED HERE, deliberately: how either lane COMPUTES its offset. The b-roll lane uses the
 * stored `global_offset_sec`; the clip lane derives one from a running sum of `video_files
 * .duration_sec`. Those disagree, and reconciling them is a blocked product decision (D-01). This
 * module only makes the lanes DISJOINT, so one row can no longer be answered two ways at once.
 */

/** The widest a single project's timeline is ever allowed to be, in seconds (24 h). */
export const MAX_TIMELINE_SEC = 86_400;

/**
 * The shape of one row — the census's three shapes, the adjacent shapes that must not be confused
 * with them, and an explicit `invalid`.
 *
 * `invalid` means "no reader can place this row", not "this row is illegal to store": a `type='clip'`
 * section with no `clip_source_*` at all is exactly what the editor's Add → "Existing clip" button
 * creates as a provisional row for the user to fill in. It matches no branch in the viewer and no
 * branch in the export, so it renders nowhere until a source is chosen — which is correct, and is
 * why the write schemas allow it while the lane router drops it.
 */
export type TimelineSectionShape =
  /** Shape 1 — a true b-roll overlay. Source is `video_file_id`; `global_offset_sec` is absolute. */
  | 'broll'
  /** Shape 3 — malformed: a b-roll row still carrying a clip source pointer. Plays as b-roll. */
  | 'broll_clip_hybrid'
  /** Shape 2 — a main-track "Existing Visual". Source is `clip_source_video_id`; host-local times. */
  | 'clip_video'
  /** The still-image sibling of Shape 2. */
  | 'clip_image'
  /** An audio-only cutaway, on either track. */
  | 'audio_cutaway'
  /** A main-track simulation section. */
  | 'simulation'
  /** A plain main-track segment section. */
  | 'main'
  /** Placeable by no reader — e.g. a clip section whose source was deleted (`ON DELETE SET NULL`). */
  | 'invalid';

/**
 * The output array a row belongs in. Exactly one per row, by construction — that is the whole point.
 * `none` is the explicit "renders nowhere" bucket, so a dropped row is countable instead of silent.
 */
export type TimelineLane = 'broll' | 'clip_video' | 'clip_image' | 'audio_cutaway' | 'main' | 'none';

/** The columns a classification depends on. Structural so both a Drizzle row and a request body fit. */
export interface TimelineSectionLike {
  id?: string | null;
  track?: string | null;
  type?: string | null;
  video_file_id?: string | null;
  clip_source_video_id?: string | null;
  clip_source_image_id?: string | null;
  clip_source_audio_id?: string | null;
  global_offset_sec?: number | null;
  start_sec?: number | null;
  end_sec?: number | null;
  clip_in_sec?: number | null;
  sort_order?: number | null;
}

const isSet = (v: string | null | undefined): v is string => typeof v === 'string' && v.length > 0;

/**
 * Which of the shapes this row is. TOTAL and DETERMINISTIC: every row returns exactly one answer,
 * and the checks below are ordered so no two can both apply.
 *
 * Precedence, and why each step comes where it does:
 *   1. `clip_source_audio_id` — an audio cutaway is audio, whatever else the row says. This is the
 *      one exclusion the old b-roll filter already made by hand, so it stays first.
 *   2. `track === 'broll'` — the lane discriminator every other consumer already uses. A clip
 *      pointer on such a row makes it the malformed hybrid, which still plays in the b-roll lane
 *      (see the header): the classification records the malformation without changing the picture.
 *   3. `type === 'clip'` — the main-track overlays, video before image (both set is a malformation
 *      reported by `timelineSectionViolations`; video wins so the answer is never order-dependent).
 *      This comes AFTER the b-roll arm, and that ordering is the fix: it is what makes the two
 *      lanes disjoint, and it is why `track` beats `type` on a b-roll row.
 *   4. `track === 'audio'` with nothing left to play — invalid, not a segment.
 *   5. simulation, then plain main.
 */
export function classifyTimelineSection(row: TimelineSectionLike): TimelineSectionShape {
  if (isSet(row.clip_source_audio_id)) return 'audio_cutaway';

  if (row.track === 'broll') {
    return isSet(row.clip_source_video_id) || isSet(row.clip_source_image_id)
      ? 'broll_clip_hybrid'
      : 'broll';
  }

  if (row.type === 'clip') {
    if (isSet(row.clip_source_video_id)) return 'clip_video';
    if (isSet(row.clip_source_image_id)) return 'clip_image';
    return 'invalid';                    // orphaned or provisional clip — placeable by no reader
  }

  // An audio-track row with no audio source and no clip source. It resolves to nothing in every
  // reader today and still does; calling it `invalid` rather than letting it fall through to `main`
  // keeps `main` meaning "a segment section", so the buckets stay honest.
  if (row.track === 'audio') return 'invalid';

  if (row.type === 'simulation') return 'simulation';
  return 'main';
}

/** Where a shape plays. The hybrid's routing is the explicit decision documented in the header. */
export function laneForShape(shape: TimelineSectionShape): TimelineLane {
  switch (shape) {
    case 'broll':
    case 'broll_clip_hybrid': return 'broll';
    case 'clip_video':        return 'clip_video';
    case 'clip_image':        return 'clip_image';
    case 'audio_cutaway':     return 'audio_cutaway';
    case 'simulation':
    case 'main':              return 'main';
    case 'invalid':           return 'none';
  }
}

export function laneForTimelineSection(row: TimelineSectionLike): TimelineLane {
  return laneForShape(classifyTimelineSection(row));
}

/**
 * Split rows into their lanes in ONE pass, preserving input order within each lane.
 *
 * A reader that consumes this cannot emit a row twice: membership is a partition, not a set of
 * independently-evaluated filters. That property is what the `:558`/`:591` overlap violated, and
 * restoring it structurally is worth more than any single-case fix.
 */
export function groupTimelineSectionsByLane<T extends TimelineSectionLike>(
  rows: readonly T[],
): Record<TimelineLane, T[]> {
  const lanes: Record<TimelineLane, T[]> = {
    broll: [], clip_video: [], clip_image: [], audio_cutaway: [], main: [], none: [],
  };
  for (const row of rows) lanes[laneForTimelineSection(row)].push(row);
  return lanes;
}

// ── Ordering ──────────────────────────────────────────────────────────────────

/**
 * The canonical order of a project's sections, shared by the editor read and the player build so
 * the two surfaces cannot disagree about the same project.
 *
 * The player used to order by `start_sec` ALONE. On the b-roll track `start_sec` is a source
 * in-point — almost always 0 — so every b-roll row of a project tied, and a tie in `ORDER BY` lets
 * Postgres return the rows in any order it likes, run to run. That is why "b-roll plays the wrong
 * clip" was intermittent: the viewer's `.find()` takes the FIRST match, so which of two overlapping
 * clips wins was decided by the query planner.
 *
 * The key is `(sort_order, start_sec, global_offset_sec, id)`, NULLS LAST, matching Postgres's
 * default for ASC so the in-memory sort and the `ORDER BY` agree exactly. It is a strict REFINEMENT
 * of the editor's existing `(sort_order, start_sec)` — the editor's visible order therefore does not
 * move at all, it only stops being ambiguous — and the player adopts the editor's key. `id` is a
 * primary key, so the order is total: no two rows can tie.
 */
export function compareTimelineSections(a: TimelineSectionLike, b: TimelineSectionLike): number {
  return (
    nullsLast(a.sort_order, b.sort_order) ||
    nullsLast(a.start_sec, b.start_sec) ||
    nullsLast(a.global_offset_sec, b.global_offset_sec) ||
    compareIds(a.id, b.id)
  );
}

/** ASC with NULLs (and NaNs, which no comparison orders) sorting last — Postgres's ASC default. */
function nullsLast(a: number | null | undefined, b: number | null | undefined): number {
  const av = typeof a === 'number' && Number.isFinite(a) ? a : null;
  const bv = typeof b === 'number' && Number.isFinite(b) ? b : null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function compareIds(a: string | null | undefined, b: string | null | undefined): number {
  const av = a ?? '';
  const bv = b ?? '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** `compareTimelineSections` applied to a copy — never mutates the caller's array. */
export function sortTimelineSections<T extends TimelineSectionLike>(rows: readonly T[]): T[] {
  return [...rows].sort(compareTimelineSections);
}

// ── Structural validation ─────────────────────────────────────────────────────

export type TimelineSectionViolationCode =
  /** A second-valued field is absent, non-finite, negative, or past `MAX_TIMELINE_SEC`. */
  | 'out_of_range'
  /** `end_sec` is not strictly after `start_sec`. */
  | 'empty_interval'
  /** A row POSITIONED by its own offset (b-roll / audio) has no offset — four readers play it at 0. */
  | 'missing_offset'
  /** A b-roll row carrying a clip source pointer: the double-emission shape (and its residue). */
  | 'broll_clip_hybrid'
  /** Two clip source pointers at once — the row would be two different overlays. */
  | 'multiple_clip_sources';

export interface TimelineSectionViolation {
  code: TimelineSectionViolationCode;
  field: string;
  message: string;
}

/**
 * A row that carries its own absolute position, and so must actually have one.
 *
 * Keyed on the TRACK rather than on the classified shape, because the track is what positions a
 * row: an overlay lane is placed by `global_offset_sec`, a main segment by `start_sec` inside its
 * host video. An audio cutaway is included wherever it sits, since it is placed by offset on any
 * track. This deliberately still holds for a malformed audio-track row that classifies `invalid` —
 * a row missing its position needs to be reported for THAT, not excused by a second defect.
 */
export function isOffsetPositioned(row: TimelineSectionLike): boolean {
  return row.track === 'broll' || row.track === 'audio' || isSet(row.clip_source_audio_id);
}

/**
 * Every structural rule the table has no constraint for, in one list.
 *
 * Returns ALL violations rather than the first, because the PATCH path diffs this against the same
 * function applied to the row as it stands: a partial update must be free to leave a pre-existing
 * malformation alone (or repair it) while still being refused permission to introduce a new one.
 *
 * DELIBERATELY NOT A RULE: a main-track row with a NULL `global_offset_sec`. Main rows are
 * positioned by `start_sec` within their host video and legitimately have no global offset;
 * requiring one there would manufacture a violation out of correct data.
 */
export function timelineSectionViolations(row: TimelineSectionLike): TimelineSectionViolation[] {
  const out: TimelineSectionViolation[] = [];

  const seconds = (field: string, v: number | null | undefined, required: boolean): number | null => {
    if (v === null || v === undefined) {
      if (required) out.push({ code: 'out_of_range', field, message: `${field} is required` });
      return null;
    }
    if (!Number.isFinite(v) || v < 0 || v > MAX_TIMELINE_SEC) {
      out.push({
        code: 'out_of_range', field,
        message: `${field} must be a finite number between 0 and ${MAX_TIMELINE_SEC}`,
      });
      return null;
    }
    return v;
  };

  const start = seconds('start_sec', row.start_sec, true);
  const end = seconds('end_sec', row.end_sec, true);
  seconds('clip_in_sec', row.clip_in_sec, false);
  seconds('global_offset_sec', row.global_offset_sec, false);   // range only; presence is its own rule

  if (start !== null && end !== null && end <= start) {
    out.push({ code: 'empty_interval', field: 'end_sec', message: 'end_sec must be greater than start_sec' });
  }

  // ABSENT, specifically — a present-but-out-of-range offset is already reported above, and saying
  // "it is missing" about a value the caller can plainly see would send them looking for the wrong bug.
  if (isOffsetPositioned(row) && row.global_offset_sec == null) {
    out.push({
      code: 'missing_offset', field: 'global_offset_sec',
      message: 'global_offset_sec is required on a broll or audio section — it is the only thing that positions it',
    });
  }

  // The shape-specific rules, discriminated by the classifier itself so that "which rules apply"
  // and "which lane this plays in" can never be two different answers.
  switch (classifyTimelineSection(row)) {
    case 'broll_clip_hybrid':
      out.push({
        code: 'broll_clip_hybrid', field: 'clip_source_video_id',
        message: 'a broll section must not carry a clip source — set track to "main" for a clip section',
      });
      break;
    // Everything else is either well-formed or `invalid`, and `invalid` is NOT an error here: it is
    // what the editor's Add → "Existing clip" button legitimately creates, a provisional row waiting
    // for the user to pick a source. It renders nowhere until they do, which is correct.
    default:
      break;
  }

  const sources = [row.clip_source_video_id, row.clip_source_image_id, row.clip_source_audio_id]
    .filter(isSet).length;
  if (sources > 1) {
    out.push({
      code: 'multiple_clip_sources', field: 'clip_source_video_id',
      message: 'a section may reference at most one clip source (video, image, or audio)',
    });
  }

  return out;
}

/** Stable identity of a violation, for the "did this write INTRODUCE one?" diff on PATCH. */
export function violationKey(v: TimelineSectionViolation): string {
  return `${v.code}:${v.field}`;
}

/**
 * The violations `next` has that `previous` did not — the rule a partial update is held to.
 *
 * A PATCH may repair a malformed row, or leave it exactly as malformed as it found it, but it may
 * not make it worse. Holding PATCH to the stricter "the result must be perfect" would brick the
 * editor on every row the missing constraints already let through: the undo/redo restore path posts
 * a section's WHOLE stored body back, so one legacy b-roll row with a NULL offset would make every
 * undo in that project fail.
 */
export function newTimelineSectionViolations(
  previous: TimelineSectionLike,
  next: TimelineSectionLike,
): TimelineSectionViolation[] {
  const had = new Set(timelineSectionViolations(previous).map(violationKey));
  return timelineSectionViolations(next).filter((v) => !had.has(violationKey(v)));
}
