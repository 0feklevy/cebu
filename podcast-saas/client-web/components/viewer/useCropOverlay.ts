'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { PlayerSegment } from './types';

/**
 * Smart portrait-crop overlay.
 *
 * WHY object-position instead of transform + explicit width:
 *   The naive approach of `style.width = scaledW; style.transform = translateX(tx)` on
 *   a <video> element with `position:absolute; inset:0` causes the GPU compositor to
 *   black out the video on most browsers — a known rendering limitation when a video
 *   element's painted area is pushed far outside the viewport via transform.
 *
 *   The correct approach: in portrait mode switch the video to `object-fit: cover`
 *   (fills the container) and drive `object-position: P% 50%` to control which
 *   horizontal slice is visible. No size change, no transform, no compositing issues.
 *
 * Portrait mode detection: container height > container width (device or DevTools).
 * In landscape: resets all inline styles so the default `object-contain` class takes over.
 */

interface CropKeyframe { t: number; x: number; }
interface CropMetadata {
  duration: number; width: number; height: number;
  crop_aspect: number; keyframes: CropKeyframe[];
}

/** Binary-search interpolation on the keyframe track. */
function lookupCropX(kf: CropKeyframe[], time: number): number {
  const n = kf.length;
  if (n === 0) return 0.5;
  if (time <= kf[0].t) return kf[0].x;
  if (time >= kf[n - 1].t) return kf[n - 1].x;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (kf[m].t <= time) lo = m; else hi = m; }
  const a = kf[lo], b = kf[hi];
  return a.x + (b.x - a.x) * (time - a.t) / (b.t - a.t);
}

/**
 * Map a crop fraction measured on the ORIGINAL upload onto the PADDED HLS frame the player shows.
 *
 * THE MISMATCH. Crop analysis runs on the source video; the player applies the answer to an HLS
 * tier. Every tier is 16:9, so a source with a different display aspect is PILLARBOXED into it —
 * and `crop_x` is a fraction of the source's width, while `object-position` addresses the padded
 * frame. Nothing reconciled the two, so the crop landed left of the subject on any non-16:9 video.
 *
 * A 4:3 source is the common case (Zoom, webcam, older footage). Its content occupies
 * (4/3)/(16/9) = 0.75 of the tier's width, centred, leaving 0.125 of padding each side. So
 * `crop_x = 0.2` in the source is at `0.125 + 0.2 x 0.75 = 0.275` of the padded frame — which is
 * exactly the correction ordered in D-16, and the number this function is asserted against.
 *
 * Returns `cropX` unchanged when the aspects match (the 16:9 case, i.e. most videos) or when the
 * source dimensions are unknown, so the common path is untouched and an absent field degrades to
 * today's behaviour rather than to a wrong number.
 *
 * @param cropX     fraction of the SOURCE frame width, from the crop keyframe track
 * @param srcW/srcH the source dimensions the analysis measured (CropMetadata.width/height)
 * @param tileW/tileH the dimensions the player is actually showing (video.videoWidth/Height)
 */
export function sourceCropXToRenderedX(
  cropX: number,
  srcW: number | undefined,
  srcH: number | undefined,
  tileW: number,
  tileH: number,
): number {
  if (!srcW || !srcH || !tileW || !tileH) return cropX;
  const srcAspect = srcW / srcH;
  const tileAspect = tileW / tileH;
  // Source WIDER than the tile would be letterboxed (bars top/bottom), which does not move
  // anything horizontally — so only the pillarbox case shifts x.
  if (srcAspect >= tileAspect) return cropX;
  const contentFraction = srcAspect / tileAspect;      // 0.75 for 4:3 inside 16:9
  const padFraction = (1 - contentFraction) / 2;       // 0.125 each side
  return padFraction + cropX * contentFraction;
}

/**
 * Convert a crop target (0..1) to an `object-position` percentage.
 *
 * With `object-fit: cover` in a portrait container (cW × cH) and a landscape video
 * (vW × vH), the rendered video width is: rendW = cH × (vW/vH).
 * The formula below places `cropX` at the horizontal centre of the container:
 *
 *   P = 100 × (cW/2 − cropX × rendW) / (cW − rendW)
 *
 * Clamped to [0, 100] so the window never exceeds the video edges.
 */
function cropXToObjectPosition(cropX: number, cW: number, cH: number, vW: number, vH: number): number {
  const rendW = cH * (vW / vH);
  if (rendW <= cW) return 50; // video narrower than container — centre
  const p = 100 * (cW / 2 - cropX * rendW) / (cW - rendW);
  return Math.max(0, Math.min(100, p));
}

