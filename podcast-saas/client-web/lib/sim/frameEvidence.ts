/**
 * The browser-side probe that FEEDS the transition coordinator (audit P0.1).
 *
 * The coordinator itself is a pure reducer with no clock and no DOM; this is the only place that
 * touches `requestVideoFrameCallback`, `requestAnimationFrame` and the media element. It makes no
 * decisions — it reports observations and lets the reducer accept or reject them. That split is
 * what lets the accept/reject rules be tested over their whole cartesian product.
 *
 * TWO OBSERVATION CHANNELS, ALWAYS BOTH
 *   rVFC       one callback per frame submitted to the compositor, carrying that frame's own
 *              `mediaTime`. Registered only after the source/seek is issued and only while the
 *              page is visible, because the callback is suppressed for hidden/occluded video.
 *   rAF        an animation-frame loop, which does two jobs: it counts VISIBLE frames (two of them
 *              are one third of the audit's labelled fallback) and it offers a `fallback`-kind
 *              claim built from `currentTime`.
 *
 * Both channels run unconditionally, and the reducer decides which is admissible: a `fallback`
 * claim is rejected outright while rVFC is available and has not been observed to stall. Running
 * the rAF loop anyway is what makes the switch to the fallback instant when rVFC turns out to be
 * absent or silent — the two visible frames have already been counted by then, rather than the
 * clock starting over at the moment of the diagnosis.
 *
 * NON-ARRIVAL IS REPORTED, NEVER ASSUMED
 * `requestVideoFrameCallback` can simply never fire. A separate bounded timer reports that as a
 * fact (`onNonArrival`) so the reducer can unlock the labelled fallback. The probe never promotes
 * anything itself, and nothing here can authorise a reveal.
 */

import type { EvidenceKind } from './transitionCoordinator';

export interface PresentedFrameClaim {
  generation: number;
  mediaTime: number;
  kind: EvidenceKind;
  atMs: number;
}

export interface FrameEvidenceProbeOptions {
  video: HTMLVideoElement;
  /** The handoff this probe belongs to. Stamped on every observation so late ones are droppable. */
  generation: number;
  onFrame: (claim: PresentedFrameClaim) => void;
  /** One animation frame elapsed while the page was visible. */
  onVisibleFrame: (generation: number) => void;
  /** No rVFC callback within the bound. Unlocks the labelled lower-confidence fallback. */
  onNonArrival: (generation: number) => void;
  /** Bound for declaring rVFC non-arrival. Ignored when rVFC is absent (nothing to wait for). */
  nonArrivalMs?: number;
  now?: () => number;
}

export interface FrameEvidenceProbe {
  /** Which channels actually armed. `none` means the element could not be probed at all. */
  readonly mode: 'rvfc+raf' | 'raf' | 'none';
  cancel(): void;
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function supportsRequestVideoFrameCallback(video: HTMLVideoElement): boolean {
  return typeof (video as VideoWithRvfc).requestVideoFrameCallback === 'function';
}

/** Default bound before rVFC silence is reported as non-arrival. */
export const DEFAULT_NON_ARRIVAL_MS = 400;

/**
 * Cap on the rAF loop. The handoff's own deadline ends the wait; this only guarantees that a probe
 * nobody cancelled cannot spin for the life of the page (a detached element, a lost cancel).
 */
export const MAX_RAF_FRAMES = 600;

const NOOP_PROBE: FrameEvidenceProbe = { mode: 'none', cancel: () => {} };

export function armFrameEvidence(opts: FrameEvidenceProbeOptions): FrameEvidenceProbe {
  const { video, generation, onFrame, onVisibleFrame, onNonArrival } = opts;
  if (!video) return NOOP_PROBE;

  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const v = video as VideoWithRvfc;
  const hasRvfc = typeof v.requestVideoFrameCallback === 'function';

  let cancelled = false;
  let sawRvfc = false;
  let rvfcHandle: number | null = null;
  let rafHandle: number | null = null;
  let nonArrivalTimer: ReturnType<typeof setTimeout> | null = null;
  let frames = 0;

  // ── rVFC ────────────────────────────────────────────────────────────────────────────────────
  // ONE callback, not a self-rescheduling loop: the reducer re-arms by emitting ARM_FRAME_EVIDENCE
  // when it rejects a frame. Keeping the re-arm decision on the reducer's side is what makes
  // "a stale frame must be ignored AND the loop must keep looking" a testable assertion rather
  // than an emergent property of two independent loops.
  if (hasRvfc) {
    rvfcHandle = v.requestVideoFrameCallback!((_now, meta) => {
      rvfcHandle = null;
      if (cancelled) return;
      sawRvfc = true;
      const mediaTime = typeof meta?.mediaTime === 'number' ? meta.mediaTime : safeCurrentTime(video);
      if (mediaTime === null) return;
      onFrame({ generation, mediaTime, kind: 'rvfc', atMs: now() });
    });

    nonArrivalTimer = setTimeout(() => {
      nonArrivalTimer = null;
      if (cancelled || sawRvfc) return;
      onNonArrival(generation);
    }, opts.nonArrivalMs ?? DEFAULT_NON_ARRIVAL_MS);
  }

  // ── rAF ─────────────────────────────────────────────────────────────────────────────────────
  const raf: typeof requestAnimationFrame | null =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;

  if (raf) {
    const step = (): void => {
      rafHandle = null;
      if (cancelled) return;
      frames += 1;
      if (frames > MAX_RAF_FRAMES) return;
      onVisibleFrame(generation);
      // Offered every frame; admissible only once the reducer has ruled rVFC out. `currentTime` is
      // a sampled estimate rather than a presented frame's own timestamp, which is precisely why
      // this claim is labelled low confidence when it is accepted at all.
      const t = safeCurrentTime(video);
      if (t !== null) onFrame({ generation, mediaTime: t, kind: 'fallback', atMs: now() });
      if (cancelled) return;
      rafHandle = raf(step);
    };
    rafHandle = raf(step);
  }

  if (!hasRvfc && !raf) return NOOP_PROBE;

  return {
    mode: hasRvfc ? 'rvfc+raf' : 'raf',
    cancel() {
      cancelled = true;
      // Cancellation is not optional. rVFC handles are per-ELEMENT and this player swaps video
      // elements between segments; a callback left registered against a superseded handoff would
      // report frames for a seek nobody is waiting on.
      if (rvfcHandle !== null && typeof v.cancelVideoFrameCallback === 'function') {
        try { v.cancelVideoFrameCallback(rvfcHandle); } catch { /* already gone */ }
      }
      rvfcHandle = null;
      if (rafHandle !== null && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(rafHandle); } catch { /* already gone */ }
      }
      rafHandle = null;
      if (nonArrivalTimer !== null) { clearTimeout(nonArrivalTimer); nonArrivalTimer = null; }
    },
  };
}

/** `currentTime` can throw on a detached or errored element; an observation is not worth throwing. */
function safeCurrentTime(video: HTMLVideoElement): number | null {
  try {
    const t = video.currentTime;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
