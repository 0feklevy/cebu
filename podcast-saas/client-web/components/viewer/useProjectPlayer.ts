'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip, ImageOverlayItem, AudioCutaway, PlayerBranchSequence, PlayerChoicePoint, PlayerBranchEdge } from './types';
import { releaseAvatarElement } from '../../lib/avatarAudioGraph';
import { resolveAssetUrl } from '../../lib/assetUrl';
import { simDestroyGraceMs } from '../../lib/simLifecycle';
import type { SimStartScriptParams } from '../../lib/simUiControls';
import { resolveSimUrl } from '../../lib/simUrl';
import { canWarmUnpaused } from '../../lib/simCapability';

// Seamless sim preload tuning. A sim's scene paints inside its OWN load-time rAF (independent
// of startScript), so the player pre-mounts the iframe hidden + UNPAUSED ahead of the boundary,
// waits for the bridge's SIM_PAINTED first-frame ack, freezes it, and only then crossfades — the
// reveal is gated on real paint, never a timer, so no loading/black frame is ever shown.
const SIM_PREMOUNT_LEAD_SEC = 12;   // start warming this far before a sim section
const SIM_PAINT_DEADLINE_MS = 1200; // bounded HOLD ceiling: best-effort reveal if SIM_PAINTED never comes
const SIM_BOOT_STALLED_MS   = 5000; // only after this does a genuine-failure loading affordance show

