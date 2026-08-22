/**
 * P0.3 — what a crop number measured on real footage is allowed to claim.
 *
 * This module produces the only figure the P2.8 go/no-go may quote, so every test here is about a
 * way of being CONFIDENTLY wrong. A refused clip costs the owner a re-label; a clip averaged in
 * when it should have been refused produces a precise, reproducible, meaningless number that ends
 * the argument it should have started.
 *
 * The project has made exactly that mistake before, which is why the fixtures file carries a
 * header warning: synthetic-fixture scores have been quoted as field accuracy.
 */
import { describe, it, expect } from 'vitest';
import { admitClips, fieldVerdict, MIN_QUOTABLE_CLIPS, type FieldClip } from '../fieldEval.js';
import type { LabelledClip } from '../labels.js';

const clip = (over: Partial<LabelledClip> = {}): LabelledClip => ({
  id: 'c1',
  category: 'talking-head',
  width: 1920,
  height: 1080,
  durationSec: 10,
  sampleFps: 2,
  cuts: [],
  labels: Array.from({ length: 20 }, (_, i) => ({ t: i / 2, x: 0.5 }) as never),
  source: { file: 'c1.mp4', sha256: 'abc', bytes: 100 },
  confirmedFrames: 20,
  ...over,
});

const field = (over: Partial<FieldClip> = {}): FieldClip => ({
  clip: clip(),
  videoPath: '/tmp/c1.mp4',
  actualSha256: 'abc',
  ...over,
});

describe('which labelled clips may be scored at all', () => {
  it('admits a complete clip whose video matches', () => {
    const { admitted, refused } = admitClips([field()]);
    expect(admitted).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it('refuses a clip whose video is MISSING', () => {
    const { admitted, refused } = admitClips([field({ videoPath: null })]);
    expect(admitted).toEqual([]);
    expect(refused[0].code).toBe('no_video');
  });

  it('refuses a clip whose video is not the one that was labelled', () => {
    // The dangerous one. The pipeline runs happily against a DIFFERENT video and every frame is
    // compared to ground truth for footage it never saw — a score that is precise, reproducible
    // and meaningless. Nothing about the run looks wrong.
    const { admitted, refused } = admitClips([field({ actualSha256: 'a-different-file' })]);
    expect(admitted).toEqual([]);
    expect(refused[0].code).toBe('sha_mismatch');
    expect(refused[0].reason).toMatch(/never saw/);
  });

  it('admits a clip labelled BEFORE hashes were recorded', () => {
    // A label file with no hash is older than the field, not falsified. Refusing it would discard
    // honest work for a missing column rather than a wrong one.
    const noHash = field({ clip: clip({ source: { file: 'c1.mp4', sha256: null, bytes: 100 } }) });
    expect(admitClips([noHash]).admitted).toHaveLength(1);
  });

  it('refuses an UNFINISHED label file', () => {
    // The tool carries the previous frame's value forward as the next frame's default — which is
    // what makes a static shot quick to label, and what makes an abandoned file look complete.
    // `confirmedFrames` is the only count of what a human actually looked at.
    const { admitted, refused } = admitClips([field({ clip: clip({ confirmedFrames: 11 }) })]);
    expect(admitted).toEqual([]);
    expect(refused[0].code).toBe('unfinished');
    expect(refused[0].reason, 'the refusal does not say how much is missing').toMatch(/11 of 20/);
  });

  it('refuses an empty label file', () => {
    expect(admitClips([field({ clip: clip({ labels: [], confirmedFrames: 0 }) })]).refused[0].code).toBe('no_labels');
  });

  it('refuses a clip with no duration', () => {
    expect(admitClips([field({ clip: clip({ durationSec: 0 }) })]).refused[0].code).toBe('zero_duration');
  });

  it('reports every refusal rather than stopping at the first', () => {
    // A run that stops at the first bad file makes the owner fix them one at a time, re-running a
    // full pipeline pass between each.
    //
    // A GOOD CLIP SITS LAST, and each refusal kind sits before it. The first version of this test
    // put every refusal at the end, so replacing a `continue` with a `break` changed nothing and
    // survived as a mutation — the test asserted the right set for the wrong reason.
    const { admitted, refused } = admitClips([
      field({ clip: clip({ id: 'c1' }), actualSha256: 'other' }),
      field({ clip: clip({ id: 'c2' }), videoPath: null }),
      field({ clip: clip({ id: 'c3', confirmedFrames: 1 }) }),
      field({ clip: clip({ id: 'c4', labels: [], confirmedFrames: 0 }) }),
      field({ clip: clip({ id: 'good' }) }),
    ]);
    expect(refused.map((r) => r.code).sort()).toEqual(['no_labels', 'no_video', 'sha_mismatch', 'unfinished']);
    // The clip AFTER four refusals is still scored. A loop that gave up on the first bad file
    // would make the owner fix them one at a time, re-running a full pipeline pass between each.
    expect(admitted.map((a) => a.clip.id), 'a valid clip after a refusal was dropped').toEqual(['good']);
  });

  it('names the clip in every refusal, so it can be found and relabelled', () => {
    const { refused } = admitClips([field({ clip: clip({ id: 'lesson-14' }), videoPath: null })]);
    expect(refused[0].clipId).toBe('lesson-14');
  });
});

describe('what a field number is allowed to claim', () => {
  it('refuses to be quoted with no clips at all', () => {
    // The vacuous result. A report that prints an aggregate over zero clips is a report someone
    // will screenshot.
    const v = fieldVerdict(0, 0);
    expect(v.quotable).toBe(false);
    expect(v.caveat).toMatch(/NO CLIPS SCORED/);
    expect(v.caveat).toMatch(/no measurement/i);
  });

  it('says so when every clip was REFUSED, not merely absent', () => {
    // "No labels yet" and "all your labels were rejected" need different reactions from the owner,
    // and a report that renders them identically sends them looking in the wrong place.
    expect(fieldVerdict(0, 7).caveat).toMatch(/All 7 label file\(s\) were refused/);
  });

  it('marks a thin sample PROVISIONAL rather than silently treating it as a result', () => {
    const v = fieldVerdict(MIN_QUOTABLE_CLIPS - 1, 0);
    expect(v.quotable).toBe(false);
    expect(v.caveat).toMatch(/PROVISIONAL/);
    expect(v.caveat).toMatch(/single-digit samples/);
  });

  it('becomes quotable at the threshold', () => {
    expect(fieldVerdict(MIN_QUOTABLE_CLIPS, 0).quotable).toBe(true);
  });

  it('ALWAYS carries a caveat line, even when quotable', () => {
    // A report with no caveat is one whose limits a reader has to reconstruct — and the single
    // most repeated mistake in this project's crop history is a synthetic-fixture score being
    // quoted as field accuracy.
    const v = fieldVerdict(30, 0);
    expect(v.caveat.trim().length).toBeGreaterThan(0);
    expect(v.caveat).toMatch(/hand-labelled/);
  });

  it('surfaces the refusal count even in a quotable report', () => {
    // Thirty scored and twenty refused is a different fact from thirty scored and none refused.
    expect(fieldVerdict(30, 20).caveat).toMatch(/20 refused/);
  });
});
