/**
 * D-01b — THE THREE THINGS THAT CAN HAPPEN TO A HOST, held apart.
 *
 * THE ASSERTION DISCIPLINE OF THIS FILE, inherited from placement.test.ts: every test asks "would
 * the BROKEN implementation also pass this?". The broken implementation here is not a stub — it
 * shipped, and it was a single `UPDATE timeline_sections SET end_sec = LEAST(end_sec, $new)` fired
 * from the transcode job on every duration change. It would pass "the row still exists" and "the
 * export does not overrun". What it cannot pass is any assertion that the AUTHORED value survived,
 * which is why nearly every expectation below reads the input row back unchanged and asserts the
 * finding was REPORTED rather than applied.
 *
 * The three cases, and the property each one pins:
 *   • a duration correction reports nothing and rewrites nothing;
 *   • a replace that shortens the media puts the row on the review list — at the boundary, in the
 *     post-roll tail, and for a window that no longer fits — and clamps nothing;
 *   • a delete lists what depends on the host and cannot express "re-anchor it to the next video".
 */
import { describe, it, expect } from 'vitest';
import { POST_ROLL_TAIL_SEC, buildMainSegmentTimeline, type PlacementSectionLike } from '../placement.js';
import {
  HOST_DELETE_CHOICES,
  anchoredSectionIdsFor,
  dependentSectionIdsFor,
  isHostDeleteChoice,
  planHostDeleteImpact,
  planHostMediaImpact,
  sourceWindowFor,
  type LabelledSectionLike,
} from '../hostChange.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const vid = (id: string, duration_sec: number | null, is_broll = false) =>
  ({ id, duration_sec, is_broll });

/** A = [0,30), B = [30,70). `SRC` is a b-roll source: no position on the main timeline at all. */
const BEFORE = [vid('A', 30), vid('B', 40), vid('SRC', 20, true)];

/** The same project after A's media is REPLACED with a twelve-second file. B now runs [12,52). */
const AFTER_REPLACE = [vid('A', 12), vid('B', 40), vid('SRC', 20, true)];

const anchoredBroll = (over: Partial<LabelledSectionLike> = {}): LabelledSectionLike => ({
  id: 'sec-broll', track: 'broll', type: 'broll', video_file_id: 'SRC',
  start_sec: 0, end_sec: 6, global_offset_sec: 20,
  placement_mode: 'segment', anchor_video_file_id: 'A', anchor_offset_sec: 20, ...over,
});

const replaceOf = (
  rows: readonly PlacementSectionLike[],
  opts: { host?: string; after?: number; before?: number | null } = {},
) => planHostMediaImpact({
  hostVideoFileId: opts.host ?? 'A',
  afterDurationSec: opts.after ?? 12,
  beforeDurationSec: opts.before ?? 30,
  kind: 'media_replace',
  rows,
  timelineAfter: buildMainSegmentTimeline(AFTER_REPLACE),
});

// ── Case 1: a duration correction ─────────────────────────────────────────────

