/**
 * Boundary math for recutting one line out of a multi-line synthesis chunk.
 *
 * v3's voice_segments timestamps are imprecise in a KNOWN direction: end_time
 * routinely UNDERSHOOTS (trailing consonants/decay land after it) and everything
 * drifts a few 10s of ms vs the decoded mp3. The old symmetric-ish guards caused
 * the classic glitch pair: line N's real tail fell outside its slice (tail guard
 * too tight) and line N+1's head guard reached back far enough to capture that
 * orphaned tail — whose leading-silence trim then made it the audible START of
 * the next block. ("The section end is cut and plays as the next section's
 * start.")
 *
 * Rules that kill both failure modes structurally:
 *   1. EXCLUSIVE allocation — a slice may never start before the previous slice's
 *      chosen end. No sample can belong to two clips → the "tail replays on the
 *      next block" glitch is impossible by construction.
 *   2. Generous TAIL (0.30s, midpoint-clamped) — claims the real decay; any dead
 *      air it drags in is removed by the edge silence-trim.
 *   3. Tight HEAD (0.10s) — word onsets are sharp; a big reach-back is exactly
 *      what grabbed the neighbor's tail.
 */

export const HEAD_GUARD_SEC = 0.10;
export const TAIL_GUARD_SEC = 0.30;
export const CUTOFF_TAIL_SHAVE_SEC = 0.1;
const MIN_SLICE_SEC = 0.15;

export interface ClipBoundsInput {
  segStart: number;       // reported segment start (sec)
  segEnd: number;         // reported segment end (sec)
  prevSegEnd: number;     // previous segment's reported end (0 if none)
  nextSegStart: number;   // next segment's reported start (chunk duration if none)
  prevChosenEnd: number;  // the END actually chosen for the previous slice (0 if none)
  chunkDur: number;       // decoded chunk duration (sec)
  isCutOff?: boolean;     // scripted "—" line: shave the tail (v3 stutter zone)
}

export interface ClipBounds { start: number; end: number }

export function computeClipBounds(b: ClipBoundsInput): ClipBounds {
  const tailAdj = b.isCutOff ? -CUTOFF_TAIL_SHAVE_SEC : TAIL_GUARD_SEC;

  // Head: reach a little before the reported start (mp3 drift), but never past the
  // midpoint of the inter-line gap (only when a previous line exists), and NEVER
  // before the previous slice's chosen end — exclusivity is what makes the
  // double-play glitch impossible.
  const midHead = b.prevSegEnd > 0 ? (b.prevSegEnd + b.segStart) / 2 : 0;
  let start = Math.max(midHead, b.segStart - HEAD_GUARD_SEC, 0);
  start = Math.max(start, b.prevChosenEnd);

  // Tail: claim generously into the following dead air (midpoint-clamped) so the
  // real decay stays in THIS clip; the edge silence-trim removes the excess.
  let end = Math.min((b.segEnd + b.nextSegStart) / 2, b.segEnd + tailAdj, b.chunkDur);
  end = Math.max(end, Math.min(start + MIN_SLICE_SEC, b.chunkDur)); // never collapse

  return { start, end };
}
