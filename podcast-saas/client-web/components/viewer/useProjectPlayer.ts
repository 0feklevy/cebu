'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip, ImageOverlayItem, AudioCutaway, PlayerBranchSequence, PlayerChoicePoint, PlayerBranchEdge } from './types';

const BRANCH_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

// ── HLS.js config (ported from interactive-podcast-react/player/src/constants/index.ts) ──
const HLS_OPTS = {
  enableWorker: true,
  startLevel: -1,
  capLevelToPlayerSize: true,
  startFragPrefetch: false,
  // Buffer headroom: 15s was a thin cushion that underran (stuttered) on variable
  // networks. 45s ahead / 90s cap gives the active video room to ride out dips while
  // still freeing bandwidth for the standby/broll instances once full.
  maxBufferLength: 45,
  maxMaxBufferLength: 90,
  backBufferLength: 10,
  abrEwmaDefaultEstimate: 500_000,
  abrEwmaFastHalf: 2,
  fragLoadingTimeOut: 20_000,
  manifestLoadingTimeOut: 10_000,
  maxBufferHole: 0.5,
  // More nudge attempts before HLS.js declares a fatal bufferStalledError — most
  // stalls clear with a nudge rather than needing a full reload.
  nudgeMaxRetry: 10,
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
  globalTime:       number;
  activeSimUrl:    string | null;
  currentSegIdx:   number;
  activeSegmentId: string;          // id of the playing segment (stable across branching)
  timeline:        TimelineSeg[];
  totalDuration:   number;
  volume:          number;
  muted:           boolean;
  badgeText:       string;
  badgeMode:       'sim' | 'free' | '';
  resumeAction:    'resume' | 'backToVideo';
  activeImageOverlay: ImageOverlayItem | null;
  guidanceCaption: string;
  // ── Branching (only used when config.branching is present) ──
  activeChoice:    PlayerChoicePoint | null;  // the decision overlay to render, or null
  choiceCountdown: number | null;             // seconds remaining on the timeout, or null
  canGoBack:       boolean;                    // viewer has a previous decision to return to
}