export interface CropOverlayRefs {
  videoA: RefObject<HTMLVideoElement | null>;
  videoB: RefObject<HTMLVideoElement | null>;
  root:   RefObject<HTMLDivElement | null>;
}

/**
 * Wall-clock time constant of the crop pan: after this long, the remaining distance to the target
 * has fallen to 1/e. Chosen to match what the previous per-frame 0.06 delivered on the 60Hz
 * display it was tuned on, so ordinary panning looks unchanged — the fix is that 30Hz and 120Hz
 * now look the same as 60Hz, which they did not.
 */
const SMOOTH_TAU_MS = 260;

/**
 * A jump this large (fraction of frame width) is a CUT, not a pan, and is adopted immediately.
 * The backend commits a deliberate step when it decides the speaker changed; easing across that
 * step is what kept the viewer on the previous speaker for most of a short turn. 0.12 sits well
 * above the jitter of a stationary subject and well below a real two-shot switch (~0.4).
 */
const SNAP_THRESHOLD = 0.12;

/**
 * The whole smoothing decision, as a pure function so it can be tested by exercising THIS code
 * rather than a copy of it. An earlier test reimplemented the law and consequently passed with the
 * cut-snap deleted from the hook — a mutation check caught it. Anything the viewer's framing
 * depends on belongs here, not inside the rAF closure.
 *
 * @param current  where the crop is now, or null before a segment's first frame
 * @param target   the keyframe value for this instant
 * @param dtMs     elapsed wall-clock since the previous tick (0 on the first)
 */
export function nextCropX(current: number | null, target: number, dtMs: number): number {
  // First frame of a segment: adopt. A segment change is a cut, and starting from frame-centre
  // made every boundary begin with a visible pan to wherever the speaker actually is.
  if (current === null) return target;
  // A jump this large is a cut, not a pan. The backend commits a deliberate step when it decides
  // the speaker changed; easing across it is what kept the viewer on the previous speaker for
  // most of a short turn.
  if (Math.abs(target - current) >= SNAP_THRESHOLD) return target;
  if (dtMs <= 0) return current;
  // Exponential approach with a WALL-CLOCK time constant, so 30Hz, 60Hz and 120Hz all pan at the
  // same speed. The previous per-frame factor made the same video look different on different
  // hardware.
  return current + (target - current) * (1 - Math.exp(-dtMs / SMOOTH_TAU_MS));
}

