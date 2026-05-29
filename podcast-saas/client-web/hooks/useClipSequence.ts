'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface Clip {
  id: string;
  hlsUrl: string | null;
  rawUrl: string | null;
  duration: number;
}

const HLS_OPTS = {
  enableWorker: true,
  startLevel: -1,
  capLevelToPlayerSize: true,
  startFragPrefetch: false,
  maxBufferLength: 15,
  maxMaxBufferLength: 30,
  backBufferLength: 5,
  abrEwmaDefaultEstimate: 500_000,
  fragLoadingTimeOut: 20_000,
  manifestLoadingTimeOut: 10_000,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 5,
};

const HLS_OPTS_STANDBY = { ...HLS_OPTS, startLevel: 0, maxBufferLength: 8 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hlsErrHandlers = new WeakMap<object, (e: string, d: any) => void>();

// Use actual durations from the ref array when available; fall back to clip.duration.
// This ensures offsets and total are correct even when duration_sec is null/0 in the DB.
function clipOffset(actualDurs: number[], clips: Clip[], idx: number): number {
  let off = 0;
  for (let i = 0; i < idx; i++) off += actualDurs[i] || clips[i].duration || 0;
  return off;
}

export interface UseClipSequenceResult {
  videoARef: RefObject<HTMLVideoElement | null>;
  videoBRef: RefObject<HTMLVideoElement | null>;
  globalTime: number;
  currentClipIdx: number;
  isPlaying: boolean;
  totalDuration: number;
  play(): void;
  pause(): void;
  seek(globalSec: number): void;
}

export function useClipSequence(
  clips: Clip[],
  onTimeUpdate: (globalSec: number) => void,
): UseClipSequenceResult {
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
  const clipsRef      = useRef<Clip[]>(clips);
  const curIdxRef     = useRef(0);
  const swapGenRef    = useRef(0);
  const standbyIdRef  = useRef<string | null>(null);
  const rafRef        = useRef(0);
  const isPlayingRef  = useRef(false);
  const onTimeUpdateRef = useRef(onTimeUpdate);

  // Actual durations learned from video elements — overrides clip.duration.
  // Indexed by clip position (not id) so offset recalculation is O(n).
  const actualDursRef = useRef<number[]>(clips.map(c => c.duration || 0));

  const [globalTime, setGlobalTime]         = useState(0);
  const [currentClipIdx, setCurrentClipIdx] = useState(0);
  const [isPlaying, setIsPlaying]           = useState(false);
  const [totalDuration, setTotalDuration]   = useState(
    () => clips.reduce((s, c) => s + (c.duration || 0), 0),
  );

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

  // When clips prop changes length (new upload), extend actualDursRef and update total
  useEffect(() => {
    while (actualDursRef.current.length < clips.length) {
      actualDursRef.current.push(clips[actualDursRef.current.length]?.duration || 0);
    }
    const newTotal = actualDursRef.current.reduce(
      (s, d, i) => s + (d || clipsRef.current[i]?.duration || 0), 0
    );
    if (newTotal > 0) setTotalDuration(newTotal);
  }, [clips.length]);

  // ── attachSource ─────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachSource = useCallback((el: HTMLVideoElement, clip: Clip, hls: any) => {
    const HlsLib = hlsLibRef.current;
    const useHlsJs = HlsLib && HlsLib.isSupported() && clip.hlsUrl;

    if (useHlsJs && hls) {
      hls.stopLoad();
      hls.detachMedia();
      hls.loadSource(clip.hlsUrl);
      hls.attachMedia(el);
      const prev = _hlsErrHandlers.get(hls);
      if (prev) hls.off(HlsLib.Events.ERROR, prev);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onErr = (_: string, d: any) => {
        if (!d.fatal) return;
        if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
        else if (d.type === 'mediaError') hls.recoverMediaError();
        else if (clip.rawUrl) { el.src = clip.rawUrl; el.load(); }
      };
      _hlsErrHandlers.set(hls, onErr);
      hls.on(HlsLib.Events.ERROR, onErr);
    } else if (clip.hlsUrl && el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = clip.hlsUrl;
    } else if (clip.rawUrl) {
      el.src = clip.rawUrl;
      el.load();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── prewarm ───────────────────────────────────────────────────────────────
  const prewarm = useCallback((idx: number) => {
    const clips = clipsRef.current;
    if (idx < 0 || idx >= clips.length || !standbyRef.current) return;
    const clip = clips[idx]!;
    if (standbyIdRef.current === clip.id) return;
    standbyIdRef.current = clip.id;
    attachSource(standbyRef.current, clip, hlsStandbyRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── swapVideos ────────────────────────────────────────────────────────────
  const swapVideos = useCallback(() => {
    const a = videoRef.current!;
    const b = standbyRef.current!;
    b.style.zIndex = '2';
    a.style.zIndex = '1';
    videoRef.current   = b;
    standbyRef.current = a;
    [hlsRef.current, hlsStandbyRef.current] = [hlsStandbyRef.current, hlsRef.current];
    standbyIdRef.current = null;
    a.pause();
    hlsStandbyRef.current?.stopLoad();
    hlsStandbyRef.current?.detachMedia();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── loadClip ──────────────────────────────────────────────────────────────
  const loadClip = useCallback((idx: number, localTime = 0, forcePlay = true) => {
    swapGenRef.current++;
    const gen = swapGenRef.current;
    const clips = clipsRef.current;
    if (idx < 0 || idx >= clips.length) return;
    const clip = clips[idx];
    curIdxRef.current = idx;
    setCurrentClipIdx(idx);

    hlsRef.current?.stopLoad();

    if (standbyIdRef.current !== clip.id) {
      standbyIdRef.current = clip.id;
      attachSource(standbyRef.current!, clip, hlsStandbyRef.current);
    }

    const sv = standbyRef.current!;

    const finishSwap = () => {
      if (gen !== swapGenRef.current) return;
      swapVideos();
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

  // ── onEnded ───────────────────────────────────────────────────────────────
  const onEnded = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    const nextIdx = curIdxRef.current + 1;
    if (nextIdx < clipsRef.current.length) {
      loadClip(nextIdx, 0, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── RAF tick ──────────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const v = videoRef.current;
    const clips = clipsRef.current;
    const idx = curIdxRef.current;
    const clip = clips[idx];
    if (v && clip) {
      // Use actual durations for offset so bar stays in sync with real video duration
      const offset = clipOffset(actualDursRef.current, clips, idx);
      const gt = offset + v.currentTime;
      setGlobalTime(gt);
      onTimeUpdateRef.current(gt);
      const dur = actualDursRef.current[idx] || clip.duration || 0;
      if (dur > 0 && dur - v.currentTime < 8) prewarm(idx + 1);
    }
    rafRef.current = requestAnimationFrame(tick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync actual duration from video element ───────────────────────────────
  const syncDuration = useCallback((v: HTMLVideoElement) => {
    if (!v.duration || !isFinite(v.duration) || v.duration <= 0) return;

    // Find which clip index this video corresponds to
    let idx = -1;
    if (v === videoRef.current) {
      idx = curIdxRef.current;
    } else {
      const sid = standbyIdRef.current;
      if (sid) idx = clipsRef.current.findIndex(c => c.id === sid);
    }
    if (idx < 0) return;

    const prev = actualDursRef.current[idx] || 0;
    if (Math.abs(v.duration - prev) < 0.05) return; // negligible

    actualDursRef.current[idx] = v.duration;

    // Recompute total — fall back to clip.duration for entries not yet loaded
    const newTotal = actualDursRef.current.reduce(
      (s, d, i) => s + (d || clipsRef.current[i]?.duration || 0), 0
    );
    setTotalDuration(newTotal);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── mount setup ───────────────────────────────────────────────────────────
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
        const hA = new HlsLib(HLS_OPTS);
        hlsRef.current        = hA;
        hlsStandbyRef.current = new HlsLib(HLS_OPTS_STANDBY);
        if (firstClip) attachSource(vA, firstClip, hA);
      } else {
        if (firstClip) attachSource(vA, firstClip, null);
      }

      const attachListeners = (v: HTMLVideoElement) => {
        v.addEventListener('loadedmetadata', () => syncDuration(v));
        v.addEventListener('play',  () => { if (v !== videoRef.current) return; setIsPlaying(true);  isPlayingRef.current = true; });
        v.addEventListener('pause', () => { if (v !== videoRef.current) return; setIsPlaying(false); isPlayingRef.current = false; });
        v.addEventListener('ended', () => { if (v === videoRef.current) onEnded(); });
      };
      attachListeners(vA);
      attachListeners(vB);

      prewarm(1);
      rafRef.current = requestAnimationFrame(tick);
    };

    setup();

    return () => {
      destroyed = true;
      cancelAnimationFrame(rafRef.current);
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-attach first clip if videos were loaded after mount (e.g. upload while editor is open)
  const prevClipCountRef = useRef(0);
  useEffect(() => {
    const prev = prevClipCountRef.current;
    prevClipCountRef.current = clips.length;
    if (prev === 0 && clips.length > 0 && videoRef.current && hlsLibRef.current) {
      attachSource(videoRef.current, clips[0], hlsRef.current);
      setTimeout(() => prewarm(1), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.length]);

  // ── seek(globalSec) ──────────────────────────────────────────────────────
  const seek = useCallback((globalSec: number) => {
    const clips = clipsRef.current;
    const durs  = actualDursRef.current;
    let targetIdx = 0;
    let offset = 0;
    for (let i = 0; i < clips.length; i++) {
      const dur = durs[i] || clips[i].duration || 0;
      const end = offset + dur;
      if (globalSec < end) { targetIdx = i; break; }
      offset = end;
      targetIdx = i;
    }
    const localTime = Math.max(0, globalSec - clipOffset(durs, clips, targetIdx));
    const wasPlaying = isPlayingRef.current;

    if (targetIdx === curIdxRef.current) {
      swapGenRef.current++;
      const v = videoRef.current;
      if (!v) return;
      hlsRef.current?.startLoad();
      v.currentTime = localTime;
      if (wasPlaying) {
        v.addEventListener('seeked', () => v.play().catch(() => {}), { once: true });
      }
    } else {
      loadClip(targetIdx, localTime, wasPlaying);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play  = useCallback(() => { videoRef.current?.play().catch(() => {}); }, []);
  const pause = useCallback(() => { videoRef.current?.pause(); }, []);

  return {
    videoARef,
    videoBRef,
    globalTime,
    currentClipIdx,
    isPlaying,
    totalDuration,
    play,
    pause,
    seek,
  };
}
