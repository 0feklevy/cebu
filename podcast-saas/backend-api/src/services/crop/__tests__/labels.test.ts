/**
 * The label contract, tested against a file the annotator really wrote.
 *
 * `__fixtures__/annotator-roundtrip.labels.json` was not typed by hand. It came out of
 * `scripts/crop-eval/annotate.html` driven in a real Chromium — keyboard nudges, a marked cut, a
 * b-roll span, two ambiguous frames, a slow pan — and then through the tool's own re-import,
 * which reproduced it exactly. Keeping that artefact and scoring it here is what makes the
 * loader's claim checkable: the format is whatever the tool emits, not whatever this file wishes
 * it emitted.
 *
 * What this cannot catch, stated so nobody assumes otherwise: annotate.html carries its own copy
 * of the schema constant and its own validator, because a single self-contained HTML file cannot
 * import TypeScript. If someone edits the tool's copy and does not regenerate this fixture, the
 * drift is invisible here. Regenerating it is a browser run, documented in the crop-eval README.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLabelFile, labelFileIssues, labelHalfWidth, frameCount, toFrameLabel,
  LABEL_SCHEMA, LABEL_SAMPLE_FPS, type RawLabelFile,
} from '../eval/labels.js';
import { scoreClip, targetX, type Keyframe } from '../eval/metrics.js';
import { CROP_ASPECT } from '../cropProcessor.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../eval/__fixtures__/annotator-roundtrip.labels.json');

function raw(): RawLabelFile {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as RawLabelFile;
}

describe('crop label file', () => {
  it('loads what the annotator exported', () => {
    const f = raw();
    expect(labelFileIssues(f)).toEqual([]);

    const clip = parseLabelFile(f);
    expect(clip.id).toBe('annotator-roundtrip');
    expect(clip.labels).toHaveLength(frameCount(clip.durationSec, clip.sampleFps));
    expect(clip.sampleFps).toBe(LABEL_SAMPLE_FPS);
    expect(clip.confirmedFrames).toBe(clip.labels.length);
    expect(clip.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the tool copy of the schema and aspect, unchanged', () => {
    const f = raw();
    // A mismatch here means annotate.html and labels.ts have drifted, and every label file the
    // tool has written since is unreadable by the harness.
    expect(f.schema).toBe(LABEL_SCHEMA);
    expect(f.crop_aspect).toBe(CROP_ASPECT);
    expect(f.sample_fps).toBe(LABEL_SAMPLE_FPS);
  });

  it('records the cut the labeller marked, at a sampled time', () => {
    const f = raw();
    expect(f.cuts.length).toBeGreaterThan(0);
    for (const t of f.cuts) {
      expect(t * f.sample_fps).toBeCloseTo(Math.round(t * f.sample_fps), 9);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(f.duration_sec);
    }
    // The frame that starts a shot must not have inherited the previous shot's framing.
    const idx = Math.round(f.cuts[0] * f.sample_fps);
    expect(f.labels[idx].crop_x).not.toBeCloseTo(f.labels[idx - 1].crop_x, 3);
  });

  it('maps each subject state onto the branch of targetX it means', () => {
    const half = labelHalfWidth(1920, 1080);
    expect(targetX(toFrameLabel({ frame_idx: 0, t: 0, crop_x: 0.42, subject: 'subject', confirmed: true }), half))
      .toBeCloseTo(0.42, 9);
    // Nobody on screen: the centre is the only non-arbitrary answer, and the labelled x is ignored.
    expect(targetX(toFrameLabel({ frame_idx: 0, t: 0, crop_x: 0.42, subject: 'none', confirmed: true }), half))
      .toBe(0.5);
    // Undecidable: no target at all, so the frame leaves the accuracy denominator.
    expect(targetX(toFrameLabel({ frame_idx: 0, t: 0, crop_x: 0.42, subject: 'ambiguous', confirmed: true }), half))
      .toBeNull();
  });

  it('clamps a marker no 9:16 window can reach back to the clamp', () => {
    const half = labelHalfWidth(1920, 1080);
    expect(targetX(toFrameLabel({ frame_idx: 0, t: 0, crop_x: 0.99, subject: 'subject', confirmed: true }), half))
      .toBeCloseTo(1 - half, 9);
  });
});

describe('crop labels through the real scorer', () => {
  const f = raw();
  const clip = parseLabelFile(f);
  const half = labelHalfWidth(clip.width, clip.height);
  /** A track that agrees with the labeller on every frame that named a subject. */
  const perfect: Keyframe[] = f.labels.map((l) => ({ t: l.t, x: l.subject === 'none' ? 0.5 : l.crop_x }));

  it('scores a track that matches the labels perfectly', () => {
    const s = scoreClip(clip, perfect, half);
    const ambiguous = f.labels.filter((l) => l.subject === 'ambiguous').length;
    expect(ambiguous).toBeGreaterThan(0);
    expect(s.total_frames).toBe(f.labels.length);
    expect(s.scored_frames).toBe(f.labels.length - ambiguous);
    expect(s.m_iou).toBe(1);
    expect(s.iou_at_50).toBe(1);
    expect(s.out_of_frame).toBe(0);
  });

  it('reports attribution as not measurable rather than inventing a number', () => {
    // A crop-x label names one point, never a cast of faces, so "did it pick the right person"
    // has no ground truth here. Emitting 1.0 would be a lie that flatters every algorithm.
    const s = scoreClip(clip, perfect, half);
    expect(s.attribution).toBeNull();
    expect(s.attribution_frames).toBe(0);
  });

  it('punishes a track that follows the labelled x through the no-subject span', () => {
    // The b-roll frames were labelled with a carried-forward x, and the convention says the
    // centre is ground truth there. A crop that keeps tracking must score worse than one that
    // recentres — if it did not, the convention would be decorative.
    const naive: Keyframe[] = f.labels.map((l) => ({ t: l.t, x: l.crop_x }));
    const none = f.labels.filter((l) => l.subject === 'none');
    expect(none.length).toBeGreaterThan(0);
    expect(none.some((l) => Math.abs(l.crop_x - 0.5) > 0.05)).toBe(true);
    expect(scoreClip(clip, naive, half).m_iou).toBeLessThan(scoreClip(clip, perfect, half).m_iou);
  });

  it('beats the centre baseline on a clip that is not centred', () => {
    const centre: Keyframe[] = f.labels.map((l) => ({ t: l.t, x: 0.5 }));
    expect(scoreClip(clip, perfect, half).m_iou).toBeGreaterThan(scoreClip(clip, centre, half).m_iou);
  });

  it('flags a marker the crop window misses', () => {
    const off: Keyframe[] = f.labels.map((l) => ({ t: l.t, x: half }));
    const s = scoreClip(clip, off, half);
    expect(s.out_of_frame).toBeGreaterThan(0);
    expect(s.pinned_at_clamp).toBe(1);
  });
});

