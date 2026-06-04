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

export function useCropOverlay(
  refs: CropOverlayRefs,
  segments: PlayerSegment[],
  currentSegIdx: number,
): void {
  // keyframes per segment id: undefined = unfetched, [] = in-flight/missing, [...] = loaded
  const cache      = useRef<Record<string, CropKeyframe[]>>({});
  const isPortrait = useRef(false);
  const dims       = useRef({ w: 1, h: 1 });
  const smoothX    = useRef(0.5);
  const rafRef     = useRef<number | null>(null);

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
      isPortrait.current = h > w;
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
    cache.current[segId] = []; // mark in-flight
    fetch(cropUrl)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then((d: CropMetadata) => { cache.current[segId] = d.keyframes ?? []; })
      .catch(() => { /* leave as [] → centre fallback */ });
  }, [segId, cropUrl]);

  // ── per-frame RAF loop ─────────────────────────────────────────────────────
  useEffect(() => {
    smoothX.current = 0.5; // reset on segment change

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const vA = refs.videoA.current;
      const vB = refs.videoB.current;
      if (!vA || !vB) return;

      // ── LANDSCAPE: clear any portrait overrides and bail ──────────────────
      if (!isPortrait.current) {
        for (const v of [vA, vB]) {
          if (v.style.objectFit)       v.style.objectFit       = '';
          if (v.style.objectPosition)  v.style.objectPosition  = '';
        }
        return;
      }

      // ── PORTRAIT: object-fit:cover + object-position ──────────────────────
      const zA = parseInt(vA.style.zIndex) || 1;
      const zB = parseInt(vB.style.zIndex) || 1;
      const active = zA >= zB ? vA : vB;

      const kf     = cache.current[segId] ?? [];
      const target = lookupCropX(kf, active.currentTime);

      // EMA smoothing — slow enough for a deliberate pan, fast enough to track cuts
      smoothX.current += (target - smoothX.current) * 0.06;
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

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [segId, refs.videoA, refs.videoB]);
}