describe('a duration correction rewrites nothing and reports nothing', () => {
  /**
   * The probe lands 30.04 over the client's guess of 30. This is the case the anchor exists for:
   * every anchored row's absolute second changes by itself, out of the new layout, and there is
   * nothing for a person to decide.
   */
  const corrected = [vid('A', 30.04), vid('B', 40), vid('SRC', 20, true)];

  it('finds nothing to review when every row still fits', () => {
    const row = anchoredBroll();
    const impacts = planHostMediaImpact({
      hostVideoFileId: 'A', afterDurationSec: 30.04, beforeDurationSec: 30,
      kind: 'duration_correction', rows: [row],
      timelineAfter: buildMainSegmentTimeline(corrected),
    });
    expect(impacts).toEqual([]);
  });

  it('does not mutate the row it was handed — the property the shipped clamp violated', () => {
    // The clamp this replaces rewrote `end_sec`/`start_sec` IN THE DATABASE on exactly this event.
    // A planner that returns findings cannot do that, and this asserts it structurally rather than
    // by reading the source of the caller.
    const row = anchoredBroll({ end_sec: 60 });
    const snapshot = JSON.stringify(row);
    planHostMediaImpact({
      hostVideoFileId: 'A', afterDurationSec: 12, beforeDurationSec: 30,
      kind: 'duration_correction', rows: [row],
      timelineAfter: buildMainSegmentTimeline(AFTER_REPLACE),
    });
    expect(JSON.stringify(row)).toBe(snapshot);
  });

  it('records WHICH change produced a finding, so the two cases stay distinguishable', () => {
    const [impact] = planHostMediaImpact({
      hostVideoFileId: 'A', afterDurationSec: 12, beforeDurationSec: 30,
      kind: 'duration_correction', rows: [anchoredBroll()],
      timelineAfter: buildMainSegmentTimeline(AFTER_REPLACE),
    });
    expect(impact.changeKind).toBe('duration_correction');
    expect(replaceOf([anchoredBroll()])[0].changeKind).toBe('media_replace');
  });

  it('measures nothing against an unknown or zero new duration', () => {
    // The transcode probe can come back with 0. Treating that as "the host is now zero seconds
    // long" would nominate every row in the project on a failed probe.
    for (const after of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(replaceOf([anchoredBroll()], { after })).toEqual([]);
    }
  });
});

// ── Case 2: a media replace ───────────────────────────────────────────────────

