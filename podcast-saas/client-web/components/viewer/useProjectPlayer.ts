'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip } from './types';

// ── HLS.js config (ported from interactive-podcast-react/player/src/constants/index.ts) ──
const HLS_OPTS = {
  enableWorker: true,
  startLevel: -1,
  capLevelToPlayerSize: true,
  startFragPrefetch: false,
  maxBufferLength: 15,
  maxMaxBufferLength: 30,
  backBufferLength: 5,
  abrEwmaDefaultEstimate: 500_000,
  abrEwmaFastHalf: 2,
  fragLoadingTimeOut: 20_000,
  manifestLoadingTimeOut: 10_000,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 5,
};
const HLS_OPTS_STANDBY       = { ...HLS_OPTS, startLevel: 0, maxBufferLength: 8 };
const HLS_OPTS_BROLL         = { ...HLS_OPTS, startLevel: -1, maxBufferLength: 10 };
const HLS_OPTS_BROLL_STANDBY = { ...HLS_OPTS, startLevel: -1, maxBufferLength: 20 };

export interface ProjectPlayerRefs {
  videoA:             RefObject<HTMLVideoElement | null>;
  videoB:             RefObject<HTMLVideoElement | null>;
  videoBroll:         RefObject<HTMLVideoElement | null>;
  videoBrollStandby?: RefObject<HTMLVideoElement | null>;
  tapFeedback:        RefObject<HTMLDivElement | null>;
  progressFill:  RefObject<HTMLDivElement | null>;
  progressThumb: RefObject<HTMLDivElement | null>;
  progressBuf:   RefObject<HTMLDivElement | null>;
  progressTrack: RefObject<HTMLDivElement | null>;
  progressWrap:  RefObject<HTMLDivElement | null>;
  curTime:       RefObject<HTMLSpanElement | null>;
  totTime:       RefObject<HTMLSpanElement | null>;
  root:          RefObject<HTMLDivElement | null>;
  simFrame:      RefObject<HTMLIFrameElement | null>;
}

export interface ProjectPlayerState {
  playing:         boolean;
  started:         boolean;
  showResumeBtn:   boolean;
  showSimOverlay:  boolean;
  showBrollOverlay: boolean;
  controlsVisible: boolean;
  activeSimUrl:    string | null;
  currentSegIdx:   number;
  timeline:        TimelineSeg[];
  totalDuration:   number;
  badgeText:       string;
  badgeMode:       'sim' | 'free' | '';
}

