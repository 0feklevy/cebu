'use client';

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useEditorPlayback } from '../hooks/useEditorPlayback';
import { HLS_OPTS } from '../hooks/useSegmentedPlaybackCore';
import type { Clip } from '../hooks/useClipSequence';
import type { TimelineSection } from 'shared/src/generated/client-v1';

export type { Clip };

const IS_DEV = process.env.NODE_ENV === 'development';

export interface VideoPlayerHandle {
  seek(globalSec: number): void;
}

interface SingleClipProps {
  src?: string | null;
  hlsUrl?: string | null;
  hlsStatus?: string;
  clips?: undefined;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
}

interface MultiClipProps {
  clips: Clip[];
  src?: undefined;
  hlsUrl?: undefined;
  hlsStatus?: undefined;
  timelineDuration?: number;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
  activeSimSection?: TimelineSection | null;
  activeBrollSection?: TimelineSection | null;
  brollHlsUrl?: string | null;
}

type Props = SingleClipProps | MultiClipProps;

// ── Multi-clip player (dual-buffer) ──────────────────────────────────────────

interface MultiClipPlayerProps {
  clips: Clip[];
  timelineDuration?: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
  activeSimSection?: TimelineSection | null;
  activeBrollSection?: TimelineSection | null;
  brollHlsUrl?: string | null;
  imperativeRef: React.RefObject<VideoPlayerHandle | null>;
}

