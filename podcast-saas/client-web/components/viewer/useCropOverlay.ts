'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { PlayerSegment } from './types';

/**
 * Smart portrait-crop overlay.
 *
 * Ported from interactive-podcast-react's useCropOverlay and adapted to the
 * dynamic player's two-video-element (A/B) cross-fade setup. On portrait devices
 * it widens the active <video> to fill the height and translates it horizontally
 * so the precomputed crop-x (active speaker) sits at the centre. In landscape it
 * is a no-op (object-contain letterboxing as before).
 *
 * Crop metadata is fetched per segment from `segment.crop_url` (served by
 * buildPlayerConfig once the background job is ready) and cached.
 */

interface CropKeyframe { t: number; x: number; }
interface CropMetadata { duration: number; width: number; height: number; crop_aspect: number; keyframes: CropKeyframe[]; }

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

export interface CropOverlayRefs {
  videoA: RefObject<HTMLVideoElement | null>;
  videoB: RefObject<HTMLVideoElement | null>;
  root: RefObject<HTMLDivElement | null>;
}

export function useCropOverlay(
  refs: CropOverlayRefs,
  segments: PlayerSegment[],
  currentSegIdx: number,
): void {
  // keyframes per segment id: undefined = unfetched, [] = in-flight/missing, [...] = loaded
  const cache = useRef<Record<string, CropKeyframe[]>>({});
  const isPortrait = useRef(false);
  const containerDims = useRef({ w: 1, h: 1 });
  const smoothX = useRef(0.5);
  const rafRef = useRef<number | null>(null);

  const seg = segments[currentSegIdx];
  const segId = seg?.id ?? '';
  const cropUrl = seg?.crop_url ?? null;

  // ── orientation + container size (read out of the RAF loop) ──
  useEffect(() => {
    const update = () => {
      const root = refs.root.current;
      const w = root?.offsetWidth ?? window.innerWidth;
      const h = root?.offsetHeight ?? window.innerHeight;
      containerDims.current = { w, h };
      isPortrait.current = h > w;
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [refs.root]);

  // ── fetch crop metadata for the active segment ──
  useEffect(() => {
    if (!segId || !cropUrl) return;
    if (cache.current[segId] !== undefined) return;
    cache.current[segId] = [];
    fetch(cropUrl)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then((d: CropMetadata) => { cache.current[segId] = d.keyframes ?? []; })
      .catch(() => { /* leave as [] → centre fallback */ });
  }, [segId, cropUrl]);

  // ── per-frame transform ──
  useEffect(() => {
    smoothX.current = 0.5; // reset on segment change to avoid a cross-segment pan
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const vA = refs.videoA.current;
      const vB = refs.videoB.current;
      if (!vA || !vB) return;

      if (!isPortrait.current) {
        for (const v of [vA, vB]) { if (v.style.transform) v.style.transform = ''; if (v.style.width) v.style.width = ''; }
        return;
      }

      const zA = parseInt(vA.style.zIndex) || 1;
      const zB = parseInt(vB.style.zIndex) || 1;
      const active = zA >= zB ? vA : vB;

      const kf = cache.current[segId] ?? [];
      const targetX = lookupCropX(kf, active.currentTime);
      smoothX.current += (targetX - smoothX.current) * 0.06; // EMA (~75 frames @60fps)
      const cropX = smoothX.current;

      const { w: cW, h: cH } = containerDims.current;
      const vW = active.videoWidth || 1920;
      const vH = active.videoHeight || 1080;
      const scaledW = cH * (vW / vH);
      const wPx = `${scaledW.toFixed(0)}px`;
      const desired = cW / 2 - cropX * scaledW;
      const tx = Math.max(cW - scaledW, Math.min(0, desired));
      const transform = `translateX(${tx.toFixed(1)}px)`;

      for (const v of [vA, vB]) {
        if (v.style.width !== wPx) v.style.width = wPx;
        if (v.style.transform !== transform) v.style.transform = transform;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [segId, refs.videoA, refs.videoB]);
}
