import type { PlayerConfig } from './types';

/**
 * D-13 — how a freshly fetched config becomes the session's next revision.
 *
 * A pure module on purpose. The rule it encodes has two failure modes that only show up as
 * *viewer-visible* bugs (wiped captions; a correction that never lands), and both are decided
 * entirely by object identity — which is exactly the kind of thing a rendering test observes
 * indirectly and a unit test observes head-on.
 */

/**
 * The four flat-overlay lanes, and the whole of what a freshness poll is allowed to change.
 *
 * They are a BUNDLE: `useProjectPlayer` promotes them together, at a shot boundary, through
 * `commitOverlayConfig` (broll-player-001). Handing the player three of the four would let the
 * b-roll schedule and the audio-cutaway schedule describe different edits of the same lecture.
 */
const OVERLAY_LANES = ['broll_clips', 'clip_overlays', 'image_overlays', 'audio_cutaways'] as const;
type OverlayLane = (typeof OVERLAY_LANES)[number];

/** Structural equality by serialization — the payload is JSON off the wire, so this is exact. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function overlaysDiffer(prev: PlayerConfig, next: PlayerConfig): boolean {
  return OVERLAY_LANES.some((lane: OverlayLane) => !sameJson(prev[lane], next[lane]));
}

/** Everything that is NOT an overlay lane — segments, branching, the sim switches, titles. */
function structureDiffers(prev: PlayerConfig, next: PlayerConfig): boolean {
  const strip = (c: PlayerConfig) => {
    const rest = { ...c } as Record<string, unknown>;
    for (const lane of OVERLAY_LANES) delete rest[lane];
    return rest;
  };
  return !sameJson(strip(prev), strip(next));
}

/**
 * Fold a freshly fetched config into the one the session is already playing.
 *
 * THE RETURN VALUE'S IDENTITY IS THE CONTRACT, not just its contents:
 *
 *  - **Nothing changed → the SAME object back.** The caller passes this straight to `setConfig`,
 *    and React bails out of the re-render when the state is identical. This is the
 *    diff-before-setState guard the ruling calls mandatory: a `304` covers the common case, but a
 *    rebuilt-but-identical payload (the server micro-cache expired and the build ran again) still
 *    arrives as a 200, and without this guard that 200 would be indistinguishable from an edit.
 *
 *  - **Only overlays changed → a new object carrying the overlay BUNDLE, and `prev.segments` by
 *    reference.** `HLSPlayerShell` resets caption state on `config.segments` *identity*
 *    (`useEffect(..., [config.project_id, config.segments])`), so a poll that handed back an
 *    equal-but-fresh `segments` array would wipe the viewer's captions once a minute — and would
 *    wipe them *exactly when the real correction arrived*, which is the verified regression that
 *    blocked the naive "just keep polling" fix. Preserving the reference is what makes an
 *    editorial correction invisible to caption state.
 *
 *  - **Structure changed → the new config, but still reusing `prev.segments` when the segments
 *    themselves are unchanged.** This is the still-transcoding path, whose delivery predates D-13
 *    and must keep working: a segment that gains an `hls_url` genuinely IS new segment data and
 *    goes through untouched. A change confined to anything else no longer costs the captions —
 *    and that half is not hypothetical. `sim_prepare_budget_ms` is a fleet p90 that
 *    `buildPlayerConfig` recomputes from accumulating RUM rows, so a project with simulations
 *    drifts its own payload with no editorial change at all. Without this clause every such drift
 *    would turn a viewer's captions off. (The player reads that budget once into a ref at mount,
 *    so the drift itself is inert for playback.)
 *
 * `prev === null` (first delivery) returns `next` verbatim — a session with no config has no
 * identity to preserve and nothing to diff against.
 */
export function applyConfigRevision(prev: PlayerConfig | null, next: PlayerConfig): PlayerConfig {
  if (!prev) return next;

  // A different project in the same mounted page is a new session, not a revision of this one.
  if (prev.project_id !== next.project_id) return next;

  const structural = structureDiffers(prev, next);
  const overlays = overlaysDiffer(prev, next);

  if (!structural && !overlays) return prev;

  if (!structural) {
    return {
      ...prev,
      broll_clips:    next.broll_clips,
      clip_overlays:  next.clip_overlays,
      image_overlays: next.image_overlays,
      audio_cutaways: next.audio_cutaways,
    };
  }

  return sameJson(prev.segments, next.segments)
    ? { ...next, segments: prev.segments }
    : next;
}

/** Base freshness interval. 60s is the ruling's number: this is "the creator fixed a mistake". */
export const FRESHNESS_INTERVAL_MS = 60_000;
/** Plus or minus 25%, so a lecture's audience does not revalidate in lockstep. */
const FRESHNESS_JITTER_RATIO = 0.25;

/**
 * The next poll delay: `FRESHNESS_INTERVAL_MS` scaled by a random factor in [0.75, 1.25].
 *
 * The jitter is not cosmetic. Viewers of one lecture tend to arrive together (a link goes out, a
 * class starts), so an unjittered interval reconvenes them into a synchronised burst every 60s
 * against the host D-12 already identified as the scaling constraint. Spreading them turns that
 * burst into a flat rate.
 *
 * `random` is injected so the spread is testable rather than asserted.
 */
export function nextFreshnessDelayMs(random: () => number = Math.random): number {
  const spread = (random() * 2 - 1) * FRESHNESS_JITTER_RATIO;
  return Math.round(FRESHNESS_INTERVAL_MS * (1 + spread));
}
