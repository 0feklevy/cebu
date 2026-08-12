/**
 * Which timeline section is at the playhead — and the boundary tolerance that decides it.
 *
 * Section intervals are laid out from STORED durations (`video_files.duration_sec`) while the
 * playhead comes from the media element's own clock. The two disagree by a few tens of
 * milliseconds routinely — a transcode's real duration is never exactly the stored one — so a
 * predicate that treats interval ends as exact is wrong at exactly one instant: the last one.
 *
 * The viewer has always applied a tolerance for this. `useProjectPlayer` uses the same 0.05 s
 * everywhere it compares a media time to a section edge: seeding the pool when the timeline OPENS
 * on a simulation (`start_sec <= 0.05`), classifying a POST-ROLL simulation
 * (`start_sec >= segmentDuration - 0.05`), reconciling a measured duration against the stored one
 * (`Math.abs(v.duration - stored) < 0.05`), and — the case this module exists for — its `onEnded`
 * handler, which snaps into a section the media end lands in (`seg.duration >= s.start_sec - 0.05`)
 * instead of leaving a post-roll simulation permanently unreachable.
 *
 * The EDITOR had no such tolerance, so a post-roll simulation could never be active at the final
 * instant: `useEditorPlayback.onEnded` parks the playhead exactly on the last clip's end, and
 * `playheadSec < end` is false there (audit §9.6). This module is the one constant and the one
 * predicate both surfaces use — a second epsilon, defined somewhere else with its own value, is
 * how the two clocks drift apart again.
 */

/**
 * Media/timeline slop, in seconds. 50 ms: comfortably longer than the stored-vs-measured duration
 * drift and than one `timeupdate` interval (~4-10 Hz), and far shorter than any section a human
 * would author, so it can never reach into a neighbouring section's interior.
 */
export const SECTION_BOUNDARY_EPSILON_SEC = 0.05;

/** A section's position on the global timeline, in seconds. */
export interface SectionBounds {
  start: number;
  end: number;
}

/**
 * The ONE section active at `playheadSec`, or null.
 *
 * Two passes, and the order is the whole safety argument:
 *
 *   1. EXACT containment `[start, end)` — unchanged from the predicate this replaces. Adjacent
 *      sections meet at a shared edge (`A.end === B.start`), and the incoming section owns it, so
 *      a boundary between two touching sections still resolves to exactly one of them and the
 *      widened bounds below are never even consulted there.
 *   2. Only if nothing contained the playhead, the TOLERANT pass — and only for a section that
 *      runs to the end of the timeline. That restriction is what keeps this from turning a
 *      mid-timeline gap edge into a moment where a just-ended section and a just-started one are
 *      both "active" (they live in separate lists here — sim, clip, image, b-roll — so nothing
 *      else would catch it). It is also faithful to the viewer, whose tolerance likewise applies
 *      only at the end of the media, in `onEnded`.
 *
 * The tolerance is applied to BOTH edges, for the two halves of the same defect: a post-roll
 * section that ENDS at the timeline end stays active at the final instant, and one that STARTS
 * there becomes reachable even though the media stops a few milliseconds short of the stored
 * duration it was laid out against.
 */
export function sectionAtPlayhead<T>(
  sections: readonly T[],
  playheadSec: number,
  boundsOf: (section: T) => SectionBounds,
  timelineEndSec: number,
): T | null {
  for (const section of sections) {
    const { start, end } = boundsOf(section);
    if (playheadSec >= start && playheadSec < end) return section;
  }

  const eps = SECTION_BOUNDARY_EPSILON_SEC;
  for (const section of sections) {
    const { start, end } = boundsOf(section);
    if (end < timelineEndSec - eps) continue;   // not the timeline's final section — no tolerance
    if (playheadSec >= start - eps && playheadSec < end + eps) return section;
  }

  return null;
}
