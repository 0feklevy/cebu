/**
 * WHERE A SECTION SITS — the one resolver, tested against the failure it exists to prevent.
 *
 * THE ASSERTION DISCIPLINE OF THIS FILE. It is not enough to assert that a resolved second is a
 * number, or that an anchored row "has an anchor". A resolver that simply returned
 * `global_offset_sec` — i.e. today's broken behaviour — would satisfy both. Every test below is
 * written to ask: WOULD THE BROKEN IMPLEMENTATION ALSO PASS THIS? Where the answer would be yes,
 * the assertion is strengthened until it is no, which in practice means asserting the position
 * RELATIVE TO THE CONTENT (which segment, and how far into it) across a change of durations, rather
 * than the absolute number on its own.
 *
 * The centrepiece is `re-transcode moves the content`: a legacy row and an anchored row that sit at
 * the same second BEFORE a main video changes length, and must sit at DIFFERENT seconds after —
 * with the anchored one still over the same frame. Nothing about the broken implementation can
 * produce that split, because the broken implementation has only one number to return.
 */
import { describe, it, expect } from 'vitest';
import { MAX_TIMELINE_SEC } from '../sectionShape.js';
import {
  MAIN_TIMELINE_HAS_NO_GAPS,
  POST_ROLL_TAIL_SEC,
  anchorPlacementViolations,
  buildMainSegmentTimeline,
  deriveAnchorForAbsoluteSec,
  isAnchorable,
  placementModeOf,
  planAnchorBackfill,
  resolveSectionPlacement,
  resolveSectionStartSec,
  segmentAtAbsoluteSec,
  type PlacementSectionLike,
  resolveMarkerPlacement,
  anchorForAbsoluteSec,
  type PlacementMarkerLike,
} from '../placement.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const vid = (id: string, duration_sec: number | null, is_broll = false) =>
  ({ id, duration_sec, is_broll });

/** A = [0,30), B = [30,70), C = [70,85). Total 85. */
const THREE = [vid('A', 30), vid('B', 40), vid('C', 15)];

/** The SAME project after B's neighbour A is re-transcoded five seconds shorter. */
const THREE_AFTER_RETRANSCODE = [vid('A', 25), vid('B', 40), vid('C', 15)];

const broll = (over: Partial<PlacementSectionLike> = {}): PlacementSectionLike => ({
  id: 'sec-broll', track: 'broll', type: 'broll', video_file_id: 'vid-source',
  start_sec: 0, end_sec: 6, global_offset_sec: null, ...over,
});

const clip = (over: Partial<PlacementSectionLike> = {}): PlacementSectionLike => ({
  id: 'sec-clip', track: 'main', type: 'clip', video_file_id: 'B',
  clip_source_video_id: 'vid-lib', start_sec: 10, end_sec: 16, ...over,
});

// ── THE BUG ───────────────────────────────────────────────────────────────────

