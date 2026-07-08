import { describe, it, expect } from 'vitest';
import { computeClipBounds, segmentsAligned, HEAD_GUARD_SEC, TAIL_GUARD_SEC } from '../clipBounds.js';

describe('segmentsAligned', () => {
  // The real chunk that shipped corrupt: 3 inputs of 226 / 155 / 46 chars.
  const lens = [226, 155, 46];

  it('accepts a correctly-positioned segmentation', () => {
    const segs = [
      { dialogue_input_index: 0, character_start_index: 0 },
      { dialogue_input_index: 1, character_start_index: 226 },
      { dialogue_input_index: 2, character_start_index: 381 },
    ];
    expect(segmentsAligned(segs, lens, 0, 3)).toBe(true);
  });

  it('REJECTS the scrambled segmentation that caused the 12s-clip / lanes overlap', () => {
    // v3 returned 3 segments but positioned wrong: input 1 & 2 char-starts are far
    // from where their text actually begins → recut slices land on the wrong audio.
    const segs = [
      { dialogue_input_index: 0, character_start_index: 0 },
      { dialogue_input_index: 1, character_start_index: 12 },   // should be ~226
      { dialogue_input_index: 2, character_start_index: 40 },   // should be ~381
    ];
    expect(segmentsAligned(segs, lens, 0, 3)).toBe(false);
  });

  it('rejects a missing segment', () => {
    const segs = [
      { dialogue_input_index: 0, character_start_index: 0 },
      { dialogue_input_index: 2, character_start_index: 381 },
    ];
    expect(segmentsAligned(segs, lens, 0, 3)).toBe(false);
  });

  it('honors the context offset (context inputs precede the real turns)', () => {
    const withCtx = [180, 226, 155]; // input 0 is context, 1 & 2 are real
    const segs = [
      { dialogue_input_index: 0, character_start_index: 0 },
      { dialogue_input_index: 1, character_start_index: 180 },
      { dialogue_input_index: 2, character_start_index: 406 },
    ];
    expect(segmentsAligned(segs, withCtx, 1, 2)).toBe(true);
  });

  it('tolerates small tag/whitespace drift', () => {
    const segs = [
      { dialogue_input_index: 0, character_start_index: 3 },
      { dialogue_input_index: 1, character_start_index: 232 },
      { dialogue_input_index: 2, character_start_index: 379 },
    ];
    expect(segmentsAligned(segs, lens, 0, 3)).toBe(true);
  });
});

describe('computeClipBounds', () => {
  it('REGRESSION — the reported glitch: a late real tail must belong to clip N, never to clip N+1', () => {
    // v3 reports line N ending at 5.0s, but the real audio decays until ~5.25s.
    // Line N+1 is reported at 5.6s. Old math: N ended at 5.08 (tail cut), N+1
    // started at 5.30 (midpoint) → the 5.08–5.30 real tail leaked into N+1 and
    // played as its start. New math must (a) give N its tail, (b) start N+1 at
    // or after N's chosen end.
    const n = computeClipBounds({ segStart: 1.0, segEnd: 5.0, prevSegEnd: 0, nextSegStart: 5.6, prevChosenEnd: 0, chunkDur: 10 });
    expect(n.end).toBeGreaterThanOrEqual(5.25);                 // real decay stays inside N
    const n1 = computeClipBounds({ segStart: 5.6, segEnd: 8.0, prevSegEnd: 5.0, nextSegStart: 10, prevChosenEnd: n.end, chunkDur: 10 });
    expect(n1.start).toBeGreaterThanOrEqual(n.end);             // EXCLUSIVE — no sample in two clips
  });

  it('slices never overlap across a whole chunk (exclusivity invariant)', () => {
    const segs = [
      { s: 0.2, e: 2.0 }, { s: 2.3, e: 4.1 }, { s: 4.15, e: 6.0 }, { s: 6.9, e: 9.4 },
    ];
    let prevChosenEnd = 0;
    let prevEndReported = 0;
    const out: { start: number; end: number }[] = [];
    segs.forEach((seg, i) => {
      const b = computeClipBounds({
        segStart: seg.s, segEnd: seg.e,
        prevSegEnd: prevEndReported,
        nextSegStart: segs[i + 1]?.s ?? 10,
        prevChosenEnd, chunkDur: 10,
      });
      out.push(b);
      prevChosenEnd = b.end;
      prevEndReported = seg.e;
    });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
    }
  });

  it('claims a generous tail into following dead air, clamped at the midpoint', () => {
    // Big gap after the line: tail extends by the full guard.
    const wide = computeClipBounds({ segStart: 1, segEnd: 3, prevSegEnd: 0, nextSegStart: 5, prevChosenEnd: 0, chunkDur: 10 });
    expect(wide.end).toBeCloseTo(3 + TAIL_GUARD_SEC, 5);
    // Tight gap: clamped at the midpoint so it can't reach the next line's words.
    const tight = computeClipBounds({ segStart: 1, segEnd: 3, prevSegEnd: 0, nextSegStart: 3.2, prevChosenEnd: 0, chunkDur: 10 });
    expect(tight.end).toBeCloseTo(3.1, 5);
  });

  it('keeps the head reach small and midpoint-clamped', () => {
    const b = computeClipBounds({ segStart: 5, segEnd: 8, prevSegEnd: 4.95, nextSegStart: 10, prevChosenEnd: 0, chunkDur: 10 });
    expect(b.start).toBeGreaterThanOrEqual(4.975 - 1e-9);       // midpoint clamp
    const b2 = computeClipBounds({ segStart: 5, segEnd: 8, prevSegEnd: 2, nextSegStart: 10, prevChosenEnd: 0, chunkDur: 10 });
    expect(b2.start).toBeCloseTo(5 - HEAD_GUARD_SEC, 5);        // full (small) guard when far
  });

  it('cut-off lines get their tail SHAVED (v3 stutter zone), not extended', () => {
    const b = computeClipBounds({ segStart: 1, segEnd: 4, prevSegEnd: 0, nextSegStart: 8, prevChosenEnd: 0, chunkDur: 10, isCutOff: true });
    expect(b.end).toBeLessThan(4);
  });

  it('never collapses a slice below the minimum, never exceeds the chunk', () => {
    const b = computeClipBounds({ segStart: 9.9, segEnd: 9.95, prevSegEnd: 9.5, nextSegStart: 10, prevChosenEnd: 9.9, chunkDur: 10 });
    expect(b.end).toBeLessThanOrEqual(10);
    expect(b.end).toBeGreaterThan(b.start);
  });

  it('first line of a chunk starts at 0 when the segment starts near 0', () => {
    const b = computeClipBounds({ segStart: 0.05, segEnd: 2, prevSegEnd: 0, nextSegStart: 3, prevChosenEnd: 0, chunkDur: 10 });
    expect(b.start).toBe(0);
  });
});