describe('a replace keeps the anchor and raises a review — it never clamps', () => {
  it('reports an anchor that no longer lands inside its host', () => {
    const row = anchoredBroll({ anchor_offset_sec: 20 });   // 20s into a host that is now 12s
    const impacts = replaceOf([row]);

    expect(impacts).toHaveLength(1);
    expect(impacts[0].reason).toBe('anchor_out_of_range');
    expect(impacts[0].sectionId).toBe('sec-broll');
    expect(impacts[0].hostVideoFileId).toBe('A');
    expect(impacts[0].hostDurationSecBefore).toBe(30);
    expect(impacts[0].hostDurationSecAfter).toBe(12);

    // THE ANCHOR IS KEPT, exactly as authored. A clamp to 12, a reset to 0, or a re-point at B
    // would each be a plausible-looking "fix" and each would destroy the author's intent.
    expect(row.anchor_offset_sec).toBe(20);
    expect(row.anchor_video_file_id).toBe('A');
    expect(impacts[0].anchorOffsetSec).toBe(20);
  });

  it('says nothing about a row anchored to a DIFFERENT host', () => {
    const elsewhere = anchoredBroll({ id: 'on-B', anchor_video_file_id: 'B', anchor_offset_sec: 20 });
    expect(replaceOf([elsewhere])).toEqual([]);
  });

  it('is silent while the anchor still fits — the same replace, a shorter offset', () => {
    expect(replaceOf([anchoredBroll({ anchor_offset_sec: 5 })])).toEqual([]);
  });

  // ── The boundary ────────────────────────────────────────────────────────────

  it('gives the seam to the NEXT segment: an offset AT the new duration is out of range', () => {
    // Half-open `[start, start+dur)`. Second 12 of a 12-second host is the FIRST instant of B, so a
    // row claiming to be 12s into A is claiming a frame it does not sit in.
    expect(replaceOf([anchoredBroll({ anchor_offset_sec: 12 })])).toHaveLength(1);
    // …and one frame earlier is fine, which is what makes this a boundary rather than a margin.
    expect(replaceOf([anchoredBroll({ anchor_offset_sec: 11.999 })])).toEqual([]);
  });

  it('allows the LAST segment its post-roll tail, and reports only past the end of it', () => {
    // B is last. The editor's ruler runs past the content (a 50s display floor), so a row can be
    // dragged and saved past the last frame; that tail is legal and must not become a review item.
    const onB = (offset: number) => anchoredBroll({
      id: 'on-B', anchor_video_file_id: 'B', anchor_offset_sec: offset,
    });
    const replaceB = (rows: readonly PlacementSectionLike[]) => planHostMediaImpact({
      hostVideoFileId: 'B', afterDurationSec: 10, beforeDurationSec: 40, kind: 'media_replace',
      rows, timelineAfter: buildMainSegmentTimeline([vid('A', 30), vid('B', 10)]),
    });

    expect(replaceB([onB(10)])).toEqual([]);                              // exactly at the end
    expect(replaceB([onB(10 + POST_ROLL_TAIL_SEC - 0.001)])).toEqual([]); // inside the tail
    expect(replaceB([onB(10 + POST_ROLL_TAIL_SEC)])).toHaveLength(1);     // past it
  });

  // ── The window ──────────────────────────────────────────────────────────────

  it('reports a b-roll whose in/out window is longer than its replaced source', () => {
    // The b-roll SOURCE was replaced, not a main segment: `video_file_id` on this row is that
    // source, and start/end are in-points into it. The row's POSITION is untouched.
    const row = anchoredBroll({ start_sec: 4, end_sec: 18 });   // 14s of a source now 10s long
    const impacts = planHostMediaImpact({
      hostVideoFileId: 'SRC', afterDurationSec: 10, beforeDurationSec: 20, kind: 'media_replace',
      rows: [row], timelineAfter: buildMainSegmentTimeline(AFTER_REPLACE),
    });

    expect(impacts).toHaveLength(1);
    expect(impacts[0].reason).toBe('source_window_out_of_range');
    expect(impacts[0].windowStartSec).toBe(4);
    expect(impacts[0].windowEndSec).toBe(18);
    // Not clamped to 10 — the whole point.
    expect(row.end_sec).toBe(18);
  });

  it('reports a main-track section whose window outlives its replaced host', () => {
    const chapter: PlacementSectionLike = {
      id: 'chapter-2', track: 'main', type: 'section', video_file_id: 'A',
      start_sec: 18, end_sec: 28,
    };
    const impacts = replaceOf([chapter]);
    expect(impacts.map((i) => i.reason)).toEqual(['source_window_out_of_range']);
    expect(chapter.end_sec).toBe(28);
  });

  it('leaves a 60-second music bed alone when its 12-second host is replaced', () => {
    // The regression this module is shaped around: on an audio cutaway `video_file_id` is only the
    // HOST, and start/end are offsets into the AUDIO file. The clamp did not know that and rewrote
    // a music bed to the length of the video under it, in the player and in the exported MP4.
    const bed: PlacementSectionLike = {
      id: 'bed', track: 'audio', type: 'audio', video_file_id: 'A',
      clip_source_audio_id: 'aud-1', start_sec: 0, end_sec: 60, global_offset_sec: 0,
    };
    expect(replaceOf([bed])).toEqual([]);
    expect(sourceWindowFor(bed, 'A')).toBeNull();
    expect(bed.end_sec).toBe(60);
  });

  it('measures a clip overlay against its SOURCE trim, not its position on the host', () => {
    // `start_sec`/`end_sec` on a clip overlay are positions on the host timeline; the span of the
    // source it consumes is `[clip_in, clip_in + shown duration)`.
    const overlay: PlacementSectionLike = {
      id: 'overlay', track: 'main', type: 'clip', video_file_id: 'B',
      clip_source_video_id: 'SRC', clip_in_sec: 6, start_sec: 10, end_sec: 20,
    };
    expect(sourceWindowFor(overlay, 'SRC')).toEqual({ startSec: 6, endSec: 16 });

    const shortened = (after: number) => planHostMediaImpact({
      hostVideoFileId: 'SRC', afterDurationSec: after, beforeDurationSec: 20, kind: 'media_replace',
      rows: [overlay], timelineAfter: buildMainSegmentTimeline(AFTER_REPLACE),
    });
    expect(shortened(16)).toEqual([]);          // fits exactly
    expect(shortened(15)).toHaveLength(1);      // one second short
  });

  it('reports BOTH faults separately when one replace causes each', () => {
    // A row anchored to A and sourced from A at once is malformed, but it exists in the wild, and
    // merging the two findings would hide half of what the author has to fix.
    const both = anchoredBroll({ video_file_id: 'A', anchor_offset_sec: 20, end_sec: 25 });
    expect(replaceOf([both]).map((i) => i.reason).sort())
      .toEqual(['anchor_out_of_range', 'source_window_out_of_range']);
  });

  it('carries where the row plays TODAY, so the review reads in the author’s units', () => {
    // Not the second it was authored at: the timeline has already moved, and the number a person
    // needs in order to find the clip is the one the viewer is showing them now.
    const [impact] = replaceOf([anchoredBroll({ anchor_offset_sec: 20 })]);
    // A is now 12s, so second 20 of A resolves to absolute 20 — inside B, which starts at 12.
    expect(impact.absoluteSec).toBe(20);
    expect(impact.detail).toContain('12');
  });
});