function MultiClipPlayer({ clips, timelineDuration, onTimeUpdate, sectionLabel, activeSimSection, activeBrollSection, brollHlsUrl, imperativeRef }: MultiClipPlayerProps) {
  const [speed, setSpeed] = useState(1);
  // scrubDisplay: non-null while the user is dragging the seek bar — used for
  // visual feedback only; the actual seek fires once on mouseup/touchend.
  const [scrubDisplay, setScrubDisplay] = useState<number | null>(null);

  // ── broll overlay state ───────────────────────────────────────────────────
  const brollVideoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brollHlsRef   = useRef<any>(null);

  // ── sim overlay state ─────────────────────────────────────────────────────
  const simFrameRef     = useRef<HTMLIFrameElement>(null);
  const simReadyRef     = useRef(false);
  const simPollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingSimRef   = useRef<{ script: string; params: Record<string, boolean> } | null>(null);
  const activeSimUrlRef = useRef<string | null>(null);
  const [simUrl, setSimUrl]          = useState<string | null>(null);
  const [showSimOverlay, setShowSim] = useState(false);

  const sendToSim = (msg: object) => {
    try { simFrameRef.current?.contentWindow?.postMessage(msg, '*'); } catch (_) {}
  };

  const startSimPoll = useCallback(() => {
    if (simPollRef.current) clearInterval(simPollRef.current);
    let attempts = 0;
    simPollRef.current = setInterval(() => {
      if (simReadyRef.current || ++attempts > 40) {
        if (simPollRef.current) clearInterval(simPollRef.current);
        return;
      }
      sendToSim({ type: 'PING_SIM_READY' });
    }, 300);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── shared playback engine (viewer-quality) ───────────────────────────────
  const hook = useEditorPlayback(clips, onTimeUpdate, timelineDuration);

  useImperativeHandle(imperativeRef, () => ({
    seek: (globalSec: number) => hook.seek(globalSec),
  }));

  // ── postMessage listener (sim ready + user interaction) ───────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== simFrameRef.current?.contentWindow) return;
      const { type } = (e.data as { type?: string }) ?? {};
      if (type === 'SIM_READY') {
        simReadyRef.current = true;
        if (simPollRef.current) clearInterval(simPollRef.current);
        const pending = pendingSimRef.current;
        pendingSimRef.current = null;
        if (pending) {
          setShowSim(true);
          sendToSim({ type: 'startScript', script: pending.script, params: pending.params });
        }
      }
      if (type === 'userInteraction') hook.pause();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // iframe load → reset ready + re-poll
  useEffect(() => {
    const frame = simFrameRef.current;
    if (!frame) return;
    const onLoad = () => { simReadyRef.current = false; startSimPoll(); };
    frame.addEventListener('load', onLoad);
    return () => frame.removeEventListener('load', onLoad);
  }, [startSimPoll]);

  // poll cleanup on unmount
  useEffect(() => () => { if (simPollRef.current) clearInterval(simPollRef.current); }, []);

  // ── broll video: load / unload HLS ───────────────────────────────────────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v) return;
    brollHlsRef.current?.destroy();
    brollHlsRef.current = null;
    if (!brollHlsUrl) { v.src = ''; return; }
    let destroyed = false;
    const setup = async () => {
      const HlsLib = (await import('hls.js')).default;
      if (destroyed) return;
      if (HlsLib.isSupported()) {
        const hls = new HlsLib(HLS_OPTS);
        hls.loadSource(brollHlsUrl);
        hls.attachMedia(v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hls.on(HlsLib.Events.ERROR, (_: string, d: any) => {
          if (!d.fatal) return;
          if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
          else if (d.type === 'mediaError') hls.recoverMediaError();
        });
        brollHlsRef.current = hls;
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = brollHlsUrl;
      }
    };
    setup();
    return () => { destroyed = true; brollHlsRef.current?.destroy(); brollHlsRef.current = null; };
  }, [brollHlsUrl]);

  // broll cleanup on unmount
  useEffect(() => () => { brollHlsRef.current?.destroy(); brollHlsRef.current = null; }, []);

  // ── broll/clip video: seek to correct position when section starts/ends ─────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v) return;
    if (!activeBrollSection) { v.pause(); return; }
    // For clip sections, clip_in_sec is the source video in-point;
    // for broll sections, start_sec is the in-point (usually 0).
    const inPoint = (activeBrollSection as unknown as { clip_in_sec?: number }).clip_in_sec
      ?? activeBrollSection.start_sec
      ?? 0;
    const brollTime = inPoint + (hook.globalTime - (activeBrollSection.global_offset_sec ?? 0));
    v.currentTime = Math.max(0, brollTime);
    if (hook.isPlaying) v.play().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrollSection?.id]);

  // ── broll video: sync volume from section's broll_volume field ────────────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v) return;
    const vol = (activeBrollSection as unknown as { broll_volume?: number })?.broll_volume;
    v.volume = typeof vol === 'number' ? Math.max(0, Math.min(1, vol)) : 1.0;
  }, [activeBrollSection?.id, (activeBrollSection as unknown as { broll_volume?: number })?.broll_volume]);

  // ── broll/clip video: resync drift on every global-time tick ────────────────
  // Runs at timeupdate rate (~8–10 Hz), not 60 Hz — drift check is cheap.
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v || !activeBrollSection) return;
    const inPoint = (activeBrollSection as unknown as { clip_in_sec?: number }).clip_in_sec
      ?? activeBrollSection.start_sec
      ?? 0;
    const expected = inPoint + (hook.globalTime - (activeBrollSection.global_offset_sec ?? 0));
    if (Math.abs(v.currentTime - expected) > 1.0) v.currentTime = Math.max(0, expected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook.globalTime]);

  // ── broll video: play / pause in sync with main ──────────────────────────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v || !activeBrollSection) return;
    if (hook.isPlaying && v.paused)    v.play().catch(() => {});
    else if (!hook.isPlaying && !v.paused) v.pause();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook.isPlaying, activeBrollSection?.id]);

  // ── sim section boundary crossings ───────────────────────────────────────
  useEffect(() => {
    const newUrl = activeSimSection?.simulation_url ?? null;
    const script  = activeSimSection?.sim_script ?? 'main';
    // Pass the section's toggle values so the bridge can apply simpleUi / autoScript
    const params  = {
      simpleUi:   activeSimSection?.simple_ui   ?? false,
      autoScript: activeSimSection?.auto_script  ?? true,
    };
    if (!newUrl) {
      if (activeSimUrlRef.current) {
        sendToSim({ type: 'stopScript' });
        setTimeout(() => setShowSim(false), 350);
      }
      activeSimUrlRef.current = null;
      return;
    }
    const sameUrl = newUrl === activeSimUrlRef.current;
    activeSimUrlRef.current = newUrl;
    setSimUrl(newUrl);
    if (sameUrl && simReadyRef.current) {
      setShowSim(true);
      sendToSim({ type: 'startScript', script, params });
    } else {
      simReadyRef.current   = false;
      pendingSimRef.current = { script, params };
      if (!sameUrl) startSimPoll();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSimSection?.id, activeSimSection?.simulation_url]);

  // ── playback speed ────────────────────────────────────────────────────────
  useEffect(() => {
    const vA = hook.videoARef.current;
    const vB = hook.videoBRef.current;
    if (vA) vA.playbackRate = speed;
    if (vB) vB.playbackRate = speed;
  }, [speed, hook.videoARef, hook.videoBRef]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  const displayTime   = scrubDisplay ?? hook.globalTime;
  const totalDuration = Math.max(hook.totalDuration, timelineDuration ?? 0);

  // ── seek bar handlers — scrub fires exactly once on release ──────────────
  const handleScrubStart = useCallback(() => {
    hook.startScrub();
  }, [hook]);

  const handleScrubMove = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubDisplay(parseFloat(e.target.value));
  }, []);

  const handleScrubEnd = useCallback((e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    setScrubDisplay(null);
    hook.endScrub(val);
  }, [hook]);

  return (
    <div className="flex-1 relative bg-black rounded-lg overflow-hidden shadow-card">
      {/* Video A — initial z=2 (main), swapped by hook on clip transitions */}
      <video
        ref={hook.videoARef}
        className="absolute inset-0 w-full h-full object-contain"
        style={{ zIndex: 2 }}
        playsInline
        preload="auto"
      />
      {/* Video B — initial z=1 (standby), pre-warms the next clip */}
      <video
        ref={hook.videoBRef}
        className="absolute inset-0 w-full h-full object-contain"
        style={{ zIndex: 1 }}
        playsInline
        preload="auto"
      />

      {/* B-roll overlay */}
      <video
        ref={brollVideoRef}
        className="absolute inset-0 w-full h-full"
        style={{
          zIndex: 3,
          objectFit: 'cover',
          opacity: activeBrollSection && !showSimOverlay ? 1 : 0,
          transition: 'opacity 150ms ease',
          pointerEvents: 'none',
        }}
        playsInline
        preload="auto"
      />

      {/* No source yet */}
      {clips.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ zIndex: 5 }}>
          <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-3" />
          <p className="text-xs text-white/40">Preparing video…</p>
        </div>
      )}

      {/* Simulation overlay */}
      {simUrl && (
        <div
          className="absolute inset-0"
          style={{
            zIndex: 5,
            background: '#0e0e0e',
            opacity: showSimOverlay ? 1 : 0,
            pointerEvents: showSimOverlay ? 'auto' : 'none',
            transition: 'opacity 350ms ease',
          }}
        >
          <iframe
            ref={simFrameRef}
            src={simUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms"
            title="Interactive simulation"
          />
        </div>
      )}

      {sectionLabel && !showSimOverlay && (
        <div className="absolute top-3 left-3 bg-black/70 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm" style={{ zIndex: 10 }}>
          {sectionLabel}
        </div>
      )}

      {clips.length > 1 && (
        <div className="absolute top-3 right-3 bg-black/60 text-white/70 text-[10px] font-semibold px-2 py-0.5 rounded-md" style={{ zIndex: 10 }}>
          {hook.currentClipIdx + 1}/{clips.length}
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-0 left-0 right-0 px-4 py-2.5 space-y-2" style={{ zIndex: 10, background: 'linear-gradient(180deg,rgba(2,6,23,0),rgba(2,6,23,0.9) 22%,rgba(2,6,23,0.96))', backdropFilter: 'blur(10px)' }}>
        <input
          type="range"
          min={0}
          max={totalDuration || 1}
          step={0.1}
          value={displayTime}
          onChange={handleScrubMove}
          onMouseDown={handleScrubStart}
          onMouseUp={handleScrubEnd}
          onTouchStart={handleScrubStart}
          onTouchEnd={handleScrubEnd}
          className="w-full h-1 accent-primary cursor-pointer"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => hook.isPlaying ? hook.pause() : hook.play()}
              className="text-white hover:text-violet-300 transition-colors focus-ring rounded"
            >
              {hook.isPlaying ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <rect x="4" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                  <rect x="10.5" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M5 3l11 6-11 6V3z" fill="currentColor" />
                </svg>
              )}
            </button>
            <span className="text-xs text-white/70 font-mono">
              {fmt(displayTime)} / {fmt(totalDuration)}
            </span>
          </div>
          <div className="flex gap-1">
            {([0.5, 1, 1.5, 2] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors focus-ring ${speed === s ? 'bg-violet-500 text-white' : 'text-white/50 hover:text-white'}`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Single-clip player (existing code path, unchanged) ───────────────────────

interface SingleClipPlayerProps {
  src?: string | null;
  hlsUrl?: string | null;
  hlsStatus?: string;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
  imperativeRef: React.RefObject<VideoPlayerHandle | null>;
}

function SingleClipPlayer({ src, hlsUrl, hlsStatus, currentTime, onTimeUpdate, sectionLabel, imperativeRef }: SingleClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seekingRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsRef = useRef<any>(null);

  const prevSrcRef = useRef<string | null>(null);
  const prevHlsRef = useRef<string | null>(null);

  const transcoding = hlsStatus === 'pending' || hlsStatus === 'processing';
  const effectiveSrc = hlsUrl ?? src;

  // Expose seek imperatively
  useImperativeHandle(imperativeRef, () => ({
    seek(globalSec: number) {
      const v = videoRef.current;
      if (!v) return;
      seekingRef.current = true;
      v.currentTime = globalSec;
    },
  }));

  const logMedia = useCallback((evt: string) => {
    if (!IS_DEV) return;
    const v = videoRef.current;
    if (!v) return;
    const safeSrc = v.currentSrc ? v.currentSrc.split('?')[0] : null;
    console.log(`[VideoPlayer:media] ${evt}`, {
      readyState: v.readyState,
      networkState: v.networkState,
      currentTime: v.currentTime,
      duration: v.duration,
      currentSrc: safeSrc,
      errorCode: v.error?.code,
    });
  }, []);

  useEffect(() => {
    setLoadError(null);
    setIsLoading(!!effectiveSrc);
    setDuration(0);
    if (IS_DEV) {
      console.log('[VideoPlayer] source transition', {
        rawSrc: src,
        hlsUrl,
        effectiveSrc,
        srcChanged: src !== prevSrcRef.current,
        hlsChanged: hlsUrl !== prevHlsRef.current,
      });
      prevSrcRef.current = src ?? null;
      prevHlsRef.current = hlsUrl ?? null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSrc]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (!hlsUrl) {
      if (src) { v.src = src; v.load(); }
      else v.removeAttribute('src');
      return;
    }
    let destroyed = false;
    const setup = async () => {
      const HlsLib = (await import('hls.js')).default;
      if (destroyed) return;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (HlsLib.isSupported()) {
        const hls = new HlsLib(HLS_OPTS);
        hls.loadSource(hlsUrl);
        hls.attachMedia(v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hls.on(HlsLib.Events.ERROR, (_: string, d: any) => {
          if (!d.fatal) return;
          if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
          else if (d.type === 'mediaError') hls.recoverMediaError();
          else { if (src) v.src = src; else setLoadError('HLS playback failed.'); }
        });
        hlsRef.current = hls;
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = hlsUrl;
      } else if (src) {
        v.src = src;
      } else {
        setLoadError('HLS is not supported in this browser.');
      }
    };
    setup();
    return () => { destroyed = true; hlsRef.current?.destroy(); hlsRef.current = null; };
  }, [hlsUrl, src]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - currentTime) > 0.3) {
      seekingRef.current = true;
      v.currentTime = currentTime;
    }
  }, [currentTime]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex-1 relative bg-black rounded-lg overflow-hidden shadow-card">
      {effectiveSrc ? (
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain"
          onTimeUpdate={() => {
            if (!videoRef.current || seekingRef.current) return;
            onTimeUpdate(videoRef.current.currentTime);
          }}
          onSeeked={() => { seekingRef.current = false; if (videoRef.current) onTimeUpdate(videoRef.current.currentTime); }}
          onLoadedMetadata={() => { logMedia('loadedmetadata'); setDuration(videoRef.current?.duration ?? 0); }}
          onLoadedData={() => { logMedia('loadeddata'); setIsLoading(false); setLoadError(null); }}
          onCanPlay={() => { logMedia('canplay'); setIsLoading(false); }}
          onCanPlayThrough={() => logMedia('canplaythrough')}
          onPlay={() => { logMedia('play'); setPlaying(true); }}
          onPause={() => { logMedia('pause'); setPlaying(false); }}
          onEnded={() => { logMedia('ended'); setPlaying(false); }}
          onError={() => {
            logMedia('error');
            setPlaying(false); setIsLoading(false);
            const code = videoRef.current?.error?.code;
            if (code === 4) setLoadError('This video format is not supported.');
            else if (code === 2) setLoadError('Network error — could not load video.');
            else setLoadError('Video could not be loaded.');
          }}
          onWaiting={() => { logMedia('waiting'); setIsLoading(true); }}
          onPlaying={() => { logMedia('playing'); setIsLoading(false); }}
          onStalled={() => logMedia('stalled')}
          playsInline
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-3" />
          <p className="text-xs text-white/40">Preparing video…</p>
        </div>
      )}

      {isLoading && !loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mb-3" />
          <p className="text-white/60 text-xs">{transcoding ? 'Preparing preview…' : 'Loading…'}</p>
        </div>
      )}

      {loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 px-6 text-center pb-16">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="text-red-400 mb-3" aria-hidden>
            <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.5" />
            <path d="M16 9v8M16 21v1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <p className="text-white/90 text-sm font-medium mb-1">Playback error</p>
          <p className="text-white/50 text-xs mb-4">{loadError}</p>
          {src && (
            <button
              onClick={() => { const v = videoRef.current; if (!v) return; setLoadError(null); setIsLoading(true); v.src = src; v.load(); }}
              className="h-7 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors"
            >
              Retry
            </button>
          )}
          {transcoding && (
            <p className="text-amber-400/80 text-xs mt-3">
              HD version is still processing — raw preview will be available shortly.
            </p>
          )}
        </div>
      )}

      {sectionLabel && !loadError && (
        <div className="absolute top-3 left-3 bg-black/70 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm">
          {sectionLabel}
        </div>
      )}

      {transcoding && !loadError && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-amber-500/90 text-black text-xs font-semibold px-2 py-1 rounded-md">
          <span className="w-1.5 h-1.5 bg-black rounded-full animate-pulse" />
          {hlsStatus === 'processing' ? 'Transcoding…' : 'Queued'}
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 px-4 py-2.5 space-y-2" style={{ background: 'linear-gradient(180deg,rgba(2,6,23,0),rgba(2,6,23,0.9) 22%,rgba(2,6,23,0.96))', backdropFilter: 'blur(10px)' }}>
        <input
          type="range" min={0} max={duration || 1} step={0.1} value={currentTime}
          onChange={(e) => {
            const t = parseFloat(e.target.value);
            if (videoRef.current) videoRef.current.currentTime = t;
            onTimeUpdate(t);
          }}
          className="w-full h-1 accent-primary cursor-pointer"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) { v.play().catch(() => setPlaying(false)); setPlaying(true); }
                else { v.pause(); setPlaying(false); }
              }}
              className="text-white hover:text-violet-300 transition-colors focus-ring rounded"
            >
              {playing ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <rect x="4" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                  <rect x="10.5" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M5 3l11 6-11 6V3z" fill="currentColor" />
                </svg>
              )}
            </button>
            <span className="text-xs text-white/70 font-mono">{fmt(currentTime)} / {fmt(duration)}</span>
          </div>
          <div className="flex gap-1">
            {([0.5, 1, 1.5, 2] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors focus-ring ${speed === s ? 'bg-violet-500 text-white' : 'text-white/50 hover:text-white'}`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(props, ref) {
  // Internal ref that both sub-components share for imperative handle
  const imperativeRef = useRef<VideoPlayerHandle>(null);

  // Forward the internal ref out to the parent via forwardRef
  useImperativeHandle(ref, () => ({
    seek(globalSec: number) {
      imperativeRef.current?.seek(globalSec);
    },
  }));

  if (props.clips !== undefined) {
    return (
      <MultiClipPlayer
        clips={props.clips}
        timelineDuration={props.timelineDuration}
        onTimeUpdate={props.onTimeUpdate}
        sectionLabel={props.sectionLabel}
        activeSimSection={props.activeSimSection}
        activeBrollSection={props.activeBrollSection}
        brollHlsUrl={props.brollHlsUrl}
        imperativeRef={imperativeRef}
      />
    );
  }

  return (
    <SingleClipPlayer
      src={props.src}
      hlsUrl={props.hlsUrl}
      hlsStatus={props.hlsStatus}
      currentTime={props.currentTime}
      onTimeUpdate={props.onTimeUpdate}
      sectionLabel={props.sectionLabel}
      imperativeRef={imperativeRef}
    />
  );
});
