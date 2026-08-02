'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip, ImageOverlayItem, AudioCutaway, PlayerBranchSequence, PlayerChoicePoint, PlayerBranchEdge } from './types';
import { releaseAvatarElement } from '../../lib/avatarAudioGraph';
import type { SimStartScriptParams } from '../../lib/simUiControls';
import { canWarmUnpaused } from '../../lib/simCapability';
import { collectSimPool, bootHideFor, dynamicScriptFor, flattenSimOccurrences, packageKeyOf, planWindowResidency, SIM_POOL_CAP, type SimPoolFrameSpec } from '../../lib/simPool';
import { applyGateFor } from '../../lib/simApplyGate';
import { simTelemetry } from '../../lib/simTelemetry';

// Resident sim pool tuning. Every sim in the video is mounted ONCE up front in a persistent
// hidden iframe (SimPoolOverlay) that boots muted, paints its scene, and freezes — so entering
// a sim section is a pure opacity swap of an already-painted frame; nothing loads at the
// boundary. A sim's scene paints inside its OWN load-time rAF (independent of startScript);
// the bridge's SIM_PAINTED ack is the "safe to show" signal. Reveal is paint-gated, never a
// timer: if a frame is somehow not painted at its boundary (early seek beating the staggered
// boot, a legacy sim without the v4 gate), the underlying video/last-frame is HELD, with a
// bounded best-effort ceiling and a genuine-stall affordance only after 5s.
const SIM_PAINT_DEADLINE_MS = 1200; // bounded HOLD ceiling (see the deadline handler for what it may reveal)
const SIM_BOOT_STALLED_MS   = 5000; // only after this does a genuine-failure loading affordance show
const SIM_WARM_MAX_MS       = 8000; // hidden un-paused warm budget per frame before force-freezing
// Atomic exit: stopScript synchronously removes __simHideUi and runs the section cleanup, so
// sending it at the boundary re-showed the FULL UI while the overlay was still fading (audited
// deterministic flash). The exit now freezes/mutes first and defers stopScript until the CSS
// opacity fade (200ms, viewer.css) has finished.
const SIM_EXIT_STOP_MS      = 280;
// Same-document section switch on a PROVEN-modern bridge: the swap waits for SCRIPT_APPLIED and
// is NEVER force-revealed on a timer (see lib/simApplyGate.ts). This bound only decides when a
// silent wait stops being plausible and the honest failure affordance appears — the outgoing
// content keeps holding either way. Legacy/unknown documents never enter this wait at all.
const SIM_APPLY_STALL_MS    = 3000;
// Sliding-window residency (weak devices): mount the NEXT package's frame only when its first
// section is this close; drop packages with no section in the window (the active one stays).
const SIM_WINDOW_LEAD_SEC   = 45;

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
  // Resident sim pool: EVERY unique sim in the config (device-capped), mounted once in
  // persistent hidden iframes for the whole session (see SimPoolOverlay) — transitions are
  // pure opacity swaps of already-painted frames; nothing loads at a section boundary.
  simPool:         SimPoolFrameSpec[];
  // Opens the pool's boot gate once the main video's own startup is out of the way
  // (loadeddata / short fallback / sim-first video) — sims must not race the video's boot.
  simPoolArm:      boolean;
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
  simFrameLoaded:   (url: string) => void;             // wire to each pool iframe's onLoad
  registerSimFrame: (url: string, el: HTMLIFrameElement | null) => void;  // pool ref registry
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

  // Kill switch: 'single' mode (admin_settings.sim_pool_mode / SIM_POOL_MODE env, overridable
  // per-session with ?simpool=single|adaptive) reverts to the conservative pre-pool behavior —
  // ONE sim frame, mounted on activation, no residency/warm — without a deploy rollback.
  const simPoolModeRef = useRef<'adaptive' | 'single' | null>(null);
  if (simPoolModeRef.current === null) {
    let mode: 'adaptive' | 'single' = config.sim_pool_mode === 'single' ? 'single' : 'adaptive';
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('simpool');
      if (q === 'single' || q === 'adaptive') mode = q;
    }
    simPoolModeRef.current = mode;
  }
  // Residency tier, decided once per mount. 'all': every active-path PACKAGE mounts up front
  // (strong devices; ≤SIM_POOL_CAP). 'window': only active + next package resident (weak/touch/
  // Data-Saver). 'single': kill-switch — nothing up front; only the active package is ever
  // mounted, dropped on leave (approximates the pre-pool single navigating iframe).
  const poolTierRef = useRef<'all' | 'window' | 'single' | null>(null);
  if (poolTierRef.current === null) {
    poolTierRef.current = simPoolModeRef.current === 'single' ? 'single' : canWarmUnpaused() ? 'all' : 'window';
  }
  const initialSimPoolRef = useRef<SimPoolFrameSpec[] | null>(null);
  if (initialSimPoolRef.current === null) {
    // 'window' starts EMPTY: the residency planner mounts active+next by media-time lead — the
    // old cap of 1 booted the first package at video start even when its section was minutes
    // away (audited distant-mount defect on weak devices).
    // 'window' starts EMPTY (the planner mounts by media-time lead) — EXCEPT when the timeline
    // OPENS on a simulation: there is no lead time to plan with, so its package must be seeded or
    // a weak device is guaranteed a cold boot at t=0 (the arm gate already opens immediately for
    // sim-first). 'single' never pre-mounts.
    const opensOnSim = (config.segments?.[0]?.simulations ?? []).some((sec) => !!sec.simulation_url && sec.start_sec <= 0.05);
    const simFirstSeed = poolTierRef.current === 'window' && opensOnSim ? 1 : 0;
    const cap = poolTierRef.current === 'all' ? SIM_POOL_CAP : simFirstSeed;
    initialSimPoolRef.current = collectSimPool(config, cap);
  }
  // Does the timeline OPEN on a sim (no leading video)? Then pool frames must arm immediately —
  // there is no video boot to protect.
  const simFirst = (initialSegments[0]?.simulations ?? []).some((s) => !!s.simulation_url && s.start_sec <= 0.05);

  const [state, setState] = useState<ProjectPlayerState>({
    playing:          false,
    started:          false,
    showResumeBtn:    false,
    showSimOverlay:   false,
    showBrollOverlay: false,
    controlsVisible:  true,
    globalTime:       0,
    activeSimUrl:     null,
    simPool:          initialSimPoolRef.current,
    simPoolArm:       simFirst,
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
  const simPollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  // Pending/desired start for the ACTIVE section. `dynScript` = the section's own id (v2
  // dynamic bridges run it directly); `legacyScript` = what an old bridge understands
  // ('main' → its URL's ?section default); `sectionUrl` lets the SIM_READY handler detect a
  // legacy frame parked on the WRONG section (→ navigate).
  interface PendingSimStart { sectionUrl: string; dynScript: string; legacyScript: string; params: SimStartScriptParams }
  const pendingSimRef   = useRef<PendingSimStart | null>(null);
  // The CURRENT desired sim script+params while a sim section is active (null outside one).
  // A pool frame's 'load' listener re-arms pendingSimRef from this so a freshly (re)loaded
  // active frame always gets the current desired script.
  const desiredSimRef   = useRef<PendingSimStart | null>(null);
  // (D5) True while we stopLoad()'ed the active+standby HLS because a sim holds the screen
  // with the video paused by the player — only then may we startLoad() them back.
  const simHlsStoppedRef = useRef(false);
  // ── Resident sim pool ────────────────────────────────────────────────────────
  // Pool specs mirrored in a ref (stale-closure-safe); grows only for overflow/branching sims
  // not present in the initial config walk.
  const simPoolSpecsRef = useRef<SimPoolFrameSpec[]>(initialSimPoolRef.current);
  // Live iframe elements, keyed by RAW sim URL (registered by SimPoolOverlay callback refs).
  const simPoolFramesRef = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Per-PACKAGE lifecycle flags (keyed by packageKeyOf). `painted` (the bridge's SIM_PAINTED
  // first-frame ack) — not `ready` — is the reveal gate. `dynamic` is the bridge's v2
  // capability (startScript(sectionId) on one document); null until its SIM_READY payload
  // arrives; false = legacy bridge that must NAVIGATE to switch sections. `v4` = the frame's
  // gate can ack paints at all (legacy v3 gates can't — they get the bounded force-reveal).
  // `expectReload` marks a DELIBERATE src change so a late native `load` event (fires after
  // subresources — often after the handshake) can never reset a live frame's flags.
  // `lastScript` = the script the document last APPLIED (ack) or was last sent (no-ack bridge);
  // a same-document switch to a DIFFERENT script briefly awaits SCRIPT_APPLIED before reveal.
  // `ackCapable`: null until known; true once a SCRIPT_APPLIED arrives; false after a switch
  // timed out (stored pre-ack bridge) — those never wait again.
  interface PoolMeta {
    ready: boolean; painted: boolean; dynamic: boolean | null; v4: boolean;
    expectReload: boolean; warmCeil: ReturnType<typeof setTimeout> | null;
    lastScript: string | null; ackCapable: boolean | null;
  }
  const simPoolMetaRef = useRef<Map<string, PoolMeta>>(new Map());
  // Deferred exit stops: key → timer posting stopScript AFTER the fade completes. Cancelled if
  // the same package re-activates inside the fade window (its own startScript supersedes).
  const simDeferredStopRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // A same-document section switch awaiting the bridge's SCRIPT_APPLIED before revealing.
  const pendingApplyRef = useRef<{ key: string; script: string; token: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Monotonic activation token echoed by the bridge on every ack. A stale SCRIPT_APPLIED from a
  // superseded activation (A→B→A faster than the child drains its queue) must never satisfy the
  // CURRENT pending apply — matching on key+script alone could not tell them apart (audited).
  const simActivationTokenRef = useRef(0);
  // Section id waiting on a paint ack to reveal (set on cold/at-boundary entry).
  const awaitingPaintSimIdRef = useRef<string | null>(null);
  // Bounded HOLD ceiling: reveals best-effort if SIM_PAINTED never arrives (legacy sim).
  const simPaintDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Genuine-stall (5s) → the only path that ever shows a loading affordance in normal flows.
  const simBootStalledRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every section change / seek / sequence load; a reveal scheduled under an old
  // generation is dropped, so a stale async paint can never reveal the wrong sim.
  const warmGenRef = useRef(0);
  // Hidden-warm serialization: at most ONE background frame runs unpaused at a time (several
  // hidden WebGL scenes warming concurrently would fight the video decode). Others queue
  // paused and take their turn when the current one paints or hits its budget.
  const warmingSimUrlRef = useRef<string | null>(null);
  const warmQueueRef = useRef<string[]>([]);
  // Latest resumeFromSim, callable from togglePlay (declared earlier than resumeFromSim).
  const resumeFromSimRef = useRef<() => void>(() => {});
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

  // ── postMessage helpers (pool-frame routed; KEYS are package identities) ──
  const sendToFrame = (key: string | null, msg: object) => {
    if (!key) return;
    try { simPoolFramesRef.current.get(key)?.contentWindow?.postMessage(msg, '*'); } catch (_) {}
  };
  // Messages for "the current section's sim" go to the ACTIVE package's frame.
  const sendToSim = (msg: object) => sendToFrame(activeSimUrlRef.current, msg);

  // Per-package lifecycle flags (get-or-create — a frame may message before any bookkeeping).
  const poolMeta = (key: string): PoolMeta => {
    let m = simPoolMetaRef.current.get(key);
    if (!m) {
      m = { ready: false, painted: false, dynamic: null, v4: false, expectReload: false, warmCeil: null, lastScript: null, ackCapable: null };
      simPoolMetaRef.current.set(key, m);
    }
    return m;
  };
  const clearWarmCeil = (m: { warmCeil: ReturnType<typeof setTimeout> | null }) => {
    if (m.warmCeil) { clearTimeout(m.warmCeil); m.warmCeil = null; }
  };
  // Serialized hidden warming: run ONE background frame unpaused until it paints (or its
  // budget expires), then advance the queue. Frames that painted, were reloaded, or became
  // the active section are skipped naturally.
  const beginWarm = (key: string) => {
    const meta = poolMeta(key);
    warmingSimUrlRef.current = key;
    clearWarmCeil(meta);
    simTelemetry('warm-begin', { key });
    meta.warmCeil = setTimeout(() => {
      meta.warmCeil = null;
      if (key !== activeSimUrlRef.current) sendToFrame(key, { type: 'simPause' });
      simTelemetry('warm-budget-expired', { key });
      finishWarm(key);
    }, SIM_WARM_MAX_MS);
  };
  const finishWarm = (key: string) => {
    if (warmingSimUrlRef.current !== key) return;
    warmingSimUrlRef.current = null;
    while (warmQueueRef.current.length) {
      const next = warmQueueRef.current.shift()!;
      const m = poolMeta(next);
      if (next === activeSimUrlRef.current || m.painted || !m.ready) continue;
      sendToFrame(next, { type: 'simResume' });
      beginWarm(next);
      return;
    }
  };
  // Drop a package's frame entirely (iframe unmounts → context/heap freed). Releases the warm
  // slot FIRST — evicting the currently-warming frame must never strand the queue.
  const dropPooled = (key: string, reason: string) => {
    warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
    finishWarm(key);
    const meta = simPoolMetaRef.current.get(key);
    if (meta) clearWarmCeil(meta);
    simPoolMetaRef.current.delete(key);
    simPoolSpecsRef.current = simPoolSpecsRef.current.filter((s) => s.key !== key);
    merge({ simPool: simPoolSpecsRef.current });
    simTelemetry('pool-spec-evict', { key, reason });
  };
  // Grow the pool at section entry (on-demand adds mount immediately — no stagger). A hard
  // ceiling protects the browser's live-WebGL-context budget: beyond it, evict the first
  // non-active, non-warming frame.
  const SIM_POOL_HARD_CAP = 6;
  const ensurePooledSpec = (spec: SimPoolFrameSpec) => {
    if (simPoolSpecsRef.current.some((s) => s.key === spec.key)) return;
    // Single mode: strictly one resident frame — evict every non-active package before adding.
    if (poolTierRef.current === 'single') {
      for (const s of [...simPoolSpecsRef.current]) {
        if (s.key !== activeSimUrlRef.current) dropPooled(s.key, 'single-mode');
      }
    }
    if (simPoolSpecsRef.current.length + 1 > SIM_POOL_HARD_CAP) {
      const evict = simPoolSpecsRef.current.find((s) =>
        s.key !== spec.key && s.key !== activeSimUrlRef.current && s.key !== warmingSimUrlRef.current)
        ?? simPoolSpecsRef.current.find((s) => s.key !== spec.key && s.key !== activeSimUrlRef.current);
      if (evict) dropPooled(evict.key, 'hard-cap');
    }
    simPoolSpecsRef.current = [...simPoolSpecsRef.current, spec];
    merge({ simPool: simPoolSpecsRef.current });
    simTelemetry('pool-spec-add', { key: spec.key });
  };
  const ensurePooled = (sec: SimulationOverlay) => {
    const url = sec.simulation_url;
    if (!url) return;
    ensurePooledSpec({ key: packageKeyOf(url), src: url, bootHide: bootHideFor(sec) });
  };
  // ── Deferred exit stop (atomic fade-out) ──────────────────────────────────
  // stopScript synchronously removes __simHideUi and runs the section cleanup inside the
  // child, so posting it at the boundary re-showed the FULL UI while the overlay was still
  // ~200ms into its opacity fade (audited deterministic Minimal-UI flash). The exit path now
  // freezes+mutes the frame immediately and posts stopScript only after the fade finished.
  // Cancelled when the same package re-activates inside the window — the new startScript
  // runs the bridge's own stopScript first, and a late deferred stop would kill the LIVE
  // section instead.
  const cancelDeferredStop = (key: string) => {
    const t = simDeferredStopRef.current.get(key);
    if (t) { clearTimeout(t); simDeferredStopRef.current.delete(key); }
  };
  const scheduleDeferredStop = (key: string) => {
    cancelDeferredStop(key);
    simDeferredStopRef.current.set(key, setTimeout(() => {
      simDeferredStopRef.current.delete(key);
      if (key === activeSimUrlRef.current) return;   // re-activated during the fade — superseded
      sendToFrame(key, { type: 'stopScript' });
      // The section is now torn down (its cleanup restored whatever it had hidden), so the
      // document no longer has it applied. Forget it, or re-entering the SAME section would take
      // the no-wait path and reveal a document showing restored full UI (audited).
      poolMeta(key).lastScript = null;
      simTelemetry('deferred-stop', { key });
    }, SIM_EXIT_STOP_MS));
  };
  const cancelPendingApply = () => {
    if (pendingApplyRef.current) { clearTimeout(pendingApplyRef.current.timer); pendingApplyRef.current = null; }
  };

  // Deliberate frame NAVIGATION (legacy non-dynamic bridge switching sections, or a
  // back-to-video pristine reload). Marks the expected reload so the load handler knows this
  // reset is intentional — a late native `load` from the previous document is ignored.
  // `bootHide` re-cloaks the DESTINATION section (the spec's original bootHide belonged to the
  // package's first-using section — audited: a legacy Minimal-UI target navigated uncloaked).
  const navigateFrame = (key: string, src: string, bootHide?: string[] | null) => {
    const meta = poolMeta(key);
    meta.ready = false; meta.painted = false; meta.expectReload = true;
    meta.lastScript = null; meta.ackCapable = null;   // fresh document — fresh contract
    cancelDeferredStop(key);                          // a deferred stop must not hit the new doc
    clearWarmCeil(meta);
    warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
    finishWarm(key);
    simPoolSpecsRef.current = simPoolSpecsRef.current.map((s) =>
      (s.key === key ? { ...s, src, ...(bootHide !== undefined ? { bootHide } : {}) } : s));
    merge({ simPool: simPoolSpecsRef.current });   // spec.src change → iframe src prop → navigation
    simTelemetry('navigate', { key, src: src.slice(-80) });
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
      const url = activeSimUrlRef.current;
      if (!opts?.force && !(url && poolMeta(url).painted)) return;  // not painted yet
      // CENTRAL GUARD: a proven-modern document awaiting SCRIPT_APPLIED is never presented, no
      // matter which path called reveal (a late SIM_PAINTED, a hold deadline, a poll). The ack
      // handlers clear the pending entry and call reveal again themselves.
      if (!opts?.force && pendingApplyRef.current && pendingApplyRef.current.key === url) return;
      merge({ showSimOverlay: true, simBootStalled: false, simColdCover: false });
    }));
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

  // Poll the ACTIVE frame's two handshakes: SIM_READY (bridge alive) then SIM_PAINTED (first
  // real frame drew). The paint ping matters because the broadcast SIM_PAINTED can fire before
  // our listener is looking (a sim animating during document load paints before SIM_READY) —
  // the v4 gate re-posts it on request. Legacy (pre-v4) sims never answer the paint ping and
  // are covered by the bounded HOLD deadline instead.
  const startSimPoll = useCallback(() => {
    if (simPollRef.current) clearInterval(simPollRef.current);
    let attempts = 0;
    simPollRef.current = setInterval(() => {
      const url = activeSimUrlRef.current;
      const meta = url ? poolMeta(url) : null;
      if (!meta || (meta.ready && meta.painted) || ++attempts > 40) {
        if (simPollRef.current) clearInterval(simPollRef.current);
        return;
      }
      sendToFrame(url, { type: meta.ready ? 'PING_SIM_PAINTED' : 'PING_SIM_READY' });
    }, 300);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── simulation overlay (resident pool) ────────────────────────────────────
  // Deactivate the current section's pool frame — ATOMIC EXIT ORDER (audited):
  //   1. freeze (simPause) + silence (simMute) + close the guidance gate — the fade shows the
  //      last VALID frame, and a hidden resident frame must never keep sounding or polling;
  //   2. start the opacity fade;
  //   3. stopScript only AFTER the fade (deferred) — it restores hidden controls/cleanup, which
  //      used to flash the full UI mid-fade. The frame STAYS mounted and painted.
  const deactivateSim = () => {
    warmGenRef.current++;                    // invalidate any pending reveal
    cancelPendingApply();
    const key = activeSimUrlRef.current;
    if (key && (activeSimRef.current || showSimOverlayRef.current)) {
      sendToFrame(key, { type: 'simPause' });
      sendToFrame(key, { type: 'simMute' });
      sendToFrame(key, { type: 'guidanceGate', active: false });  // before the key is nulled — audited no-op before
      merge({ showSimOverlay: false, simBootStalled: false, simColdCover: false });
      scheduleDeferredStop(key);
    }
    clearRevealTimers();
    awaitingPaintSimIdRef.current = null;
    desiredSimRef.current = null;
    pendingSimRef.current = null;
    activeSimRef.current = null;
    activeSimUrlRef.current = null;
  };

  const updateSimOverlay = (segmentIdx: number, localTime: number) => {
    const seg = segmentsRef.current[segmentIdx];
    if (!seg) {
      deactivateSim();
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

    // Section is CHANGING — stop/hide/freeze the outgoing sim (frame stays resident).
    const hadActive = !!activeSimRef.current;
    if (hadActive || !simSection) deactivateSim();
    else warmGenRef.current++;
    activeSimRef.current = simSection;

    if (!simSection && resumeActionRef.current === 'backToVideo') {
      resumeActionRef.current = 'resume';
      userPausedRef.current = false;
      merge({ showResumeBtn: false, resumeAction: 'resume' });
    }

    if (simSection?.simulation_url) {
      const sectionUrl = simSection.simulation_url;
      const key = packageKeyOf(sectionUrl);
      ensurePooled(simSection);
      const params: SimStartScriptParams = {
        simpleUi:   simSection.simple_ui ?? false,
        autoScript: simSection.auto_script ?? true,
        // Minimal-UI control picker: mechanical hides (wrap template) while simpleUi is on.
        ...(simSection.ui_hide?.length ? { hideSelectors: simSection.ui_hide } : {}),
      };
      // Section-specific config is reapplied on EVERY activation via startScript params —
      // package identity never lets the first section's simple_ui/ui_hide define later ones.
      // dynScript: v2 bridges dispatch the section's own body, keyed by the section URL's
      // ?section= param (dynamicScriptFor — NEVER the stored 'main', which a pooled document
      // resolves to its boot URL's default, i.e. the first-pooled section's body). Legacy
      // bridges only run their URL's ?section default, so they must NAVIGATE when the
      // frame's src is another section.
      const dynScript = dynamicScriptFor(simSection);
      const legacyScript = simSection.sim_script ?? 'main';
      activeSimUrlRef.current = key;
      desiredSimRef.current = { sectionUrl, dynScript, legacyScript, params };
      merge({ activeSimUrl: key });
      simTelemetry('activate', { key, section: simSection.id });

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

      // Activate the resident frame. In the normal flow it booted + painted + froze long ago,
      // so this is: resume, apply the section's real params, unmute, reveal — a pure opacity
      // swap of an already-painted frame. Reveal is NEVER blind: if the frame hasn't painted,
      // the underlying content HOLDS (video keeps playing mid-roll / last frame post-roll)
      // until SIM_PAINTED — the bounded ceiling only force-reveals legacy (pre-v4) frames
      // that can never ack a paint.
      const gen = warmGenRef.current;
      const meta = poolMeta(key);
      const spec = simPoolSpecsRef.current.find((s) => s.key === key);
      // The activated frame no longer occupies the hidden-warm slot; let the next queued
      // frame take its turn (it warms behind whatever is on screen).
      warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
      finishWarm(key);
      awaitingPaintSimIdRef.current = simSection.id;

      cancelDeferredStop(key);   // re-entering during the exit fade — the deferred stop is superseded

      const legacyNeedsNav = meta.dynamic === false && spec && spec.src !== sectionUrl;
      if (legacyNeedsNav) {
        // Old load-time-locked bridge showing a different section — reload it on this URL,
        // re-cloaked with the TARGET section's Minimal-UI selectors (not the first-user's).
        navigateFrame(key, sectionUrl, bootHideFor(simSection));
        pendingSimRef.current = { sectionUrl, dynScript, legacyScript, params };
      } else if (meta.ready && meta.painted) {
        clearWarmCeil(meta);
        const script = meta.dynamic ? dynScript : legacyScript;
        const token = ++simActivationTokenRef.current;
        sendToFrame(key, { type: 'simResume' });
        sendToFrame(key, { type: 'startScript', script, params, token });
        sendToFrame(key, { type: 'clearBootHide' });   // startScript's __simHideUi supersedes the boot style
        sendToFrame(key, { type: 'simRelayout' });     // re-sync canvas to the container/DPR at reveal
        sendToFrame(key, { type: 'simUnmute' });
        // Same-document switch: `painted` only certifies the document once drew SOMETHING
        // (possibly the PREVIOUS section's frozen frame), so a proven-modern bridge holds the
        // swap until its SCRIPT_APPLIED ack — never a timer. See lib/simApplyGate.ts for why
        // this is safe for both bridge generations.
        // Record what the child was actually SENT, immediately — not when it acks. An
        // abandoned switch (seek/branch mid-flight) otherwise left lastScript pointing at the
        // previous section, and re-entering it would take the no-wait path over a document that
        // had already been told to run something else (audited).
        meta.lastScript = script;
        if (applyGateFor(meta, script) === 'await-ack') {
          cancelPendingApply();
          const gen = warmGenRef.current;
          pendingApplyRef.current = {
            key, script, token,
            // NOT a reveal timer: an unacknowledged frame is NEVER presented. The video (or the
            // outgoing last frame) keeps holding; after this bound we surface the honest failure
            // affordance and keep holding. SCRIPT_APPLIED / _MISSING / _ERROR release the wait.
            timer: setTimeout(() => {
              if (pendingApplyRef.current?.token !== token) return;
              if (warmGenRef.current !== gen) return;
              // Hold the outgoing content (the video keeps playing) — but never park a
              // permanent spinner on it. Revealing here would present the PREVIOUS section.
              simTelemetry('apply-ack-stalled', { key, script });
            }, SIM_APPLY_STALL_MS),
          };
        } else {
          revealSim();
        }
      } else if (meta.ready) {
        // Frame is alive but hasn't acked a painted frame yet — drive it and poll the paint ack.
        clearWarmCeil(meta);
        meta.lastScript = meta.dynamic ? dynScript : legacyScript;
        sendToFrame(key, { type: 'simResume' });
        sendToFrame(key, { type: 'simUnmute' });
        sendToFrame(key, { type: 'startScript', script: meta.lastScript, params });
        sendToFrame(key, { type: 'clearBootHide' });
        sendToFrame(key, { type: 'simRelayout' });
      } else {
        // Frame still booting (or just added on-demand): the SIM_READY handler applies the
        // pending start once its bridge answers (and resolves dynamic-vs-legacy then).
        pendingSimRef.current = { sectionUrl, dynScript, legacyScript, params };
      }

      if (!(meta.ready && meta.painted) || legacyNeedsNav) {
        startSimPoll();
        // Bounded HOLD ceiling. A paint ack may still land any moment — but a LEGACY frame
        // (pre-v4 gate) can never ack, so after the ceiling it force-reveals (old behavior,
        // documented blank risk only for legacy sims). v4 frames keep holding the underlying
        // content and surface the wait affordance instead of a blank canvas.
        const remainingMs = Math.max(0, simSection.end_sec - localTime) * 1000;
        const holdMs = Math.min(SIM_PAINT_DEADLINE_MS, remainingMs || SIM_PAINT_DEADLINE_MS);
        simPaintDeadlineRef.current = setTimeout(() => {
          simPaintDeadlineRef.current = null;
          if (warmGenRef.current !== gen || awaitingPaintSimIdRef.current !== simSection.id) return;
          // Mid-roll: the video kept PLAYING through the hold — if the section is about to
          // end anyway, revealing now would flash in and be hidden a tick later. Let it pass.
          const v = videoRef.current;
          if (v && !v.paused && simSection.end_sec - v.currentTime < 0.35) return;
          const m = poolMeta(key);
          if (m.painted) { revealSim(); return; }
          if (m.ready && !m.v4) {
            // Legacy gate — no paint ack will ever come. Best-effort reveal (old behavior).
            m.painted = true;
            simTelemetry('hold-expired-legacy-reveal', { key });
            revealSim({ force: true });
            return;
          }
          // v4 frame, genuinely not painted yet: keep holding the video/last frame and show
          // the honest wait affordance. SIM_PAINTED reveals whenever it lands; the 5s stall
          // affordance takes over if it never does.
          simTelemetry('hold-expired-waiting', { key });
          merge({ simColdCover: true });
        }, holdMs);
        // Sim-first with no video frame underneath to hold → show the loader immediately.
        if ((videoRef.current?.readyState ?? 0) < 2) merge({ simColdCover: true });
        // TERMINAL bound. Making paint acks honest removed the only signal a simulation that
        // never drives requestAnimationFrame ever produced (uploaded DOM / setInterval-canvas
        // packages, and any package whose scene draws once on DOMContentLoaded). Those frames
        // would otherwise hold forever behind the wait affordance — a permanent spinner and an
        // entire class of simulations made undisplayable. So the hold ENDS here: show the frame
        // best-effort rather than never. This is the documented compatibility fallback; a v4
        // package that genuinely paints never reaches it.
        simBootStalledRef.current = setTimeout(() => {
          simBootStalledRef.current = null;
          if (warmGenRef.current !== gen || showSimOverlayRef.current || activeSimRef.current?.id !== simSection.id) return;
          const m = poolMeta(key);
          if (!m.painted) {
            m.painted = true;                       // stop re-arming the hold for this document
            simTelemetry('stall-force-reveal', { key });
            merge({ simBootStalled: false, simColdCover: false });
            revealSim({ force: true });
            return;
          }
          simTelemetry('stall', { key });
          merge({ simBootStalled: true, simColdCover: false });
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

    // Segment load: stop/hide/freeze the outgoing sim; its resident frame stays warm for
    // re-entry. If the new segment starts inside a sim section, finishSwap → updateSimOverlay
    // re-activates it instantly.
    deactivateSim();
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

      // Residency. 'single' tier (kill switch): keep ONLY the active package's frame; drop
      // everything else each tick, so at most one sim document ever lives (approximates the
      // pre-pool navigating iframe). The active frame mounts on activation via ensurePooled.
      if (poolTierRef.current === 'single') {
        for (const spec of [...simPoolSpecsRef.current]) {
          if (spec.key !== activeSimUrlRef.current) dropPooled(spec.key, 'single-mode');
        }
      }
      // Residency. 'all' tier: every active-path package mounted at start — nothing to do.
      // 'window' tier (weak devices): planner-driven — keep only the ACTIVE package plus the
      // next DISTINCT upcoming package within SIM_WINDOW_LEAD_SEC, scanning the WHOLE remaining
      // active path in absolute media time (the old scan stopped at segment+1 and missed sims
      // behind short segments — audited). The plan is authoritative: an EMPTY plan evicts every
      // non-active frame, so long sim-free gaps release WebGL contexts (the old `want.size > 0`
      // guard retained them indefinitely — audited).
      if (poolTierRef.current === 'window') {
        const occurrences = flattenSimOccurrences(
          segmentsRef.current.map((s, i) => ({ offset: timelineRef.current[i]?.offset ?? 0, simulations: s.simulations })),
        );
        const absNow = (timelineRef.current[idx]?.offset ?? 0) + t;
        const plan = planWindowResidency(occurrences, absNow, SIM_WINDOW_LEAD_SEC);
        const keep = new Set(plan.keep);
        if (activeSimUrlRef.current) keep.add(activeSimUrlRef.current);   // never drop the live frame
        // A frame still inside its EXIT FADE must survive: unmounting it mid-fade removes the
        // element being animated (the sim cuts to video instead of fading) and the deferred
        // stopScript would fire into a dead frame. It is evicted on the next tick, after the fade.
        for (const k of simDeferredStopRef.current.keys()) keep.add(k);
        for (const occ of [plan.active, plan.next]) {
          if (occ && !simPoolSpecsRef.current.some((s) => s.key === occ.packageKey)) {
            ensurePooledSpec({ key: occ.packageKey, src: occ.src, bootHide: occ.bootHide });
          }
        }
        for (const spec of [...simPoolSpecsRef.current]) {
          if (!keep.has(spec.key)) dropPooled(spec.key, 'window-slide');
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
      // Self-heal the sim-interaction pause flag on ANY ordinary resume (Space, the play
      // button, a click) — not just the dedicated "Resume video" button. Leaving it set
      // froze updateSimOverlay/broll/image tracking for the rest of the session, gluing the
      // sim overlay + resume button on screen over the playing video. Post-roll's explicit
      // backToVideo state keeps its own resume flow.
      if (userPausedRef.current && resumeActionRef.current !== 'backToVideo') {
        userPausedRef.current = false;
        merge({ showResumeBtn: false });
      }
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

  // ── postMessage listener (pool-frame routed) ──────────────────────────────
  // Every pool frame posts through here; the source window identifies WHICH sim sent it.
  // Only the ACTIVE frame may drive user-visible behavior (pause video, guidance cues,
  // branching edges); background frames only update their own lifecycle flags.
  useEffect(() => {
    const urlOfSource = (source: MessageEventSource | null): string | null => {
      for (const [url, el] of simPoolFramesRef.current) {
        if (el.contentWindow === source) return url;
      }
      return null;
    };
    const handler = (e: MessageEvent) => {
      const frameUrl = urlOfSource(e.source);
      if (!frameUrl) return;
      const meta = poolMeta(frameUrl);
      const isActive = frameUrl === activeSimUrlRef.current;
      const { type } = (e.data as { type?: string }) ?? {};

      if (type === 'SIM_READY') {
        meta.ready = true;
        // v2 capability handshake: dynamic bridges advertise startScript(sectionId) dispatch.
        // A dynamic bridge implies the rebuilt package (v4 gate) — paint acks WILL come.
        // Classify only from a payload that CARRIES the field (or on first contact): the
        // bridge's PING_SIM_READY reply re-posts a bare {type:'SIM_READY'}, and letting it
        // overwrite would DOWNGRADE a known-dynamic frame to legacy → spurious per-section
        // document navigations of a perfectly pooled frame.
        const payload = e.data as { dispatch?: string };
        if (payload.dispatch !== undefined || meta.dynamic === null) {
          meta.dynamic = payload.dispatch === 'dynamic';
        }
        if (meta.dynamic) meta.v4 = true;
        simTelemetry('sim-ready', { key: frameUrl, dynamic: meta.dynamic });
        if (isActive) {
          // Self-heal: even if the pending start was consumed, an active section must never
          // stay scriptless — fall back to the desired state. (sim-reliability fix)
          const pending = pendingSimRef.current ??
            (activeSimRef.current && desiredSimRef.current ? { ...desiredSimRef.current } : null);
          pendingSimRef.current = null;
          if (pending && (!userPausedRef.current || resumeActionRef.current === 'backToVideo')) {
            // LEGACY frame parked on the wrong section: its SCRIPTS.main is the URL's own
            // ?section default, so postMessage can't run the desired section — navigate.
            const spec = simPoolSpecsRef.current.find((s) => s.key === frameUrl);
            if (!meta.dynamic && spec && spec.src !== pending.sectionUrl) {
              pendingSimRef.current = pending;   // re-arm for the post-navigation document
              // Re-cloak for the TARGET section (params carry its Minimal-UI selection).
              navigateFrame(frameUrl, pending.sectionUrl,
                pending.params.simpleUi && pending.params.hideSelectors?.length ? pending.params.hideSelectors : null);
              return;
            }
            // Drive the frame to paint. Reveal stays gated on SIM_PAINTED / the bounded ceiling.
            meta.lastScript = meta.dynamic ? pending.dynScript : pending.legacyScript;
            sendToFrame(frameUrl, { type: 'simResume' });
            sendToFrame(frameUrl, { type: 'simUnmute' });
            sendToFrame(frameUrl, { type: 'startScript', script: meta.lastScript, params: pending.params });
            sendToFrame(frameUrl, { type: 'clearBootHide' });
            sendToFrame(frameUrl, { type: 'simRelayout' });
          }
        } else {
          // A background pool frame finished loading. Mute it and gate guidance off; on capable
          // devices let it warm (run unpaused → paint) — but SERIALIZED, one frame at a time,
          // so several hidden WebGL scenes never fight the video decode concurrently. Low-end
          // parks it cold immediately.
          sendToFrame(frameUrl, { type: 'simMute' });
          sendToFrame(frameUrl, { type: 'guidanceGate', active: false });
          if (canWarmUnpaused()) {
            if (warmingSimUrlRef.current && warmingSimUrlRef.current !== frameUrl) {
              sendToFrame(frameUrl, { type: 'simPause' });
              if (!warmQueueRef.current.includes(frameUrl)) warmQueueRef.current.push(frameUrl);
            } else {
              beginWarm(frameUrl);
            }
          } else {
            sendToFrame(frameUrl, { type: 'simPause' });
          }
        }
      }
      if (type === 'SIM_PAINTED') {
        // The sim rendered its first real frame (v4 rAF gate) — the true "safe to show" signal.
        // Frames only navigate through navigateFrame (expected-reload epoch), so this ack can't
        // belong to a stale document; recording it before SIM_READY is fine (a sim animating
        // during load paints early).
        meta.painted = true;
        meta.v4 = true;
        clearWarmCeil(meta);
        simTelemetry('sim-painted', { key: frameUrl, active: isActive });
        if (!isActive || !activeSimRef.current) {
          sendToFrame(frameUrl, { type: 'simPause' });   // painted + frozen — instant reveal later
        } else if (awaitingPaintSimIdRef.current === activeSimRef.current.id) {
          if (simPaintDeadlineRef.current) { clearTimeout(simPaintDeadlineRef.current); simPaintDeadlineRef.current = null; }
          merge({ simColdCover: false });
          revealSim();
        }
        finishWarm(frameUrl);   // this frame's warm turn is over — advance the queue
      }
      // ── SCRIPT_APPLIED — the bridge finished applying a section (v2.1 ack) ──────────
      // Records the document's authoritative lastScript and releases an ack-gated reveal.
      if (type === 'SCRIPT_APPLIED') {
        const { script: applied = null, token: ackToken } = e.data as { script?: string; token?: number };
        meta.ackCapable = true;
        if (applied) meta.lastScript = applied;
        simTelemetry('script-applied', { key: frameUrl, script: applied, active: isActive });
        const pend = pendingApplyRef.current;
        if (pend && pend.key === frameUrl && pend.script === applied && pend.token === ackToken) {
          clearTimeout(pend.timer);
          pendingApplyRef.current = null;
          if (isActive) { merge({ simBootStalled: false }); revealSim(); }
        }
      }
      // The requested section has NO body in this bridge (regenerated bridge / stale copy).
      // The bridge deliberately runs NOTHING instead of silently playing another section's
      // body; surface it and fall back to the honest bare-scene reveal path.
      if (type === 'SCRIPT_MISSING') {
        const { script: missing = null, token: missToken } = e.data as { script?: string; token?: number };
        meta.ackCapable = true;
        simTelemetry('script-missing', { key: frameUrl, script: missing, active: isActive });
        const pend = pendingApplyRef.current;
        if (pend && pend.key === frameUrl && pend.script === missing && pend.token === missToken) {
          clearTimeout(pend.timer);
          pendingApplyRef.current = null;
          // The bridge ran NOTHING, so the document still shows the PREVIOUS section's frozen
          // frame — revealing it would present exactly the wrong-section frame this gate exists
          // to prevent. Degrade gracefully instead: keep the video playing through the section,
          // with telemetry. No spinner is parked (a failure the viewer cannot act on).
          if (isActive) merge({ simBootStalled: false, simColdCover: false });
        }
      }
      // A section body (or a previous section's cleanup) threw. The bridge recovered — the
      // document is NOT wedged — but record it; the scene may be showing partial state.
      if (type === 'SCRIPT_ERROR') {
        const d = e.data as { script?: string; phase?: string; message?: string; token?: number };
        simTelemetry('script-error', { key: frameUrl, script: d.script, phase: d.phase, message: (d.message ?? '').slice(0, 200), active: isActive });
        const pend = pendingApplyRef.current;
        if (pend && pend.key === frameUrl && pend.script === d.script && pend.token === d.token) {
          clearTimeout(pend.timer);
          pendingApplyRef.current = null;
          // A body that threw mid-apply leaves partial state; do not present it. Same graceful
          // degradation as SCRIPT_MISSING — the video plays on, no permanent spinner.
          if (isActive) merge({ simBootStalled: false, simColdCover: false });
        }
      }
      // ── Guided Simulation init — for EVERY frame (background boots/reloads included) ──
      if (type === 'GUIDANCE_READY') {
        // Seed with already-heard cues so they never replay across boots/reloads — a resident
        // frame usually boots (and back-to-video reloads) while BACKGROUNDED, so this must not
        // sit behind the active-frame gate. The gate send is delayed so it reflects the
        // overlay's actual visible state at fire time (read live, never captured).
        sendToFrame(frameUrl, { type: 'guidanceInit', firedIds: Array.from(firedCueIds.current) });
        setTimeout(() => {
          sendToFrame(frameUrl, { type: 'guidanceGate', active: showSimOverlayRef.current && frameUrl === activeSimUrlRef.current });
        }, 100);
      }

      // Everything below is user-visible behavior — only the ACTIVE frame may drive it.
      if (!isActive) return;

      if (type === 'userInteraction') {
        videoRef.current?.pause();
        // Stops the section's auto-demo timers WITHOUT tearing it down (bridge timer scope). NOTE:
      // only packages whose bridge has been rebuilt honour this — on a stored pre-v2.1 bridge it
      // is still a no-op and the auto-script keeps fighting the user (see the verdict doc).
      sendToFrame(frameUrl, { type: 'pauseScript' });
        userPausedRef.current = true;
        // (D5) The player paused the video while the sim holds the screen — stop the
        // active + standby HLS loaders. NO simPause here: the sim stays visible and
        // interactive, and guidance depends on pauseScript arriving exactly as before.
        if (showSimOverlayRef.current) stopHlsForSim();
        merge({ showResumeBtn: true, badgeMode: 'free', resumeAction: resumeActionRef.current });
      }
      // ── Guided Simulation cues (GUIDANCE_READY handled above the gate, for all frames) ──
      if (type === 'guidanceCue') {
        const { id, text, audioUrl } = (e.data as { id?: string; text?: string; audioUrl?: string }) ?? {};
        if (id && !firedCueIds.current.has(id)) {
          firedCueIds.current.add(id);                       // once per viewing session, across section reloads
          sendToFrame(frameUrl, { type: 'guidanceFired', ids: [id] });
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

  // ── pool frame registry + load handler ─────────────────────────────────────
  // SimPoolOverlay registers each iframe element by URL (callback refs) and reports document
  // loads. A load resets that frame's lifecycle flags (a fresh document has painted nothing);
  // if it's the ACTIVE frame, the desired script re-arms so the new document gets startScript.
  const registerSimFrame = useCallback((url: string, el: HTMLIFrameElement | null) => {
    if (el) simPoolFramesRef.current.set(url, el);
    else simPoolFramesRef.current.delete(url);
  }, []);

  const handleSimFrameLoad = useCallback((key: string) => {
    const meta = poolMeta(key);
    simTelemetry('frame-load', { key, expected: meta.expectReload, hadHandshake: meta.ready || meta.painted });
    // The native `load` event fires after ALL subresources — routinely AFTER the bridge's
    // SIM_READY/SIM_PAINTED handshake on the same document. Resetting flags on such a late
    // load would restart a live, visible sim (poll → fresh SIM_READY → spurious startScript).
    // Flags reset ONLY when this load is a DELIBERATE navigation (navigateFrame/back-to-video
    // marked expectReload) or the frame's very first document (no handshake recorded yet).
    if (!meta.expectReload && (meta.ready || meta.painted)) return;
    meta.expectReload = false;
    meta.ready = false;
    meta.painted = false;
    meta.dynamic = null;
    meta.lastScript = null;
    meta.ackCapable = null;
    clearWarmCeil(meta);
    warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
    finishWarm(key);   // a reloading frame gives up its warm slot
    if (key === activeSimUrlRef.current) {
      if (desiredSimRef.current) pendingSimRef.current = { ...desiredSimRef.current };
      startSimPoll();
    }
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

    simTelemetry('pool-init', { mode: simPoolModeRef.current, tier: poolTierRef.current, packages: initialSimPoolRef.current?.length ?? 0 });
    // Open the pool's boot gate only once the video is actually PLAYING (measured: arming at
    // loadeddata still cost the video 1-4s of startup — sim fetch/parse competed with the
    // first HLS segment). A long fallback covers a permanently-stalled video; sim-first
    // videos opened the gate at init.
    const armPool = () => { merge({ simPoolArm: true }); simTelemetry('pool-armed', {}); };
    vA.addEventListener('playing', armPool, { once: true });
    // Stall fallback — armed only after an actual PLAY ATTEMPT stalls. The old unconditional
    // 12s timer booted WebGL documents on pages the user never pressed play on (audited).
    let armPoolTimer: ReturnType<typeof setTimeout> | null = null;
    const armPoolOnAttempt = () => { if (!armPoolTimer) armPoolTimer = setTimeout(armPool, 12_000); };
    vA.addEventListener('play', armPoolOnAttempt, { once: true });

    const poolMetaAtMount = simPoolMetaRef.current;   // stable Map instance for the cleanup
    const deferredStopsAtMount = simDeferredStopRef.current;
    return () => {
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
      hlsBrollRef.current?.destroy();
      hlsBrollStandbyRef.current?.destroy();
      clearTimeout(idleTimerRef.current ?? undefined);
      if (simPollRef.current) clearInterval(simPollRef.current);
      clearRevealTimers();
      vA.removeEventListener('playing', armPool);
      vA.removeEventListener('play', armPoolOnAttempt);
      if (armPoolTimer) clearTimeout(armPoolTimer);
      // Deferred exit stops + a pending apply-ack must not fire into an unmounted tree.
      for (const t of deferredStopsAtMount.values()) clearTimeout(t);
      deferredStopsAtMount.clear();
      cancelPendingApply();
      // Per-frame warm budgets must not fire into an unmounted tree.
      for (const m of poolMetaAtMount.values()) clearWarmCeil(m);
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

    // (Scrub warm-up removed: every sim is a resident pool frame, booted + painted since
    // player start — releasing the thumb inside a sim section activates it instantly.)
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
    // (Sims need no warm-up here: the resident pool mounted them at player render.)
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
    // Space / the play button during a sim-interaction hold must act as the RESUME action —
    // a raw safePlay would resume the audio/video invisibly UNDER the still-visible sim.
    if (v.paused && userPausedRef.current && showSimOverlayRef.current) { resumeFromSimRef.current(); return; }
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

      // ATOMIC EXIT (same ordering as deactivateSim — audited fade-out flash): freeze + mute
      // NOW so the fade shows the last valid frame silently; run the state-restoring work
      // (stopScript / legacy document reload) only after the fade has finished. A mid-fade
      // stopScript re-showed hidden controls; a mid-fade src reload blanked the frame.
      sendToSim({ type: 'simPause' });
      sendToSim({ type: 'simMute' });
      sendToSim({ type: 'guidanceGate', active: false });
      // "Back to video" is an explicit "I'm done with this sim" — the next entry must start
      // pristine (user's in-sim changes discarded, by design). For a v2 DYNAMIC bridge,
      // stopScript already runs the section's full cleanup and the next activation's
      // startScript re-runs the body from its initial state — NO document reload, no network,
      // no shader recompile, and the frame stays painted for an instant re-entry. Only a
      // LEGACY (pre-v2) bridge falls back to a document reload for pristine state.
      const doneKey = activeSimUrlRef.current;
      const doneFrame = doneKey ? simPoolFramesRef.current.get(doneKey) : null;
      if (doneKey && doneFrame) {
        const m = poolMeta(doneKey);
        if (m.dynamic !== true) {
          cancelDeferredStop(doneKey);
          simTelemetry('reset-reload-legacy', { key: doneKey });
          setTimeout(() => {
            if (doneKey === activeSimUrlRef.current) return;   // re-entered during the fade
            m.ready = false; m.painted = false; m.expectReload = true; m.dynamic = null;
            m.lastScript = null; m.ackCapable = null;
            clearWarmCeil(m);
            // Re-assigning src reloads the (cross-origin) document — location.reload() throws.
            const src = doneFrame.src;
            try { doneFrame.src = src; } catch { /* frame detached */ }
          }, SIM_EXIT_STOP_MS);
        } else {
          simTelemetry('reset-stopscript', { key: doneKey });
          scheduleDeferredStop(doneKey);
        }
      }
      warmGenRef.current++;
      cancelPendingApply();
      clearRevealTimers();
      awaitingPaintSimIdRef.current = null;
      desiredSimRef.current = null;
      pendingSimRef.current = null;
      activeSimRef.current = null;
      // Release the URL too: the reloading frame must be a BACKGROUND frame again, so its
      // fresh SIM_READY takes the mute + guidance-gate + warm-budget path, not the active one.
      activeSimUrlRef.current = null;
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
      const sec = activeSimRef.current;
      const key = activeSimUrlRef.current;
      const dynamic = key ? poolMeta(key).dynamic === true : false;
      const script = dynamic ? dynamicScriptFor(sec) : (sec.sim_script ?? 'main');
      if (key) poolMeta(key).lastScript = script;
      sendToSim({ type: 'stopScript' });
      sendToSim({
        type: 'startScript',
        // Dynamic bridges must be re-pointed at the ACTIVE section's body — 'main' would
        // restart the frame URL's ?section default, which may be a different section.
        // dynamicScriptFor keys off the section URL's ?section= param (sim_script is the
        // literal 'main' on every generated row, so it must never win here).
        script,
        params: {
          simpleUi:   sec.simple_ui   ?? false,
          autoScript: sec.auto_script ?? true,
          ...(sec.ui_hide?.length ? { hideSelectors: sec.ui_hide } : {}),
        } satisfies SimStartScriptParams,
      });
      sendToSim({ type: 'clearBootHide' });
    }
    safePlay(videoRef.current!);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  resumeFromSimRef.current = resumeFromSim;

  return {
    state,
    actions: { startPlayback, togglePlay, handleVideoClick, resumeFromSim, simFrameLoaded: handleSimFrameLoad, registerSimFrame, setVolume, toggleMute, revealControls: showControls, selectEdge, goBack },
  };
}