// ── Case 3: a delete ──────────────────────────────────────────────────────────

describe('deleting a host lists its dependents and refuses to choose', () => {
  const timeline = buildMainSegmentTimeline(BEFORE);
  const rows: LabelledSectionLike[] = [
    anchoredBroll({ id: 'anchored-to-A', label: 'logo sting' }),
    { id: 'sourced-from-A', track: 'main', type: 'section', video_file_id: 'A',
      start_sec: 0, end_sec: 30, label: 'chapter one' },
    { id: 'on-B', track: 'broll', type: 'broll', video_file_id: 'SRC', start_sec: 0, end_sec: 4,
      global_offset_sec: 40, placement_mode: 'segment',
      anchor_video_file_id: 'B', anchor_offset_sec: 10, label: 'unrelated' },
  ];

  const plan = planHostDeleteImpact({ hostVideoFileId: 'A', rows, timeline });

  it('names every dependent, and only the dependents', () => {
    expect(plan.requiresChoice).toBe(true);
    expect(dependentSectionIdsFor(plan).sort()).toEqual(['anchored-to-A', 'sourced-from-A']);
  });

  it('keeps the two dependency KINDS apart — one loses its position, the other its media', () => {
    expect(plan.dependents.find((d) => d.sectionId === 'anchored-to-A')!.kind).toBe('anchor');
    expect(plan.dependents.find((d) => d.sectionId === 'sourced-from-A')!.kind).toBe('source');
    // Only an anchored row can be detached: a sourced row's media IS the video being deleted.
    expect(anchoredSectionIdsFor(plan)).toEqual(['anchored-to-A']);
  });

  it('offers exactly two choices, and NEVER names a video to re-anchor to', () => {
    // "Move it to the next clip" is a guess about intent that would be indistinguishable, later,
    // from a placement the author made. The ruling forbids it; the vocabulary cannot express it.
    expect(plan.choices).toEqual(['detach', 'delete']);
    expect(HOST_DELETE_CHOICES).toEqual(['detach', 'delete']);
    expect(isHostDeleteChoice('reanchor')).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('"B"');
  });

  it('will not "keep" a row whose media is the video being deleted, however it is anchored', () => {
    // A row anchored to A AND sourced from A. It is malformed, and it exists in the wild. The
    // `video_file_id` FK cascades it away with the host whatever the author chose, so reporting it
    // as detached would be a lie told at the exact moment the author was deciding.
    const both: LabelledSectionLike = {
      id: 'both', track: 'broll', type: 'broll', video_file_id: 'A',
      start_sec: 0, end_sec: 6, global_offset_sec: 20,
      placement_mode: 'segment', anchor_video_file_id: 'A', anchor_offset_sec: 20,
    };
    const p = planHostDeleteImpact({ hostVideoFileId: 'A', rows: [both], timeline });
    expect(dependentSectionIdsFor(p)).toEqual(['both']);   // still named as a dependent
    expect(anchoredSectionIdsFor(p)).toEqual([]);          // but not offered as keepable
  });

  it('requires no choice when nothing depends on the host', () => {
    const free = planHostDeleteImpact({ hostVideoFileId: 'SRC', rows: [rows[1]], timeline });
    expect(free).toMatchObject({ requiresChoice: false, dependents: [] });
  });

  it('reports where each dependent plays today', () => {
    // Second 20 of A, with A starting at 0 — the number the author sees on the ruler.
    expect(plan.dependents.find((d) => d.sectionId === 'anchored-to-A')!.absoluteSec).toBe(20);
  });
});