describe('a re-transcode moves the content, and only an anchored row moves with it', () => {
  /**
   * The author placed a b-roll ten seconds into video B. Both rows below are that placement — one
   * expressed the old way (absolute second 40) and one the new way (segment B, offset 10). On
   * today's timeline they are the same moment.
   */
  const before = buildMainSegmentTimeline(THREE);
  const after = buildMainSegmentTimeline(THREE_AFTER_RETRANSCODE);

  const legacy = broll({ id: 'legacy', global_offset_sec: 40, placement_mode: 'legacy_absolute' });
  const anchored = broll({
    id: 'anchored', global_offset_sec: 40,
    placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10,
  });

  it('places both at the same second while nothing has changed', () => {
    expect(resolveSectionStartSec(legacy, before)).toBe(40);
    expect(resolveSectionStartSec(anchored, before)).toBe(40);
  });

  it('SPLITS them once A is five seconds shorter — the anchored one keeps its frame', () => {
    // A now ends at 25, so B runs [25, 65). "Ten seconds into B" is second 35.
    const legacyAt = resolveSectionPlacement(legacy, after);
    const anchoredAt = resolveSectionPlacement(anchored, after);

    // The two answers must now DIFFER. A resolver that ignored the anchor would return 40 for both,
    // and this single line is what it could not pass.
    expect(anchoredAt.absoluteSec).not.toBe(legacyAt.absoluteSec);

    // And the anchored one is still over the same frame of the same video — asserted as
    // (segment, offset into it), which is the thing the author actually chose. The absolute number
    // is a consequence, not the claim.
    expect(anchoredAt.absoluteSec).toBe(35);
    expect(anchoredAt.containingSegmentId).toBe('B');
    expect(anchoredAt.absoluteSec - after.byId.get('B')!.startSec).toBe(10);
    expect(anchoredAt.source).toBe('anchor');
    expect(anchoredAt.degradation).toBeNull();

    // The legacy row is pinned to the wall clock: same number, DIFFERENT frame. This is the bug,
    // pinned so that "we fixed it" cannot quietly become "we changed what legacy rows do".
    expect(legacyAt.absoluteSec).toBe(40);
    expect(legacyAt.containingSegmentId).toBe('B');
    expect(legacyAt.absoluteSec - after.byId.get('B')!.startSec).toBe(15);   // drifted five seconds
  });

  it('a clip overlay on the same host lands on the same frame as the anchored b-roll, before and after', () => {
    // The two drift mechanisms in one assertion. A clip overlay stores no absolute at all — it is
    // derived from its host — so it has ALWAYS followed the content. Before D-01 the b-roll did not,
    // and the two representations of "ten seconds into B" came apart the moment B moved.
    const overlay = clip({ video_file_id: 'B', start_sec: 10 });
    expect(resolveSectionStartSec(overlay, before)).toBe(resolveSectionStartSec(anchored, before));
    expect(resolveSectionStartSec(overlay, after)).toBe(resolveSectionStartSec(anchored, after));
    expect(resolveSectionStartSec(overlay, after)).toBe(35);
  });
});

// ── The segment layout ────────────────────────────────────────────────────────

describe('buildMainSegmentTimeline', () => {
  it('lays the main videos out end to end, half-open', () => {
    const t = buildMainSegmentTimeline(THREE);
    expect(t.segments.map((s) => [s.id, s.startSec, s.endSec])).toEqual([
      ['A', 0, 30], ['B', 30, 70], ['C', 70, 85],
    ]);
    expect(t.totalSec).toBe(85);
    expect(t.segments[2]!.isLast).toBe(true);
    expect(t.segments[0]!.isLast).toBe(false);
  });

  it('EXCLUDES b-roll source videos — they have no position on the main timeline', () => {
    // Not cosmetic: a b-roll source counted as a segment would widen the concatenation and shift
    // every section after it. The filter lives inside the builder so no caller can forget it.
    const t = buildMainSegmentTimeline([vid('A', 30), vid('gen', 6, true), vid('B', 40)]);
    expect(t.segments.map((s) => s.id)).toEqual(['A', 'B']);
    expect(t.byId.has('gen')).toBe(false);
    expect(t.byId.get('B')!.startSec).toBe(30);      // NOT 36
    expect(t.totalSec).toBe(70);
  });

  it('treats an unknown or non-positive duration as zero width, and says so', () => {
    const t = buildMainSegmentTimeline([vid('A', null), vid('B', 40), vid('C', 0)]);
    expect(t.hasUnknownDuration).toBe(true);
    expect(t.byId.get('A')!.durationKnown).toBe(false);
    expect(t.byId.get('B')!.startSec).toBe(0);        // A contributes nothing
    expect(t.byId.get('C')!.durationKnown).toBe(false);
    expect(t.totalSec).toBe(40);
  });

  it('is empty, not broken, for a project with no main video', () => {
    const t = buildMainSegmentTimeline([vid('gen', 6, true)]);
    expect(t.segments).toEqual([]);
    expect(t.totalSec).toBe(0);
    expect(segmentAtAbsoluteSec(t, 0)).toBeNull();
  });
});