export interface ProjectPlayerActions {
  startPlayback:    () => void;
  togglePlay:       () => void;
  handleVideoClick: () => void;
  resumeFromSim:    () => void;
  setVolume:        (volume: number) => void;
  toggleMute:       () => void;
  revealControls:   () => void;                        // YouTube-style hover reveal (over the sim)
  selectEdge:       (edge: PlayerBranchEdge) => void;  // viewer picked a choice
  goBack:           () => void;                        // back to the previous decision
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function safePlay(v: HTMLVideoElement): Promise<void> {
  try { await v.play(); } catch (_) {}
}

// Branching: does a postMessage from the sim match an edge's sim-trigger condition?
// trigger_event matches the message `type`; trigger_match optionally filters {key, op, value}.
function triggerMatches(
  triggerEvent: string | null,
  triggerMatch: Record<string, unknown> | null,
  data: Record<string, unknown>,
): boolean {
  if (!triggerEvent || data.type !== triggerEvent) return false;
  if (!triggerMatch) return true;
  const { key, op, value } = triggerMatch as { key?: string; op?: string; value?: unknown };
  if (!key) return true;
  const actual = data[key];
  const nums = typeof actual === 'number' && typeof value === 'number';
  switch (op) {
    case 'gte': return nums && (actual as number) >= (value as number);
    case 'lte': return nums && (actual as number) <= (value as number);
    case 'gt':  return nums && (actual as number) >  (value as number);
    case 'lt':  return nums && (actual as number) <  (value as number);
    case 'eq':
    default:    return actual === value;
  }
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
  /** Branching: navigate away to another project/playlist/external URL (route change, not in-player). */
  onNavigate?: (dest: { type: 'project' | 'playlist' | 'external_url'; url?: string | null; token?: string | null }) => void;
}

export function useProjectPlayer(
  config: PlayerConfig,
  refs: ProjectPlayerRefs,
  options: ProjectPlayerOptions = {},
): { state: ProjectPlayerState; actions: ProjectPlayerActions } {
  // ── Branching: the player walks a graph of sequences; each sequence is internally a
  // linear timeline driven by `segmentsRef`. When config.branching is null this resolves
  // to config.segments and every branching code path below is skipped → identical behavior.
  const branching = config.branching ?? null;
  const entrySequence: PlayerBranchSequence | null = branching
    ? (branching.sequences.find((s) => s.id === branching.entry_sequence_id) ?? branching.sequences[0] ?? null)
    : null;
  const initialSegments = entrySequence ? entrySequence.segments : config.segments;

  const { segs: initialSegs, total: initialTotal } = makeTimeline(initialSegments);
  const onProjectCompleteRef = useRef<(() => void) | undefined>(options.onProjectComplete);
  onProjectCompleteRef.current = options.onProjectComplete;
  const onNavigateRef = useRef<ProjectPlayerOptions['onNavigate']>(options.onNavigate);
  onNavigateRef.current = options.onNavigate;

  // Active sequence's segments (the linear timeline currently playing). === config.segments
  // for non-branching projects.
  const segmentsRef = useRef<PlayerSegment[]>(initialSegments);
  const currentSequenceIdRef = useRef<string | null>(entrySequence?.id ?? null);
  const pathStackRef = useRef<Array<{ sequenceId: string; edgeId: string }>>([]);
  const activeChoiceRef = useRef<PlayerChoicePoint | null>(null);
  const choiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const choiceResolvedRef = useRef(false);  // a selection/timeout already navigated
  const sessionIdRef = useRef<string>('');
  if (!sessionIdRef.current) {
    sessionIdRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  }
  // Fire-and-forget branching analytics (Phase 5). No-op for non-branching projects.
  const recordBranchEvent = (eventType: 'sequence_enter' | 'choice' | 'complete', payload: { sequence_id?: string | null; edge_id?: string | null; destination_type?: string | null } = {}) => {
    if (!branching) return;
    try {
      fetch(`${BRANCH_API}/api/v1/projects/${config.project_id}/branch/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionIdRef.current, event_type: eventType, ...payload }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  };

  const [state, setState] = useState<ProjectPlayerState>({
    playing:          false,
    started:          false,
    showResumeBtn:    false,
    showSimOverlay:   false,
    showBrollOverlay: false,
    controlsVisible:  true,
    globalTime:       0,
    activeSimUrl:     null,
    currentSegIdx:    0,
    activeSegmentId:  initialSegments[0]?.id ?? '',
    timeline:         initialSegs,
    totalDuration:    initialTotal,
    volume:           1,
    muted:            false,
    badgeText:        initialSegments[0]?.label ?? '',
    badgeMode:        '',
    resumeAction:     'resume',
    activeImageOverlay: null,
    guidanceCaption:  '',
    activeChoice:     null,
    choiceCountdown:  null,
    canGoBack:        false,
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
  const volumeRef     = useRef(1);
  const mutedRef      = useRef(false);
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
    const displayTotal = computeDisplayTotal(timelineRef.current, segmentsRef.current);
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
    // Keep the slider's ARIA value in sync (the fill is driven imperatively, so React props
    // can't carry it) — otherwise screen readers announce a value-less slider (ui-ux-004).
    if (refs.progressWrap.current) {
      refs.progressWrap.current.setAttribute('aria-valuenow', String(Math.round(pct)));
      refs.progressWrap.current.setAttribute('aria-valuetext', `${fmt(gt)} of ${fmt(tot)}`);
    }
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

  const effectiveVolume = () => mutedRef.current ? 0 : volumeRef.current;

  const applyMediaVolume = useCallback(() => {
    const volume = effectiveVolume();
    const mainVideoVolume = guidanceVolRef.current != null ? Math.min(volume, 0.2) : volume;
    for (const video of [refs.videoA.current, refs.videoB.current]) {
      if (!video) continue;
      video.volume = mainVideoVolume;
      video.muted = mutedRef.current;
    }
    if (audioCutawayRef.current) {
      const active = (config.audio_cutaways ?? []).find((cut) => cut.id === activeAudioCutawayIdRef.current);
      audioCutawayRef.current.volume = Math.max(0, Math.min(1, (active?.broll_volume ?? 1) * volume));
      audioCutawayRef.current.muted = mutedRef.current;
    }
    if (guidanceAudioRef.current) {
      guidanceAudioRef.current.volume = volume;
      guidanceAudioRef.current.muted = mutedRef.current;
    }
  }, [config.audio_cutaways, refs.videoA, refs.videoB]);

  // ── controls reveal ───────────────────────────────────────────────────────
  const hideControls = () => {
    clearTimeout(idleTimerRef.current ?? undefined);
    merge({ controlsVisible: false });
  };

  const scheduleHide = useCallback(() => {
    clearTimeout(idleTimerRef.current ?? undefined);
    // Auto-hide when playing, OR whenever a simulation overlay is up — even though the
    // main video is paused for the sim — so a revealed bar fades back out YouTube-style
    // instead of staying parked over the simulation.
    if (startedRef.current && (!videoRef.current?.paused || showSimOverlayRef.current)) {
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
      guidanceVolRef.current = null;
      applyMediaVolume();
      merge({ guidanceCaption: '' });
      return;
    }
    if (videoRef.current && guidanceVolRef.current == null) {
      guidanceVolRef.current = videoRef.current.volume;
      videoRef.current.volume = Math.min(effectiveVolume(), 0.2);  // duck under narration
    }
    merge({ guidanceCaption: next.text });
    const done = () => {
      guidanceQueueRef.current.shift();
      guidanceAudioRef.current = null;
      startNextGuidanceRef.current();
    };
    if (!next.audioUrl) { setTimeout(done, 3500); return; }
    const audio = new Audio(next.audioUrl);
    audio.volume = effectiveVolume();
    audio.muted = mutedRef.current;
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
    const seg = segmentsRef.current[segmentIdx];
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
      // Recover the b-roll overlay in place on fatal errors rather than leaving it
      // frozen over the main video.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hls.on(HlsLib.Events.ERROR, (_: string, d: any) => {
        if (!d.fatal) return;
        if (d.type === 'networkError') { setTimeout(() => { try { hls.startLoad(); } catch { /* detached */ } }, 1000); }
        else { try { hls.recoverMediaError(); } catch { /* detached */ } }
      });
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
    if (branching) return;  // flat overlays disabled in branching mode (Phase 2)
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
            ? Math.max(0, Math.min(1, clip.broll_volume * effectiveVolume()))
            : effectiveVolume();
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
    if (branching) return;  // flat overlays disabled in branching mode (Phase 2)
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
        audio.volume = Math.max(0, Math.min(1, (active.broll_volume ?? 1.0) * effectiveVolume()));
        audio.muted = mutedRef.current;
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
    if (branching) return;  // flat overlays disabled in branching mode (Phase 2)
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
    const seg = segmentsRef.current[segIdx];
    return seg?.hls_url ?? seg?.fallback_url ?? '';
  };

  // Attach (idempotently) a fatal-error recovery handler to an Hls instance. Recovers
  // in place rather than killing playback: a fatal networkError retries the load, a
  // mediaError calls recoverMediaError(), and any other fatal error tries a media
  // recover too. Critically it never sets el.src to the HLS playlist as a "fallback"
  // — fallback_url === hls_url (an .m3u8), which Chrome/Firefox can't play natively, so
  // that path turned a recoverable stall into a permanent freeze. Only a *progressive*
  // fallback (a real file, not the same .m3u8) is ever assigned.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachHlsRecovery = (hls: any, el: HTMLVideoElement, segIdxOf: () => number) => {
    const HLS_ERROR = hlsLibRef.current?.Events?.ERROR ?? 'hlsError';
    const prev = _hlsErrHandlers.get(hls);
    if (prev) hls.off(HLS_ERROR, prev);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onErr = (_: string, d: any) => {
      if (!d.fatal) return;
      const segIdx = segIdxOf();
      if (d.type === 'networkError') { setTimeout(() => { try { hls.startLoad(); } catch { /* detached */ } }, 1000); }
      else if (d.type === 'mediaError') { try { hls.recoverMediaError(); } catch { /* detached */ } }
      else {
        try { hls.recoverMediaError(); } catch { /* detached */ }
        const fb = segmentsRef.current[segIdx]?.fallback_url ?? '';
        if (fb && fb !== getSegmentUrl(segIdx)) { el.src = fb; el.load(); }
      }
    };
    _hlsErrHandlers.set(hls, onErr);
    hls.on(HLS_ERROR, onErr);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachHlsSource = (el: HTMLVideoElement, segIdx: number, hls: any) => {
    const url = getSegmentUrl(segIdx);
    if (!url) return;
    if (useHlsJsRef.current && hls) {
      hls.stopLoad(); hls.detachMedia();
      hls.loadSource(url); hls.attachMedia(el);
      attachHlsRecovery(hls, el, () => segIdx);
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = url; el.load();
    } else {
      el.src = segmentsRef.current[segIdx]?.fallback_url ?? url; el.load();
    }
  };

  const prewarm = (segIdx: number) => {
    const id = segmentsRef.current[segIdx]?.id;
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
    // The two instances were created with different buffer budgets — active 45s, standby
    // 8s for cheap prewarm. The swap promotes the former standby to active, so re-apply the
    // full active budget to it (and the lean budget to the new standby). Without this the
    // player rode on only 8s of buffer from segment 2 onward and stalled on any dip >8s
    // (perf-006). hls.config is mutable at runtime and takes effect on the next fragment.
    if (hlsRef.current) {
      hlsRef.current.config.maxBufferLength    = HLS_OPTS.maxBufferLength;
      hlsRef.current.config.maxMaxBufferLength = HLS_OPTS.maxMaxBufferLength;
      hlsRef.current.config.backBufferLength   = HLS_OPTS.backBufferLength;
    }
    if (hlsStandbyRef.current) {
      hlsStandbyRef.current.config.maxBufferLength = HLS_OPTS_STANDBY.maxBufferLength;
    }
    hlsStandbyRef.current?.stopLoad();
    hlsStandbyRef.current?.detachMedia();
    applyMediaVolume();
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
      activeSegmentId: segmentsRef.current[idx]?.id ?? '',
      globalTime: seg.offset + localTime,
      badgeText: segmentsRef.current[idx]?.label ?? '',
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

  // ── Branching graph walker (no-op unless config.branching is present) ───────
  const clearChoiceTimer = () => {
    if (choiceTimerRef.current) { clearInterval(choiceTimerRef.current); choiceTimerRef.current = null; }
  };

  const currentSequence = (): PlayerBranchSequence | null =>
    branching ? (branching.sequences.find((s) => s.id === currentSequenceIdRef.current) ?? null) : null;

  function clearChoice() {
    clearChoiceTimer();
    activeChoiceRef.current = null;
    merge({ activeChoice: null, choiceCountdown: null });
  }

  function startChoiceCountdown(cp: PlayerChoicePoint) {
    clearChoiceTimer();
    if (cp.timeout_sec == null) { merge({ choiceCountdown: null }); return; }
    let remaining = cp.timeout_sec;
    merge({ choiceCountdown: remaining });
    choiceTimerRef.current = setInterval(() => {
      remaining = Math.max(0, remaining - 0.25);
      merge({ choiceCountdown: remaining });
      if (remaining <= 0) {
        clearChoiceTimer();
        const def = cp.edges.find((e) => e.id === cp.default_edge_id) ?? cp.edges[0];
        if (def) selectEdge(def);
      }
    }, 250);
  }

  function revealChoice(cp: PlayerChoicePoint) {
    if (activeChoiceRef.current?.id === cp.id) return;
    activeChoiceRef.current = cp;
    merge({ activeChoice: cp, controlsVisible: true });
    startChoiceCountdown(cp);  // 'pause'/'continue'-without-default hold at the end via onEnded
  }

  function loadSequence(sequenceId: string) {
    clearChoice();
    choiceResolvedRef.current = false;
    const seq = branching?.sequences.find((s) => s.id === sequenceId) ?? null;
    if (!seq || seq.segments.length === 0) {
      // Missing or empty destination — end gracefully rather than dead-ending.
      stopBroll();
      startedRef.current = false;
      merge({ started: false, controlsVisible: true });
      onProjectCompleteRef.current?.();
      return;
    }
    currentSequenceIdRef.current = seq.id;
    recordBranchEvent('sequence_enter', { sequence_id: seq.id });
    segmentsRef.current = seq.segments;
    const { segs, total } = makeTimeline(seq.segments);
    timelineRef.current = segs;
    totalDurRef.current = total;
    curIdxRef.current = 0;
    standbyIdRef.current = null;
    merge({ timeline: segs, totalDuration: total, currentSegIdx: 0, activeSegmentId: seq.segments[0]?.id ?? '' });
    setTotTime(total);
    loadSegment(0, 0, true);
  }

  function goBack() {
    const prev = pathStackRef.current.pop();
    merge({ canGoBack: pathStackRef.current.length > 0 });
    if (prev) loadSequence(prev.sequenceId);
  }

  function followEdge(edge: PlayerBranchEdge) {
    clearChoice();
    switch (edge.destination_type) {
      case 'sequence':
        if (edge.dest_sequence_id) {
          pathStackRef.current.push({ sequenceId: currentSequenceIdRef.current ?? '', edgeId: edge.id });
          merge({ canGoBack: true });
          loadSequence(edge.dest_sequence_id);
        } else { onProjectCompleteRef.current?.(); }
        return;
      case 'back':    goBack(); return;
      case 'restart':
        pathStackRef.current = [];
        merge({ canGoBack: false });
        if (branching) loadSequence(branching.entry_sequence_id);
        return;
      case 'external_url':
        if (onNavigateRef.current) onNavigateRef.current({ type: 'external_url', url: edge.dest_url });
        else if (edge.dest_url && typeof window !== 'undefined') window.open(edge.dest_url, '_blank', 'noopener');
        return;
      case 'project':  onNavigateRef.current?.({ type: 'project',  token: edge.dest_project_token });  return;
      case 'playlist': onNavigateRef.current?.({ type: 'playlist', token: edge.dest_playlist_token }); return;
      case 'end':
      default:
        recordBranchEvent('complete');
        stopBroll();
        startedRef.current = false;
        merge({ started: false, controlsVisible: true });
        onProjectCompleteRef.current?.();
        return;
    }
  }

  function selectEdge(edge: PlayerBranchEdge) {
    if (choiceResolvedRef.current) return;
    choiceResolvedRef.current = true;
    recordBranchEvent('choice', { sequence_id: currentSequenceIdRef.current, edge_id: edge.id, destination_type: edge.destination_type });
    followEdge(edge);
  }

  // ── tick ──────────────────────────────────────────────────────────────────
  const onTick = useCallback(() => {
    if (scrubbingRef.current) return;
    const gt = globalTime();
    setProgress(gt);
    merge({ globalTime: gt });
    const t   = videoRef.current?.currentTime ?? 0;
    const idx = curIdxRef.current;

    const seg = timelineRef.current[idx];
    if (seg && seg.duration - t < 30) {
      const nextIdx = idx + 1;
      if (nextIdx < timelineRef.current.length) prewarm(nextIdx);
    }

    // Branching: reveal the decision overlay in the last `lead_in_sec` of the final segment.
    if (branching && seg) {
      const cp = currentSequence()?.choice_point ?? null;
      const isLast = idx === timelineRef.current.length - 1;
      if (cp && isLast) {
        const remaining = seg.duration - t;
        if (remaining <= cp.lead_in_sec && !activeChoiceRef.current && !choiceResolvedRef.current) {
          revealChoice(cp);
        }
        // Loop behavior: replay the trailing region until the viewer chooses.
        if (cp.behavior === 'loop' && activeChoiceRef.current && remaining <= 0.3 && videoRef.current) {
          videoRef.current.currentTime = Math.max(0, seg.duration - cp.lead_in_sec);
        }
      }
    }

    if (!userPausedRef.current && !swappingRef.current) {
      updateSimOverlay(idx, t);
      updateBrollOverlay(gt);
      updateImageOverlay(gt);
      updateAudioCutaway(gt, !videoRef.current?.paused);

      // Pre-warm next broll clip 15s before its start (flat overlays are disabled in
      // branching mode — their global offsets don't map onto per-sequence timelines).
      if (!branching) {
        const brollClips = config.broll_clips ?? [];
        const nextBroll = brollClips.find((b) =>
          gt < b.global_offset_sec && gt + 15 >= b.global_offset_sec
        ) ?? null;
        if (nextBroll && nextBroll.id !== standbyBrollClipIdRef.current && nextBroll.id !== activeBrollRef.current?.id) {
          prewarmBroll(nextBroll, hlsLibRef.current);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── onEnded ───────────────────────────────────────────────────────────────
  const onEnded = useCallback(() => {
    merge({ playing: false });
    const idx = curIdxRef.current;
    const seg = timelineRef.current[idx];
    const section = segmentsRef.current[idx]?.simulations.find((s) =>
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
      return;
    }

    // End of the current sequence — branching resolves the decision here.
    if (branching) {
      const cp = currentSequence()?.choice_point ?? null;
      if (cp) {
        if (!choiceResolvedRef.current) {
          if (!activeChoiceRef.current) revealChoice(cp);
          // 'continue' with a default auto-advances; otherwise hold and wait for a pick.
          if (cp.behavior === 'continue') {
            const def = cp.edges.find((e) => e.id === cp.default_edge_id);
            if (def) { selectEdge(def); return; }
          }
          videoRef.current?.pause();
          merge({ playing: false });
        }
        return;  // resolved (navigating) or holding on the overlay
      }
      // sequence with no choice point → fall through to terminal behavior
    }

    stopBroll();
    startedRef.current = false;
    merge({ started: false, controlsVisible: true });
    // Playlist: hand control back to the wrapper to advance to the next project.
    onProjectCompleteRef.current?.();
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
      // Pausing into a simulation (userInteraction) must NOT raise the controls bar — it
      // would cover the sim. Keep it hidden; the viewer reveals it by moving the mouse
      // (hover zone) and resumes with Space / the resume button. Normal pauses show it.
      if (showSimOverlayRef.current) hideControls();
      else showControls();
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
      // ── Branching: simulation-triggered edges ──────────────────────────────
      // If the current sequence's choice point has an edge whose sim-trigger matches this
      // message, auto-select it (e.g. solved → response clip, wrong → explanation clip).
      if (branching && !choiceResolvedRef.current) {
        const cp = currentSequence()?.choice_point ?? null;
        if (cp) {
          const data = (e.data as Record<string, unknown>) ?? {};
          const match = cp.edges.find((edge) => triggerMatches(edge.trigger_event, edge.trigger_match, data));
          if (match) selectEdge(match);
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
    // When a simulation comes up, drop the controls bar so it never covers the sim.
    // It stays revealable on hover and auto-hides again via scheduleHide.
    if (state.showSimOverlay) hideControls();
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
        // The primary instance previously had no error handler, so a fatal stall on
        // the first segment was unrecoverable (frozen). Attach the same in-place
        // recovery the standby/swap path uses; segIdx tracks the live segment.
        attachHlsRecovery(hA, vA, () => curIdxRef.current);
        hlsRef.current = hA;
        hlsStandbyRef.current = new HlsLib(HLS_OPTS_STANDBY);
      } else if (vA.canPlayType('application/vnd.apple.mpegurl') && firstUrl) {
        vA.src = firstUrl;
      } else {
        vA.src = segmentsRef.current[0]?.fallback_url ?? firstUrl;
      }

      attachListeners(vA);
      attachListeners(vB);
      setTotTime(totalDurRef.current);
      applyMediaVolume();
    };

    initAsync();
    if (branching && entrySequence) recordBranchEvent('sequence_enter', { sequence_id: entrySequence.id });

    return () => {
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
      hlsBrollRef.current?.destroy();
      hlsBrollStandbyRef.current?.destroy();
      clearTimeout(idleTimerRef.current ?? undefined);
      if (simPollRef.current) clearInterval(simPollRef.current);
      // Stop any cutaway / guided-narration audio so it doesn't keep playing after
      // the player unmounts (e.g. navigating away mid-cutaway or mid-guidance).
      if (audioCutawayRef.current) { audioCutawayRef.current.pause(); audioCutawayRef.current = null; }
      if (guidanceAudioRef.current) { guidanceAudioRef.current.pause(); guidanceAudioRef.current = null; }
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
      merge({ globalTime: targetGlobal });

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
    applyMediaVolume();
    safePlay(videoRef.current!);
    scheduleHide();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleHide, applyMediaVolume]);

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

  const setVolume = useCallback((nextVolume: number) => {
    const volume = Math.max(0, Math.min(1, nextVolume));
    volumeRef.current = volume;
    if (volume > 0) mutedRef.current = false;
    applyMediaVolume();
    merge({ volume, muted: mutedRef.current });
  }, [applyMediaVolume]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    applyMediaVolume();
    merge({ muted: mutedRef.current });
  }, [applyMediaVolume]);

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
        merge({ globalTime: newGlobal });
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
      merge({ showResumeBtn: false, showSimOverlay: false, resumeAction: 'resume', controlsVisible: true, globalTime: targetGlobal });
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
    actions: { startPlayback, togglePlay, handleVideoClick, resumeFromSim, setVolume, toggleMute, revealControls: showControls, selectEdge, goBack },
  };
}
