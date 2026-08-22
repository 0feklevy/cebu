/**
 * WHICH OVERLAY IS ON TOP — one rule, for the viewer and the export both.
 *
 * ── The defect this exists to end (broll-player-002 / broll-data-008) ─────────────────────────
 * Overlapping overlays are possible (no constraint has ever prevented them) and the two surfaces
 * that have to choose a winner each invented their own answer:
 *
 *   viewer  `[...broll_clips, ...clip_overlays].find(...)` — FIRST match in array order, with no
 *           notion of layer or time at all. A `clip_overlay` could therefore never beat a
 *           `broll_clip`, however much later it started.
 *   export  layer priority, then the LATER start, then the higher array index.
 *
 * Those disagree on both tiebreaks, and on one of them they are exact opposites. The consequence is
 * the worst kind: **what the author previews is not what the exported master contains**, silently,
 * with the export even emitting a warning promising that "the viewer's stacking order decides" —
 * a stacking order the viewer did not have.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 *   1. LAYER CLASS. A simulation/poster covers an image covers a clip covers the base video.
 *   2. THE LATER START WINS. Two overlays of the same class: the one that started more recently is
 *      the one the author most recently put there. This is the export's existing rule and it is the
 *      intuitive one — a new clip dropped on top of an old one shows.
 *   3. STABLE ID. A genuine tie in class AND start needs *a* deterministic answer, and it must be
 *      the SAME answer on both sides. Array position is not that — the two surfaces build different
 *      arrays — so the tiebreak is the section id, which both already carry and neither can reorder.
 *
 * Deliberately domain-agnostic on `start`: the export ranks in frames, the viewer in seconds, and
 * the comparison is identical either way. Making callers convert would be a second place to get it
 * wrong.
 */

/**
 * Layer classes, higher is nearer the viewer.
 *
 * These are the export's existing `LAYER_PRIORITY` values, moved rather than re-chosen, so this
 * module cannot silently restack anything that already ships.
 */
export const OVERLAY_LAYER = {
  /** A live simulation, or the poster standing in for one. */
  sim: 3,
  image: 2,
  /** B-roll and clip overlays — one class, which is exactly what the viewer got wrong. */
  clip: 1,
  /** The main video. Never an overlay; present so the base can be ranked by the same function. */
  base: 0,
} as const;

export type OverlayLayer = (typeof OVERLAY_LAYER)[keyof typeof OVERLAY_LAYER];

/** The three fields the stacking rule reads. `start`/`end` may be in any consistent unit. */
export interface StackRank {
  layer: number;
  start: number;
  end: number;
  /** Stable identity — the final tiebreak. Must be the same string both surfaces know the row by. */
  id: string;
}

/**
 * Does `candidate` sit above `incumbent`?
 *
 * Strict: an identical rank returns false, so a sweep that starts from the first element and only
 * replaces on `true` is stable and order-independent.
 */
export function stacksAbove(candidate: StackRank, incumbent: StackRank): boolean {
  if (candidate.layer !== incumbent.layer) return candidate.layer > incumbent.layer;
  if (candidate.start !== incumbent.start) return candidate.start > incumbent.start;
  return candidate.id > incumbent.id;
}

/** Half-open containment, `[start, end)` — the convention every timeline reader here uses. */
export function coversPoint(r: StackRank, at: number): boolean {
  return at >= r.start && at < r.end;
}

/**
 * The overlay visible at `at`, or null when none covers it.
 *
 * Independent of the order of `overlays`, which is the property that makes viewer and export agree
 * even though they assemble their lists differently.
 */
export function topmostAt<T extends StackRank>(overlays: readonly T[], at: number): T | null {
  let winner: T | null = null;
  for (const o of overlays) {
    if (!coversPoint(o, at)) continue;
    if (winner === null || stacksAbove(o, winner)) winner = o;
  }
  return winner;
}

/**
 * The first pair of overlays that overlap, or null when none do.
 *
 * Used by the writer to REFUSE creating an overlap, and by the export to warn about ones that
 * already exist. Returns the pair rather than a boolean so the caller can name both rows.
 */
export function firstOverlappingPair<T extends StackRank>(
  overlays: readonly T[],
): readonly [T, T] | null {
  for (let i = 0; i < overlays.length; i++) {
    for (let j = i + 1; j < overlays.length; j++) {
      const a = overlays[i]!;
      const b = overlays[j]!;
      if (a.start < b.end && b.start < a.end) return [a, b];
    }
  }
  return null;
}