describe('the two cases with no host to anchor to', () => {
  it('an INTERIOR GAP is unrepresentable — asserted, because the anchor model depends on it', () => {
    // If a gap could exist, an absolute second could fall in one and `deriveAnchorForAbsoluteSec`
    // would have to invent a host. It cannot, and the reason is structural rather than lucky: there
    // is no per-video start column anywhere in the schema, and every layout in the product is the
    // same running total — `buildMainSegmentTimeline` here, `videoGlobalOffsets` in the export
    // planner, `buildClips` in the editor. A video whose duration has not landed contributes zero
    // width and the next one begins exactly where it did; that is a zero-width segment, not a hole.
    expect(MAIN_TIMELINE_HAS_NO_GAPS).toBe(true);
    const t = buildMainSegmentTimeline([vid('A', 30), vid('B', null), vid('C', 15)]);
    // Segment n+1 starts exactly where segment n ended, with no second unaccounted for anywhere.
    t.segments.forEach((seg, i) => {
      expect(seg.startSec).toBe(i === 0 ? 0 : t.segments[i - 1]!.endSec);
    });
    for (let at = 0; at < t.totalSec; at += 0.5) expect(segmentAtAbsoluteSec(t, at)).not.toBeNull();
  });

  it('PAST THE END is representable, and resolves to the last segment', () => {
    // The editor can produce this today (its ruler floors at 50s, so a 30s project has twenty
    // seconds of timeline with no video under it) and the API accepts any second up to 24h. There
    // is no host there, and the rule adopted — anchor to the LAST segment, offset past its end — is
    // the editor's own `findClipAtGlobalSec`. See the report: the TAIL'S MAGNITUDE and what a
    // tail-anchored overlay should do when the last segment is re-transcoded are the owner's calls.
    const t = buildMainSegmentTimeline([vid('A', 30)]);
    expect(deriveAnchorForAbsoluteSec(t, 45)).toMatchObject({
      anchor_video_file_id: 'A', anchor_offset_sec: 45, postRollSec: 15,
    });
  });
});