export interface ProjectPlayerActions {
  startPlayback:    () => void;
  togglePlay:       () => void;
  handleVideoClick: () => void;
  resumeFromSim:    () => void;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function safePlay(v: HTMLVideoElement): Promise<void> {
  try { await v.play(); } catch (_) {}
}

function makeTimeline(segments: PlayerSegment[]): { segs: TimelineSeg[]; total: number } {
  const segs: TimelineSeg[] = [];
  let off = 0;
  for (const seg of segments) {
    segs.push({ id: seg.id, duration: seg.duration_sec, offset: off });
    off += seg.duration_sec;
  }
  return { segs, total: off };
}

// WeakMap tracks error handlers per Hls instance to allow precise removal
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hlsErrHandlers = new WeakMap<object, (e: string, d: any) => void>();

export function useProjectPlayer(
  config: PlayerConfig,
  refs: ProjectPlayerRefs,
): { state: ProjectPlayerState; actions: ProjectPlayerActions } {
  const { segs: initialSegs, total: initialTotal } = makeTimeline(config.segments);

  const [state, setState] = useState<ProjectPlayerState>({
    playing:          false,
    started:          false,
    showResumeBtn:    false,
    showSimOverlay:   false,
    showBrollOverlay: false,
    controlsVisible:  true,
    activeSimUrl:     null,
    currentSegIdx:    0,
    timeline:         initialSegs,
    totalDuration:    initialTotal,
    badgeText:        config.segments[0]?.label ?? '',
    badgeMode:        '',
  });

  const merge = (patch: Partial<ProjectPlayerState>) =>
    setState((s) => ({ ...s, ...patch }));

  const videoRef      = useRef<HTMLVideoElement | null>(null);
  const standbyRef    = useRef<HTMLVideoElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsRef        = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsStandbyRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsBrollRef         = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsBrollStandbyRef  = useRef<any>(null);
  const standbyBrollClipIdRef = useRef<string | null>(null);
  const timelineRef   = useRef<TimelineSeg[]>(initialSegs);
  const totalDurRef   = useRef(initialTotal);
  const curIdxRef     = useRef(0);
  const activeSimRef    = useRef<SimulationOverlay | null>(null);
  const activeSimUrlRef = useRef<string | null>(null);
  const activeBrollRef  = useRef<BrollClip | null>(null);
  const swappingRef     = useRef(false);
  const userPausedRef   = useRef(false);
  const simReadyRef     = useRef(false);
  const simPollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingSimRef   = useRef<{ script: string; params: Record<string, boolean> } | null>(null);
  const startedRef    = useRef(false);
  const scrubbingRef  = useRef(false);
  const wasPlayingRef = useRef(false);
  const swapGenRef    = useRef(0);
  const standbyIdRef  = useRef<string | null>(null);
  const idleTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const useHlsJsRef   = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsLibRef     = useRef<any>(null);

  // ── Sync timeline with actual video duration ──────────────────────────────
  const syncActualDuration = useCallback((v: HTMLVideoElement) => {
    if (!v.duration || !isFinite(v.duration) || v.duration <= 0) return;

    let segIdx = -1;
    if (v === videoRef.current) {
      segIdx = curIdxRef.current;
    } else {
      const sid = standbyIdRef.current;
      if (sid) segIdx = timelineRef.current.findIndex((s) => s.id === sid);
    }
    if (segIdx < 0) return;

    const stored = timelineRef.current[segIdx].duration;
    if (Math.abs(v.duration - stored) < 0.05) return;

    timelineRef.current[segIdx].duration = v.duration;
    let off = timelineRef.current[segIdx].offset;
    for (let i = segIdx; i < timelineRef.current.length; i++) {
      timelineRef.current[i].offset = off;
      off += timelineRef.current[i].duration;
    }
    totalDurRef.current = off;

    merge({ timeline: [...timelineRef.current], totalDuration: off });

    if (v === videoRef.current) setTotTime(off);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── DOM helpers ───────────────────────────────────────────────────────────
  const setProgress = (gt: number, tot = totalDurRef.current) => {
    const pct = Math.min(1, gt / Math.max(1, tot)) * 100;
    if (refs.progressFill.current)  refs.progressFill.current.style.width = `${pct}%`;
    if (refs.progressThumb.current) refs.progressThumb.current.style.left = `${pct}%`;
    if (refs.curTime.current)       refs.curTime.current.textContent = fmt(gt);
  };

  const setTotTime = (tot: number) => {
    if (refs.totTime.current) refs.totTime.current.textContent = fmt(tot);
  };

  const updateBuf = () => {
    const v   = videoRef.current;
    const seg = timelineRef.current[curIdxRef.current];
    if (!v?.duration || !v.buffered.length || !seg) return;
    const end = v.buffered.end(v.buffered.length - 1);
    const tot = totalDurRef.current;
    if (refs.progressBuf.current) {
      refs.progressBuf.current.style.left  = `${(seg.offset / tot) * 100}%`;
      refs.progressBuf.current.style.width = `${(end       / tot) * 100}%`;
    }
  };

  const globalTime = () =>
    (timelineRef.current[curIdxRef.current]?.offset ?? 0) + (videoRef.current?.currentTime ?? 0);

  // ── controls reveal ───────────────────────────────────────────────────────
  const hideControls = () => {
    clearTimeout(idleTimerRef.current ?? undefined);
    merge({ controlsVisible: false });
  };

  const scheduleHide = useCallback(() => {
    clearTimeout(idleTimerRef.current ?? undefined);
    if (startedRef.current && !videoRef.current?.paused) {
      idleTimerRef.current = setTimeout(() => merge({ controlsVisible: false }), 2500);
    }
  }, []);

  const showControls = useCallback(() => {
    merge({ controlsVisible: true });
    scheduleHide();
  }, [scheduleHide]);

  // ── postMessage helpers ───────────────────────────────────────────────────
  const sendToSim = (msg: object) => {
    try { refs.simFrame.current?.contentWindow?.postMessage(msg, '*'); } catch (_) {}
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

  // ── simulation overlay ────────────────────────────────────────────────────
  const updateSimOverlay = (segmentIdx: number, localTime: number) => {
    const seg = config.segments[segmentIdx];
    if (!seg) {
      if (activeSimRef.current) {
        sendToSim({ type: 'stopScript' });
        setTimeout(() => merge({ showSimOverlay: false }), 350);
      }
      activeSimRef.current = null;
      merge({ badgeText: '', badgeMode: '' });
      return;
    }

    const section    = seg.simulations.find((s) => localTime >= s.start_sec && localTime < s.end_sec) ?? null;
    const simSection = section?.simulation_url ? section : null;

    if (simSection !== null && simSection?.id === activeSimRef.current?.id) return;

    if (activeSimRef.current) {
      sendToSim({ type: 'stopScript' });
      setTimeout(() => merge({ showSimOverlay: false }), 350);
    }
    activeSimRef.current = simSection;

    if (simSection) {
      const script  = simSection.sim_script ?? 'main';
      const params  = { simpleUi: simSection.simple_ui ?? false, autoScript: simSection.auto_script ?? true };
      const sameUrl = simSection.simulation_url === activeSimUrlRef.current;
      activeSimUrlRef.current = simSection.simulation_url;
      merge({ activeSimUrl: simSection.simulation_url });

      if (sameUrl && simReadyRef.current) {
        merge({ showSimOverlay: true });
        sendToSim({ type: 'startScript', script, params });
      } else {
        simReadyRef.current   = false;
        pendingSimRef.current = { script, params };
        startSimPoll();
      }
    }

    merge({
      badgeText: section ? (section.label ?? section.type) : (seg.label ?? ''),
      badgeMode: section?.type === 'simulation' ? 'sim' : section ? 'free' : '',
    });
  };

  // ── broll overlay ─────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadBrollHls = (url: string, seekTo: number, HlsLib: any) => {
    const brollEl = refs.videoBroll.current;
    if (!brollEl) return;

    if (hlsBrollRef.current) {
      hlsBrollRef.current.stopLoad();
      hlsBrollRef.current.detachMedia();
      hlsBrollRef.current.destroy();
      hlsBrollRef.current = null;
    }

    if (useHlsJsRef.current && HlsLib?.isSupported()) {
      const hls = new HlsLib(HLS_OPTS_BROLL);
      hlsBrollRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(brollEl);
      hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
        brollEl.currentTime = Math.max(0, seekTo);
        brollEl.addEventListener('seeked', () => {
          if (!videoRef.current?.paused) safePlay(brollEl);
        }, { once: true });
      });
    } else if (brollEl.canPlayType('application/vnd.apple.mpegurl')) {
      brollEl.src = url;
      brollEl.load();
      brollEl.currentTime = Math.max(0, seekTo);
      if (!videoRef.current?.paused) safePlay(brollEl);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prewarmBroll = (clip: BrollClip, HlsLib: any) => {
    const standbyEl = refs.videoBrollStandby?.current;
    if (!standbyEl || !useHlsJsRef.current || !HlsLib?.isSupported()) return;
    if (standbyBrollClipIdRef.current === clip.id) return;

    if (hlsBrollStandbyRef.current) {
      hlsBrollStandbyRef.current.stopLoad();
      hlsBrollStandbyRef.current.detachMedia();
      hlsBrollStandbyRef.current.destroy();
      hlsBrollStandbyRef.current = null;
    }

    standbyBrollClipIdRef.current = clip.id;
    const hls = new HlsLib(HLS_OPTS_BROLL_STANDBY);
    hlsBrollStandbyRef.current = hls;
    hls.loadSource(clip.hls_url);
    hls.attachMedia(standbyEl);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activateBrollClip = (clip: BrollClip, seekTo: number, HlsLib: any) => {
    const brollEl = refs.videoBroll.current;
    if (!brollEl) return;

    const hasWarm = standbyBrollClipIdRef.current === clip.id && hlsBrollStandbyRef.current;

    if (hlsBrollRef.current) {
      hlsBrollRef.current.stopLoad();
      hlsBrollRef.current.detachMedia();
      hlsBrollRef.current.destroy();
      hlsBrollRef.current = null;
    }

    if (hasWarm) {
      // Transfer pre-warmed HLS from standby to active element
      hlsBrollStandbyRef.current.detachMedia();
      hlsBrollStandbyRef.current.attachMedia(brollEl);
      hlsBrollRef.current = hlsBrollStandbyRef.current;
      hlsBrollStandbyRef.current = null;
      standbyBrollClipIdRef.current = null;

      brollEl.currentTime = Math.max(0, seekTo);
      brollEl.addEventListener('seeked', () => {
        if (!videoRef.current?.paused) safePlay(brollEl);
      }, { once: true });
    } else {
      loadBrollHls(clip.hls_url, seekTo, HlsLib);
    }
  };

  const stopBroll = () => {
    const brollEl = refs.videoBroll.current;
    if (brollEl) { brollEl.pause(); brollEl.src = ''; }
    if (hlsBrollRef.current) {
      hlsBrollRef.current.stopLoad();
      hlsBrollRef.current.detachMedia();
      hlsBrollRef.current.destroy();
      hlsBrollRef.current = null;
    }
    if (hlsBrollStandbyRef.current) {
      hlsBrollStandbyRef.current.stopLoad();
      hlsBrollStandbyRef.current.detachMedia();
      hlsBrollStandbyRef.current.destroy();
      hlsBrollStandbyRef.current = null;
      standbyBrollClipIdRef.current = null;
    }
    activeBrollRef.current = null;
    merge({ showBrollOverlay: false });
  };

  const updateBrollOverlay = (gt: number) => {
    const brollClips = config.broll_clips ?? [];
    const clip = brollClips.find((b) => {
      const brollEnd = b.global_offset_sec + (b.end_sec - b.start_sec);
      return gt >= b.global_offset_sec && gt < brollEnd;
    }) ?? null;

    if (clip?.id !== activeBrollRef.current?.id) {
      const brollEl = refs.videoBroll.current;
      if (brollEl) { brollEl.pause(); }

      activeBrollRef.current = clip;
      if (clip) {
        const brollLocalTime = clip.start_sec + (gt - clip.global_offset_sec);
        activateBrollClip(clip, brollLocalTime, hlsLibRef.current);
        merge({ showBrollOverlay: true });
      } else {
        if (refs.videoBroll.current) refs.videoBroll.current.pause();
        if (hlsBrollRef.current) {
          hlsBrollRef.current.stopLoad();
          hlsBrollRef.current.detachMedia();
          hlsBrollRef.current.destroy();
          hlsBrollRef.current = null;
        }
        merge({ showBrollOverlay: false });
      }
    } else if (clip && refs.videoBroll.current) {
      // Same broll clip — check sync drift
      const expectedBrollTime = clip.start_sec + (gt - clip.global_offset_sec);
      const actualBrollTime   = refs.videoBroll.current.currentTime;
      if (Math.abs(actualBrollTime - expectedBrollTime) > 1.0) {
        refs.videoBroll.current.currentTime = Math.max(0, expectedBrollTime);
      }
    }
  };

  // ── HLS helpers ───────────────────────────────────────────────────────────
  const getSegmentUrl = (segIdx: number) => {
    const seg = config.segments[segIdx];
    return seg?.hls_url ?? seg?.fallback_url ?? '';
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachHlsSource = (el: HTMLVideoElement, segIdx: number, hls: any) => {
    const url = getSegmentUrl(segIdx);
    if (!url) return;
    if (useHlsJsRef.current && hls) {
      hls.stopLoad(); hls.detachMedia();
      hls.loadSource(url); hls.attachMedia(el);
      const HLS_ERROR = hlsLibRef.current?.Events?.ERROR ?? 'hlsError';
      const prev = _hlsErrHandlers.get(hls);
      if (prev) hls.off(HLS_ERROR, prev);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onErr = (_: string, d: any) => {
        if (!d.fatal) return;
        if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
        else if (d.type === 'mediaError') hls.recoverMediaError();
        else { el.src = config.segments[segIdx]?.fallback_url ?? ''; }
      };
      _hlsErrHandlers.set(hls, onErr);
      hls.on(HLS_ERROR, onErr);
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = url; el.load();
    } else {
      el.src = config.segments[segIdx]?.fallback_url ?? url; el.load();
    }
  };

  const prewarm = (segIdx: number) => {
    const id = config.segments[segIdx]?.id;
    if (!id || standbyIdRef.current === id || !standbyRef.current) return;
    standbyIdRef.current = id;
    attachHlsSource(standbyRef.current, segIdx, hlsStandbyRef.current);
  };

  const swapVideos = () => {
    const a = videoRef.current!, b = standbyRef.current!;
    b.style.zIndex = '2'; a.style.zIndex = '1';
    videoRef.current = b; standbyRef.current = a;
    [hlsRef.current, hlsStandbyRef.current] = [hlsStandbyRef.current, hlsRef.current];
    standbyIdRef.current = null;
    a.pause();
    hlsStandbyRef.current?.stopLoad();
    hlsStandbyRef.current?.detachMedia();
  };

  // ── loadSegment ───────────────────────────────────────────────────────────
  const loadSegment = useCallback((idx: number, localTime = 0, forcePlay = true) => {
    swapGenRef.current++;
    const gen = swapGenRef.current;
    const seg = timelineRef.current[idx];
    if (!seg) return;
    curIdxRef.current = idx;
    const tot = totalDurRef.current;

    if (useHlsJsRef.current) hlsRef.current?.stopLoad();
    setProgress(seg.offset + localTime, tot);
    if (refs.progressBuf.current) {
      refs.progressBuf.current.style.left  = `${(seg.offset / tot) * 100}%`;
      refs.progressBuf.current.style.width = '0%';
    }

    if (activeSimRef.current) {
      sendToSim({ type: 'stopScript' });
      merge({ showSimOverlay: false });
    }
    activeSimRef.current = null;
    swappingRef.current = true;

    merge({
      currentSegIdx: idx,
      badgeText: config.segments[idx]?.label ?? '',
      badgeMode: 'free',
    });

    if (standbyIdRef.current !== seg.id) prewarm(idx);
    const sv = standbyRef.current!;

    const finishSwap = () => {
      if (gen !== swapGenRef.current) return;
      swapVideos();
      swappingRef.current = false;
      if (forcePlay) safePlay(videoRef.current!);
      const nextIdx = idx + 1;
      if (nextIdx < timelineRef.current.length) prewarm(nextIdx);
      updateSimOverlay(idx, localTime);
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
      } else { finishSwap(); }
    };

    if (sv.readyState >= 3) doSwap();
    else sv.addEventListener('canplay', doSwap, { once: true });

    startedRef.current = true;
    merge({ started: true, showResumeBtn: false, controlsVisible: true });
    scheduleHide();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleHide]);

  // ── tick ──────────────────────────────────────────────────────────────────
  const onTick = useCallback(() => {
    if (scrubbingRef.current) return;
    const gt = globalTime();
    setProgress(gt);
    const t   = videoRef.current?.currentTime ?? 0;
    const idx = curIdxRef.current;

    const seg = timelineRef.current[idx];
    if (seg && seg.duration - t < 30) {
      const nextIdx = idx + 1;
      if (nextIdx < timelineRef.current.length) prewarm(nextIdx);
    }

    if (!userPausedRef.current && !swappingRef.current) {
      updateSimOverlay(idx, t);
      updateBrollOverlay(gt);

      // Pre-warm next broll clip 15s before its start
      const brollClips = config.broll_clips ?? [];
      const nextBroll = brollClips.find((b) =>
        gt < b.global_offset_sec && gt + 15 >= b.global_offset_sec
      ) ?? null;
      if (nextBroll && nextBroll.id !== standbyBrollClipIdRef.current && nextBroll.id !== activeBrollRef.current?.id) {
        prewarmBroll(nextBroll, hlsLibRef.current);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── onEnded ───────────────────────────────────────────────────────────────
  const onEnded = useCallback(() => {
    merge({ playing: false });
    activeSimRef.current = null;

    const nextIdx = curIdxRef.current + 1;
    if (nextIdx < timelineRef.current.length) {
      loadSegment(nextIdx, 0);
    } else {
      stopBroll();
      startedRef.current = false;
      merge({ started: false, controlsVisible: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSegment]);

  // ── listener attachment ───────────────────────────────────────────────────
  const attachListeners = useCallback((v: HTMLVideoElement) => {
    v.addEventListener('loadedmetadata', () => { syncActualDuration(v); });
    v.addEventListener('timeupdate',     () => { if (v === videoRef.current) onTick(); });
    v.addEventListener('play',  () => {
      if (v !== videoRef.current) return;
      merge({ playing: true });
      scheduleHide();
      // Sync broll: if broll is active, resume it too
      if (activeBrollRef.current && refs.videoBroll.current?.paused) {
        safePlay(refs.videoBroll.current);
      }
    });
    v.addEventListener('pause', () => {
      if (v !== videoRef.current) return;
      merge({ playing: false });
      showControls();
      // Sync broll: pause it too
      refs.videoBroll.current?.pause();
    });
    v.addEventListener('ended',    () => { if (v === videoRef.current) onEnded(); });
    v.addEventListener('progress', () => { if (v === videoRef.current) updateBuf(); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTick, onEnded, scheduleHide, showControls]);

  // ── postMessage listener (SIM_READY + userInteraction) ───────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== refs.simFrame.current?.contentWindow) return;
      const { type } = (e.data as { type?: string }) ?? {};
      if (type === 'SIM_READY') {
        simReadyRef.current = true;
        if (simPollRef.current) clearInterval(simPollRef.current);
        const pending = pendingSimRef.current;
        pendingSimRef.current = null;
        if (pending && !userPausedRef.current) {
          merge({ showSimOverlay: true });
          sendToSim({ type: 'startScript', script: pending.script, params: pending.params });
        }
      }
      if (type === 'userInteraction') {
        videoRef.current?.pause();
        sendToSim({ type: 'pauseScript' });   // stop animation, keep sim panel visible
        userPausedRef.current = true;
        merge({ showResumeBtn: true, badgeMode: 'free' });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── iframe load listener — reset ready state when src changes ─────────────
  useEffect(() => {
    const frame = refs.simFrame.current;
    if (!frame) return;
    const onLoad = () => {
      simReadyRef.current = false;
      startSimPoll();
    };
    frame.addEventListener('load', onLoad);
    return () => frame.removeEventListener('load', onLoad);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSimPoll]);

  // ── setup effect ──────────────────────────────────────────────────────────
  useEffect(() => {
    const vA = refs.videoA.current!;
    const vB = refs.videoB.current!;
    videoRef.current   = vA;
    standbyRef.current = vB;
    vA.style.zIndex = '2';
    vB.style.zIndex = '1';

    const initAsync = async () => {
      if (typeof window === 'undefined') return;
      const HlsLib = (await import('hls.js')).default;
      hlsLibRef.current = HlsLib;
      const canUse = HlsLib.isSupported();
      useHlsJsRef.current = canUse;

      const firstUrl = getSegmentUrl(0);
      if (canUse && firstUrl) {
        const hA = new HlsLib(HLS_OPTS);
        hA.loadSource(firstUrl); hA.attachMedia(vA);
        hlsRef.current = hA;
        hlsStandbyRef.current = new HlsLib(HLS_OPTS_STANDBY);
      } else if (vA.canPlayType('application/vnd.apple.mpegurl') && firstUrl) {
        vA.src = firstUrl;
      } else {
        vA.src = config.segments[0]?.fallback_url ?? firstUrl;
      }

      attachListeners(vA);
      attachListeners(vB);
      setTotTime(totalDurRef.current);
    };

    initAsync();

    return () => {
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
      hlsBrollRef.current?.destroy();
      hlsBrollStandbyRef.current?.destroy();
      clearTimeout(idleTimerRef.current ?? undefined);
      if (simPollRef.current) clearInterval(simPollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── progress scrubbing ────────────────────────────────────────────────────
  useEffect(() => {
    const wrap  = refs.progressWrap.current;
    const track = refs.progressTrack.current;
    if (!wrap || !track) return;

    const getPct = (cx: number) => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (cx - r.left) / r.width));
    };

    const startScrub = (cx: number) => {
      scrubbingRef.current  = true;
      wasPlayingRef.current = !videoRef.current?.paused;
      videoRef.current?.pause();
      if (useHlsJsRef.current) hlsStandbyRef.current?.stopLoad();
      setProgress(getPct(cx) * totalDurRef.current);
      showControls();
    };

    const moveScrub = (cx: number) => {
      if (!scrubbingRef.current) return;
      setProgress(getPct(cx) * totalDurRef.current);
    };

    const endScrub = (cx: number) => {
      if (!scrubbingRef.current) return;
      scrubbingRef.current = false;
      const targetGlobal = getPct(cx) * totalDurRef.current;
      const tl = timelineRef.current;
      setProgress(targetGlobal, totalDurRef.current);

      let targetIdx = 0;
      for (let i = tl.length - 1; i >= 0; i--) {
        if (tl[i].offset <= targetGlobal) { targetIdx = i; break; }
      }
      const targetSeg = tl[targetIdx];
      const localTime = Math.max(0, targetGlobal - targetSeg.offset);

      if (targetIdx === curIdxRef.current) {
        swapGenRef.current++;
        if (useHlsJsRef.current) hlsRef.current?.startLoad();
        videoRef.current!.currentTime = localTime;
        if (useHlsJsRef.current && standbyIdRef.current) {
          const resumeGen = swapGenRef.current;
          setTimeout(() => {
            if (!scrubbingRef.current && swapGenRef.current === resumeGen) {
              hlsStandbyRef.current?.startLoad();
            }
          }, 1500);
        }
        if (userPausedRef.current) { userPausedRef.current = false; merge({ showResumeBtn: false }); }
        updateSimOverlay(targetIdx, localTime);
        updateBrollOverlay(targetGlobal);
        if (wasPlayingRef.current) safePlay(videoRef.current!);
      } else {
        loadSegment(targetIdx, localTime, wasPlayingRef.current);
      }
    };

    const onMouseDown  = (e: MouseEvent) => { e.preventDefault(); startScrub(e.clientX); };
    const onMouseMove  = (e: MouseEvent) => moveScrub(e.clientX);
    const onMouseUp    = (e: MouseEvent) => endScrub(e.clientX);
    const onTouchStart = (e: TouchEvent) => { e.preventDefault(); startScrub(e.touches[0].clientX); };
    const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); moveScrub(e.touches[0].clientX); };
    const onTouchEnd   = (e: TouchEvent) => endScrub(e.changedTouches[0].clientX);
    wrap.addEventListener('mousedown',   onMouseDown);
    wrap.addEventListener('touchstart',  onTouchStart, { passive: false });
    wrap.addEventListener('touchmove',   onTouchMove,  { passive: false });
    wrap.addEventListener('touchend',    onTouchEnd);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);

    return () => {
      wrap.removeEventListener('mousedown',  onMouseDown);
      wrap.removeEventListener('touchstart', onTouchStart);
      wrap.removeEventListener('touchmove',  onTouchMove);
      wrap.removeEventListener('touchend',   onTouchEnd);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── controls reveal on mouse/touch ────────────────────────────────────────
  useEffect(() => {
    const root = refs.root.current;
    if (!root) return;
    const onMove = () => showControls();
    const onTouch = (e: TouchEvent) => {
      const fromBottom = window.innerHeight - e.touches[0].clientY;
      if (fromBottom < window.innerHeight * 0.3) showControls();
    };
    root.addEventListener('mousemove', onMove);
    root.addEventListener('touchstart', onTouch, { passive: true });
    return () => {
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('touchstart', onTouch);
    };
  }, [showControls, refs.root]);

  // ── public actions ─────────────────────────────────────────────────────────
  const startPlayback = useCallback(() => {
    startedRef.current = true;
    merge({ started: true });
    safePlay(videoRef.current!);
    scheduleHide();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleHide]);

  const togglePlay = useCallback(() => {
    if (!startedRef.current) { startPlayback(); return; }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) safePlay(v); else v.pause();
  }, [startPlayback]);

  // ── keyboard shortcuts (Space, ←, →) — global, like YouTube ──────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement).isContentEditable) return;

      if (e.key === ' ') {
        e.preventDefault();
        if (!startedRef.current) { startPlayback(); return; }
        togglePlay();
        showControls();
        return;
      }

      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && startedRef.current) {
        e.preventDefault();
        const delta = e.key === 'ArrowLeft' ? -5 : 5;
        const newGlobal = Math.max(0, Math.min(totalDurRef.current, globalTime() + delta));
        const tl = timelineRef.current;

        let targetIdx = 0;
        for (let i = tl.length - 1; i >= 0; i--) {
          if (tl[i].offset <= newGlobal) { targetIdx = i; break; }
        }
        const localTime = Math.max(0, newGlobal - tl[targetIdx].offset);
        const wasPlaying = !videoRef.current?.paused;

        setProgress(newGlobal);
        showControls();

        if (targetIdx === curIdxRef.current) {
          videoRef.current!.currentTime = localTime;
          updateSimOverlay(targetIdx, localTime);
          updateBrollOverlay(newGlobal);
          if (wasPlaying) safePlay(videoRef.current!);
        } else {
          loadSegment(targetIdx, localTime, wasPlaying);
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPlayback, togglePlay, showControls, loadSegment]);

  const handleVideoClick = useCallback(() => {
    if (!startedRef.current) { startPlayback(); return; }
    const willPlay = videoRef.current?.paused ?? false;
    togglePlay();
    hideControls();
    const fb = refs.tapFeedback.current;
    if (fb) {
      fb.classList.remove('show', 'will-play', 'will-pause');
      void fb.offsetWidth;
      fb.classList.add('show', willPlay ? 'will-play' : 'will-pause');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, startPlayback]);

  const resumeFromSim = useCallback(() => {
    userPausedRef.current = false;
    merge({ showResumeBtn: false });
    // Restart the animation script that was paused on userInteraction
    if (activeSimRef.current) {
      sendToSim({
        type: 'startScript',
        script: activeSimRef.current.sim_script ?? 'main',
        params: {
          simpleUi:   activeSimRef.current.simple_ui   ?? false,
          autoScript: activeSimRef.current.auto_script ?? true,
        },
      });
    }
    safePlay(videoRef.current!);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    actions: { startPlayback, togglePlay, handleVideoClick, resumeFromSim },
  };
}