export function useCropOverlay(
  refs: CropOverlayRefs,
  segments: PlayerSegment[],
  currentSegIdx: number,
): void {
  // keyframes per segment id: undefined = unfetched, [] = in-flight/missing, [...] = loaded
  /**
   * Per-segment crop track. Keeps the SOURCE dimensions alongside the keyframes, because
   * `crop_x` is a fraction of the source frame and the player renders a padded HLS tile — see
   * sourceCropXToRenderedX. Discarding them is why a 4:3 video cropped left of its subject.
   */
  const cache      = useRef<Record<string, { keyframes: CropKeyframe[]; srcW?: number; srcH?: number }>>({});
  const isPortrait = useRef(false);
  const dims       = useRef({ w: 1, h: 1 });
  /**
   * Current crop centre, or null before the first frame of a segment has been drawn.
   * Null rather than 0.5 so a segment starts ON its speaker instead of panning in from centre.
   */
  const smoothX     = useRef<number | null>(null);
  /** performance.now() of the previous tick, for frame-rate-independent smoothing. */
  const lastTickAt  = useRef(0);
  const rafRef     = useRef<number | null>(null);
  // Latest tick implementation + a stable "(re)start the loop if idle" kick. The loop suspends
  // itself in landscape (nothing to animate); the kick resumes it when we re-enter portrait
  // (perf-008) — avoids ~60 no-op RAF callbacks/sec on every desktop (landscape) viewer.
  const tickRef = useRef<() => void>(() => {});
  const kick = useRef(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => tickRef.current());
  });

  const seg    = segments[currentSegIdx];
  const segId  = seg?.id ?? '';
  const cropUrl = seg?.crop_url ?? null;

  // ── orientation / container size (read outside the RAF loop) ──────────────
  useEffect(() => {
    const update = () => {
      const root = refs.root.current;
      const w = root?.offsetWidth  ?? window.innerWidth;
      const h = root?.offsetHeight ?? window.innerHeight;
      dims.current = { w, h };
      const portrait = h > w;
      isPortrait.current = portrait;
      if (portrait) kick.current(); // resume the suspended loop when entering portrait
    };
    update();
    window.addEventListener('resize',            update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize',            update);
      window.removeEventListener('orientationchange', update);
    };
  }, [refs.root]);

  // ── fetch crop metadata for the active segment ─────────────────────────────
  useEffect(() => {
    if (!segId || !cropUrl) return;
    if (cache.current[segId] !== undefined) return;
    cache.current[segId] = { keyframes: [] }; // mark in-flight
    fetch(cropUrl)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then((d: CropMetadata) => { cache.current[segId] = { keyframes: d.keyframes ?? [], srcW: d.width, srcH: d.height }; })
      .catch(() => { /* leave as [] → centre fallback */ });
  }, [segId, cropUrl]);

  // ── per-frame RAF loop ─────────────────────────────────────────────────────
  useEffect(() => {
    // A segment change is a CUT, not a pan: adopt the new segment's first keyframe rather than
    // sliding there from frame-centre. Resetting to 0.5 made every segment boundary start with a
    // visible pan from the middle of the frame to wherever the speaker actually is — on a
    // multi-segment lecture, once per segment. `null` means "not yet initialised"; the first tick
    // adopts its target outright.
    smoothX.current = null;
    lastTickAt.current = 0;

    const tick = () => {
      const vA = refs.videoA.current;
      const vB = refs.videoB.current;
      if (!vA || !vB) { rafRef.current = requestAnimationFrame(() => tickRef.current()); return; }

      // ── LANDSCAPE: clear any portrait overrides and SUSPEND ───────────────
      // Stop rescheduling — there is nothing to animate in landscape. The orientation
      // handler's kick() restarts the loop if we rotate back to portrait (perf-008).
      if (!isPortrait.current) {
        for (const v of [vA, vB]) {
          if (v.style.objectFit)       v.style.objectFit       = '';
          if (v.style.objectPosition)  v.style.objectPosition  = '';
        }
        rafRef.current = null;
        return;
      }

      // ── PORTRAIT: keep the loop running ───────────────────────────────────
      rafRef.current = requestAnimationFrame(() => tickRef.current());

      // ── object-fit:cover + object-position ────────────────────────────────
      const zA = parseInt(vA.style.zIndex) || 1;
      const zB = parseInt(vB.style.zIndex) || 1;
      const active = zA >= zB ? vA : vB;

      const entry  = cache.current[segId];
      const kf     = entry?.keyframes ?? [];
      // Measured on the SOURCE, applied to the PADDED tile — convert before smoothing, so the
      // snap threshold and the pan both operate in the coordinate space the viewer sees.
      const target = sourceCropXToRenderedX(
        lookupCropX(kf, active.currentTime),
        entry?.srcW, entry?.srcH,
        active.videoWidth || 1920, active.videoHeight || 1080,
      );

      // ── SMOOTHING, and the two things the old one-liner got wrong ────────
      //
      // It was `smoothX += (target - smoothX) * 0.06` per animation frame. Two defects, both
      // measured by an adversarial review of the backend crop work:
      //
      //   1. FRAME-RATE DEPENDENT. 0.06 per FRAME means the time constant halves on a 120Hz
      //      display and doubles on a 30Hz one: the backend's clean step was smeared over ~0.85s
      //      at 60Hz and ~1.70s at 30Hz. The same video framed differently on different hardware.
      //      Now expressed as a time constant and converted per elapsed millisecond, so the pan
      //      takes the same wall-clock time everywhere.
      //   2. IT EASED ACROSS CUTS. The backend now emits a deliberate STEP when it commits a
      //      speaker switch (services/crop), and easing at 0.06 turned that step back into the
      //      slow drift the fix existed to remove — the viewer stayed on the previous speaker for
      //      most of a short turn. A jump larger than SNAP_THRESHOLD is treated as a cut and
      //      adopted immediately; anything smaller is still eased, so a genuine slow pan (a
      //      walking presenter) keeps its smoothing.
      const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dt = lastTickAt.current ? Math.min(250, nowMs - lastTickAt.current) : 0;
      lastTickAt.current = nowMs;

      smoothX.current = nextCropX(smoothX.current, target, dt);
      const cropX = smoothX.current;

      const { w: cW, h: cH } = dims.current;
      const vW = active.videoWidth  || 1920;
      const vH = active.videoHeight || 1080;

      const P      = cropXToObjectPosition(cropX, cW, cH, vW, vH);
      const objPos = `${P.toFixed(2)}% 50%`;

      for (const v of [vA, vB]) {
        if (v.style.objectFit      !== 'cover') v.style.objectFit      = 'cover';
        if (v.style.objectPosition !== objPos)  v.style.objectPosition = objPos;
      }
    };

    tickRef.current = tick;
    kick.current();  // start the loop (it suspends itself immediately if currently landscape)
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [segId, refs.videoA, refs.videoB]);
}