describe('segmentAtAbsoluteSec — half-open, and the post-roll tail', () => {
  const t = buildMainSegmentTimeline(THREE);

  it('gives the seam to the LATER segment', () => {
    // The one assertion an inclusive upper bound (`<= endSec`) could not pass, and the reason the
    // rule has to be written down: a placement exactly on a cut is otherwise two answers.
    expect(segmentAtAbsoluteSec(t, 29.999)!.id).toBe('A');
    expect(segmentAtAbsoluteSec(t, 30)!.id).toBe('B');
    expect(segmentAtAbsoluteSec(t, 70)!.id).toBe('C');
  });

  it('resolves anything past the last frame to the LAST segment — the tail', () => {
    // This mirrors the editor's own `findClipAtGlobalSec`, which scans for a containing clip and
    // returns the last one when it finds none. Matching it is what makes "second 200" mean the
    // same thing in the editor and on the server.
    expect(segmentAtAbsoluteSec(t, 85)!.id).toBe('C');
    expect(segmentAtAbsoluteSec(t, 200)!.id).toBe('C');
  });

  it('never returns a zero-width segment for an interior point', () => {
    // `[x, x)` contains nothing, so a segment whose duration has not landed cannot swallow a
    // placement that belongs to the video after it.
    const z = buildMainSegmentTimeline([vid('A', null), vid('B', 40)]);
    expect(segmentAtAbsoluteSec(z, 0)!.id).toBe('B');
    expect(segmentAtAbsoluteSec(z, 39)!.id).toBe('B');
  });

  it('refuses a negative or non-finite second', () => {
    expect(segmentAtAbsoluteSec(t, -1)).toBeNull();
    expect(segmentAtAbsoluteSec(t, Number.NaN)).toBeNull();
    expect(segmentAtAbsoluteSec(t, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ── Dual read ─────────────────────────────────────────────────────────────────

describe('the dual read', () => {
  const t = buildMainSegmentTimeline(THREE);

  it('reads a legacy row exactly as it reads today — the stored absolute, untouched', () => {
    const at = resolveSectionPlacement(broll({ global_offset_sec: 47 }), t);
    expect(at).toMatchObject({ absoluteSec: 47, source: 'absolute', degradation: null });
  });

  it('names a positionless overlay instead of silently playing it at second zero', () => {
    // Four read sites used to coerce this NULL to 0, so a b-roll with no position played over the
    // opening frames and nothing said a word. It still plays there — moving it would be a second
    // change — but the reason is now on the resolution.
    const at = resolveSectionPlacement(broll({ global_offset_sec: null }), t);
    expect(at.absoluteSec).toBe(0);
    expect(at.degradation).toBe('absolute_missing');
  });

  it('falls back to the absolute when an anchored row has LOST its host, and says which fault it was', () => {
    // `ON DELETE SET NULL`: deleting a main video leaves the overlay behind with a hollow anchor.
    // Falling back keeps it visible; reporting `anchor_missing` rather than `absolute_missing`
    // points at the real fault instead of the consequence.
    const at = resolveSectionPlacement(
      broll({ global_offset_sec: 47, placement_mode: 'segment', anchor_video_file_id: null }), t,
    );
    expect(at).toMatchObject({ absoluteSec: 47, source: 'absolute', degradation: 'anchor_missing' });
  });

  it('falls back when the anchor names a video that is not a segment of this timeline', () => {
    const at = resolveSectionPlacement(
      broll({
        global_offset_sec: 47, placement_mode: 'segment',
        anchor_video_file_id: 'vid-source', anchor_offset_sec: 3,       // a b-roll source, not a segment
      }), t,
    );
    expect(at).toMatchObject({ absoluteSec: 47, degradation: 'anchor_not_a_segment' });
  });

  it('falls back when only half the pair survived', () => {
    const at = resolveSectionPlacement(
      broll({ global_offset_sec: 47, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: null }), t,
    );
    expect(at).toMatchObject({ absoluteSec: 47, degradation: 'anchor_offset_missing' });
  });

  it('ignores an anchor pair that was written without the mode being flipped', () => {
    // Expand/contract: the mode is what a row USES, so a half-finished write cannot change where an
    // existing row plays. The pair is stored, inert, until something sets `placement_mode`.
    const row = broll({ global_offset_sec: 47, anchor_video_file_id: 'B', anchor_offset_sec: 10 });
    expect(placementModeOf(row)).toBe('legacy_absolute');
    expect(resolveSectionPlacement(row, t)).toMatchObject({ absoluteSec: 47, source: 'absolute' });
  });

  it('reports the post-roll distance for a placement past the end', () => {
    const at = resolveSectionPlacement(broll({ global_offset_sec: 100 }), t);
    expect(at.postRollSec).toBe(15);
    expect(at.containingSegmentId).toBe('C');
  });

  it('clamps a stored absolute past the 24h ceiling rather than emitting it', () => {
    const at = resolveSectionPlacement(broll({ global_offset_sec: MAX_TIMELINE_SEC * 3 }), t);
    expect(at.absoluteSec).toBe(MAX_TIMELINE_SEC);
  });
});

describe('main-track rows resolve through their host, not through an anchor', () => {
  const t = buildMainSegmentTimeline(THREE);

  it('places a clip overlay at segmentStart(host) + start_sec', () => {
    const at = resolveSectionPlacement(clip({ video_file_id: 'C', start_sec: 4 }), t);
    expect(at).toMatchObject({ absoluteSec: 74, source: 'native_host', degradation: null });
  });

  it('places a plain main section and a simulation the same way', () => {
    const main = { id: 'm', track: 'main', type: 'video', video_file_id: 'B', start_sec: 5, end_sec: 9 };
    const sim = { id: 's', track: 'main', type: 'simulation', video_file_id: 'B', start_sec: 5, end_sec: 9 };
    expect(resolveSectionStartSec(main, t)).toBe(35);
    expect(resolveSectionStartSec(sim, t)).toBe(35);
  });

  it('NAMES a host that is not in the main timeline instead of silently using second zero', () => {
    // `videoGlobalOffsets.get(id) ?? 0` is what both readers did. The row still lands at its local
    // second — changing that would move live content — but the `?? 0` is no longer invisible.
    const at = resolveSectionPlacement(clip({ video_file_id: 'gone', start_sec: 4 }), t);
    expect(at).toMatchObject({ absoluteSec: 4, source: 'native_host', degradation: 'host_not_a_segment' });
  });

  it('classifies which rows an anchor even applies to', () => {
    expect(isAnchorable(broll())).toBe(true);
    expect(isAnchorable({ track: 'audio', type: 'audio', clip_source_audio_id: 'aud-1' })).toBe(true);
    expect(isAnchorable(clip())).toBe(false);
    expect(isAnchorable({ track: 'main', type: 'video' })).toBe(false);
  });

  it('treats an audio cutaway on the BROLL track as anchorable too — the lane decides, not the track', () => {
    const cutaway = broll({ clip_source_audio_id: 'aud-1', global_offset_sec: 12 });
    expect(isAnchorable(cutaway)).toBe(true);
    const anchoredCutaway = { ...cutaway, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 2 };
    expect(resolveSectionStartSec(anchoredCutaway, t)).toBe(32);
  });
});

// ── Deriving an anchor ────────────────────────────────────────────────────────

describe('deriveAnchorForAbsoluteSec', () => {
  const t = buildMainSegmentTimeline(THREE);

  it('round-trips EXACTLY through the resolver, at seams and in the tail', () => {
    // The property that makes "anchor on write" safe: anchoring a row must never move it. Includes
    // both sides of every seam, because that is where an off-by-one in the half-open rule would
    // land, and a point in the tail, where the last segment is the only host available.
    for (const at of [0, 1, 29.999, 30, 30.001, 69.999, 70, 84.5, 85, 120]) {
      const d = deriveAnchorForAbsoluteSec(t, at)!;
      const row = broll({
        placement_mode: 'segment',
        anchor_video_file_id: d.anchor_video_file_id,
        anchor_offset_sec: d.anchor_offset_sec,
        global_offset_sec: null,
      });
      expect(resolveSectionStartSec(row, t)).toBeCloseTo(at, 9);
    }
  });

  it('gives a seam to the later segment, matching the resolver', () => {
    expect(deriveAnchorForAbsoluteSec(t, 30)).toMatchObject({ anchor_video_file_id: 'B', anchor_offset_sec: 0 });
    expect(deriveAnchorForAbsoluteSec(t, 29)).toMatchObject({ anchor_video_file_id: 'A', anchor_offset_sec: 29 });
  });

  it('anchors a past-the-end placement to the LAST segment and reports the tail', () => {
    expect(deriveAnchorForAbsoluteSec(t, 95)).toMatchObject({
      anchor_video_file_id: 'C', anchor_offset_sec: 25, postRollSec: 10,
    });
  });

  it('returns null when there is nothing to anchor to', () => {
    expect(deriveAnchorForAbsoluteSec(buildMainSegmentTimeline([]), 5)).toBeNull();
    expect(deriveAnchorForAbsoluteSec(t, -1)).toBeNull();
    expect(deriveAnchorForAbsoluteSec(t, Number.NaN)).toBeNull();
  });
});

// ── Legality ──────────────────────────────────────────────────────────────────

describe('anchorPlacementViolations', () => {
  const t = buildMainSegmentTimeline(THREE);
  const codes = (row: PlacementSectionLike) => anchorPlacementViolations(row, t).map((v) => v.code);

  it('says nothing about a row with no anchor at all', () => {
    expect(codes(broll({ global_offset_sec: 12 }))).toEqual([]);
  });

  it('refuses an offset AT or PAST the end of a non-last segment', () => {
    // Under the half-open rule that instant belongs to the NEXT segment. Allowing it would let a
    // row claim a host it does not sit in, and the next re-transcode of either video would move it
    // somewhere neither the author nor the anchor meant.
    expect(codes(broll({ anchor_video_file_id: 'A', anchor_offset_sec: 30 }))).toEqual(['anchor_offset_past_segment']);
    expect(codes(broll({ anchor_video_file_id: 'A', anchor_offset_sec: 31 }))).toEqual(['anchor_offset_past_segment']);
    expect(codes(broll({ anchor_video_file_id: 'A', anchor_offset_sec: 29.999 }))).toEqual([]);
  });

  it('allows the LAST segment a bounded post-roll tail', () => {
    expect(codes(broll({ anchor_video_file_id: 'C', anchor_offset_sec: 15 }))).toEqual([]);
    expect(codes(broll({ anchor_video_file_id: 'C', anchor_offset_sec: 15 + POST_ROLL_TAIL_SEC - 0.5 }))).toEqual([]);
    expect(codes(broll({ anchor_video_file_id: 'C', anchor_offset_sec: 15 + POST_ROLL_TAIL_SEC })))
      .toEqual(['anchor_offset_past_tail']);
  });

  it('refuses half a pair', () => {
    expect(codes(broll({ anchor_video_file_id: 'B' }))).toEqual(['anchor_incomplete']);
    expect(codes(broll({ anchor_offset_sec: 3 }))).toEqual(['anchor_incomplete']);
  });

  it('refuses an anchor on a main-track row', () => {
    // Those are placed by `video_file_id + start_sec` and always have been. A second anchor on the
    // same row is two answers to one question — the defect the whole module exists to remove.
    expect(codes(clip({ anchor_video_file_id: 'B', anchor_offset_sec: 3 })))
      .toEqual(['anchor_on_unanchorable_row']);
  });

  it('refuses a non-finite or out-of-range offset', () => {
    expect(codes(broll({ anchor_video_file_id: 'B', anchor_offset_sec: -1 }))).toEqual(['anchor_offset_out_of_range']);
    expect(codes(broll({ anchor_video_file_id: 'B', anchor_offset_sec: Number.NaN }))).toEqual(['anchor_offset_out_of_range']);
    expect(codes(broll({ anchor_video_file_id: 'B', anchor_offset_sec: MAX_TIMELINE_SEC + 1 })))
      .toEqual(['anchor_offset_out_of_range']);
  });

  it('refuses a pair whose SUM would leave the timeline, even though each half is in range', () => {
    // The sum is what gets written back as the dual read's fallback, so a pair that individually
    // passes every bound but resolves past the ceiling has to be caught here or not at all.
    const far = buildMainSegmentTimeline([vid('X', MAX_TIMELINE_SEC - 10), vid('Y', 100)]);
    expect(far.byId.get('Y')!.startSec).toBe(MAX_TIMELINE_SEC - 10);
    // 100 is a legal offset INTO Y (its duration is 100, and it is the last segment, so the tail
    // rule alone would allow it) — only the sum is out of range.
    expect(anchorPlacementViolations(
      broll({ anchor_video_file_id: 'Y', anchor_offset_sec: 100 }), far,
    ).map((v) => v.code)).toEqual(['anchor_offset_out_of_range']);
    expect(anchorPlacementViolations(
      broll({ anchor_video_file_id: 'Y', anchor_offset_sec: 5 }), far,
    )).toEqual([]);
  });

  it('says nothing when the segment has no known duration — there is nothing to measure against', () => {
    const u = buildMainSegmentTimeline([vid('A', null), vid('B', 40)]);
    expect(anchorPlacementViolations(broll({ anchor_video_file_id: 'A', anchor_offset_sec: 900 }), u)).toEqual([]);
  });
});

// ── The dry run ───────────────────────────────────────────────────────────────

describe('planAnchorBackfill — nominates, converts nothing', () => {
  const t = buildMainSegmentTimeline(THREE);

  it('does not mutate a single input row', () => {
    // The ruling's central prohibition, asserted structurally rather than by reading the code: the
    // rows that go in come out byte-identical, so nothing here can ever have been a write.
    const rows = [broll({ id: 'x', global_offset_sec: 40 }), clip()];
    const snapshot = JSON.parse(JSON.stringify(rows));
    planAnchorBackfill(rows, t);
    expect(rows).toEqual(snapshot);
  });

  it('nominates an in-range legacy overlay, with the anchor it WOULD get', () => {
    const r = planAnchorBackfill([broll({ id: 'x', global_offset_sec: 40 })], t);
    expect(r.anchorableRows).toBe(1);
    expect(r.candidates).toEqual([{
      sectionId: 'x', absoluteSec: 40, anchor_video_file_id: 'B', anchor_offset_sec: 10, postRollSec: 0,
    }]);
  });

  it('ignores main-track rows entirely — they are not in this population', () => {
    const r = planAnchorBackfill([clip(), { id: 'm', track: 'main', type: 'video', video_file_id: 'A', start_sec: 1, end_sec: 2 }], t);
    expect(r.anchorableRows).toBe(0);
    expect(r.candidates).toEqual([]);
    expect(r.excluded).toEqual([]);
  });

  it('EXCLUDES the three populations the ruling names, and counts them', () => {
    const rows = [
      broll({ id: 'ok', global_offset_sec: 40 }),
      broll({ id: 'done', global_offset_sec: 40, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10 }),
      broll({ id: 'far', global_offset_sec: 85 + POST_ROLL_TAIL_SEC + 1 }),
      broll({ id: 'nowhere', global_offset_sec: null }),
    ];
    const r = planAnchorBackfill(rows, t);
    expect(r.candidates.map((c) => c.sectionId)).toEqual(['ok']);
    expect(r.alreadyAnchored).toBe(1);
    expect(r.excludedByReason.already_anchored).toBe(1);
    expect(r.excludedByReason.out_of_range).toBe(2);        // past the tail, and positionless
  });

  it('excludes everything at or after a segment whose duration has not landed', () => {
    // A = unknown, B = 40 → B currently starts at 0, and WILL move once A's real duration arrives.
    // Anything mapped now would be mapped against a layout that is about to change.
    const u = buildMainSegmentTimeline([vid('A', null), vid('B', 40)]);
    const r = planAnchorBackfill([broll({ id: 'x', global_offset_sec: 10 })], u);
    expect(r.candidates).toEqual([]);
    expect(r.excludedByReason.unknown_duration).toBe(1);
  });

  it('still nominates rows BEFORE the first unknown-duration segment', () => {
    const u = buildMainSegmentTimeline([vid('A', 30), vid('B', null), vid('C', 15)]);
    const r = planAnchorBackfill(
      [broll({ id: 'early', global_offset_sec: 10 }), broll({ id: 'late', global_offset_sec: 32 })], u,
    );
    expect(r.candidates.map((c) => c.sectionId)).toEqual(['early']);
    expect(r.excludedByReason.unknown_duration).toBe(1);
  });

  it('excludes EVERY row of a branched project', () => {
    // Playback there is a graph, not one concatenation, so "the cumulative sum of durations" is not
    // its timeline at all and no mapping computed from it means anything.
    const r = planAnchorBackfill([broll({ id: 'x', global_offset_sec: 40 })], t, { branched: true });
    expect(r.branched).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(r.excludedByReason.branched).toBe(1);
  });

  it('a nominated candidate, if applied, would not move the row', () => {
    // The safety property behind every nomination: converting is a change of REPRESENTATION only.
    const rows = [broll({ id: 'x', global_offset_sec: 40 }), broll({ id: 'y', global_offset_sec: 7.25 })];
    for (const c of planAnchorBackfill(rows, t).candidates) {
      const converted = broll({
        placement_mode: 'segment',
        anchor_video_file_id: c.anchor_video_file_id,
        anchor_offset_sec: c.anchor_offset_sec,
        global_offset_sec: null,
      });
      expect(resolveSectionStartSec(converted, t)).toBeCloseTo(c.absoluteSec, 9);
    }
  });
});

// ── Markers (migration 074) ───────────────────────────────────────────────────

/**
 * A marker is not a section — no length, no lane, no host — and it drifts for exactly the same
 * reason. These tests pin that it resolves through the SAME rules and reports the SAME degradation
 * words, because the bug class 063 was written to end is that each surface answers "where is this
 * row?" differently, and near-identical wording on a second resolver is how that comes back.
 */
describe('marker placement', () => {
  const marker = (over: Partial<PlacementMarkerLike> = {}): PlacementMarkerLike =>
    ({ at_sec: 40, placement_mode: 'legacy_absolute', ...over });

  it('resolves a legacy marker at its stored second, unchanged', () => {
    const t = buildMainSegmentTimeline(THREE);
    const r = resolveMarkerPlacement(marker(), t);
    expect(r.absoluteSec).toBe(40);
    expect(r.source).toBe('absolute');
    expect(r.degradation).toBeNull();
  });

  it('FOLLOWS ITS CONTENT when an earlier clip changes length', () => {
    // The whole point. A marker on "second 10 of clip B" means a moment in the lesson. Trim four
    // seconds out of clip A and the absolute marker still fires at 40 — now pointing at a different
    // sentence — while the anchored one moves with the content it was placed on.
    const before = buildMainSegmentTimeline(THREE);
    const shorter = buildMainSegmentTimeline([vid('A', 26), vid('B', 40), vid('C', 15)]);

    const legacy = marker({ at_sec: 40 });
    const anchored = marker({
      at_sec: 40, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10,
    });

    expect(resolveMarkerPlacement(legacy, before).absoluteSec).toBe(40);
    expect(resolveMarkerPlacement(anchored, before).absoluteSec).toBe(40);

    expect(resolveMarkerPlacement(legacy, shorter).absoluteSec).toBe(40);      // stayed put
    expect(resolveMarkerPlacement(anchored, shorter).absoluteSec).toBe(36);    // followed clip B
  });

  it('keeps a marker VISIBLE when its anchor is gone, and names the anchor\'s fault', () => {
    // A marker that vanishes is worse than one in the wrong place: the author can move a marker
    // they can see. Same fallback posture as sections, and the same word for it.
    const t = buildMainSegmentTimeline(THREE);
    const orphan = marker({ at_sec: 40, placement_mode: 'segment', anchor_video_file_id: null });

    const r = resolveMarkerPlacement(orphan, t);
    expect(r.absoluteSec).toBe(40);
    expect(r.degradation).toBe('anchor_missing');
  });

  it('distinguishes an anchor pointing at a NON-segment from a missing one', () => {
    const t = buildMainSegmentTimeline(THREE);
    const r = resolveMarkerPlacement(
      marker({ placement_mode: 'segment', anchor_video_file_id: 'not-a-segment', anchor_offset_sec: 5 }), t);
    expect(r.degradation).toBe('anchor_not_a_segment');
  });

  it('treats half a pair as no anchor at all', () => {
    const t = buildMainSegmentTimeline(THREE);
    const r = resolveMarkerPlacement(
      marker({ placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: null }), t);
    expect(r.degradation).toBe('anchor_offset_missing');
    expect(r.absoluteSec).toBe(40);
  });

  it('names a missing absolute rather than silently placing it at zero', () => {
    const t = buildMainSegmentTimeline(THREE);
    const r = resolveMarkerPlacement(marker({ at_sec: null }), t);
    expect(r.absoluteSec).toBe(0);
    expect(r.degradation).toBe('absolute_missing');
  });
});

describe('choosing an anchor to store', () => {
  it('turns an absolute second into the segment it falls in, plus the offset', () => {
    const t = buildMainSegmentTimeline(THREE);   // A 0-30, B 30-70, C 70-85
    expect(anchorForAbsoluteSec(t, 40)).toEqual({
      anchor_video_file_id: 'B', anchor_offset_sec: 10, placement_mode: 'segment',
    });
  });

  it('round-trips: what it stores is what the resolver reads back', () => {
    // The property that matters more than either function alone.
    const t = buildMainSegmentTimeline(THREE);
    for (const sec of [0, 12, 30, 55, 70, 84]) {
      const pair = anchorForAbsoluteSec(t, sec)!;
      expect(resolveMarkerPlacement({ at_sec: sec, ...pair }, t).absoluteSec, `at ${sec}`).toBeCloseTo(sec, 6);
    }
  });

  it('returns NULL rather than half a pair when there is no timeline', () => {
    // A row claiming to be anchored and resolving through the fallback forever is strictly worse
    // than an honest absolute.
    const empty = buildMainSegmentTimeline([]);
    expect(anchorForAbsoluteSec(empty, 10)).toBeNull();
  });

  it('returns NULL for a nonsense second', () => {
    const t = buildMainSegmentTimeline(THREE);
    for (const bad of [-1, NaN, Infinity]) {
      expect(anchorForAbsoluteSec(t, bad), String(bad)).toBeNull();
    }
  });
});