const BRANCH_API = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

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
  // Minimal-UI selectors baked into the iframe src fragment (#simboot=…) so the sim
  // paints already-minimal — no full-UI flash while startScript is still in flight.
  activeSimBootHide: string[] | null;
  // Genuine-failure affordance: a sim that never paints within SIM_BOOT_STALLED_MS.
  // NOT routine loading — the normal path holds the video/last frame until the sim paints.
  simBootStalled:  boolean;
  // Sim-first entry (t=0 sim / post-branch first sim) with no video frame underneath to
  // hold — the one case a brief loading affordance is correct instead of a blank hold.
  simColdCover:    boolean;
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
  simFrameLoaded:   () => void;                        // wire to the sim iframe's onLoad
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
    activeSimBootHide: null,
    simBootStalled:   false,
    simColdCover:     false,
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
  const pendingSimRef   = useRef<{ script: string; params: SimStartScriptParams } | null>(null);
  // The CURRENT desired sim script+params while a sim section is active (null outside one).
  // The iframe 'load' listener re-arms pendingSimRef from this — heals the stale-SIM_READY race
  // where the OLD page answers a ping during navigation and consumes the pending startScript,
  // leaving the NEW page visible but scriptless (no autoScript / wrong simpleUi). (sim-race fix)
  const desiredSimRef   = useRef<{ script: string; params: SimStartScriptParams } | null>(null);
  // (D2) Destroy-on-leave: after the overlay hides, keep the simPause'd iframe mounted for a
  // grace window (45s desktop / 700ms touch-or-low-memory), then clear activeSimUrl so
  // SimOverlayDynamic unmounts it and the WebGL context is truly freed. Cancelled on re-entry.
  const simDestroyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // (D5) True while we stopLoad()'ed the active+standby HLS because a sim holds the screen
  // with the video paused by the player — only then may we startLoad() them back.
  const simHlsStoppedRef = useRef(false);
  // (D4) Sim entry URLs already prefetched this mount — warm the HTTP cache once per URL.
  const prefetchedSimUrlsRef = useRef<Set<string>>(new Set());
  // ── Paint-gated reveal (seamless preload) ────────────────────────────────────
  // The URL whose CURRENTLY-MOUNTED iframe document has posted SIM_PAINTED (rendered ≥1 real
  // frame). This — not simReadyRef (which fires before the scene draws) — is the reveal gate:
  // showSimOverlay only flips true once simPaintedUrlRef === activeSimUrlRef.
  const simPaintedUrlRef = useRef<string | null>(null);
  // Section id waiting on a paint ack to reveal (set on cold/at-boundary entry).
  const awaitingPaintSimIdRef = useRef<string | null>(null);
  // Bounded HOLD ceiling: reveals best-effort if SIM_PAINTED never arrives (throttled/legacy sim).
  const simPaintDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Genuine-stall (5s) → the only path that ever shows a loading affordance in normal flows.
  const simBootStalledRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every section change / seek / sequence load; a reveal scheduled under an old
  // generation is dropped, so a stale async paint can never reveal the wrong sim.
  const warmGenRef = useRef(0);
  // Scrub pre-mount: while the thumb rests over a sim section, mount its iframe
  // hidden+unscripted so the boot happens DURING the scrub, not after release.
  const scrubPremountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // ── Paint-gated reveal — the ONLY writer of showSimOverlay:true ───────────
  // Clears every reveal/hold timer, then on a double-rAF (so the opacity flip composites on a
  // real frame) flips the overlay visible — but only if the section is still active, the sim
  // has actually painted for the current URL, and the generation hasn't moved under us. `force`
  // is the bounded-deadline / cold-cover escape hatch: reveal best-effort when SIM_PAINTED never
  // came (throttled or not-yet-backfilled sim), holding the underlying content until then.
  const clearRevealTimers = () => {
    if (simPaintDeadlineRef.current) { clearTimeout(simPaintDeadlineRef.current); simPaintDeadlineRef.current = null; }
    if (simBootStalledRef.current) { clearTimeout(simBootStalledRef.current); simBootStalledRef.current = null; }
  };
  const revealSim = (opts?: { force?: boolean }) => {
    const gen = warmGenRef.current;
    clearRevealTimers();
    awaitingPaintSimIdRef.current = null;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
    raf(() => raf(() => {
      if (warmGenRef.current !== gen) return;                  // seek/branch moved on — drop stale reveal
      if (!activeSimRef.current) return;                       // no longer a sim section
      if (!opts?.force && simPaintedUrlRef.current !== activeSimUrlRef.current) return;  // not painted yet
      merge({ showSimOverlay: true, simBootStalled: false, simColdCover: false });
    }));
  };

  // ── (D2) sim overlay lifecycle: pause on hide, destroy after grace ────────
  const cancelSimDestroy = () => {
    if (simDestroyTimerRef.current) { clearTimeout(simDestroyTimerRef.current); simDestroyTimerRef.current = null; }
  };

  // graceOverrideMs: an explicit "the user is done with this sim" signal (e.g. the
  // back-to-video resume) shortens the grace so the next entry is a guaranteed
  // fresh mount in its initial state — still > the 200ms fade, never mid-fade.
  const scheduleSimDestroy = (graceOverrideMs?: number) => {
    cancelSimDestroy();
    simDestroyTimerRef.current = setTimeout(() => {
      simDestroyTimerRef.current = null;
      if (activeSimRef.current) return;   // a sim became active again — keep the live iframe
      // Reset the fresh-mount machinery: the next entry must take the not-sameUrl path
      // (PING_SIM_READY poll → SIM_READY → startScript) against a brand-new iframe.
      activeSimUrlRef.current = null;
      simReadyRef.current = false;
      simPaintedUrlRef.current = null;          // freed context — its painted frame is gone
      awaitingPaintSimIdRef.current = null;
      clearRevealTimers();
      merge({ activeSimUrl: null, activeSimBootHide: null, simBootStalled: false, simColdCover: false });  // unmounts the iframe → frees the WebGL context
    }, Math.max(700, graceOverrideMs ?? simDestroyGraceMs()));
  };

  // ── (D5) free HLS bandwidth/memory while a sim holds the screen ───────────
  // Only the active + standby instances — never the b-roll pair. startLoad is only
  // called if we stopLoad'ed (flag), and both are idempotent/null-guarded.
  const stopHlsForSim = () => {
    if (!useHlsJsRef.current || simHlsStoppedRef.current) return;
    simHlsStoppedRef.current = true;
    try { hlsRef.current?.stopLoad(); } catch { /* detached */ }
    try { hlsStandbyRef.current?.stopLoad(); } catch { /* detached */ }
  };

  const resumeHlsAfterSim = () => {
    if (!simHlsStoppedRef.current) return;
    simHlsStoppedRef.current = false;
    try { hlsRef.current?.startLoad(); } catch { /* detached */ }
    try { hlsStandbyRef.current?.startLoad(); } catch { /* detached */ }
  };

  // ── (D4) warm the HTTP cache for an upcoming sim (entry + bridge.js) ──────
  // Mirrors the iframe's exact request URL (resolveAssetUrl + resolveSimUrl) so the
  // cache entry actually hits when the iframe mounts. Fetch-only — no iframe here.
  const prefetchSimAssets = (rawUrl: string) => {
    if (typeof window === 'undefined') return;
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (nav.connection?.saveData) return;
    if (prefetchedSimUrlsRef.current.has(rawUrl)) return;
    prefetchedSimUrlsRef.current.add(rawUrl);
    try {
      const entryHref = resolveSimUrl(resolveAssetUrl(rawUrl) ?? rawUrl);
      fetch(entryHref, { credentials: 'omit', mode: 'cors' }).catch(() => {});
      const entry = new URL(entryHref, window.location.href);
      const v = entry.searchParams.get('v');
      if (v) {
        const bridge = new URL('bridge.js', entry);   // sibling of the entry file
        bridge.search = '';
        bridge.searchParams.set('v', v);
        fetch(bridge.href, { credentials: 'omit', mode: 'cors' }).catch(() => {});
      }
    } catch { /* best-effort — never surface prefetch failures */ }
  };

  // Minimal-UI selectors a sim section should BOOT with (fragment hint → painted
  // already-minimal). Only when simple_ui is on and there are mechanical hides.
  const bootHideFor = (sec: SimulationOverlay | null | undefined): string[] | null =>
    sec?.simple_ui && sec.ui_hide?.length ? sec.ui_hide : null;

  // Mount an upcoming sim's iframe hidden BEFORE the boundary (playing-path + scrub warm-up).
  // No activeSimRef/reveal state is touched. On SIM_READY, a capable device leaves the hidden
  // sim RUNNING (un-paused) so it paints its scene while off-screen; the bridge posts
  // SIM_PAINTED and we freeze it — so the boundary reveals an already-painted frame with no
  // load. Low-end/Data-Saver devices park it cold at SIM_READY instead (see the SIM_READY handler).
  const premountSim = (sec: SimulationOverlay | null | undefined) => {
    if (activeSimRef.current) return;   // live iframe (possibly on screen) — never navigate it
    if (!sec?.simulation_url) return;
    prefetchSimAssets(sec.simulation_url);
    cancelSimDestroy();
    if (activeSimUrlRef.current === sec.simulation_url) return;   // already mounted (warm)
    // Re-targeting a still-warm iframe to a DIFFERENT url: freeze the outgoing document's rAF
    // so it can't post a late SIM_PAINTED that would be mis-attributed to the new target, and
    // bump the generation so any reveal scheduled against the old warm is dropped.
    if (activeSimUrlRef.current) { sendToSim({ type: 'simPause' }); warmGenRef.current++; }
    simReadyRef.current = false;
    simPaintedUrlRef.current = null;
    activeSimUrlRef.current = sec.simulation_url;
    merge({ activeSimUrl: sec.simulation_url, activeSimBootHide: bootHideFor(sec) });
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
        warmGenRef.current++;                    // invalidate any pending reveal
        sendToSim({ type: 'stopScript' });
        // Fade out immediately at the boundary; CSS opacity transition smooths it.
        merge({ showSimOverlay: false, simBootStalled: false, simColdCover: false });
        // (D2) After the existing messages: freeze the hidden sim's rAF loop, then arm the
        // destroy grace (>= 700ms, so the unmount can never land inside the 200ms fade).
        sendToSim({ type: 'simPause' });
        scheduleSimDestroy();
      } else if (activeSimUrlRef.current && !simDestroyTimerRef.current) {
        // A scrub pre-mount that never became active: freeze it and let the grace free it.
        sendToSim({ type: 'simPause' });
        scheduleSimDestroy();
      }
      clearRevealTimers();
      awaitingPaintSimIdRef.current = null;
      desiredSimRef.current = null;
      pendingSimRef.current = null;
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

    // Section is CHANGING — invalidate any reveal scheduled for the previous section.
    warmGenRef.current++;
    if (activeSimRef.current) {
      sendToSim({ type: 'stopScript' });
      // Fade out immediately at the boundary; CSS opacity transition smooths it.
      merge({ showSimOverlay: false, simBootStalled: false, simColdCover: false });
      // (D2) Existing messages first, then freeze the hidden sim + arm the destroy grace.
      // On a sim→sim change the enter branch below cancels the grace synchronously.
      sendToSim({ type: 'simPause' });
      scheduleSimDestroy();
    } else if (!simSection && activeSimUrlRef.current && !simDestroyTimerRef.current) {
      // A scrub pre-mount that never became active: freeze it and let the grace free it.
      sendToSim({ type: 'simPause' });
      scheduleSimDestroy();
    }
    // A section change (into another sim OR out of sims) invalidates any queued reveal/start.
    clearRevealTimers();
    awaitingPaintSimIdRef.current = null;
    if (!simSection) { desiredSimRef.current = null; pendingSimRef.current = null; }
    activeSimRef.current = simSection;

    if (!simSection && resumeActionRef.current === 'backToVideo') {
      resumeActionRef.current = 'resume';
      userPausedRef.current = false;
      merge({ showResumeBtn: false, resumeAction: 'resume' });
    }

    if (simSection) {
      // (D2) Entered a sim section before a pending destroy grace fired — keep the iframe.
      cancelSimDestroy();
      const script  = simSection.sim_script ?? 'main';
      const params: SimStartScriptParams = {
        simpleUi:   simSection.simple_ui ?? false,
        autoScript: simSection.auto_script ?? true,
        // Minimal-UI control picker: mechanical hides (wrap template) while simpleUi is on.
        ...(simSection.ui_hide?.length ? { hideSelectors: simSection.ui_hide } : {}),
      };
      const sameUrl = simSection.simulation_url === activeSimUrlRef.current;
      activeSimUrlRef.current = simSection.simulation_url;
      desiredSimRef.current = { script, params };   // what the loaded sim SHOULD be running now
      merge({ activeSimUrl: simSection.simulation_url, activeSimBootHide: bootHideFor(simSection) });

      if (isPostRollSim) {
        videoRef.current?.pause();
        userPausedRef.current = true;
        resumeActionRef.current = 'backToVideo';
        simReturnGlobalSecRef.current = timelineRef.current[segmentIdx]?.offset ?? 0;
        merge({ showResumeBtn: true, resumeAction: 'backToVideo', controlsVisible: true });
        // (D5) The player itself paused the video for a post-roll sim — stop the active +
        // standby HLS loaders (never the b-roll pair) until a resume path startLoads them.
        stopHlsForSim();
      }

      // Apply the REAL params to the mounted sim and drive it toward its first painted frame.
      // Reveal is NEVER on a timer — it happens only when the sim has actually painted (the
      // SIM_PAINTED ack sets simPaintedUrlRef, and the SIM_PAINTED / bounded-deadline handlers
      // call revealSim). Until then the underlying content stays: the video keeps PLAYING under
      // a mid-roll sim, or the frozen last frame is held under a paused post-roll sim — so a
      // black/loading frame is structurally unreachable.
      const gen = warmGenRef.current;
      const warmPainted = sameUrl && simReadyRef.current && simPaintedUrlRef.current === simSection.simulation_url;
      awaitingPaintSimIdRef.current = simSection.id;
      if (warmPainted) {
        // The warmed sim already painted its scene while hidden — resume + script + reveal now.
        sendToSim({ type: 'simResume' });
        sendToSim({ type: 'startScript', script, params });
        sendToSim({ type: 'clearBootHide' });   // startScript's __simHideUi supersedes the boot style
        sendToSim({ type: 'simRelayout' });     // re-sync canvas to the container/DPR at reveal
        sendToSim({ type: 'simUnmute' });
        revealSim();
      } else {
        // Cold, or warmed-but-not-yet-painted.
        if (sameUrl && simReadyRef.current) {
          // Same mounted doc, ready but not painted yet (warm still in flight) — drive it now.
          sendToSim({ type: 'simResume' });
          sendToSim({ type: 'simUnmute' });
          sendToSim({ type: 'startScript', script, params });
          sendToSim({ type: 'clearBootHide' });
          sendToSim({ type: 'simRelayout' });
        } else {
          // Different URL (the iframe is navigating) or not ready yet: arm the pending start;
          // handleSimFrameLoad + the SIM_READY handler drive startScript against the new doc.
          if (!sameUrl) simReadyRef.current = false;
          pendingSimRef.current = { script, params };
          startSimPoll();
        }
        // Bounded HOLD ceiling: if SIM_PAINTED never comes (throttled/legacy sim), reveal
        // best-effort — but hold the video/last frame until then. Base the ceiling on the time
        // REMAINING from the actual entry point (localTime), not the section's full span: a
        // mid-roll sim entered partway through (seek/scrub) leaves the video PLAYING, so a
        // ceiling longer than the remaining play time would be cancelled by the leave branch
        // before it fires and the sim would never appear.
        const remainingMs = Math.max(0, simSection.end_sec - localTime) * 1000;
        const holdMs = Math.min(SIM_PAINT_DEADLINE_MS, remainingMs || SIM_PAINT_DEADLINE_MS);
        simPaintDeadlineRef.current = setTimeout(() => {
          simPaintDeadlineRef.current = null;
          if (warmGenRef.current !== gen || awaitingPaintSimIdRef.current !== simSection.id) return;
          simPaintedUrlRef.current = simSection.simulation_url;   // waited long enough — best-effort
          revealSim({ force: true });
        }, holdMs);
        // Sim-first with no video frame underneath to hold → show a brief loader (the one place
        // routine loading UI is correct); otherwise the video/last frame covers the wait silently.
        if ((videoRef.current?.readyState ?? 0) < 2) merge({ simColdCover: true });
        // Genuine-stall error affordance — only fires on a truly broken sim that never paints.
        simBootStalledRef.current = setTimeout(() => {
          simBootStalledRef.current = null;
          if (warmGenRef.current === gen && !showSimOverlayRef.current && activeSimRef.current?.id === simSection.id) {
            merge({ simBootStalled: true });
          }
        }, SIM_BOOT_STALLED_MS);
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

    // (D5) Any segment load resumes normal streaming — clear a sim-hold if one was active.
    // (The stopLoad below is the pre-existing swap choreography for the outgoing instance.)
    resumeHlsAfterSim();
    if (useHlsJsRef.current) hlsRef.current?.stopLoad();
    setProgress(seg.offset + localTime, tot);
    if (refs.progressBuf.current) {
      refs.progressBuf.current.style.left  = `${(seg.offset / tot) * 100}%`;
      refs.progressBuf.current.style.width = '0%';
    }

    warmGenRef.current++;                    // sequence change invalidates any pending reveal
    if (activeSimRef.current) {
      sendToSim({ type: 'stopScript' });
      merge({ showSimOverlay: false, simBootStalled: false, simColdCover: false });
      // (D2) Existing messages first, then freeze the hidden sim + arm the destroy grace.
      // If the new segment starts inside a sim section, finishSwap → updateSimOverlay
      // re-enters and cancels the grace.
      sendToSim({ type: 'simPause' });
      scheduleSimDestroy();
    }
    clearRevealTimers();
    awaitingPaintSimIdRef.current = null;
    desiredSimRef.current = null;
    pendingSimRef.current = null;
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

      // (D4) Sim prefetch + warm: while playing, warm the HTTP cache 15s ahead, then within
      // SIM_PREMOUNT_LEAD_SEC (12s) pre-MOUNT the iframe hidden so it parses, boots AND paints
      // its scene behind the video — the boundary then reveals an already-painted, already-
      // minimal sim with no load. Covers the in-segment case and, when the current segment is
      // ending, the FIRST sim of the next segment (cross-segment lead, ~0 today).
      if (!videoRef.current?.paused && !activeSimRef.current) {
        const segDur = timelineRef.current[idx]?.duration ?? segmentsRef.current[idx]?.duration_sec ?? Infinity;
        const inSeg = segmentsRef.current[idx]?.simulations.find((s) =>
          !!s.simulation_url && t < s.start_sec && s.start_sec - t <= 15,
        ) ?? null;
        // Next segment's opening sim, when this segment is within the lead window of its end.
        const nextOpener = (segDur - t <= SIM_PREMOUNT_LEAD_SEC)
          ? (segmentsRef.current[idx + 1]?.simulations.find((s) =>
              !!s.simulation_url && s.start_sec <= 0.05) ?? null)
          : null;
        const upcomingSim = inSeg ?? nextOpener;
        if (upcomingSim?.simulation_url) {
          prefetchSimAssets(upcomingSim.simulation_url);
          const lead = inSeg ? inSeg.start_sec - t : segDur - t;
          if (lead <= SIM_PREMOUNT_LEAD_SEC) premountSim(upcomingSim);
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
      // (D5) Safety net: any playback resume must restore streaming if a sim-hold
      // stopLoad'ed the loaders (e.g. Space to resume out of a userInteraction pause).
      resumeHlsAfterSim();
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
        // Self-heal: if the pending start was consumed (e.g. the OLD page answered a
        // ping mid-navigation) but a sim section is active and has a desired script,
        // start from the desired state anyway — a READY sim inside an active section
        // must never stay scriptless/hidden. (sim-reliability fix)
        const pending = pendingSimRef.current ??
          (activeSimRef.current && desiredSimRef.current ? { ...desiredSimRef.current } : null);
        pendingSimRef.current = null;
        if (pending && (!userPausedRef.current || resumeActionRef.current === 'backToVideo')) {
          // Active section is waiting: drive the sim to paint. Reveal is NOT scheduled here —
          // it is gated on the SIM_PAINTED ack (or the bounded deadline armed in updateSimOverlay).
          sendToSim({ type: 'simResume' });
          sendToSim({ type: 'simUnmute' });
          sendToSim({ type: 'startScript', script: pending.script, params: pending.params });
          sendToSim({ type: 'clearBootHide' });
          sendToSim({ type: 'simRelayout' });
        } else if (!pending && !activeSimRef.current) {
          // A pre-mounted (scrub / playing-path) sim finished loading while no section is active.
          if (canWarmUnpaused()) {
            // Keep it RUNNING (un-paused) so it paints its scene while hidden; mute it and gate
            // guidance off. SIM_PAINTED will freeze it; if it never paints, the ceiling below does.
            sendToSim({ type: 'simMute' });
            sendToSim({ type: 'guidanceGate', active: false });
            if (simPaintDeadlineRef.current) clearTimeout(simPaintDeadlineRef.current);
            simPaintDeadlineRef.current = setTimeout(() => {
              simPaintDeadlineRef.current = null;
              if (!activeSimRef.current) sendToSim({ type: 'simPause' });   // park un-acked (not marked painted)
            }, SIM_PAINT_DEADLINE_MS);
          } else {
            // Low-end / Data-Saver: don't spend GPU warming a hidden sim — park it cold.
            sendToSim({ type: 'simPause' });
          }
        }
      }
      if (type === 'SIM_PAINTED') {
        // The sim rendered its first real frame (from the v4 rAF gate). This — not SIM_READY —
        // is when it's safe to show. Freeze a still-hidden premount; reveal an awaited section.
        // Require the CURRENT document to have handshaked (SIM_READY precedes its SIM_PAINTED from
        // the same frame): a paint arriving while simReadyRef is false is a stale ack from an
        // abandoned document (in-place iframe navigation reuses the same source window), so
        // attributing it to activeSimUrlRef would falsely mark a not-yet-painted target painted.
        if (!simReadyRef.current) return;
        if (simPaintDeadlineRef.current) { clearTimeout(simPaintDeadlineRef.current); simPaintDeadlineRef.current = null; }
        simPaintedUrlRef.current = activeSimUrlRef.current;
        if (!activeSimRef.current) {
          sendToSim({ type: 'simPause' });   // painted + frozen, ready for an instant reveal later
        } else if (awaitingPaintSimIdRef.current === activeSimRef.current.id) {
          revealSim();
        }
      }
      if (type === 'userInteraction') {
        videoRef.current?.pause();
        sendToSim({ type: 'pauseScript' });   // stop animation, keep sim panel visible
        userPausedRef.current = true;
        // (D5) The player paused the video while the sim holds the screen — stop the
        // active + standby HLS loaders. NO simPause here: the sim stays visible and
        // interactive, and guidance depends on pauseScript arriving exactly as before.
        if (showSimOverlayRef.current) stopHlsForSim();
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

  // ── iframe load handler — reset ready state + RE-ARM startScript when src changes ──
  // Re-arming from desiredSimRef heals the stale-SIM_READY race: the OLD page can answer a
  // ping mid-navigation and consume pendingSimRef, which left the NEW page visible but
  // scriptless. On load the freshly loaded page always gets the current desired script.
  // Wired as the iframe's React onLoad (SimOverlayDynamic) — the old addEventListener
  // effect ran once while the lazily-mounted iframe ref was still null and never
  // attached, so this heal was dead code. (sim-race + sim-reliability fix)
  const handleSimFrameLoad = useCallback(() => {
    simReadyRef.current = false;
    simPaintedUrlRef.current = null;   // a fresh document has painted nothing yet
    if (desiredSimRef.current) pendingSimRef.current = { ...desiredSimRef.current };
    startSimPoll();
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
      // (D2) Pending destroy grace must not fire into an unmounted tree.
      if (simDestroyTimerRef.current) { clearTimeout(simDestroyTimerRef.current); simDestroyTimerRef.current = null; }
      clearRevealTimers();
      // Stop any cutaway / guided-narration audio so it doesn't keep playing after
      // the player unmounts (e.g. navigating away mid-cutaway or mid-guidance).
      if (audioCutawayRef.current) { audioCutawayRef.current.pause(); audioCutawayRef.current = null; }
      if (guidanceAudioRef.current) { guidanceAudioRef.current.pause(); guidanceAudioRef.current = null; }
      // Restore the video volume that guided narration ducked to 0.2 — otherwise a
      // cleanup that runs mid-cue leaves the element (and any re-mount reusing it)
      // permanently capped. Clear the duck ref, then re-apply the true volume.
      guidanceVolRef.current = null;
      applyMediaVolume();
      // Release the avatar-circle audio taps so unmounted video elements (and their
      // WebAudio nodes) can be GC'd instead of accumulating across navigations. (perf-006)
      releaseAvatarElement(refs.videoA.current);
      releaseAvatarElement(refs.videoB.current);
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

    // While the thumb rests over a sim section (~180ms), mount that sim hidden and
    // unscripted so it boots DURING the scrub — releasing inside the section then
    // reveals a warm iframe instead of starting a cold load. No script/reveal state
    // is touched (activeSimRef stays as-is), so the SIM_READY self-heal cannot
    // reveal a pre-mount; an unused pre-mount is frozen + grace-freed on release.
    const premountSimAt = (targetGlobal: number) => {
      // Never while a sim section is ACTIVE: the shared iframe is live (possibly
      // visible mid-roll) and navigating it here would destroy that session on
      // screen — and the onLoad re-arm + SIM_READY heal could then run the old
      // section's script on the new page. An active section needs no warm-up.
      if (activeSimRef.current) return;
      const tl = timelineRef.current;
      let idx = 0;
      for (let i = tl.length - 1; i >= 0; i--) { if (tl[i].offset <= targetGlobal) { idx = i; break; } }
      const seg = segmentsRef.current[idx];
      if (!seg) return;
      const local = Math.max(0, targetGlobal - tl[idx].offset);
      const sec = seg.simulations.find((s) => s.simulation_url && local >= s.start_sec && local < s.end_sec);
      premountSim(sec);
    };

    const clearPremountTimer = () => {
      if (scrubPremountTimerRef.current) { clearTimeout(scrubPremountTimerRef.current); scrubPremountTimerRef.current = null; }
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
      const target = getPct(cx) * totalDurRef.current;
      setProgress(target);
      clearPremountTimer();
      scrubPremountTimerRef.current = setTimeout(() => {
        scrubPremountTimerRef.current = null;
        if (scrubbingRef.current) premountSimAt(target);
      }, 180);
    };

    const endScrub = (cx: number) => {
      if (!scrubbingRef.current) return;
      scrubbingRef.current = false;
      clearPremountTimer();
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
        // (D5) Scrub-away resumes streaming anyway (startLoad below) — clear the sim-hold
        // flag so it stays truthful for the next stopHlsForSim.
        resumeHlsAfterSim();
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

    // Pointer Events + pointer capture — YouTube-grade scrubbing. Capturing on
    // pointerdown routes every subsequent move/up/cancel to the wrap no matter
    // where the pointer goes: outside the window, over the sim IFRAME (which
    // otherwise swallows mouse events), or into another element. The old
    // mouse/touch listeners missed the release in exactly those cases, leaving
    // scrubbingRef stuck until an extra click. pointercancel (browser gesture
    // takeover) and lostpointercapture are handled so NO path can strand a drag.
    let activePointerId: number | null = null;
    let lastClientX = 0;

    const release = (cx: number) => {
      if (activePointerId !== null) {
        try { wrap.releasePointerCapture(activePointerId); } catch { /* already released */ }
        activePointerId = null;
      }
      endScrub(cx);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // primary button only
      if (activePointerId !== null) return;   // one finger owns the scrub — no mid-drag takeover
      e.preventDefault();
      activePointerId = e.pointerId;
      lastClientX = e.clientX;
      try { wrap.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
      startScrub(e.clientX);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (activePointerId !== e.pointerId) return;
      lastClientX = e.clientX;
      moveScrub(e.clientX);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (activePointerId !== e.pointerId) return;
      release(e.clientX);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (activePointerId !== e.pointerId) return;
      release(lastClientX);   // commit the last known position, like YouTube
    };
    // Ultimate safety net: capture lost without an up/cancel we saw (e.g. the
    // element was detached mid-drag) — finish the scrub at the last position.
    const onLostCapture = () => { if (scrubbingRef.current) release(lastClientX); };
    // Belt-and-braces for browsers that drop capture silently: a window-level
    // pointerup always ends an in-flight scrub (endScrub self-guards).
    const onWindowPointerUp = (e: PointerEvent) => { if (scrubbingRef.current) release(e.clientX); };

    wrap.addEventListener('pointerdown',        onPointerDown);
    wrap.addEventListener('pointermove',        onPointerMove);
    wrap.addEventListener('pointerup',          onPointerUp);
    wrap.addEventListener('pointercancel',      onPointerCancel);
    wrap.addEventListener('lostpointercapture', onLostCapture);
    window.addEventListener('pointerup',        onWindowPointerUp);

    return () => {
      wrap.removeEventListener('pointerdown',        onPointerDown);
      wrap.removeEventListener('pointermove',        onPointerMove);
      wrap.removeEventListener('pointerup',          onPointerUp);
      wrap.removeEventListener('pointercancel',      onPointerCancel);
      wrap.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('pointerup',        onWindowPointerUp);
      clearPremountTimer();
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
    // If the very first section is a sim (sim-first video / no leading video), warm it during
    // this click gesture so it paints before it's needed instead of cold-loading on screen.
    const firstSim = segmentsRef.current[curIdxRef.current]?.simulations.find(
      (s) => !!s.simulation_url && s.start_sec <= 0.05,
    );
    if (firstSim && !activeSimRef.current) premountSim(firstSim);
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
    // (D5) Both resume paths restart playback — restore streaming if a sim-hold stopped it.
    resumeHlsAfterSim();
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
      // (D2) Overlay hides right below — freeze the sim and arm the destroy grace.
      // SHORT grace here: "back to video" is an explicit "I'm done with this sim",
      // so the iframe is dropped quickly and any later re-entry is a fresh mount in
      // its initial state (the user's in-sim changes are discarded, by design).
      // (If the return point lands inside another sim section, updateSimOverlay /
      // loadSegment below re-enters and cancels the grace.)
      sendToSim({ type: 'simPause' });
      scheduleSimDestroy(1500);
      warmGenRef.current++;
      clearRevealTimers();
      awaitingPaintSimIdRef.current = null;
      desiredSimRef.current = null;
      pendingSimRef.current = null;
      activeSimRef.current = null;
      userPausedRef.current = false;
      resumeActionRef.current = 'resume';
      merge({ showResumeBtn: false, showSimOverlay: false, simBootStalled: false, simColdCover: false, resumeAction: 'resume', controlsVisible: true, globalTime: targetGlobal });
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
    // Restart the animation script that was paused on userInteraction.
    // stopScript FIRST: it cancels the running script and clears the bridge's
    // _lastSig, so the identical startScript below is NOT deduped and the sim
    // returns to its auto-script/default initial state — the user's manual
    // changes (sliders etc.) are discarded on "resume video", by design.
    if (activeSimRef.current) {
      sendToSim({ type: 'stopScript' });
      sendToSim({
        type: 'startScript',
        script: activeSimRef.current.sim_script ?? 'main',
        params: {
          simpleUi:   activeSimRef.current.simple_ui   ?? false,
          autoScript: activeSimRef.current.auto_script ?? true,
          ...(activeSimRef.current.ui_hide?.length ? { hideSelectors: activeSimRef.current.ui_hide } : {}),
        } satisfies SimStartScriptParams,
      });
      sendToSim({ type: 'clearBootHide' });
    }
    safePlay(videoRef.current!);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    actions: { startPlayback, togglePlay, handleVideoClick, resumeFromSim, simFrameLoaded: handleSimFrameLoad, setVolume, toggleMute, revealControls: showControls, selectEdge, goBack },
  };
}
