'use client';

/**
 * useEditorPlayback — viewer-quality playback engine for the editor preview.
 *
 * All timeline math and HLS primitives come from useSegmentedPlaybackCore so
 * the editor uses exactly the same segment-offset calculations, global→local
 * mapping, and HLS error-recovery logic as the final viewer.
 *
 * Key improvements over the old useClipSequence-based editor player:
 *   • timeupdate event instead of requestAnimationFrame
 *     → ~8–10 React renders/sec instead of 60 fps
 *   • scrubbingRef + swappingRef guards
 *     → tick is a no-op during seeks/transitions (no phantom time values)
 *   • startScrub / endScrub API
 *     → seek fires exactly once on mouseup, not on every drag pixel
 *   • prewarm at 30 s (matches viewer, was 8 s before)
 *   • actualDursRef overrides DB duration_sec=0/null values
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Clip } from './useClipSequence';
import {
  HLS_OPTS,
  HLS_OPTS_STANDBY,
  computeSegmentOffset,
  globalToLocal,
  attachHlsSource,
} from './useSegmentedPlaybackCore';

export type { Clip };

export interface UseEditorPlaybackResult {
  videoARef:      RefObject<HTMLVideoElement | null>;
  videoBRef:      RefObject<HTMLVideoElement | null>;
  globalTime:     number;
  currentClipIdx: number;
  isPlaying:      boolean;
  totalDuration:  number;
  play():                      void;
  pause():                     void;
  seek(globalSec: number):     void;
  startScrub():                void;
  endScrub(globalSec: number): void;
}

export function useEditorPlayback(
  clips: Clip[],
  onTimeUpdate: (globalSec: number) => void,
): UseEditorPlaybackResult {
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsLibRef     = useRef<any>(null);
  const videoRef      = useRef<HTMLVideoElement | null>(null);
  const standbyRef    = useRef<HTMLVideoElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsRef        = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsStandbyRef = useRef<any>(null);
  const clipsRef        = useRef<Clip[]>(clips);
  const curIdxRef       = useRef(0);
  const swapGenRef      = useRef(0);
  const standbyIdRef    = useRef<string | null>(null);
  const isPlayingRef    = useRef(false);
  const scrubbingRef    = useRef(false);   // true while user drags seek bar
  const swappingRef     = useRef(false);   // true during A↔B video swap
  const wasPlayingRef   = useRef(false);   // play state captured at scrub start
  const onTimeUpdateRef = useRef(onTimeUpdate);
  // Actual durations learned from the video element override DB values.
  const actualDursRef   = useRef<number[]>(clips.map(c => c.duration || 0));
  // Fallback to clip.duration for the shared-core helpers.
  const fallbackDurs    = () => clipsRef.current.map(c => c.duration || 0);

  const [globalTime, setGlobalTime]         = useState(0);
  const [currentClipIdx, setCurrentClipIdx] = useState(0);
  const [isPlaying, setIsPlaying]           = useState(false);
  const [totalDuration, setTotalDuration]   = useState(
    () => clips.reduce((s, c) => s + (c.duration || 0), 0),
  );

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

  // Extend actualDurs when clips are added after mount (upload while editor open)
  useEffect(() => {
    while (actualDursRef.current.length < clips.length) {
      actualDursRef.current.push(clips[actualDursRef.current.length]?.duration || 0);
    }
    const newTotal = actualDursRef.current.reduce(
      (s, d, i) => s + (d || clipsRef.current[i]?.duration || 0), 0,
    );
    if (newTotal > 0) setTotalDuration(newTotal);
  }, [clips.length]);

  // ── prewarm ────────────────────────────────────────────────────────────────
  const prewarm = useCallback((idx: number) => {
    const cls = clipsRef.current;
    if (idx < 0 || idx >= cls.length || !standbyRef.current) return;
    const clip = cls[idx]!;
    if (standbyIdRef.current === clip.id) return;
    standbyIdRef.current = clip.id;
    // attachHlsSource from shared core — same error-recovery as the viewer
    attachHlsSource(standbyRef.current, clip.hlsUrl, clip.rawUrl, hlsStandbyRef.current, hlsLibRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── swapVideos — A↔B element swap, same pattern as useProjectPlayer ────────
  const swapVideos = useCallback(() => {
    const a = videoRef.current!, b = standbyRef.current!;
    b.style.zIndex = '2'; a.style.zIndex = '1';
    videoRef.current   = b; standbyRef.current = a;
    [hlsRef.current, hlsStandbyRef.current] = [hlsStandbyRef.current, hlsRef.current];
    standbyIdRef.current = null;
    a.pause();
    hlsStandbyRef.current?.stopLoad();
    hlsStandbyRef.current?.detachMedia();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── loadClip ───────────────────────────────────────────────────────────────
  const loadClip = useCallback((idx: number, localTime = 0, forcePlay = true) => {
    swapGenRef.current++;
    const gen = swapGenRef.current;
    const cls = clipsRef.current;
    if (idx < 0 || idx >= cls.length) return;
    const clip = cls[idx]!;
    curIdxRef.current   = idx;
    swappingRef.current = true;
    setCurrentClipIdx(idx);
    hlsRef.current?.stopLoad();

    if (standbyIdRef.current !== clip.id) {
      standbyIdRef.current = clip.id;
      attachHlsSource(standbyRef.current!, clip.hlsUrl, clip.rawUrl, hlsStandbyRef.current, hlsLibRef.current);
    }

    const sv = standbyRef.current!;

    const finishSwap = () => {
      if (gen !== swapGenRef.current) return;
      swapVideos();
      swappingRef.current = false;
      if (forcePlay) {
        videoRef.current!.play().catch(() => {});
        isPlayingRef.current = true;
        setIsPlaying(true);
      }
      setTimeout(() => prewarm(idx + 1), 200);
    };

    const doSwap = () => {
      if (gen !== swapGenRef.current) return;
      if (localTime > 0.05) {
        sv.currentTime = localTime;
        sv.addEventListener('seeked', () => {
          if (gen !== swapGenRef.current) return;
          if (sv.readyState >= 2) finishSwap();
          else sv.addEventListener('canplay', finishSwap, { once: true });
        }, { once: true });
      } else {
        finishSwap();
      }
    };

    if (sv.readyState >= 3) doSwap();
    else sv.addEventListener('canplay', doSwap, { once: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── onEnded ────────────────────────────────────────────────────────────────
  const onEnded = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    const nextIdx = curIdxRef.current + 1;
    if (nextIdx < clipsRef.current.length) loadClip(nextIdx, 0, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── syncDuration — same actual-duration override pattern as useProjectPlayer
  const syncDuration = useCallback((v: HTMLVideoElement) => {
    if (!v.duration || !isFinite(v.duration) || v.duration <= 0) return;
    let idx = -1;
    if (v === videoRef.current) {
      idx = curIdxRef.current;
    } else {
      const sid = standbyIdRef.current;
      if (sid) idx = clipsRef.current.findIndex(c => c.id === sid);
    }
    if (idx < 0) return;
    const prev = actualDursRef.current[idx] || 0;
    if (Math.abs(v.duration - prev) < 0.05) return;
    actualDursRef.current[idx] = v.duration;
    const newTotal = actualDursRef.current.reduce(
      (s, d, i) => s + (d || clipsRef.current[i]?.duration || 0), 0,
    );
    setTotalDuration(newTotal);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── onTick — driven by timeupdate (~4–10 Hz) not RAF (60 Hz) ─────────────
  // scrubbingRef + swappingRef guards mirror useProjectPlayer.onTick().
  const onTick = useCallback(() => {
    if (scrubbingRef.current || swappingRef.current) return;
    const v   = videoRef.current;
    const cls = clipsRef.current;
    const idx = curIdxRef.current;
    if (!v || !cls[idx]) return;

    // computeSegmentOffset from shared core — same math as the viewer
    const offset = computeSegmentOffset(actualDursRef.current, fallbackDurs(), idx);
    const gt     = offset + v.currentTime;
    setGlobalTime(gt);
    onTimeUpdateRef.current(gt);

    // Prewarm at 30 s before end — matches useProjectPlayer's threshold
    const dur = actualDursRef.current[idx] || cls[idx].duration || 0;
    if (dur > 0 && dur - v.currentTime < 30) prewarm(idx + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── mount ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let destroyed = false;
    const setup = async () => {
      const HlsLib = (await import('hls.js')).default;
      if (destroyed) return;
      hlsLibRef.current = HlsLib;
      const vA = videoARef.current!;
      const vB = videoBRef.current!;
      videoRef.current   = vA;
      standbyRef.current = vB;
      vA.style.zIndex = '2';
      vB.style.zIndex = '1';

      const firstClip = clipsRef.current[0];
      if (HlsLib.isSupported()) {
        // HLS_OPTS from shared core — same ABR/buffer config as the viewer
        const hA = new HlsLib(HLS_OPTS);
        hlsRef.current        = hA;
        hlsStandbyRef.current = new HlsLib(HLS_OPTS_STANDBY);
        if (firstClip) attachHlsSource(vA, firstClip.hlsUrl, firstClip.rawUrl, hA, HlsLib);
      } else {
        if (firstClip) attachHlsSource(vA, firstClip.hlsUrl, firstClip.rawUrl, null, null);
      }

      const addListeners = (v: HTMLVideoElement) => {
        v.addEventListener('loadedmetadata', () => syncDuration(v));
        v.addEventListener('timeupdate',     () => { if (v === videoRef.current) onTick(); });
        v.addEventListener('play',  () => { if (v !== videoRef.current) return; setIsPlaying(true);  isPlayingRef.current = true; });
        v.addEventListener('pause', () => { if (v !== videoRef.current) return; setIsPlaying(false); isPlayingRef.current = false; });
        v.addEventListener('ended', () => { if (v === videoRef.current) onEnded(); });
      };
      addListeners(vA);
      addListeners(vB);
      prewarm(1);
    };
    setup();
    return () => {
      destroyed = true;
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-attach first clip when a video is uploaded while the editor is open
  const prevClipCountRef = useRef(0);
  useEffect(() => {
    const prev = prevClipCountRef.current;
    prevClipCountRef.current = clips.length;
    if (prev === 0 && clips.length > 0 && videoRef.current && hlsLibRef.current) {
      attachHlsSource(videoRef.current, clips[0].hlsUrl, clips[0].rawUrl, hlsRef.current, hlsLibRef.current);
      setTimeout(() => prewarm(1), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.length]);

  // ── seek ───────────────────────────────────────────────────────────────────
  // Uses globalToLocal from shared core — same global→(segment, localTime)
  // mapping as useProjectPlayer.endScrub().
  const seek = useCallback((globalSec: number, resumePlay?: boolean) => {
    const cls  = clipsRef.current;
    const { segIdx, localTime } = globalToLocal(
      globalSec,
      actualDursRef.current,
      fallbackDurs(),
      cls.length,
    );
    const shouldPlay = resumePlay !== undefined ? resumePlay : isPlayingRef.current;

    // Snap display immediately so the progress bar doesn't lag
    setGlobalTime(globalSec);
    onTimeUpdateRef.current(globalSec);

    if (segIdx === curIdxRef.current) {
      swapGenRef.current++;
      const v = videoRef.current;
      if (!v) return;
      hlsRef.current?.startLoad();
      v.currentTime = localTime;
      if (shouldPlay) {
        v.addEventListener('seeked', () => { v.play().catch(() => {}); }, { once: true });
      }
    } else {
      loadClip(segIdx, localTime, shouldPlay);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // startScrub / endScrub ensure seek fires exactly once (on mouseup), not
  // on every pixel of a drag.  Mirrors useProjectPlayer's startScrub/endScrub.
  const startScrub = useCallback(() => {
    scrubbingRef.current  = true;
    wasPlayingRef.current = isPlayingRef.current;
    videoRef.current?.pause();
    hlsStandbyRef.current?.stopLoad();
  }, []);

  const endScrub = useCallback((globalSec: number) => {
    const wp = wasPlayingRef.current;
    scrubbingRef.current = false;
    seek(globalSec, wp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek]);

  const play  = useCallback(() => { videoRef.current?.play().catch(() => {}); }, []);
  const pause = useCallback(() => { videoRef.current?.pause(); }, []);

  return {
    videoARef, videoBRef,
    globalTime, currentClipIdx, isPlaying, totalDuration,
    play, pause, seek, startScrub, endScrub,
  };
}
