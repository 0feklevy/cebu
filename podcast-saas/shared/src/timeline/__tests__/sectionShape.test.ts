/**
 * The classifier IS the contract. Three surfaces used to answer "what is this row?" three different
 * ways; these tests are the single answer they now share, so a change of mind here is a change of
 * mind everywhere and shows up as a failure rather than as a divergence nobody notices.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_TIMELINE_SEC,
  classifyTimelineSection,
  compareTimelineSections,
  groupTimelineSectionsByLane,
  laneForTimelineSection,
  newTimelineSectionViolations,
  sortTimelineSections,
  timelineSectionViolations,
  type TimelineLane,
  type TimelineSectionLike,
} from '../sectionShape.js';

const row = (over: TimelineSectionLike = {}): TimelineSectionLike => ({
  id: 'sec-1', track: 'main', type: 'video', video_file_id: 'vid-1',
  clip_source_video_id: null, clip_source_image_id: null, clip_source_audio_id: null,
  start_sec: 0, end_sec: 10, global_offset_sec: null, clip_in_sec: 0, sort_order: null,
  ...over,
});

// ── The three shapes ──────────────────────────────────────────────────────────

describe('the census shapes', () => {
  it('Shape 1 — a true b-roll', () => {
    expect(classifyTimelineSection(row({ track: 'broll', type: 'broll', global_offset_sec: 5 })))
      .toBe('broll');
  });

  it('Shape 2 — a main-track "Existing Visual"', () => {
    expect(classifyTimelineSection(row({ type: 'clip', clip_source_video_id: 'vid-2' })))
      .toBe('clip_video');
  });

  it('Shape 3 — the malformed hybrid', () => {
    expect(classifyTimelineSection(row({
      track: 'broll', type: 'clip', clip_source_video_id: 'vid-2', global_offset_sec: 5,
    }))).toBe('broll_clip_hybrid');
  });

  it('invalid — a clip section with nothing to play', () => {
    expect(classifyTimelineSection(row({ type: 'clip' }))).toBe('invalid');
    expect(laneForTimelineSection(row({ type: 'clip' }))).toBe('none');
  });
});

describe('`type` cannot move a row between lanes', () => {
  // A Save from the section editor rewrites `type` to 'video' on any broll row. A classification
  // that depended on it would silently relocate the clip; every one of these is the b-roll lane.
  it.each(['broll', 'video', 'clip', 'simulation', '', null, undefined])(
    'track=broll with type=%p is still b-roll',
    (type) => {
      expect(laneForTimelineSection(row({ track: 'broll', type, global_offset_sec: 5 })))
        .toBe('broll');
    },
  );

  it('the residue shape is the same row as the live hybrid, just dormant', () => {
    // `type='video'` + a leftover clip pointer stops double-emitting on its own, and re-arms the
    // moment anything sets `type` back to 'clip'. Both classify as the hybrid, so both are caught.
    expect(classifyTimelineSection(row({ track: 'broll', type: 'video', clip_source_video_id: 'v' })))
      .toBe('broll_clip_hybrid');
  });
});

describe('the adjacent shapes are not confused with the three', () => {
  it('an audio cutaway is audio on either track', () => {
    for (const track of ['broll', 'audio', 'main']) {
      expect(classifyTimelineSection(row({ track, clip_source_audio_id: 'aud-1' })))
        .toBe('audio_cutaway');
    }
  });

  it('an image overlay is its own lane', () => {
    expect(classifyTimelineSection(row({ type: 'clip', clip_source_image_id: 'img-1' })))
      .toBe('clip_image');
  });

  it('a simulation and a plain main segment stay on the main lane', () => {
    expect(laneForTimelineSection(row({ type: 'simulation' }))).toBe('main');
    expect(laneForTimelineSection(row())).toBe('main');
  });

  it('an audio-track row with nothing to play is invalid, not a main segment', () => {
    // It renders nowhere in every reader today. Calling it `main` would put a row that plays
    // nothing into the bucket that means "a segment section".
    expect(classifyTimelineSection(row({ track: 'audio', global_offset_sec: 1 }))).toBe('invalid');
    // …but an audio-track row that IS a clip still resolves as one, exactly as it does today.
    expect(classifyTimelineSection(row({ track: 'audio', type: 'clip', clip_source_video_id: 'v', global_offset_sec: 1 })))
      .toBe('clip_video');
  });
});

// ── Exhaustive partition ──────────────────────────────────────────────────────

describe('every row lands in exactly one lane', () => {
  const tracks = ['main', 'broll', 'audio', 'something-else'];
  const types = ['video', 'broll', 'clip', 'simulation', 'whatever'];
  const ids = [null, 'x'];

  it('the whole cross product is a partition', () => {
    const rows: TimelineSectionLike[] = [];
    let n = 0;
    for (const track of tracks) {
      for (const type of types) {
        for (const v of ids) for (const i of ids) for (const a of ids) {
          rows.push(row({
            id: `s-${n++}`, track, type,
            clip_source_video_id: v, clip_source_image_id: i, clip_source_audio_id: a,
            global_offset_sec: 1,
          }));
        }
      }
    }
    const lanes = groupTimelineSectionsByLane(rows);
    const total = (Object.keys(lanes) as TimelineLane[])
      .reduce((sum, lane) => sum + lanes[lane].length, 0);

    expect(rows).toHaveLength(tracks.length * types.length * 8);
    expect(total).toBe(rows.length);              // nothing lost
    const seen = new Set<string>();
    for (const lane of Object.keys(lanes) as TimelineLane[]) {
      for (const r of lanes[lane]) {
        expect(seen.has(r.id!)).toBe(false);      // nothing counted twice
        seen.add(r.id!);
      }
    }
  });
});

// ── Ordering ──────────────────────────────────────────────────────────────────

describe('the canonical order is total', () => {
  const rows = [
    row({ id: 'd', sort_order: null, start_sec: 0, global_offset_sec: 30 }),
    row({ id: 'b', sort_order: null, start_sec: 0, global_offset_sec: 10 }),
    row({ id: 'c', sort_order: null, start_sec: 0, global_offset_sec: 10 }),
    row({ id: 'a', sort_order: 1, start_sec: 99, global_offset_sec: null }),
  ];

  it('never returns 0 for two different rows', () => {
    for (const x of rows) {
      for (const y of rows) {
        if (x.id === y.id) expect(compareTimelineSections(x, y)).toBe(0);
        else expect(compareTimelineSections(x, y)).not.toBe(0);
      }
    }
  });

  it('is independent of input order', () => {
    const canonical = sortTimelineSections(rows).map((r) => r.id);
    expect(sortTimelineSections([...rows].reverse()).map((r) => r.id)).toEqual(canonical);
    expect(sortTimelineSections([rows[2]!, rows[0]!, rows[3]!, rows[1]!]).map((r) => r.id))
      .toEqual(canonical);
  });

  it('sorts by sort_order first, with NULLs last — Postgres ASC', () => {
    expect(sortTimelineSections(rows).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate its input', () => {
    const input = [...rows];
    sortTimelineSections(input);
    expect(input.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});

// ── Row rules ─────────────────────────────────────────────────────────────────

const codes = (r: TimelineSectionLike) => timelineSectionViolations(r).map((v) => v.code);

describe('the structural rules', () => {
  it('accepts each well-formed shape', () => {
    expect(codes(row({ track: 'broll', type: 'broll', global_offset_sec: 5 }))).toEqual([]);
    expect(codes(row({ type: 'clip', clip_source_video_id: 'v' }))).toEqual([]);
    expect(codes(row())).toEqual([]);                       // main row, NULL offset — correct
  });

  it('requires an offset on the rows that carry their own position', () => {
    expect(codes(row({ track: 'broll', type: 'broll' }))).toContain('missing_offset');
    expect(codes(row({ track: 'audio' }))).toContain('missing_offset');
    expect(codes(row({ clip_source_audio_id: 'a' }))).toContain('missing_offset');
  });

  it('does NOT require one on a main row — that is the refuted claim', () => {
    // Main rows are positioned by start_sec inside their host video. Flagging them would
    // manufacture a finding out of correct data.
    expect(codes(row({ global_offset_sec: null }))).toEqual([]);
    expect(codes(row({ type: 'clip', clip_source_video_id: 'v', global_offset_sec: null }))).toEqual([]);
  });

  it('rejects the hybrid', () => {
    expect(codes(row({ track: 'broll', type: 'clip', clip_source_video_id: 'v', global_offset_sec: 1 })))
      .toContain('broll_clip_hybrid');
  });

  it('rejects an interval that does not move forward', () => {
    expect(codes(row({ start_sec: 5, end_sec: 5 }))).toContain('empty_interval');
    expect(codes(row({ start_sec: 9, end_sec: 2 }))).toContain('empty_interval');
  });

  it('rejects times that are absent, negative, absurd, or not finite', () => {
    expect(codes(row({ start_sec: null }))).toContain('out_of_range');
    expect(codes(row({ start_sec: -1 }))).toContain('out_of_range');
    expect(codes(row({ end_sec: MAX_TIMELINE_SEC + 1 }))).toContain('out_of_range');
    expect(codes(row({ end_sec: Number.POSITIVE_INFINITY }))).toContain('out_of_range');
    expect(codes(row({ end_sec: Number.NaN }))).toContain('out_of_range');
    expect(codes(row({ track: 'broll', global_offset_sec: -0.5 }))).toContain('out_of_range');
  });

  it('rejects two clip sources on one row', () => {
    expect(codes(row({ type: 'clip', clip_source_video_id: 'v', clip_source_image_id: 'i' })))
      .toContain('multiple_clip_sources');
  });
});

describe('the partial-update rule: a write may not make a row worse', () => {
  const broken = row({ track: 'broll', type: 'broll', global_offset_sec: null });

  it('reports nothing when a pre-existing violation simply survives', () => {
    expect(newTimelineSectionViolations(broken, { ...broken, id: 'renamed' })).toEqual([]);
  });

  it('reports nothing when the write REPAIRS the row', () => {
    expect(newTimelineSectionViolations(broken, { ...broken, global_offset_sec: 12 })).toEqual([]);
  });

  it('reports a violation the write introduces', () => {
    const healthy = row({ track: 'broll', type: 'broll', global_offset_sec: 12 });
    expect(newTimelineSectionViolations(healthy, { ...healthy, clip_source_video_id: 'v' })
      .map((v) => v.code)).toEqual(['broll_clip_hybrid']);
  });

  it('reports a NEW violation even while an old one is still present', () => {
    expect(newTimelineSectionViolations(broken, { ...broken, start_sec: 9, end_sec: 2 })
      .map((v) => v.code)).toEqual(['empty_interval']);
  });
});
