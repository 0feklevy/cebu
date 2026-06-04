'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip, ImageOverlayItem, AudioCutaway } from './types';

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
  resumeAction:    'resume' | 'backToVideo';
  activeImageOverlay: ImageOverlayItem | null;
  guidanceCaption: string;
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
  return { segs, total: computeDisplayTotal(segs, segments) };
}

function computeDisplayTotal(timeline: TimelineSeg[], segments: PlayerSegment[]): number {
  let total = timeline.reduce((max, seg) => Math.max(max, seg.offset + seg.duration), 0);
  segments.forEach((seg, idx) => {
    const offset = timeline[idx]?.offset ?? 0;
    for (const section of seg.simulations) {
      total = Math.max(total, offset + section.end_sec);
    }
  });
  return total;
}

// WeakMap tracks error handlers per Hls instance to allow precise removal
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hlsErrHandlers = new WeakMap<object, (e: string, d: any) => void>();

export interface ProjectPlayerOptions {
  /** Fired when the whole project (all segments) finishes — used by the playlist wrapper to advance. */
  onProjectComplete?: () => void;
  /** Auto-start playback on mount without the big play button (e.g. playlist videos 2..N). */
  autoStart?: boolean;
}

export function useProjectPlayer(
  config: PlayerConfig,
  refs: ProjectPlayerRefs,
  options: ProjectPlayerOptions = {},
): { state: ProjectPlayerState; actions: ProjectPlayerActions } {
  const { segs: initialSegs, total: initialTotal } = makeTimeline(config.segments);
  const onProjectCompleteRef = useRef<(() => void) | undefined>(options.onProjectComplete);
  onProjectCompleteRef.current = options.onProjectComplete;

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
    resumeAction:     'resume',
    activeImageOverlay: null,
    guidanceCaption:  '',
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
  const resumeActionRef = useRef<'resume' | 'backToVideo'>('resume');
  const simReturnGlobalSecRef = useRef(0);
  const activeBrollRef  = useRef<BrollClip | null>(null);
  const audioCutawayRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioCutawayIdRef = useRef<string | null>(null);
  const swappingRef     = useRef(false);
  const userPausedRef   = useRef(false);
  const simReadyRef     = useRef(false);
  const simPollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingSimRef   = useRef<{ script: string; params: Record<string, boolean> } | null>(null);
  // ── Guided Simulation: parent owns "fire once per viewing session" + audio ──
  const firedCueIds       = useRef<Set<string>>(new Set());
  const guidanceAudioRef  = useRef<HTMLAudioElement | null>(null);
  const guidanceQueueRef  = useRef<Array<{ id: string; text: string; audioUrl: string }>>([]);
  const guidanceVolRef    = useRef<number | null>(null);
  const showSimOverlayRef = useRef(false);
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
    const displayTotal = computeDisplayTotal(timelineRef.current, config.segments);
    totalDurRef.current = displayTotal;

    merge({ timeline: [...timelineRef.current], totalDuration: displayTotal });

    if (v === videoRef.current) setTotTime(displayTotal);
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

  // ── Guided Simulation narration playback (serialized queue, ducks the video) ──
  // Use a stable ref so closures inside audio event listeners always call the latest version.
  const startNextGuidanceRef = useRef<() => void>(() => {});
  startNextGuidanceRef.current = () => {
    const next = guidanceQueueRef.current[0];
    if (!next) {
      if (guidanceVolRef.current != null && videoRef.current) {
        videoRef.current.volume = guidanceVolRef.current;
      }
      guidanceVolRef.current = null;
      merge({ guidanceCaption: '' });
      return;
    }
    if (videoRef.current && guidanceVolRef.current == null) {
      guidanceVolRef.current = videoRef.current.volume;
      videoRef.current.volume = Math.min(videoRef.current.volume, 0.2);  // duck under narration
    }
    merge({ guidanceCaption: next.text });
    const done = () => {
      guidanceQueueRef.current.shift();
      guidanceAudioRef.current = null;
      startNextGuidanceRef.current();
    };
    if (!next.audioUrl) { setTimeout(done, 3500); return; }
    const audio = new Audio(next.audioUrl);
    guidanceAudioRef.current = audio;
    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    audio.play().catch(() => {
      // Autoplay blocked or load error — show caption only, then advance
      setTimeout(done, 3500);
    });
  };

  const guidanceLastStartedAt = useRef(0);
  const MIN_GUIDANCE_GAP_MS = 12_000; // never queue a new cue within 12 s of starting the previous one

  const enqueueGuidance = (cue: { id: string; text: string; audioUrl: string }) => {
    const now = Date.now();
    // Drop the cue if another one is already queued/playing or the gap is too short
    if (guidanceQueueRef.current.length > 0) return;
    if (guidanceAudioRef.current && now - guidanceLastStartedAt.current < MIN_GUIDANCE_GAP_MS) return;
    guidanceQueueRef.current.push(cue);
    guidanceLastStartedAt.current = now;
    if (!guidanceAudioRef.current) startNextGuidanceRef.current();
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
        // Fade out immediately at the boundary; CSS opacity transition smooths it.
        merge({ showSimOverlay: false });
      }
      activeSimRef.current = null;
      merge({ badgeText: '', badgeMode: '' });
      return;
    }

    const section    = seg.simulations.find((s) => localTime >= s.start_sec && localTime < s.end_sec) ?? null;
    const simSection = section?.simulation_url ? section : null;
    const segmentDuration = timelineRef.current[segmentIdx]?.duration ?? seg.duration_sec;
    const isPostRollSim = !!simSection &&
      simSection.type === 'simulation' &&
      simSection.start_sec >= segmentDuration - 0.05;

    if (simSection !== null && simSection?.id === activeSimRef.current?.id) return;

    if (activeSimRef.current) {
      sendToSim({ type: 'stopScript' });
      // Fade out immediately at the boundary; CSS opacity transition smooths it.
      merge({ showSimOverlay: false });
    }
    activeSimRef.current = simSection;

    if (!simSection && resumeActionRef.current === 'backToVideo') {
      resumeActionRef.current = 'resume';
      userPausedRef.current = false;
      merge({ showResumeBtn: false, resumeAction: 'resume' });
    }

    if (simSection) {
      const script  = simSection.sim_script ?? 'main';
      const params  = { simpleUi: simSection.simple_ui ?? false, autoScript: simSection.auto_script ?? true };
      const sameUrl = simSection.simulation_url === activeSimUrlRef.current;
      activeSimUrlRef.current = simSection.simulation_url;
      merge({ activeSimUrl: simSection.simulation_url });

      if (isPostRollSim) {
        videoRef.current?.pause();
        userPausedRef.current = true;
        resumeActionRef.current = 'backToVideo';
        simReturnGlobalSecRef.current = timelineRef.current[segmentIdx]?.offset ?? 0;
        merge({ showResumeBtn: true, resumeAction: 'backToVideo', controlsVisible: true });
      }

      if (sameUrl && simReadyRef.current) {
        // Send startScript first so sim applies simpleUi, then reveal
        sendToSim({ type: 'startScript', script, params });
        setTimeout(() => merge({ showSimOverlay: true }), 50);
      } else {
        simReadyRef.current   = false;
        pendingSimRef.current = { script, params };
        startSimPoll();
      }
    }

    merge({
      badgeText: section
        ? section.type === 'simulation'
          ? (section.label?.trim() || 'Simulation')
          : (section.label?.trim() || section.type)
        : (seg.label ?? ''),
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
    // Merge broll_clips and clip_overlays — both use the same video overlay mechanism
    const brollClips = [...(config.broll_clips ?? []), ...(config.clip_overlays ?? [])];
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
        // Apply broll volume from clip data
        if (refs.videoBroll.current) {
          refs.videoBroll.current.volume = typeof clip.broll_volume === 'number'
            ? Math.max(0, Math.min(1, clip.broll_volume)) : 1.0;
        }
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

  // ── audio cutaway (audio-only broll) ─────────────────────────────────────
  const updateAudioCutaway = (gt: number, isPlaying: boolean) => {
    const cuts: AudioCutaway[] = config.audio_cutaways ?? [];
    const active = cuts.find(c => {
      const end = c.global_offset_sec + (c.end_sec - c.start_sec);
      return gt >= c.global_offset_sec && gt < end;
    }) ?? null;

    if (active?.id !== activeAudioCutawayIdRef.current) {
      // Stop previous
      if (audioCutawayRef.current) {
        audioCutawayRef.current.pause();
        audioCutawayRef.current = null;
      }
      activeAudioCutawayIdRef.current = active?.id ?? null;

      if (active) {
        const audio = new Audio(active.audio_url);
        audio.volume = Math.max(0, Math.min(1, active.broll_volume ?? 1.0));
        const localTime = active.start_sec + (gt - active.global_offset_sec);
        audio.currentTime = Math.max(0, localTime);
        audioCutawayRef.current = audio;
        if (isPlaying) audio.play().catch(() => {});
      }
    } else if (active && audioCutawayRef.current) {
      // Same cutaway — sync drift
      const expected = active.start_sec + (gt - active.global_offset_sec);
      if (Math.abs(audioCutawayRef.current.currentTime - expected) > 1.0) {
        audioCutawayRef.current.currentTime = Math.max(0, expected);
      }
      if (isPlaying && audioCutawayRef.current.paused) {
        audioCutawayRef.current.play().catch(() => {});
      } else if (!isPlaying && !audioCutawayRef.current.paused) {
        audioCutawayRef.current.pause();
      }
    }
  };

  // ── image overlay ─────────────────────────────────────────────────────────
  const activeImageIdRef = useRef<string | null>(null);

  const updateImageOverlay = (gt: number) => {
    const overlays = config.image_overlays ?? [];
    const active = overlays.find(
      (o) => gt >= o.global_offset_sec && gt < o.global_offset_sec + o.duration_sec,
    ) ?? null;

    if (active?.id !== activeImageIdRef.current) {
      activeImageIdRef.current = active?.id ?? null;
      merge({ activeImageOverlay: active ?? null });
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
    resumeActionRef.current = 'resume';

    merge({
      currentSegIdx: idx,
      badgeText: config.segments[idx]?.label ?? '',
      badgeMode: 'free',
      resumeAction: 'resume',
    });

    if (standbyIdRef.current !== seg.id) prewarm(idx);
    const sv = standbyRef.current!;

    const finishSwap = () => {
      if (gen !== swapGenRef.current) return;
      swapVideos();
      swappingRef.current = false;
      if (forcePlay && localTime < seg.duration - 0.01) safePlay(videoRef.current!);
      const nextIdx = idx + 1;
      if (nextIdx < timelineRef.current.length) prewarm(nextIdx);
      updateSimOverlay(idx, localTime);
    };

    const doSwap = () => {
      if (gen !== swapGenRef.current) return;
      if (localTime > 0.05) {
        sv.currentTime = Math.min(localTime, seg.duration);
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
      updateImageOverlay(gt);
      updateAudioCutaway(gt, !videoRef.current?.paused);

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
    const idx = curIdxRef.current;
    const seg = timelineRef.current[idx];
    const section = config.segments[idx]?.simulations.find((s) =>
      s.type === 'simulation' &&
      !!s.simulation_url &&
      !!seg &&
      seg.duration >= s.start_sec - 0.05 &&
      seg.duration < s.end_sec,
    ) ?? null;

    if (seg && section) {
      setProgress(seg.offset + Math.max(seg.duration, section.start_sec));
      updateSimOverlay(idx, Math.max(seg.duration, section.start_sec));
      return;
    }

    activeSimRef.current = null;

    const nextIdx = idx + 1;
    if (nextIdx < timelineRef.current.length) {
      loadSegment(nextIdx, 0);
    } else {
      stopBroll();
      startedRef.current = false;
      merge({ started: false, controlsVisible: true });
      // Playlist: hand control back to the wrapper to advance to the next project.
      onProjectCompleteRef.current?.();
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
      // Sync audio cutaway
      if (audioCutawayRef.current?.paused) audioCutawayRef.current.play().catch(() => {});
    });
    v.addEventListener('pause', () => {
      if (v !== videoRef.current) return;
      merge({ playing: false });
      showControls();
      // Sync broll: pause it too
      refs.videoBroll.current?.pause();
      // Sync audio cutaway
      audioCutawayRef.current?.pause();
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
        if (pending && (!userPausedRef.current || resumeActionRef.current === 'backToVideo')) {
          // Send startScript first so sim applies simpleUi before overlay reveals
          sendToSim({ type: 'startScript', script: pending.script, params: pending.params });
          setTimeout(() => merge({ showSimOverlay: true }), 50);
        }
      }
      if (type === 'userInteraction') {
        videoRef.current?.pause();
        sendToSim({ type: 'pauseScript' });   // stop animation, keep sim panel visible
        userPausedRef.current = true;
        merge({ showResumeBtn: true, badgeMode: 'free', resumeAction: resumeActionRef.current });
      }
      // ── Guided Simulation ──────────────────────────────────────────────────
      if (type === 'GUIDANCE_READY') {
        // Seed with already-heard cues so they never replay across section reloads.
        sendToSim({ type: 'guidanceInit', firedIds: Array.from(firedCueIds.current) });
        // TIMING FIX: GUIDANCE_READY fires almost simultaneously with SIM_READY,
        // before the overlay's 50ms reveal timeout. Always delay the gate so it
        // reflects the overlay's actual visible state (true once it fades in).
        // Feature triggers don't need the gate (they use isTrusted), but config
        // polling must not run while the sim is still hidden.
        setTimeout(() => {
          sendToSim({ type: 'guidanceGate', active: showSimOverlayRef.current });
        }, 100);
      }
      if (type === 'guidanceCue') {
        const { id, text, audioUrl } = (e.data as { id?: string; text?: string; audioUrl?: string }) ?? {};
        if (id && !firedCueIds.current.has(id)) {
          firedCueIds.current.add(id);                       // once per viewing session, across section reloads
          sendToSim({ type: 'guidanceFired', ids: [id] });
          enqueueGuidance({ id, text: text ?? '', audioUrl: audioUrl ?? '' });
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the guidance overlay's config-poll gate in sync with overlay visibility.
  useEffect(() => {
    showSimOverlayRef.current = state.showSimOverlay;
    sendToSim({ type: 'guidanceGate', active: state.showSimOverlay });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.showSimOverlay]);

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
        videoRef.current!.currentTime = Math.min(localTime, targetSeg.duration);
        if (useHlsJsRef.current && standbyIdRef.current) {
          const resumeGen = swapGenRef.current;
          setTimeout(() => {
            if (!scrubbingRef.current && swapGenRef.current === resumeGen) {
              hlsStandbyRef.current?.startLoad();
            }
          }, 1500);
        }
        if (userPausedRef.current) {
          userPausedRef.current = false;
          resumeActionRef.current = 'resume';
          merge({ showResumeBtn: false, resumeAction: 'resume' });
        }
        updateSimOverlay(targetIdx, localTime);
        updateBrollOverlay(targetGlobal); updateImageOverlay(targetGlobal);
        updateAudioCutaway(targetGlobal, wasPlayingRef.current);
        if (wasPlayingRef.current && localTime < targetSeg.duration - 0.01) safePlay(videoRef.current!);
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

  // Auto-start (playlist videos 2..N): a user gesture already occurred in the lobby,
  // so begin playing as soon as the first segment is ready.
  useEffect(() => {
    if (!options.autoStart) return;
    let done = false;
    const start = () => { if (done) return; done = true; startPlayback(); };
    const v = refs.videoA.current;
    const onCan = () => start();
    if (v) {
      if (v.readyState >= 2) start();
      else v.addEventListener('canplay', onCan, { once: true });
    }
    const t = setTimeout(start, 600);
    return () => { v?.removeEventListener('canplay', onCan); clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          videoRef.current!.currentTime = Math.min(localTime, tl[targetIdx].duration);
          updateSimOverlay(targetIdx, localTime);
          updateBrollOverlay(newGlobal); updateImageOverlay(newGlobal);
          updateAudioCutaway(newGlobal, wasPlaying);
          if (wasPlaying && localTime < tl[targetIdx].duration - 0.01) safePlay(videoRef.current!);
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
    if (resumeActionRef.current === 'backToVideo') {
      const targetGlobal = Math.max(0, simReturnGlobalSecRef.current);
      const tl = timelineRef.current;
      let targetIdx = 0;
      for (let i = tl.length - 1; i >= 0; i--) {
        if (tl[i].offset <= targetGlobal) { targetIdx = i; break; }
      }
      const targetSeg = tl[targetIdx];
      const localTime = targetSeg ? Math.max(0, targetGlobal - targetSeg.offset) : 0;

      sendToSim({ type: 'stopScript' });
      activeSimRef.current = null;
      userPausedRef.current = false;
      resumeActionRef.current = 'resume';
      merge({ showResumeBtn: false, showSimOverlay: false, resumeAction: 'resume', controlsVisible: true });
      setProgress(targetGlobal);
      updateBrollOverlay(targetGlobal); updateImageOverlay(targetGlobal);
      updateAudioCutaway(targetGlobal, wasPlayingRef.current);

      if (targetSeg && targetIdx === curIdxRef.current) {
        videoRef.current!.currentTime = Math.min(localTime, targetSeg.duration);
        updateSimOverlay(targetIdx, localTime);
        safePlay(videoRef.current!);
      } else if (targetSeg) {
        loadSegment(targetIdx, localTime, true);
      }
      return;
    }

    userPausedRef.current = false;
    resumeActionRef.current = 'resume';
    merge({ showResumeBtn: false, resumeAction: 'resume' });
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
