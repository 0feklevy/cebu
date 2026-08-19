/**
 * Readiness decisions for a project whose videos may still be transcoding.
 *
 * This module exists because the first version of this fix put the rule in a comment and the
 * test asserted the comment. `ViewerPage` said "playback still STARTS on the first ready
 * segment"; the player starts at index 0 unconditionally (`useProjectPlayer` seeds
 * `currentSegIdx: 0` and attaches `segmentsRef.current[0]`). The sentence was simply untrue, and
 * because the test read the SOURCE TEXT rather than the behaviour, nothing caught it.
 *
 * So the rule lives here, as pure functions with no React and no DOM, and both viewer surfaces
 * and the tests call THESE. A test can no longer agree with a comment while the code does
 * something else.
 */

import type { PlayerConfig, PlayerSegment } from './types';

/** Can this segment be handed to the player right now? */
export function isPlayableSegment(seg: Pick<PlayerSegment, 'hls_url' | 'hls_status' | 'fallback_url'> | null | undefined): boolean {
  if (!seg) return false;
  return seg.hls_status === 'ready' || Boolean(seg.fallback_url) || Boolean(seg.hls_url);
}

/**
 * Can this segment still change? `failed` counts as resolved: it will never become ready, so
 * polling for it forever is pointless — but it is NOT playable, which is what lets the player
 * surface the failure instead of hanging on it.
 */
export function isResolvedSegment(seg: Pick<PlayerSegment, 'hls_status' | 'fallback_url'> | null | undefined): boolean {
  if (!seg) return true;
  return seg.hls_status === 'ready' || seg.hls_status === 'failed' || Boolean(seg.fallback_url);
}

/**
 * The segment playback will actually attach first.
 *
 * Mirrors `useProjectPlayer`'s own entry resolution exactly: for a branching project the entry
 * sequence (by id, else the first sequence), otherwise the flat segment list — and then index 0
 * of whichever that is. This is the segment whose readiness decides whether the viewer sees a
 * video or a dead player, and it is NOT "any ready segment".
 */
export function entrySegmentOf(config: Pick<PlayerConfig, 'segments' | 'branching'> | null | undefined): PlayerSegment | null {
  if (!config) return null;
  const branching = config.branching ?? null;
  const seq = branching
    ? (branching.sequences.find((s) => s.id === branching.entry_sequence_id) ?? branching.sequences[0] ?? null)
    : null;
  const segments = seq ? seq.segments : config.segments;
  return segments?.[0] ?? null;
}

export interface ProjectReadiness {
  /** The entry segment can be played — the ONLY condition under which handing over a config is safe. */
  entryPlayable: boolean;
  /** Segments that may still change. Polling must continue while this is non-zero. */
  pendingCount: number;
  /** Every segment failed — a hard error, not a wait. */
  allFailed: boolean;
  /** No segments at all. */
  empty: boolean;
}

/**
 * One call, one answer, used by every viewer surface.
 *
 * `entryPlayable` deliberately replaces the old `playable.length > 0`. That gate admitted a
 * config as soon as ANY segment was ready — so a project whose second video finished
 * transcoding first dropped the spinner and handed the player a segment 0 with no URL: no
 * video, no spinner, no error. Out-of-order completion is ordinary, because transcodes run
 * concurrently.
 */
export function readinessOf(config: Pick<PlayerConfig, 'segments' | 'branching'> | null | undefined): ProjectReadiness {
  const all = config?.segments ?? [];
  if (!all.length) return { entryPlayable: false, pendingCount: 0, allFailed: false, empty: true };
  return {
    entryPlayable: isPlayableSegment(entrySegmentOf(config)),
    pendingCount: all.filter((s) => !isResolvedSegment(s)).length,
    allFailed: all.every((s) => s.hls_status === 'failed'),
    empty: false,
  };
}

/**
 * Fill in URLs that arrived after the player mounted.
 *
 * `useProjectPlayer` keeps its active timeline in a `useRef` seeded once at mount. A later poll
 * that finally carries a ready URL therefore reached React state but never reached playback. This
 * merges the new URLs into the held list.
 *
 * Two rules, and both matter:
 *   • only segments that currently have NO url are touched — rewriting a segment that is already
 *     playing is how a shot gets swapped out from under a viewer mid-playback;
 *   • matching is by id across EVERY sequence in the config, so it stays correct after a branch
 *     navigation has moved the active timeline off the entry sequence.
 *
 * Returns the same array instance when nothing changed, so callers can skip the write.
 */
export function mergeSegmentUrls(
  current: PlayerSegment[],
  config: Pick<PlayerConfig, 'segments' | 'branching'> | null | undefined,
): PlayerSegment[] {
  if (!current.length || !config) return current;

  const byId = new Map<string, PlayerSegment>();
  for (const seg of config.segments ?? []) byId.set(seg.id, seg);
  for (const seq of config.branching?.sequences ?? []) for (const seg of seq.segments) byId.set(seg.id, seg);

  let changed = false;
  const merged = current.map((cur) => {
    if (cur.hls_url || cur.fallback_url) return cur;
    const next = byId.get(cur.id);
    if (!next || !(next.hls_url || next.fallback_url)) return cur;
    changed = true;
    return { ...cur, hls_url: next.hls_url, fallback_url: next.fallback_url, hls_status: next.hls_status };
  });
  return changed ? merged : current;
}

/**
 * May the standby element be claimed and loaded for this segment?
 *
 * The URL check is the whole point, and its ORDER was the bug. `prewarm` recorded the segment id
 * on the standby ref and only then called an attach that no-ops on an empty URL — so the "already
 * claimed" guard matched forever afterwards and the retry never happened when the URL arrived.
 * Deciding everything up front, here, makes that ordering impossible to get wrong again.
 */
export function shouldPrewarm(opts: {
  segmentId: string | null | undefined;
  claimedId: string | null;
  url: string;
  hasStandby: boolean;
}): boolean {
  if (!opts.segmentId) return false;
  if (!opts.hasStandby) return false;
  if (opts.claimedId === opts.segmentId) return false;
  return Boolean(opts.url);
}
