/**
 * The section-boundary sentinel (Priority 8.6).
 *
 * WHAT IS ACTUALLY WRONG TODAY
 * Section transitions are driven by the `timeupdate` DOM event, whose cadence is UA-defined and in
 * practice about 4 Hz. Boundary lateness is therefore roughly uniform on [0, 250] ms — mean ~125 ms
 * — before any of the work of preparing and revealing a section even begins.
 *
 * WHAT THIS DOES AND DOES NOT FIX
 * `requestVideoFrameCallback` fires once per PRESENTED frame and carries `mediaTime`, the frame's
 * own presentation timestamp, which is strictly more correct than `currentTime` (a sampled
 * estimate). At 30 fps that is one callback per ~33 ms. So this reduces boundary DETECTION lateness
 * to roughly a frame.
 *
 * It does not make a simulation appear sooner. Everything after the boundary — prepare, apply,
 * present, reveal — is unchanged, and detecting a boundary 200 ms earlier only helps if that work
 * has already been done. This is worth shipping because predictive preparation now exists to do
 * that work in advance; on its own it would be a 200 ms improvement to the start of a chain of
 * unknown length.
 *
 * IT IS A SENTINEL, NOT A CLOCK REPLACEMENT
 * `timeupdate` remains the master clock for everything it already drives, and remains the safety
 * net: if this sentinel misfires, the existing tick re-detects the same boundary within its normal
 * cadence. Replacing the clock would mean losing every boundary while the video is PAUSED — which
 * this player does deliberately for post-roll sections — and rVFC does not fire when paused.
 */

export interface BoundarySentinelOptions {
  video: HTMLVideoElement;
  /** Absolute media time of the boundary to watch for, in seconds. */
  targetSec: number;
  /** Called once, with the media time actually observed at or after the boundary. */
  onBoundary: (mediaTimeSec: number) => void;
  /** Arm only when the boundary is within this horizon. Keeps a long section from holding a handle. */
  horizonSec?: number;
}

export interface BoundarySentinel {
  /** Which mechanism armed. `none` means the boundary was outside the horizon or unreachable. */
  readonly mode: 'rvfc' | 'timeout' | 'none';
  cancel(): void;
}

const NOOP: BoundarySentinel = { mode: 'none', cancel: () => {} };

export const DEFAULT_HORIZON_SEC = 0.35;
/**
 * Re-arm ceiling. At 60fps this is ~2s of frames — comfortably more than the 0.35s horizon needs,
 * and finite, so a backward seek cannot leave a self-rescheduling loop running forever.
 */
export const MAX_REARM_FRAMES = 120;

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function supportsRvfc(video: HTMLVideoElement): boolean {
  return typeof (video as VideoWithRvfc).requestVideoFrameCallback === 'function';
}

/**
 * Fire `onBoundary` as close as possible to `targetSec`.
 *
 * Two mechanisms, in order of preference:
 *
 *   1. rVFC, which is frame-accurate and robust to rate changes, seeks and stalls because every
 *      callback re-reads the real `mediaTime`.
 *   2. A single `setTimeout` computed from the current time and playback rate. This is the fallback
 *      where rVFC is unavailable — notably Firefox for most of its history. Between frames it is
 *      actually MORE precise than rVFC, and it is less robust: a rate change or a stall invalidates
 *      its estimate, which is why the caller must keep `timeupdate` as the safety net either way.
 */
export function armBoundarySentinel(opts: BoundarySentinelOptions): BoundarySentinel {
  const { video, targetSec, onBoundary } = opts;
  const horizon = opts.horizonSec ?? DEFAULT_HORIZON_SEC;

  if (!video || !Number.isFinite(targetSec)) return NOOP;
  const start = safeCurrentTime(video);
  if (start === null) return NOOP;

  const until = targetSec - start;
  // Already at or past the boundary: the caller should act now rather than schedule anything.
  if (until <= 0) return NOOP;
  if (until > horizon) return NOOP;

  let done = false;
  let frames = 0;
  /**
   * Fire once.
   *
   * The once-only property comes from the STRUCTURE, not from a guard here: the rVFC loop returns
   * without re-arming after firing, the timer is single-shot, and `cancel` sets `done` which `step`
   * checks before ever reaching this. A defensive `if (done) return` here was unkillable by any
   * mutation for exactly that reason, and an unfalsifiable guard invites a later reader to weaken
   * one of the three real mechanisms believing this still covers it.
   */
  const fire = (mediaTime: number): void => {
    onBoundary(mediaTime);
  };

  const v = video as VideoWithRvfc;
  if (typeof v.requestVideoFrameCallback === 'function') {
    let handle: number | null = null;
    const step = (_now: number, meta: { mediaTime: number }): void => {
      if (done) return;
      if (typeof meta?.mediaTime === 'number' && meta.mediaTime >= targetSec) {
        fire(meta.mediaTime);
        return;
      }
      // Re-arm, but BOUNDED. Each callback re-reads the true media time, so a seek or rate change
      // during the wait is absorbed rather than producing a boundary at the wrong moment — however
      // a backward seek moves the target permanently out of reach, and an unbounded loop would then
      // burn one callback per presented frame until something else cancelled it.
      frames += 1;
      if (frames > MAX_REARM_FRAMES) { done = true; return; }
      handle = v.requestVideoFrameCallback!(step);
    };
    handle = v.requestVideoFrameCallback(step);
    return {
      mode: 'rvfc',
      cancel() {
        done = true;
        // Cancellation is not optional. rVFC handles are per-ELEMENT, and this player swaps video
        // elements between segments; a self-rescheduling loop left running against a detached
        // element would fire boundaries for a video nobody is watching.
        if (handle !== null && typeof v.cancelVideoFrameCallback === 'function') {
          try { v.cancelVideoFrameCallback(handle); } catch { /* already gone */ }
        }
      },
    };
  }

  const rate = Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1;
  const timer = setTimeout(() => {
    const t = safeCurrentTime(video);
    // The boundary must have ACTUALLY been reached. The delay is computed once from the rate at arm
    // time, so a pause or a rate drop inside the horizon leaves the video short of the target — and
    // firing anyway would report a boundary that has not happened. `timeupdate` remains the safety
    // net for a LATE boundary; nothing catches an early one, which is why this branch checks.
    if (typeof t === 'number' && t < targetSec) return;
    fire(typeof t === 'number' ? t : targetSec);
  }, Math.max(0, (until / rate) * 1000));

  return {
    mode: 'timeout',
    cancel() { done = true; clearTimeout(timer); },
  };
}

/** `currentTime` can throw on a detached or errored element; a boundary is not worth an exception. */
function safeCurrentTime(video: HTMLVideoElement): number | null {
  try {
    const t = video.currentTime;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
