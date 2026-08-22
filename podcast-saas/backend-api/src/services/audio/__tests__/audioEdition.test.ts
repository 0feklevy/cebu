/**
 * P3-B / A2.1 — the rules an audio edition is built from.
 *
 * These are separated from the ffmpeg call on purpose, and the reason shows up here: every one of
 * these decisions has a failure mode that is silent in a listening test of the first thirty
 * seconds and obvious twenty minutes in, which is where a driver actually is.
 */
import { describe, it, expect } from 'vitest';
import {
  concatCaptions,
  deriveChapters,
  editionRefusalReason,
  editionSourceHash,
  shiftVtt,
  totalDurationMs,
  type EditionSection,
  type EditionSegment,
} from '../audioEdition.js';

const seg = (audioKey: string, durationMs: number, captionsVtt?: string): EditionSegment =>
  ({ audioKey, durationMs, captionsVtt });

const sec = (startSec: number, endSec: number, label?: string | null, sortOrder = 0): EditionSection =>
  ({ startSec, endSec, label, sortOrder });

describe('chapters, for a screen that is dark', () => {
  it('turns labelled sections into contiguous chapters', () => {
    const ch = deriveChapters([sec(0, 60, 'Intro', 0), sec(60, 180, 'The middle', 1)], 180_000);
    expect(ch).toEqual([
      { startMs: 0, endMs: 60_000, title: 'Intro' },
      { startMs: 60_000, endMs: 180_000, title: 'The middle' },
    ]);
  });

  it('folds an UNLABELLED section into the chapter already playing', () => {
    // "Section 4" on a lock screen takes a slot in the skip order and tells the listener nothing.
    // Dropping it outright would be worse still: skipping would land in audio no chapter mentions.
    const ch = deriveChapters([sec(0, 60, 'Intro', 0), sec(60, 120, '', 1), sec(120, 180, 'End', 2)], 180_000);
    expect(ch.map((c) => c.title)).toEqual(['Intro', 'End']);
    // The unlabelled stretch belongs to Intro — it is not silently unreachable.
    expect(ch[0]).toEqual({ startMs: 0, endMs: 120_000, title: 'Intro' });
  });

  it('the first chapter always starts at zero', () => {
    // A listener pressing "previous" during the opening must land at the beginning, not at
    // whatever the first LABELLED section happened to be.
    const ch = deriveChapters([sec(30, 90, 'Later', 0)], 120_000);
    expect(ch[0].startMs).toBe(0);
  });

  it('never emits overlapping chapters, whatever the sections do', () => {
    // Nothing in the editor forbids overlapping sections, and overlapping chapters make
    // `nexttrack` ambiguous — the listener presses skip and cannot predict where they land.
    const ch = deriveChapters([sec(0, 100, 'A', 0), sec(50, 150, 'B', 1), sec(120, 200, 'C', 2)], 200_000);
    for (let i = 0; i < ch.length - 1; i++) {
      expect(ch[i].endMs, `chapter ${i} overruns the next`).toBe(ch[i + 1].startMs);
    }
  });

  it('drops a section that starts past the end of the audio', () => {
    // A section can outlive the media it labelled — the segment was deleted, the section was not.
    const ch = deriveChapters([sec(0, 60, 'Real', 0), sec(500, 600, 'Ghost', 1)], 120_000);
    expect(ch.map((c) => c.title)).toEqual(['Real']);
    expect(ch[0].endMs).toBe(120_000);
  });

  it('never emits a zero-length chapter', () => {
    // Two sections at the same instant would make a skip target the listener can never land on.
    //
    // The collision is deliberately NOT on the first chapter. Placed there, the start-at-zero
    // rule stretches it back to 0 and it stops being zero-length for an unrelated reason — so
    // deleting the collision guard survived, and the test looked like it was covering it.
    const ch = deriveChapters([sec(0, 10, 'Opening', 0), sec(20, 30, 'A', 1), sec(20, 40, 'B', 2)], 60_000);
    expect(ch.length, 'the colliding section became its own chapter').toBe(2);
    for (const c of ch) expect(c.endMs, `${c.title} has no duration`).toBeGreaterThan(c.startMs);
  });

  it('keeps the FIRST of two sections at the same instant, not the last', () => {
    // Which one survives is a real choice: the earlier row is the one the creator sees first in
    // the editor, so a chapter list naming the later one reads as the wrong title on the right
    // audio — indistinguishable, on a lock screen, from a broken chapter list.
    const ch = deriveChapters([sec(0, 10, 'Opening', 0), sec(20, 30, 'Kept', 1), sec(20, 40, 'Dropped', 2)], 60_000);
    expect(ch.map((c) => c.title)).toEqual(['Opening', 'Kept']);
  });

  it('returns nothing rather than something wrong when there is no audio', () => {
    expect(deriveChapters([sec(0, 60, 'Intro', 0)], 0)).toEqual([]);
  });

  it('orders by sort_order first, then by time', () => {
    const ch = deriveChapters([sec(60, 120, 'Second', 1), sec(0, 60, 'First', 0)], 120_000);
    expect(ch.map((c) => c.title)).toEqual(['First', 'Second']);
  });
});

