'use client';

/**
 * useSegmentedPlaybackCore — shared playback primitives.
 *
 * Used by:
 *   • useEditorPlayback (editor preview)
 *   • useProjectPlayer  (final viewer) — uses the same constants and patterns;
 *     it is NOT refactored to import from here because it uses DOM-ref–based
 *     progress (no React setState during playback) and a different segment
 *     shape (PlayerSegment vs Clip). Changing that already-correct, in-production
 *     hook to import from here would risk subtle regressions with no user benefit.
 *
 * What IS shared and used by both systems:
 *   1. HLS_OPTS / HLS_OPTS_STANDBY        — same ABR/buffer config → identical quality
 *   2. computeSegmentOffset()              — same global timeline math
 *   3. globalToLocal()                     — same global→(segment, localTime) mapping
 *   4. attachHlsSource()                   — same HLS attach + error-recovery pattern
 *   5. safePlay()                          — same play() swallow helper
 *
 * Any change to these constants or math here automatically applies to
 * useEditorPlayback, ensuring the editor never drifts from the viewer's logic.
 */

// ── HLS.js config ─────────────────────────────────────────────────────────────
// Must match useProjectPlayer.ts exactly.
// ABR starts at -1 (auto), player-size cap on, conservative buffer to avoid
// exhausting memory on low-end devices.

export const HLS_OPTS = {
  enableWorker:           true,
  startLevel:             -1,
  capLevelToPlayerSize:   true,
  startFragPrefetch:      false,
  maxBufferLength:        15,
  maxMaxBufferLength:     30,
  backBufferLength:       5,
  abrEwmaDefaultEstimate: 500_000,
  fragLoadingTimeOut:     20_000,
  manifestLoadingTimeOut: 10_000,
  maxBufferHole:          0.5,
  nudgeMaxRetry:          5,
} as const;

// Standby element: start at level 0 (lowest) to conserve bandwidth.
// Once promoted to the active slot it inherits the ABR state.
export const HLS_OPTS_STANDBY = { ...HLS_OPTS, startLevel: 0, maxBufferLength: 8 } as const;

// ── HLS error-handler registry ────────────────────────────────────────────────
// WeakMap so the GC cleans up when an HLS instance is destroyed.
// Lets attachHlsSource remove the previous handler before adding a new one,
// preventing handler accumulation on re-attach.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const _hlsErrHandlers = new WeakMap<object, (e: string, d: any) => void>();

// ── Timeline math ─────────────────────────────────────────────────────────────

/**
 * Compute the global-time start (offset) for segment `idx`.
 *
 * @param actualDurs   Durations learned from the video element (override DB values).
 * @param fallbackDurs Durations from the DB / initial props.
 * @param idx          Segment index.
 */
export function computeSegmentOffset(
  actualDurs:   number[],
  fallbackDurs: number[],
  idx: number,
): number {
  let off = 0;
  for (let i = 0; i < idx; i++) off += actualDurs[i] || fallbackDurs[i] || 0;
  return off;
}

/**
 * Map a global playback position to the segment that contains it, plus the
 * local time inside that segment.
 *
 * This is the single canonical implementation of the global→local mapping.
 * The final viewer (useProjectPlayer) implements the same algorithm inline;
 * the editor (useEditorPlayback) calls this function directly.
 *
 * @returns segIdx    0-based segment index
 * @returns localTime seconds elapsed inside that segment
 * @returns segOffset global-time start of that segment
 */
export function globalToLocal(
  globalSec:    number,
  actualDurs:   number[],
  fallbackDurs: number[],
  count:        number,
): { segIdx: number; localTime: number; segOffset: number } {
  let segIdx = 0, segOffset = 0;
  for (let i = 0; i < count; i++) {
    const dur = actualDurs[i] || fallbackDurs[i] || 0;
    if (globalSec < segOffset + dur) { segIdx = i; break; }
    segOffset += dur;
    segIdx = i;
  }
  const finalOffset = computeSegmentOffset(actualDurs, fallbackDurs, segIdx);
  return { segIdx, segOffset: finalOffset, localTime: Math.max(0, globalSec - finalOffset) };
}

// ── HLS attach helper ─────────────────────────────────────────────────────────

/**
 * Load `hlsUrl` (or fall back to `rawUrl`) onto a `<video>` element using
 * HLS.js when available.  Registers a fatal-error handler that retries network
 * errors once, recovers media errors, and falls back to the raw URL on other
 * fatal errors.  Deduplicates handlers via `_hlsErrHandlers`.
 */
export function attachHlsSource(
  el:      HTMLVideoElement,
  hlsUrl:  string | null,
  rawUrl:  string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hls:     any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HlsLib:  any,
): void {
  if (HlsLib?.isSupported() && hlsUrl && hls) {
    hls.stopLoad(); hls.detachMedia();
    hls.loadSource(hlsUrl); hls.attachMedia(el);
    // Remove stale handler before registering a new one
    const prev = _hlsErrHandlers.get(hls);
    if (prev) hls.off(HlsLib.Events.ERROR, prev);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onErr = (_: string, d: any) => {
      if (!d.fatal) return;
      if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
      else if (d.type === 'mediaError') hls.recoverMediaError();
      else if (rawUrl) { el.src = rawUrl; el.load(); }
    };
    _hlsErrHandlers.set(hls, onErr);
    hls.on(HlsLib.Events.ERROR, onErr);
  } else if (hlsUrl && el.canPlayType('application/vnd.apple.mpegurl')) {
    el.src = hlsUrl;
  } else if (rawUrl) {
    el.src = rawUrl; el.load();
  }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

/** Plays a video element, swallowing the DOMException thrown when play() is
 *  interrupted by a subsequent pause() or src change. */
export async function safePlay(v: HTMLVideoElement): Promise<void> {
  try { await v.play(); } catch (_) {}
}

/** Format seconds as M:SS. */
export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