describe('crop label validator', () => {
  const mutate = (fn: (f: RawLabelFile) => void): string[] => {
    const f = raw();
    fn(f);
    return labelFileIssues(f);
  };

  it('rejects a file written against a different schema', () => {
    expect(mutate((f) => { f.schema = 'flowvid.crop-labels/0'; }).join()).toContain('schema');
  });

  it('rejects a frame count the declared duration cannot produce', () => {
    expect(mutate((f) => { f.labels.pop(); }).join()).toContain('needs 24');
  });

  it('rejects a reordered or renumbered frame', () => {
    expect(mutate((f) => { f.labels[3].frame_idx = 9; }).join()).toContain('labels[3].frame_idx');
    expect(mutate((f) => { f.labels[3].t = 99; }).join()).toContain('labels[3].t');
  });

  it('rejects a crop-x outside what a 9:16 window can reach', () => {
    // 0.05 would put the window off the left edge of the frame; no algorithm can be scored
    // against a target it is structurally unable to hit.
    expect(mutate((f) => { f.labels[2].crop_x = 0.05; }).join()).toContain('outside');
    expect(mutate((f) => { f.labels[2].crop_x = 0.5; }).join()).toEqual('');
  });

  it('rejects an unknown subject state', () => {
    expect(mutate((f) => { (f.labels[1] as { subject: string }).subject = 'maybe'; }).join())
      .toContain('subject: expected one of');
  });

  it('rejects cuts that are unsorted, off-grid, or outside the clip', () => {
    expect(mutate((f) => { f.cuts = [4, 2]; }).join()).toContain('does not come after');
    expect(mutate((f) => { f.cuts = [4.3]; }).join()).toContain('not a sampled time');
    expect(mutate((f) => { f.cuts = [99]; }).join()).toContain('outside (0,');
  });

  it('accepts a missing hash but not a malformed one', () => {
    expect(mutate((f) => { f.source.sha256 = null; })).toEqual([]);
    expect(mutate((f) => { f.source.sha256 = 'nope'; }).join()).toContain('sha256');
  });

  it('collects every problem instead of stopping at the first', () => {
    const issues = mutate((f) => { f.labels[1].crop_x = 2; f.labels[2].confirmed = 'yes' as never; });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('throws with all of them when loading', () => {
    const f = raw();
    f.clip_id = '';
    expect(() => parseLabelFile(f)).toThrow(/clip_id/);
  });

  it('rejects things that are not label files at all', () => {
    expect(labelFileIssues(null)).toEqual(['not a JSON object']);
    expect(labelFileIssues([])).toEqual(['not a JSON object']);
  });
});

describe('label geometry', () => {
  it('matches the window the crop pipeline actually produces', () => {
    expect(labelHalfWidth(1920, 1080)).toBeCloseTo(0.158203125, 9);
    expect(labelHalfWidth(1280, 720)).toBeCloseTo(0.158203125, 9);
  });

  it('gives a source that is already 9:16 or narrower the whole width', () => {
    // Exactly 9:16 — the window is the frame, and there is nothing left to label.
    expect(labelHalfWidth(1080, 1920)).toBe(0.5);
    // Taller than 9:16: without the clamp the window would be wider than the source, and every
    // crop-x would validate as out of range.
    expect(labelHalfWidth(1080, 2400)).toBe(0.5);
    // A square source is WIDER than 9:16, so a real choice remains.
    expect(labelHalfWidth(1080, 1080)).toBeCloseTo(0.28125, 9);
  });

  it('counts frames the way the annotator does', () => {
    expect(frameCount(12, 2)).toBe(24);
    expect(frameCount(0.1, 2)).toBe(1);
    // Every generated time must land inside the clip, or the labeller is asked about a frame
    // the video does not have.
    for (const d of [3.1, 7.49, 7.5, 12.99, 30.25]) {
      const n = frameCount(d, LABEL_SAMPLE_FPS);
      expect((n - 1) / LABEL_SAMPLE_FPS).toBeLessThan(d);
    }
  });
});