describe('captions, once the segments are one file', () => {
  const VTT_A = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst line.\n';
  const VTT_B = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nSecond segment.\n';

  it('shifts every cue by the segment offset', () => {
    expect(shiftVtt('00:00:01.000 --> 00:00:03.500\nx', 60_000)).toContain('00:01:01.000 --> 00:01:03.500');
  });

  it('carries seconds into minutes and minutes into hours', () => {
    expect(shiftVtt('00:00:30.000 --> 00:00:31.000\nx', 3_600_000)).toContain('01:00:30.000 --> 01:00:31.000');
  });

  it('accepts the comma decimal separator some tools emit', () => {
    expect(shiftVtt('00:00:01,500 --> 00:00:02,000\nx', 1000)).toContain('00:00:02.500');
  });

  it('joins segments into one timeline with one header', () => {
    const out = concatCaptions([seg('a', 5_000, VTT_A), seg('b', 5_000, VTT_B)]);
    expect(out.match(/WEBVTT/g), 'more than one WEBVTT header').toHaveLength(1);
    expect(out).toContain('00:00:00.000 --> 00:00:02.000');
    // Segment B's cue at 1s lands at 6s, because A runs for 5.
    expect(out).toContain('00:00:06.000 --> 00:00:08.500');
  });

  it('a segment WITHOUT captions still advances the offset', () => {
    // The failure this prevents is the nastiest kind: captions perfectly correct up to the first
    // silent segment and wrong — by exactly that segment's length — for the whole rest of the
    // episode. Correct at the start is precisely where a listening test looks.
    const out = concatCaptions([seg('a', 5_000, VTT_A), seg('silent', 30_000), seg('c', 5_000, VTT_B)]);
    expect(out).toContain('00:00:36.000 --> 00:00:38.500');
  });

  it('returns nothing at all when no segment has captions', () => {
    // An empty VTT file that a player fetches and renders as an empty track is worse than a
    // missing one, which the player simply does not offer.
    expect(concatCaptions([seg('a', 1000), seg('b', 1000)])).toBe('');
  });
});

describe('the source hash decides whether regenerating costs anything', () => {
  const base = {
    language: null,
    segments: [seg('k1', 1000, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n')],
    sections: [sec(0, 1, 'Intro', 0)],
  };

  it('is stable for identical inputs', () => {
    expect(editionSourceHash(base)).toBe(editionSourceHash({ ...base }));
  });

  it.each([
    ['a different segment key', { segments: [seg('k2', 1000)] }],
    ['a different duration', { segments: [seg('k1', 2000)] }],
    ['different caption text', { segments: [seg('k1', 1000, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nbye\n')] }],
    ['a renamed section', { sections: [sec(0, 1, 'Opening', 0)] }],
    ['a moved section boundary', { sections: [sec(0, 2, 'Intro', 0)] }],
    ['a different language', { language: 'he' }],
  ])('changes when %s changes', (_what, patch) => {
    expect(editionSourceHash({ ...base, ...patch } as never)).not.toBe(editionSourceHash(base));
  });

  it('does NOT change when segment order is preserved but sections are merely re-listed', () => {
    // Sections have no inherent order in the query; sorting before hashing means a row-order
    // change from the database cannot force a rebuild of an artifact that would be identical.
    const shuffled = { ...base, sections: [sec(1, 2, 'Two', 1), sec(0, 1, 'Intro', 0)] };
    const same = { ...base, sections: [sec(0, 1, 'Intro', 0), sec(1, 2, 'Two', 1)] };
    expect(editionSourceHash(shuffled)).toBe(editionSourceHash(same));
  });

  it('DOES change when the segments are reordered', () => {
    // Segment order is the episode. Sorting these too would let a re-ordered lesson reuse the
    // previous edition, which plays the chapters in the wrong sequence and sounds like a bug in
    // the player rather than a stale artifact.
    const a = { ...base, segments: [seg('k1', 1000), seg('k2', 1000)] };
    const b = { ...base, segments: [seg('k2', 1000), seg('k1', 1000)] };
    expect(editionSourceHash(a)).not.toBe(editionSourceHash(b));
  });

  it('the source edition and a dub are never the same artifact', () => {
    // `/{slug}/audio` and `/{slug}/he/audio` are links a listener can hold at the same time.
    expect(editionSourceHash({ ...base, language: null })).not.toBe(editionSourceHash({ ...base, language: 'he' }));
  });
});

describe('refusing, with a reason the creator can act on', () => {
  it('explains an empty project', () => {
    expect(editionRefusalReason([])).toMatch(/no media/i);
  });

  it('explains a project whose segments have no audio yet', () => {
    expect(editionRefusalReason([seg('', 0), seg('', 0)])).toMatch(/playable audio/i);
  });

  it('allows a project that is only PART-WAY through transcoding', () => {
    // Refusing here would make a project permanently un-derivable for a transient reason, and the
    // edition costs one cheap ffmpeg pass to rebuild once the rest lands.
    expect(editionRefusalReason([seg('k1', 1000), seg('', 0)])).toBeNull();
  });
});

describe('duration', () => {
  it('sums the segments', () => {
    expect(totalDurationMs([seg('a', 1000), seg('b', 2500)])).toBe(3500);
  });

  it('ignores a negative duration rather than shortening the episode', () => {
    expect(totalDurationMs([seg('a', 1000), seg('b', -500)])).toBe(1000);
  });
});
