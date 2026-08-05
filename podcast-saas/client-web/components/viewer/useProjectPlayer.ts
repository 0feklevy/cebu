'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip, ImageOverlayItem, AudioCutaway, PlayerBranchSequence, PlayerChoicePoint, PlayerBranchEdge } from './types';
import { releaseAvatarElement } from '../../lib/avatarAudioGraph';
import type { SimStartScriptParams } from '../../lib/simUiControls';
import { canWarmUnpaused, learnCanEmitPaint } from '../../lib/simCapability';
import { collectSimPool, bootHideFor, dynamicScriptFor, flattenSimOccurrences, packageKeyOf, planWindowResidency, sectionKeyOf, SIM_POOL_CAP, type SimPoolFrameSpec } from '../../lib/simPool';
import { planResidency, type SimOccurrence } from 'shared/src/sim/occurrencePlanner';
import { resolveBudget } from 'shared/src/sim/prepareBudget';
import { nextQualityFor, INITIAL_QUALITY_STATE, type QualityState } from 'shared/src/sim/adaptiveQuality';
import { armBoundarySentinel, type BoundarySentinel } from '../../lib/sim/boundaryClock';
import { createRumRecorder, type RumRecorder } from '../../lib/sim/rumClient';
import { newPlayerSessionId } from 'shared/src/sim/simIdentity';
import { simTelemetry } from '../../lib/simTelemetry';
import { SimRuntimeClient } from '../../lib/sim/SimRuntimeClient';
// The atomic-exit bound lives in the shared protocol module — it is duplicated in the CSS fade
// and in the e2e harness, and all of them must agree. Importing (rather than re-declaring) is
// what keeps this surface from drifting away from the shared runtime again. The same-document
// apply bound is not needed here at all: the runtime owns that timer.
import { SIM_APPLY_STALL_MS, SIM_EXIT_STOP_MS } from '../../lib/sim/protocol';

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
// LOAD-BEARING ORDERING (review F6): the 5s stall force path is safe only because every apply
// hold is armed with the runtime's terminal bound and therefore released FIRST. Inverting these
// constants would silently let the stall path present a held (unacknowledged) switch, so the
// ordering is asserted here rather than trusted.
if (SIM_APPLY_STALL_MS >= SIM_BOOT_STALLED_MS) {
  throw new Error('SIM_APPLY_STALL_MS must stay below SIM_BOOT_STALLED_MS — see the comment above');
}
const SIM_WARM_MAX_MS       = 8000; // hidden un-paused warm budget per frame before force-freezing
// The atomic-exit bound (SIM_EXIT_STOP_MS) is imported from lib/sim/protocol — see above.
// Paint-recovery poll budget: 40 pings at 300ms. SimRuntimeClient owns the poll; its own
// legacy reveal ceiling is deliberately pushed past that budget because THIS surface keeps its
// richer, section-aware bounded hold below (mid-roll rule + cold-cover/stall affordances).
const SIM_PAINT_POLL_MAX_MS = 12_000;
// Sliding-window residency (weak devices): mount the NEXT package's frame only when its first
// section is this close; drop packages with no section in the window (the active one stays).
const SIM_WINDOW_LEAD_SEC   = 45;

const BRANCH_API = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');
/** Sampled field measurement (migration 051). Inert until an operator raises the sample rate. */
const SIM_RUM_ENDPOINT = `${BRANCH_API}/sim-rum`;

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
  // ── Layered presentation (Priority 5) ──
  // These describe the ACTIVE section only, and every one of them resets when it is left. They are
  // the inputs the layered presentation surface needs and the viewer has no other way to know; see
  // SimPresentationLayers / presentationPolicy for what each one is allowed to change.
  //
  // `simModern` is THE GATE. It is true only while the active package is BOTH classified
  // `managed-presentable` by the publish-time canary AND actually running the activation-scoped
  // protocol. Everything else — an unproven package, a legacy bridge, a modern-capable package
  // whose handshake has not completed — renders exactly what it rendered before, because the
  // layered surface refuses to present anything that has not reported PRESENTED, and no v2 package
  // ever reports it.
  simModern:       boolean;
  simPresented:    boolean;
  // A bounded modern failure is live for this activation (the package did not honour the
  // presentation it promised). Never set on the v2 path, which promised nothing.
  simFailure:      boolean;
  simPosterUrl:    string | null;
  simPosterTransparent: boolean;
  // Are the pixels BENEATH the sim still valid content to show? False only until a video frame has
  // decoded at all (sim-first entry, cold seek) — monotonic after that, because the video element
  // retains its last frame for the rest of the session.
  simOutgoingValid: boolean;
  // Absolute (global-timeline) end of the active sim section, so the surface can compute how much
  // of it is left. Null outside a sim section.
  simSectionEndSec: number | null;
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
  // True once the hook's unmount cleanup ran; late timers consult it before touching the pool.
  const unmountedRef = useRef(false);
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
  // ── Priority 8 runtime switches. Read ONCE from the config; every one defaults to today's
  // behaviour, so a config that predates migration 052 is indistinguishable from all-off.
  const schedulerModeRef = useRef<'off' | 'predictive'>(
    config.sim_scheduler_mode === 'predictive' ? 'predictive' : 'off');
  const adaptiveQualityRef = useRef<boolean>(config.sim_adaptive_quality === true);
  const boundarySentinelRef = useRef<boolean>(config.sim_boundary_sentinel === true);
  /** Per-simulation lab preparation cost, from the package's own canary. */
  const prepareBudgetsRef = useRef<Record<string, number>>(config.sim_prepare_budget_ms ?? {});
  /** Adaptive-quality state per PACKAGE — quality is a property of the bytes, not of a section. */
  const qualityStateRef = useRef<Map<string, QualityState>>(new Map());
  /** The armed boundary sentinel, if any. Exactly one at a time. */
  const boundarySentinelHandleRef = useRef<BoundarySentinel | null>(null);
  const boundaryTargetRef = useRef<number | null>(null);
  const rumRef = useRef<RumRecorder | null>(null);
  /**
   * The RUM recorder for this session, created once.
   *
   * Inert unless an operator has raised the sample rate AND this session wins its single roll, so
   * on every current deployment `createRumRecorder` returns a no-op the player cannot distinguish
   * from a live one. That symmetry is deliberate: nothing in the player may branch on whether
   * measurement is on.
   */
  const rum = (): RumRecorder => {
    if (!rumRef.current) {
      rumRef.current = createRumRecorder({
        endpoint: SIM_RUM_ENDPOINT,
        sampleRate: config.sim_rum_sample_rate ?? 0,
        poolTier: poolTierRef.current,
      });
    }
    return rumRef.current;
  };

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
    // `initialSegments` — the sequence that actually plays — NOT config.segments, which
    // buildPlayerConfig fills with every main video flat in created_at order, so for a branching
    // project its [0] is unrelated to the entry sequence and this decision disagreed with the
    // `simFirst` arm gate below on the very same config (audited).
    const opensOnSim = (initialSegments[0]?.simulations ?? []).some((sec) => !!sec.simulation_url && sec.start_sec <= 0.05);
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
    simModern:            false,
    simPresented:         false,
    simFailure:           false,
    simPosterUrl:         null,
    simPosterTransparent: false,
    simOutgoingValid:     false,
    simSectionEndSec:     null,
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

  // ── Layered-presentation state, written through a change filter ────────────
  // `merge` always allocates a new state object, so it always renders. That is fine for the fields
  // it is used for, which only change at real events — but the presentation fields are RESET on
  // every call to deactivateSim, and deactivateSim runs on EVERY tick outside a sim section
  // (updateSimOverlay only early-returns while a section is active). Merging them unconditionally
  // would therefore re-render the whole player about four times a second for the entire video.
  // The mirror makes the no-op case free while keeping `merge` the single state writer.
  type SimPresentationFields = Pick<
    ProjectPlayerState,
    'simModern' | 'simPresented' | 'simFailure' | 'simPosterUrl' | 'simPosterTransparent'
    | 'simOutgoingValid' | 'simSectionEndSec'
  >;
  const simPresentationRef = useRef<SimPresentationFields>({
    simModern: false,
    simPresented: false,
    simFailure: false,
    simPosterUrl: null,
    simPosterTransparent: false,
    simOutgoingValid: false,
    simSectionEndSec: null,
  });
  const mergePresentation = (patch: Partial<SimPresentationFields>) => {
    const cur = simPresentationRef.current;
    const next = { ...cur, ...patch };
    if (
      next.simModern === cur.simModern &&
      next.simPresented === cur.simPresented &&
      next.simFailure === cur.simFailure &&
      next.simPosterUrl === cur.simPosterUrl &&
      next.simPosterTransparent === cur.simPosterTransparent &&
      next.simOutgoingValid === cur.simOutgoingValid &&
      next.simSectionEndSec === cur.simSectionEndSec
    ) return;
    simPresentationRef.current = next;
    merge(patch);
  };
  /**
   * Everything the layered surface knows about the ACTIVE SECTION, forgotten.
   *
   * `simOutgoingValid` is deliberately absent: whether a video frame has ever decoded is a fact
   * about the player, not about the section being left, and unlearning it would make the next
   * section's cover paint opaque black over a video that is demonstrably there.
   */
  const resetPresentation = () =>
    mergePresentation({
      simModern: false,
      simPresented: false,
      simFailure: false,
      simPosterUrl: null,
      simPosterTransparent: false,
      simSectionEndSec: null,
    });

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
  // Pending/desired start for the ACTIVE section. `dynScript` = the section's own id (v2
  // dynamic bridges run it directly); `legacyScript` = what an old bridge understands
  // ('main' → its URL's ?section default); `sectionUrl` lets the SIM_READY handler detect a
  // legacy frame parked on the WRONG section (→ navigate).
  interface PendingSimStart {
    sectionUrl: string; dynScript: string; legacyScript: string; params: SimStartScriptParams;
    /** True when this activation dispatches NO body (raw package — full simulation). */
    raw: boolean;
  }
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
  // ── Per-PACKAGE state, split by OWNER ───────────────────────────────────────
  // The DOCUMENT lifecycle (ready / painted / currentScript / ackCapable / stopped, the
  // activation token, ack matching, the deferred stopScript and the paint poll) belongs to
  // SimRuntimeClient — one client per package, in `simRuntimesRef` below.
  //
  // PoolMeta keeps only what the POOL MANAGER owns and the runtime deliberately has no notion of:
  //   `canEmitPaint` — whether this PACKAGE's document can emit SIM_PAINTED at all, i.e. whether
  //     its injected rAF gate is the v4 one (legacy v3 gates can't ack a paint, and are the only
  //     frames the bounded hold below is allowed to force-reveal). This is a capability of the
  //     PAINT channel and is NOT a second classification of anything the runtime owns:
  //     `dynamic` classifies in-place section dispatch, `ackCapable` classifies SCRIPT_APPLIED
  //     acks, and both legitimately disagree with it (a DOM/setInterval package acks scripts and
  //     never paints; a load-time-locked package rebuilt with the v4 gate paints and still needs
  //     a per-section URL — both pinned in __tests__/simCapability.test.ts). It also differs from
  //     the runtime's `painted`, a per-DOCUMENT fact every reload resets: capability is a
  //     per-PACKAGE fact, so it is deliberately monotonic across navigations.
  //     Folded by learnCanEmitPaint(): proven by a real paint, implied by the RUNTIME's own
  //     `dynamic` state — read from the runtime, never re-derived here, so dispatch capability is
  //     classified in exactly one place.
  //   `expectReload` — marks a DELIBERATE src change so a late native `load` event (fires after
  //     subresources, often after the handshake) can never reset a live frame's flags.
  //   (the pool's former `paintedLatch` now lives in the runtime as markPaintedByPolicy, so
  //     hatches for documents that can never ack a paint. It is NOT a document fact, so it must
  //     not be written into the runtime's `painted`.
  //   `warmCeil` — the hidden-warm budget timer.
  interface PoolMeta {
    canEmitPaint: boolean;
    expectReload: boolean; warmCeil: ReturnType<typeof setTimeout> | null;
    /**
     * Whether THIS document has ever run a section body. Load-bearing for RAW activations (a
     * section with no ?section= and no named script — "show the full simulation"): those dispatch
     * NO body, so nothing repairs whatever imperative UI state the previous body left behind.
     * The mechanical __simHideUi hide is reversed by stopScript, but generated bodies also hide
     * controls imperatively when params.simpleUi is on, and their cleanups cannot be trusted to
     * restore it — the bytes are baked into published bridges. A raw activation on a scripted
     * document therefore needs a fresh document, and this flag is how it knows.
     */
    scriptedEver: boolean;
  }
  const simPoolMetaRef = useRef<Map<string, PoolMeta>>(new Map());
  /** Monotonic nonce for forced same-URL reloads — see navigateFrame. */
  const simResetSeqRef = useRef(0);
  // One SimRuntimeClient per package. SimRuntimeClient is a ONE-DOCUMENT state machine and this
  // hook manages a POOL of documents, so the map is owned here: created on demand, re-attached on
  // a document IDENTITY change (navigateFrame), disposed on dropPooled and on unmount.
  const simRuntimesRef = useRef<Map<string, SimRuntimeClient>>(new Map());
  // ONE player session for the whole viewer lifetime. It scopes every identity below it, and it is
  // minted per HOOK INSTANCE rather than per module: two players on one page (the editor timeline
  // and the section-editor preview do this by design) must not share a session id, because a
  // shared one would make a message from the other player's document pass the session check.
  const playerSessionIdRef = useRef<string>('');
  if (!playerSessionIdRef.current) playerSessionIdRef.current = newPlayerSessionId();
  // Back-to-video PRISTINE RELOADS: key → timer re-assigning a legacy frame's src AFTER the fade.
  // A navigation, not a stopScript, so it cannot be the runtime's deferred stop — but the
  // residency planner and the unmount cleanup must still see it (audited: a bare timer let the
  // planner evict the frame mid-fade and then fired into a detached iframe).
  const simPristineReloadRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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

  // ── GUIDANCE postMessage helper (pool-frame routed; KEYS are package identities) ──
  // NOT the simulation lifecycle. Every lifecycle message this once carried (simPause/simResume)
  // now goes through SimRuntimeClient.freeze()/thaw(), so the runtime is the single owner of the
  // sim protocol. What is left is the guidance channel, which is a different protocol with its own
  // vocabulary and no lifecycle meaning — routing it through the runtime would put messages the
  // runtime has no model for into the runtime's mouth.
  const sendToFrame = (key: string | null, msg: object) => {
    if (!key) return;
    try { simPoolFramesRef.current.get(key)?.contentWindow?.postMessage(msg, '*'); } catch (_) {}
  };

  // Per-package pool-manager flags (get-or-create — a frame may message before any bookkeeping).
  const poolMeta = (key: string): PoolMeta => {
    let m = simPoolMetaRef.current.get(key);
    if (!m) {
      m = { canEmitPaint: false, expectReload: false, warmCeil: null, scriptedEver: false };
      simPoolMetaRef.current.set(key, m);
    }
    return m;
  };

  // ── SimRuntimeClient ownership ────────────────────────────────────────────
  // Lifecycle reactions are dispatched through a ref so the client can be created before the
  // handlers below are declared (they close over revealSim / merge, which come later in the body).
  /**
   * The package identity a field measurement is filed under, or null when there isn't one.
   *
   * NEVER the pool key as a fallback. That key is a full origin + pathname, so it is always past
   * the validator's 64-character bound — and the validator rejects the whole BATCH on one bad
   * event, not just that event. A single unrevisioned section therefore discarded every
   * measurement sitting beside it in the ring. An unfiled measurement is worth nothing anyway:
   * there is no package to attribute it to, which is exactly why the validator refuses it.
   */
  const rumPackageKey = (): string | null => {
    const rev = activeSimRef.current?.package_revision;
    return typeof rev === 'string' && rev.length > 0 && rev.length <= 64 ? rev : null;
  };

  const runtimeEventRef = useRef<(key: string, event: string, detail?: Record<string, unknown>) => void>(() => {});
  // Get-or-create the client for a package. It registers NO window listener until a frame is
  // attached, so this is safe to call for a package that has no iframe yet.
  const runtimeFor = (key: string): SimRuntimeClient => {
    let rt = simRuntimesRef.current.get(key);
    if (!rt) {
      rt = new SimRuntimeClient({
        // The runtime is the single interpreter of the lifecycle wire messages; it reports what it
        // CONCLUDED (including which acks it matched against the live activation) through this
        // channel, which is also the ?simdebug=1 breadcrumb trail the e2e suites read.
        onTelemetry: (event, detail) => {
          simTelemetry(event, { ...detail, key });
          runtimeEventRef.current(key, event, detail);
        },
      });
      simRuntimesRef.current.set(key, rt);
    }
    return rt;
  };
  const runtimeState = (key: string) => runtimeFor(key).getState();
  // "Safe to composite" for THIS surface: a real paint, or the pool's own escape-hatch latch for
  // documents that can never ack one.
  // ONE classification of `painted`, owned by the runtime. The pool used to keep a parallel
  // `paintedLatch`; because the runtime never learned of it, a latched document never received
  // visibility once the reveal became gated on the runtime's grant (audited).
  const simPainted = (key: string): boolean => runtimeState(key).painted;
  /**
   * Re-read the two presentation facts that can change WITHOUT a section change.
   *
   * `simModern` is the runtime's own verdict, not a guess made here: the canary's class says what a
   * package proved at publish time, `modernActive()` says whether THIS document has actually
   * adopted the port and reported itself ready. Both are required, and the second one flips
   * mid-activation (the handshake completes after the section is already entered), so it has to be
   * re-read rather than captured once. `simOutgoingValid` latches: once a video frame has decoded,
   * the element keeps its last frame for the rest of the session.
   */
  const syncSimPresentation = () => {
    const key = activeSimUrlRef.current;
    const sec = activeSimRef.current;
    mergePresentation({
      simModern: !!key && sec?.package_class === 'managed-presentable' && runtimeFor(key).modernActive(),
      simOutgoingValid: simPresentationRef.current.simOutgoingValid || (videoRef.current?.readyState ?? 0) >= 2,
    });
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
      if (key !== activeSimUrlRef.current) runtimeFor(key).freeze();
      simTelemetry('warm-budget-expired', { key });
      finishWarm(key);
    }, SIM_WARM_MAX_MS);
  };
  const finishWarm = (key: string) => {
    if (warmingSimUrlRef.current !== key) return;
    warmingSimUrlRef.current = null;
    while (warmQueueRef.current.length) {
      const next = warmQueueRef.current.shift()!;
      if (next === activeSimUrlRef.current || simPainted(next) || !runtimeState(next).ready) continue;
      runtimeFor(next).thaw();
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
    // The document goes with the frame: dispose the client so no timer of its can fire and no
    // message can be handled after the iframe unmounts. A later re-add builds a fresh one.
    simRuntimesRef.current.get(key)?.dispose();
    simRuntimesRef.current.delete(key);
    cancelPristineReload(key);
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
  // ── Atomic fade-out ───────────────────────────────────────────────────────
  // stopScript synchronously removes __simHideUi and runs the section cleanup inside the child,
  // so posting it at the boundary re-showed the FULL UI while the overlay was still ~200ms into
  // its opacity fade (audited deterministic Minimal-UI flash). SimRuntimeClient.deactivate() owns
  // that ordering now — it freezes + mutes + closes the guidance gate immediately and defers
  // stopScript by SIM_EXIT_STOP_MS, cancelling it if the same document re-activates inside the
  // window (its own startScript runs the bridge's stopScript first, so a late deferred stop would
  // tear down the LIVE section). It also records the teardown as `stopped` — not merely
  // script-less, which reads as a genuine first activation and defeats the gate.
  const cancelPristineReload = (key: string) => {
    const t = simPristineReloadRef.current.get(key);
    if (t) { clearTimeout(t); simPristineReloadRef.current.delete(key); }
  };
  /** True while an exit fade still owes this frame work — the planner must not evict it. */
  const isFadingOut = (key: string): boolean =>
    simRuntimesRef.current.get(key)?.hasDeferredStop() === true || simPristineReloadRef.current.has(key);

  // Deliberate frame NAVIGATION (legacy non-dynamic bridge switching sections, or a
  // back-to-video pristine reload). Marks the expected reload so the load handler knows this
  // reset is intentional — a late native `load` from the previous document is ignored.
  // `bootHide` re-cloaks the DESTINATION section (the spec's original bootHide belonged to the
  // package's first-using section — audited: a legacy Minimal-UI target navigated uncloaked).
  const navigateFrame = (key: string, src: string, bootHide?: string[] | null) => {
    const meta = poolMeta(key);
    // A RELOAD ONTO THE SAME URL NEEDS A DISTINCT SRC.
    //
    // When the frame is already on this URL — which happens whenever the raw section was entered
    // before the one that dirtied the document — React re-renders an identical `src` prop and
    // nothing navigates. Worse, `attach(frame, src)` then takes its SAME-DOCUMENT branch and keeps
    // `ready`/`painted` alive, so the SIM_READY that would apply the pending activation never
    // fires again and the frame sits undispatched with no paint poll and no stall bound.
    //
    // A nonce makes it a genuine new document identity: the spec really changes, the browser really
    // navigates, and `attach` really resets. It does not disturb dispatch or residency — the nonce
    // is not a `section` param, so `variantParamOf` still returns null, and `packageKeyOf` keys on
    // origin+pathname, so the package stays one pool entry.
    const prev = simPoolSpecsRef.current.find((s) => s.key === key);
    const finalSrc = prev?.src === src
      ? `${src}${src.includes('?') ? '&' : '?'}__simreset=${++simResetSeqRef.current}`
      : src;
    meta.expectReload = true;
    // A new document identity has run nothing — the raw-activation dirtiness starts over.
    meta.scriptedEver = false;
    // A document IDENTITY change. SimRuntimeClient models ONE document, so re-attach it under the
    // new key: that resets every per-document flag and cancels its in-flight timers (including a
    // deferred stop, which must never hit the new document).
    runtimeFor(key).attach(simPoolFramesRef.current.get(key) ?? null, finalSrc);
    cancelPristineReload(key);
    clearWarmCeil(meta);
    warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
    finishWarm(key);
    simPoolSpecsRef.current = simPoolSpecsRef.current.map((s) =>
      (s.key === key ? { ...s, src: finalSrc, ...(bootHide !== undefined ? { bootHide } : {}) } : s));
    merge({ simPool: simPoolSpecsRef.current });   // spec.src change → iframe src prop → navigation
    simTelemetry('navigate', { key, src: finalSrc.slice(-80), forced: finalSrc !== src });
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
      if (!opts?.force && !(url && simPainted(url))) return;  // not painted yet
      // CENTRAL GUARD — the runtime's presentation permission is AUTHORITATIVE.
      //
      // The viewer still decides which pooled frame is selected, whether it is the active
      // occurrence, residency, generation validity and the double-rAF composition timing. It may
      // NOT present a frame the runtime has not granted. Reading `phase === 'awaiting-ack'` was
      // not enough: it is one symptom of one hold, so a runtime that stopped granting visibility
      // for any other reason was simply ignored — measured, a dead apply gate changed nothing on
      // screen because this decision never consulted the runtime at all (audited).
      if (!opts?.force && url && !runtimeState(url).visible) return;
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

  // Poll a frame's two handshakes: SIM_READY (bridge alive) then SIM_PAINTED (first real frame
  // drew). The paint ping matters because the broadcast SIM_PAINTED can fire before our listener
  // is looking (a sim animating during document load paints before SIM_READY) — the v4 gate
  // re-posts it on request. Legacy (pre-v4) sims never answer the paint ping and are covered by
  // the bounded HOLD deadline below instead.
  //
  // The runtime owns the poll (it is scoped to its own document and stops itself on the first
  // real paint). Its built-in legacy reveal ceiling is pushed out to the poll budget on purpose:
  // it would only flip the runtime's own presentation flag, which this surface does not render,
  // and the section-aware bounded hold below is the reveal policy that actually composites here.
  const startSimPoll = (key: string) => {
    runtimeFor(key).startPaintRecovery({ legacyCeilingMs: SIM_PAINT_POLL_MAX_MS });
  };

  // ── simulation overlay (resident pool) ────────────────────────────────────
  // Deactivate the current section's pool frame — ATOMIC EXIT ORDER (audited):
  //   1. freeze (simPause) + silence (simMute) + close the guidance gate — the fade shows the
  //      last VALID frame, and a hidden resident frame must never keep sounding or polling;
  //   2. start the opacity fade;
  //   3. stopScript only AFTER the fade (deferred) — it restores hidden controls/cleanup, which
  //      used to flash the full UI mid-fade. The frame STAYS mounted and painted.
  const deactivateSim = () => {
    warmGenRef.current++;                    // invalidate any pending reveal
    const key = activeSimUrlRef.current;
    // An armed apply hold must never survive the section it belonged to: its terminal bound would
    // fire later and force-reveal a document this exit has deliberately taken off screen.
    if (key) runtimeFor(key).cancelPendingApply();
    if (key && (activeSimRef.current || showSimOverlayRef.current)) {
      // Freeze + silence + close the guidance gate NOW, tear the section down only after the
      // fade — all three, in that order, are SimRuntimeClient.deactivate().
      runtimeFor(key).deactivate();
      merge({ showSimOverlay: false, simBootStalled: false, simColdCover: false });
    }
    clearRevealTimers();
    // The layered surface describes ONE activation. Carrying any of it into the next section is how
    // a poster of the section just left ends up covering the section just entered.
    resetPresentation();
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
      // SINGLE MODE IS ENFORCED HERE, not only on the tick.
      //
      // The kill switch promises at most one resident document. Leaving that to the tick made the
      // promise depend on `timeupdate`, whose cadence after a seek is engine-specific — WebKit
      // held two frames where Chromium and Firefox held one. A kill switch whose guarantee varies
      // by browser is not a kill switch, so the section change (which is deterministic) enforces
      // it too. `ensurePooledSpec` already evicts when it ADDS a spec; this covers the case where
      // the incoming package was already resident and it returns early.
      if (poolTierRef.current === 'single') {
        for (const sp of [...simPoolSpecsRef.current]) {
          // A frame still inside its EXIT FADE survives to the next tick, exactly as the window
          // planner protects it: unmounting mid-fade removes the element being animated, so the
          // simulation CUTS to video instead of fading, and the deferred stopScript fires into a
          // dead frame. The kill switch's promise is at most one resident document in steady
          // state, not one during a transition — and 'single' is the mode an operator selects
          // during an incident, which is the worst moment to add a visible glitch.
          if (sp.key !== key && !isFadingOut(sp.key)) dropPooled(sp.key, 'single-mode-switch');
        }
      }
      // ADAPTIVE QUALITY (migration 052 kill switch, default off).
      //
      // Decided BEFORE the identity is minted, which is the only safe place: `quality` is inside
      // configHash and configHash is one of the five axes the reveal invariant compares. A change
      // here produces a different hash — correctly invalidating the poster keyed on it — and can
      // never alter a LIVE activation. Nothing here is ever consulted by the reveal gate.
      //
      // State is per PACKAGE because cost is a property of the bytes. Hysteresis is asymmetric:
      // quick to protect a struggling device, slow to re-expand, because each change re-mints an
      // identity and discards a poster.
      let adaptiveQuality: 'high' | 'balanced' | 'low' | undefined;
      if (adaptiveQualityRef.current) {
        try {
          const pkgKey = packageKeyOf(sectionUrl);
          const rt0 = simRuntimesRef.current.get(pkgKey);
          const summary = rt0?.timingSummary();
          const lab = simSection.simulation_id
            ? prepareBudgetsRef.current[simSection.simulation_id] : undefined;
          // ONE tested composition, not two calls joined here.
          //
          // Joining them at this call site is what produced the defect: passing the measured p90
          // into `resolveBudget` made the budget `p90 x 1.25`, so the controller then asked whether
          // `p90 > 1.25 x p90` and pinned itself to 'high' for a device six times over its budget.
          // `nextQualityFor` takes the lab number and the field p90 as separate arguments, so
          // there is no longer a second place to put the p90.
          const prior = qualityStateRef.current.get(pkgKey) ?? INITIAL_QUALITY_STATE;
          const decision = nextQualityFor(prior, {
            measuredP90Ms: summary?.p90TotalMs ?? null,
            samples: summary?.completed ?? 0,
            labBudgetMs: lab ?? null,
          });
          qualityStateRef.current.set(pkgKey, decision.state);
          adaptiveQuality = decision.next;
          // Reported on EVERY decision, not only on a change. A controller that has decided
          // "stay at high" is doing its job; telemetry that spoke only on transitions could not
          // distinguish that from a controller that was never consulted at all — which is exactly
          // the confusion that let four of these modules ship with no caller.
          simTelemetry('adaptive-quality', {
            key: pkgKey, next: decision.next, changed: decision.changed,
            reason: decision.reason, budgetSource: decision.budgetSource,
          });
        } catch (err) {
          // A controller fault must never change what is shown. Leaving `adaptiveQuality`
          // undefined is exactly the pre-feature behaviour.
          adaptiveQuality = undefined;
          simTelemetry('adaptive-quality-error', { message: String(err).slice(0, 120) });
        }
      }

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
      // RAW activation: the URL carries NO ?section= and no real named script, so nothing selects a
      // body — by design this means "present the package as-is" (SCRIPT_MISSING runs nothing). The
      // Edge-of-Chaos shape: a full-simulation finale sharing its package with scripted sections.
      //
      // STRUCTURAL, not `dynScript === simSection.id`. That comparison looked equivalent and is a
      // string coincidence: SimulationService mints `?section=${sectionId}` using the section's OWN
      // row id, so variantKeyFor returns that id for every normally generated section and the
      // comparison was TRUE for almost all of them. Two things broke as a result — scripted
      // siblings never marked the document dirty (so the reset this exists for rarely fired), and
      // `presentAsLoaded` was passed on nearly every activation, disabling the SCRIPT_MISSING
      // protection product-wide. Only a section that genuinely selects no body is raw.
      const rawActivation = sectionKeyOf(sectionUrl) === null
        && (!simSection.sim_script || simSection.sim_script === 'main');
      const legacyScript = simSection.sim_script ?? 'main';
      activeSimUrlRef.current = key;
      desiredSimRef.current = { sectionUrl, dynScript, legacyScript, params, raw: rawActivation };
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
      const rt = runtimeFor(key);

      // Arm the activation-scoped path — but only for a package the publish-time canary has
      // classified `managed-presentable`. enableModern itself enforces that, so passing an
      // unproven or null class here is a no-op that leaves the v2 path in charge; the call is made
      // unconditionally so there is exactly ONE place that decides, rather than a condition here
      // and another inside the client that could drift apart.
      if (simSection.package_revision) {
        rt.enableModern(
          {
            playerSessionId: playerSessionIdRef.current,
            packageRevision: simSection.package_revision,
            packageClass: simSection.package_class ?? 'legacy-opaque',
            // Pre-identity, so a change here mints a NEW configHash rather than mutating a live
            // activation. Undefined when the switch is off — the client's own default then applies,
            // byte-for-byte as before.
            ...(adaptiveQuality ? { quality: adaptiveQuality } : {}),
          },
          {
            failureContext: {
              // The recovery surface offers "keep the poster" ONLY when one actually exists for
              // this exact identity — offering it with nothing to show would be a dead end.
              hasPoster: !!simSection.poster_url,
              hasVideo: !isPostRollSim,
              canSkip: true,
            },
          },
        );
      }
      // What the layered surface may know about THIS activation. Nothing is presented yet and no
      // failure is live: both are facts the runtime has to report, and assuming either would be
      // exactly the "presentation derived from something cheaper" this whole layer exists to end.
      mergePresentation({
        simModern: simSection.package_class === 'managed-presentable' && rt.modernActive(),
        simPresented: false,
        simFailure: false,
        simPosterUrl: simSection.poster_url ?? null,
        // The poster's transparency IS the section's: a capture over a transparent background is
        // made only for a section that composites over the video, so it is the observed form of the
        // same fact rather than a second, separately-stored one that could disagree.
        simPosterTransparent: !!simSection.poster_transparent,
        simOutgoingValid: simPresentationRef.current.simOutgoingValid || (videoRef.current?.readyState ?? 0) >= 2,
        simSectionEndSec: (timelineRef.current[segmentIdx]?.offset ?? 0) + simSection.end_sec,
      });
      // Snapshot BEFORE activating: rt.activate() records the new script and takes the gate
      // decision, and the branch conditions below describe the document as it was on entry.
      const was = rt.getState();
      const wasReady = was.ready;
      const wasPainted = simPainted(key);
      const wasDynamic = was.dynamic === true;
      const spec = simPoolSpecsRef.current.find((s) => s.key === key);
      // The activated frame no longer occupies the hidden-warm slot; let the next queued
      // frame take its turn (it warms behind whatever is on screen).
      warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
      finishWarm(key);
      awaitingPaintSimIdRef.current = simSection.id;

      // Re-entering during the exit fade — the deferred stop is superseded. (rt.activate() does
      // this itself; the legacy-navigate branch below never reaches it, so cancel here too.)
      rt.cancelDeferredStop();
      cancelPristineReload(key);

      // A document that HANDSHOOK and did not advertise in-place dispatch is load-time-locked:
      // its SCRIPTS.main is its own URL's ?section default, so a postMessage cannot switch it.
      const legacyNeedsNav = wasReady && !wasDynamic && spec && spec.src !== sectionUrl;
      // A RAW activation must present the package AS LOADED. On a document that has run a section
      // body, "as loaded" no longer exists: the body applied its own imperative changes (Minimal-UI
      // hiding among them, when ui_hide is empty and the mechanical path never engaged), stopScript
      // reverses only the mechanical hide, and a raw dispatch runs nothing that could repair the
      // rest. The v2-dynamic assumption — "the next startScript re-runs the body from its initial
      // state" — holds for every scripted section and fails for exactly this one, so the raw case
      // reloads the document instead of trusting it.
      const rawNeedsNav = wasReady && wasDynamic && rawActivation && meta.scriptedEver;
      if (legacyNeedsNav || rawNeedsNav) {
        if (rawNeedsNav) simTelemetry('raw-reset-reload', { key });
        // Reload on this URL, re-cloaked with the TARGET section's Minimal-UI selectors (not the
        // first-user's). For the raw case the target URL carries no ?section=, so the fresh
        // document boots with no default body — the full simulation, exactly as published.
        navigateFrame(key, sectionUrl, bootHideFor(simSection));
        pendingSimRef.current = { sectionUrl, dynScript, legacyScript, params, raw: rawActivation };
      } else if (wasReady && wasPainted) {
        clearWarmCeil(meta);
        // Same-document switch: `painted` only certifies the document once drew SOMETHING
        // (possibly the PREVIOUS section's frozen frame), so a proven-modern bridge must hold the
        // swap until its acknowledgement — never a timer. rt.activate() takes that decision (with
        // the document's OWN last-applied script, before it records the incoming one), posts
        // resume → startScript → clearBootHide → relayout → unmute with the token the bridge
        // echoes on every ack, and either holds or announces the reveal. The terminal bound that
        // guarantees a wedged bridge can never hold the screen forever is its SIM_APPLY_STALL_MS
        // timer, which reports `reveal-forced`.
        if (!(wasDynamic && rawActivation)) meta.scriptedEver = true;
        rt.activate({ script: wasDynamic ? dynScript : legacyScript, params,
          presentAsLoaded: wasDynamic && rawActivation });
        // A document the pool LATCHED as painted (the never-drives-rAF escape hatch below) can
        // never produce the runtime's paint-driven reveal, so composite it here. revealSim
        // re-checks the hold, so a gated switch is still never presented early.
  // (removed: dead branch — wasPainted IS runtimeState(key).painted, captured above, and
      // activate() never clears painted, so this condition could never be true; review F5)
      } else if (wasReady) {
        // Frame is alive but hasn't acked a painted frame yet — drive it and poll the paint ack.
        clearWarmCeil(meta);
        if (!(wasDynamic && rawActivation)) meta.scriptedEver = true;
        rt.activate({ script: wasDynamic ? dynScript : legacyScript, params,
          presentAsLoaded: wasDynamic && rawActivation });
      } else {
        // Frame still booting (or just added on-demand): the SIM_READY handler applies the
        // pending start once its bridge answers (and resolves dynamic-vs-legacy then).
        //
        // Resume it FIRST. A pool frame is frozen the instant it paints while backgrounded, and a
        // bridge announces its readiness from inside a requestAnimationFrame — so a document that
        // painted before it handshook has its OWN readiness callback frozen with it, and would
        // never answer at all. This is a pool-only race (no single-document surface can freeze a
        // frame it is about to present) and it is what the boundary handshake poll used to mask.
        rt.resume();
        pendingSimRef.current = { sectionUrl, dynScript, legacyScript, params, raw: rawActivation };
      }

      if (!(wasReady && wasPainted) || legacyNeedsNav) {
        startSimPoll(key);
        // Bounded HOLD ceiling. A paint ack may still land any moment — but a frame whose gate
        // cannot emit one (`canEmitPaint === false`) never will, so after the ceiling it
        // force-reveals (old behavior, documented blank risk only for those legacy sims).
        // Paint-capable frames keep holding the underlying content and surface the wait
        // affordance instead of a blank canvas.
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
          if (simPainted(key)) { revealSim(); return; }
          if (runtimeState(key).ready && !m.canEmitPaint) {
            // Legacy gate — no paint ack will ever come. Best-effort reveal (old behavior).
            runtimeFor(key).markPaintedByPolicy('bounded-hold');
            simTelemetry('hold-expired-legacy-reveal', { key });
            revealSim({ force: true });
            return;
          }
          // Paint-capable frame, genuinely not painted yet: keep holding the video/last frame and show
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
          if (!simPainted(key)) {
            runtimeFor(key).markPaintedByPolicy('boot-stalled');   // stop re-arming the hold
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
      // FRAME-ACCURATE BOUNDARY SENTINEL (migration 052 kill switch, default off).
      //
      // `timeupdate` fires at roughly 4Hz, so boundary detection is late by ~125ms on average
      // before any of the transition work begins. requestVideoFrameCallback fires per PRESENTED
      // frame and carries the frame's own mediaTime, cutting that to about one frame.
      //
      // It is a SENTINEL, not a replacement: this tick remains the master clock and the safety net.
      // A missed sentinel costs nothing — the next tick re-detects the same boundary — and rVFC
      // does not fire while paused, which this player does deliberately for post-roll sections.
      // Where rVFC is absent (Firefox, historically) the sentinel falls back to a rate-scaled
      // timer, and where neither can arm the behaviour is exactly today's.
      if (boundarySentinelRef.current && !scrubbingRef.current) {
        const segOff = timelineRef.current[idx]?.offset ?? 0;
        let nextStart: number | null = null;
        for (const sim of segmentsRef.current[idx]?.simulations ?? []) {
          if (!sim.simulation_url) continue;
          if (sim.start_sec > t && (nextStart === null || sim.start_sec < nextStart)) {
            nextStart = sim.start_sec;
          }
        }
        if (nextStart !== null && nextStart !== boundaryTargetRef.current) {
          boundarySentinelHandleRef.current?.cancel();
          boundarySentinelHandleRef.current = null;
          const target = nextStart;
          const armIdx = idx;
          const v = videoRef.current;
          const sentinel = v ? armBoundarySentinel({
            video: v,
            targetSec: target,
            onBoundary: (mediaTime) => {
              boundarySentinelHandleRef.current = null;
              boundaryTargetRef.current = null;
              simTelemetry('boundary-fired', { target, mediaTime });
              // Guards appropriate to a sentinel: the element may have been swapped, the segment
              // may have changed under the wait, or the user may be scrubbing.
              //
              // NOT `warmGenRef`. That counter is incremented by `deactivateSim`, which runs on
              // every tick where no section is active — about four times a second, in exactly the
              // video-only stretch this sentinel waits through. A generation that invalidates
              // itself 4x/s cannot guard a 350 ms window; it can only ever refuse.
              if (v !== videoRef.current || curIdxRef.current !== armIdx) return;
              if (scrubbingRef.current) return;
              updateSimOverlay(curIdxRef.current, mediaTime);
              setProgress(segOff + mediaTime);
            },
          }) : null;
          // LATCH ONLY ON A REAL ARM.
          //
          // `armBoundarySentinel` refuses (mode 'none') when the boundary is beyond its 0.35s
          // horizon — which, for a section 30s away, is every tick but the last. Latching the
          // target regardless spent the single arming attempt on that first refusal, and no later
          // tick could retry because the target had stopped changing. The sentinel therefore never
          // armed once during ordinary linear playback: it only ever ran when a seek happened to
          // land inside the horizon. Leaving the target null re-attempts each tick, which costs a
          // rejected call and gains the arm that the feature exists for.
          if (sentinel && sentinel.mode !== 'none') {
            boundarySentinelHandleRef.current = sentinel;
            boundaryTargetRef.current = target;
            // `mode` records WHICH mechanism armed. This is the direct field answer to "what
            // fraction of sessions get the frame-accurate path", which the rollout document
            // previously listed as unknowable without a separate study.
            simTelemetry('boundary-armed', { target, mode: sentinel.mode });
          } else {
            sentinel?.cancel();
            boundaryTargetRef.current = null;
          }
        } else if (nextStart === null && boundaryTargetRef.current !== null) {
          boundarySentinelHandleRef.current?.cancel();
          boundarySentinelHandleRef.current = null;
          boundaryTargetRef.current = null;
        }
      }

      // PREDICTIVE PREPARATION (migration 052 kill switch, default 'off').
      //
      // Strictly ADDITIVE: it only ever MOUNTS a package early. The existing tier logic below keeps
      // full authority over eviction, so a mistake here can waste a mount but can never drop a
      // document the viewer is about to need — which is why this runs before, and does not replace,
      // the residency block.
      //
      // The lead window comes from each package's own publish-time canary, never a constant. A
      // package with no lab measurement gets the floor rather than being treated as instantaneous.
      // 'all' ONLY — never at the 'window' tier.
      //
      // At 'window' the planner ~40 lines below owns residency with a 45s lead and evicts anything
      // outside its keep set. Predictive's lead is a prepare budget capped at 10s, so it can never
      // mount something that planner has not already mounted — but it CAN mount a second package
      // (its capacity is 2) that the window planner then drops on the same tick. That repeats every
      // timeupdate: iframe and WebGL context created and destroyed at ~4 Hz, which is worse than
      // the feature is good. Restricting it to the tier where nothing else evicts removes the fight
      // entirely rather than trying to keep two planners in agreement.
      if (schedulerModeRef.current === 'predictive' && poolTierRef.current === 'all') {
        try {
          const occ: SimOccurrence[] = [];
          for (let i = 0; i < segmentsRef.current.length; i += 1) {
            const off = timelineRef.current[i]?.offset ?? 0;
            for (const sim of segmentsRef.current[i]?.simulations ?? []) {
              if (!sim.simulation_url) continue;
              occ.push({
                sectionId: sim.id,
                packageKey: packageKeyOf(sim.simulation_url),
                startSec: off + sim.start_sec,
                endSec: off + sim.end_sec,
              });
            }
          }
          const absNow = (timelineRef.current[idx]?.offset ?? 0) + t;
          const v = videoRef.current;
          // Buffered-ahead gates SPECULATIVE preparation only: preparing a document the network
          // cannot yet deliver competes with the segment fetches that would make it reachable.
          let bufferedAheadSec: number | undefined;
          try {
            if (v && v.buffered.length > 0) {
              for (let i = v.buffered.length - 1; i >= 0; i -= 1) {
                if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
                  bufferedAheadSec = v.buffered.end(i) - v.currentTime;
                  break;
                }
              }
            }
          } catch { bufferedAheadSec = undefined; }

          const plan = planResidency({
            occurrences: occ,
            nowSec: absNow,
            capacity: poolTierRef.current === 'all' ? SIM_POOL_CAP : 2,
            resident: simPoolSpecsRef.current.map((sp) => sp.key),
            bufferedAheadSec,
            budgetMsFor: (packageKey) => {
              const sim = occ.find((o) => o.packageKey === packageKey);
              const secRow = sim
                ? segmentsRef.current.flatMap((sg) => sg.simulations).find((x) => x.id === sim.sectionId)
                : undefined;
              const lab = secRow?.simulation_id ? prepareBudgetsRef.current[secRow.simulation_id] : undefined;
              return resolveBudget({ measuredP90Ms: null, canaryMs: lab ?? null }).ms;
            },
          });
          // Emitted whenever the planner RUNS, not only when it mounts something. At the 'all' tier
          // every package is already resident from video start, so a plan with nothing to do is the
          // normal case — and telemetry that only appeared on a mount could not distinguish
          // "planned, nothing needed" from "never ran at all".
          simTelemetry('predictive-plan', {
            admit: plan.admit.length, prepare: plan.prepare.length, evict: plan.evict.length,
          });
          // MOUNT ONLY. `plan.evict` is deliberately ignored: eviction stays with the tier logic
          // below, which already understands exit fades and the never-drop-the-live-frame rule.
          for (const key of plan.prepare) {
            if (simPoolSpecsRef.current.some((sp) => sp.key === key)) continue;
            const o = occ.find((x) => x.packageKey === key);
            const secRow = o
              ? segmentsRef.current.flatMap((sg) => sg.simulations).find((x) => x.id === o.sectionId)
              : undefined;
            if (!secRow?.simulation_url) continue;
            ensurePooledSpec({ key, src: secRow.simulation_url, bootHide: bootHideFor(secRow) });
            simTelemetry('predictive-prepare', { key });
          }
        } catch (err) {
          // A scheduler fault must never take the player down. Falling through leaves the existing
          // residency behaviour entirely intact, which is the whole reason this is additive.
          simTelemetry('predictive-error', { message: String(err).slice(0, 120) });
        }
      }

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
        for (const spec of simPoolSpecsRef.current) if (isFadingOut(spec.key)) keep.add(spec.key);
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

  // ── postMessage listener — NON-lifecycle messages only ────────────────────
  // The document lifecycle protocol is not read here at all: each package's SimRuntimeClient
  // scopes every lifecycle event to its OWN frame by e.source and reports what it concluded (see
  // runtimeEventRef). What is left needs the pool's reverse source lookup because it is addressed
  // to the PLAYER, not to a document: guidance init/cues, the interaction pause, and branching
  // triggers. Only the ACTIVE frame may drive user-visible behavior.
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
      const isActive = frameUrl === activeSimUrlRef.current;
      const { type } = (e.data as { type?: string }) ?? {};

      // ── Guided Simulation init — for EVERY frame (background boots/reloads included) ──
      if (type === 'GUIDANCE_READY') {
        // Seed with already-heard cues so they never replay across boots/reloads — a resident
        // frame usually boots (and back-to-video reloads) while BACKGROUNDED, so this must not
        // sit behind the active-frame gate. The gate send is delayed so it reflects the
        // overlay's actual visible state at fire time (read live, never captured).
        sendToFrame(frameUrl, { type: 'guidanceInit', firedIds: Array.from(firedCueIds.current) });
        setTimeout(() => {
          if (unmountedRef.current) return;   // review F4: never resurrect a disposed runtime map
          runtimeFor(frameUrl).setGuidance(showSimOverlayRef.current && frameUrl === activeSimUrlRef.current);
        }, 100);
      }

      // Everything below is user-visible behavior — only the ACTIVE frame may drive it.
      if (!isActive) return;

      if (type === 'userInteraction') {
        videoRef.current?.pause();
        // Stops the section's auto-demo timers WITHOUT tearing it down (bridge timer scope). NOTE:
      // only packages whose bridge has been rebuilt honour this — on a stored pre-v2.1 bridge it
      // is still a no-op and the auto-script keeps fighting the user (see the verdict doc).
      runtimeFor(frameUrl).pauseAutomation();
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
    if (activeSimUrlRef.current) runtimeFor(activeSimUrlRef.current).setGuidance(state.showSimOverlay);
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
    if (el) {
      simPoolFramesRef.current.set(url, el);
      // Bind the document to its client. The client's message listener only exists while a frame
      // is attached, and every event it handles is scoped to THIS frame's contentWindow — which
      // is what makes a pool of documents safe without any reverse source lookup.
      const spec = simPoolSpecsRef.current.find((s) => s.key === url);
      const rt = runtimeFor(url);
      rt.attach(el, spec?.src ?? url);
      // Binding a document resets the client, cancelling any recovery armed for it. A frame added
      // on demand at a section boundary is polled BEFORE React mounts its element, so without
      // re-arming here that poll is silently thrown away and a cold entry waits on nothing.
      if (url === activeSimUrlRef.current && !rt.getState().painted) startSimPoll(url);
    } else {
      simPoolFramesRef.current.delete(url);
      simRuntimesRef.current.get(url)?.attach(null, null);
    }
    // Deliberately dependency-free: SimPoolOverlay relies on this callback ref being STABLE. An
    // identity change detaches and re-registers every frame on each render, and a handshake
    // landing in that window is dropped (the measured cause of painted frames still hitting the
    // bounded hold). Everything it touches is a ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSimFrameLoad = useCallback((key: string) => {
    const meta = poolMeta(key);
    const st = runtimeState(key);
    const hadHandshake = st.ready || st.painted;
    simTelemetry('frame-load-routed', { key, expected: meta.expectReload, hadHandshake });
    // The native `load` event fires after ALL subresources — routinely AFTER the bridge's
    // SIM_READY/SIM_PAINTED handshake on the same document. Resetting flags on such a late
    // load would restart a live, visible sim (poll → fresh SIM_READY → spurious startScript).
    // Flags reset ONLY when this load is a DELIBERATE navigation (navigateFrame/back-to-video
    // marked expectReload) or the frame's very first document (no handshake recorded yet).
    if (!meta.expectReload && hadHandshake) return;
    meta.expectReload = false;
    // A freshly loaded document has drawn nothing, applied nothing and torn nothing down.
    runtimeFor(key).handleFrameLoad();
    clearWarmCeil(meta);
    warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
    finishWarm(key);   // a reloading frame gives up its warm slot
    if (key === activeSimUrlRef.current) {
      if (desiredSimRef.current) pendingSimRef.current = { ...desiredSimRef.current };
      startSimPoll(key);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lifecycle reactions, driven by what the runtime CONCLUDED ──────────────
  // Each client interprets its own document's wire protocol — the handshake, the paint ack, and
  // the activation token / ack matching that decides whether a switch may be presented — and
  // reports the conclusion here. This surface adds only what the runtime deliberately has no
  // notion of: which document is ACTIVE, the warm queue, and how the overlay is composited.
  // The telemetry `detail` bag is deliberately NOT read here: every fact this surface reacts to is
  // read back from the runtime's own state, so a classification can never exist in two copies.
  // `detail` was previously dropped here. It carries the client's own measurement of the transition
  // that just completed, which is the only place field timings can be observed.
  runtimeEventRef.current = (key, event, detail) => {
    const meta = poolMeta(key);
    const isActive = key === activeSimUrlRef.current;
    // Whether the active document is on the activation-scoped path is re-read from the runtime on
    // every one of its events rather than tracked per event type: the handshake, a navigation, a
    // transport falling back to legacy and a disposal all change the answer, and enumerating them
    // here would be a second copy of the runtime's own condition — free to drift, and silently.
    if (isActive) syncSimPresentation();
    switch (event) {
      // ── the bridge answered: it is alive, and it said whether it can switch in place ──
      case 'sim-ready': {
        // A dynamic bridge implies the rebuilt package (v4 gate) — paint acks WILL come. The
        // dispatch capability itself is the RUNTIME's classification: read its state rather than
        // re-classifying from the telemetry payload, so the fact is decided in exactly one place
        // (the same state the navigate/activate decisions below read).
        meta.canEmitPaint = learnCanEmitPaint(meta.canEmitPaint, { dynamic: runtimeState(key).dynamic });
        if (isActive) {
          // Self-heal: even if the pending start was consumed, an active section must never
          // stay scriptless — fall back to the desired state. (sim-reliability fix)
          const pending = pendingSimRef.current ??
            (activeSimRef.current && desiredSimRef.current ? { ...desiredSimRef.current } : null);
          pendingSimRef.current = null;
          if (pending && (!userPausedRef.current || resumeActionRef.current === 'backToVideo')) {
            const isDynamic = runtimeState(key).dynamic === true;
            // LEGACY frame parked on the wrong section: its SCRIPTS.main is the URL's own
            // ?section default, so postMessage can't run the desired section — navigate.
            const spec = simPoolSpecsRef.current.find((s) => s.key === key);
            if (!isDynamic && spec && spec.src !== pending.sectionUrl) {
              pendingSimRef.current = pending;   // re-arm for the post-navigation document
              // Re-cloak for the TARGET section (params carry its Minimal-UI selection).
              navigateFrame(key, pending.sectionUrl,
                pending.params.simpleUi && pending.params.hideSelectors?.length ? pending.params.hideSelectors : null);
              return;
            }
            // Drive the frame to paint. Reveal stays gated on the paint / the bounded ceiling.
            if (!(isDynamic && pending.raw)) poolMeta(key).scriptedEver = true;
            runtimeFor(key).activate({
              script: isDynamic ? pending.dynScript : pending.legacyScript,
              params: pending.params,
              presentAsLoaded: isDynamic && pending.raw,
            });
          }
        } else {
          // A background pool frame finished loading. Mute it and gate guidance off; on capable
          // devices let it warm (run unpaused → paint) — but SERIALIZED, one frame at a time,
          // so several hidden WebGL scenes never fight the video decode concurrently. Low-end
          // parks it cold immediately.
          runtimeFor(key).mute();
          runtimeFor(key).setGuidance(false);
          if (canWarmUnpaused()) {
            if (warmingSimUrlRef.current && warmingSimUrlRef.current !== key) {
              runtimeFor(key).freeze();
              if (!warmQueueRef.current.includes(key)) warmQueueRef.current.push(key);
            } else {
              beginWarm(key);
            }
          } else {
            runtimeFor(key).freeze();
          }
        }
        return;
      }
      // ── a real frame drew (the rAF gate's honest "safe to show") ──
      case 'sim-painted': {
        // PROOF (not an implication): the rAF gate ran on this document, so this package can ack.
        meta.canEmitPaint = learnCanEmitPaint(meta.canEmitPaint, { painted: true });
        clearWarmCeil(meta);
        if (!isActive || !activeSimRef.current) {
          runtimeFor(key).freeze();   // painted + frozen — instant reveal later
        } else if (awaitingPaintSimIdRef.current === activeSimRef.current.id) {
          if (simPaintDeadlineRef.current) { clearTimeout(simPaintDeadlineRef.current); simPaintDeadlineRef.current = null; }
          merge({ simColdCover: false });
        }
        finishWarm(key);   // this frame's warm turn is over — advance the queue
        return;
      }
      // ── the runtime decided this document MAY be presented ──
      // It is the single authority on WHETHER (paint arrived, the matching ack released the hold,
      // or the terminal bound expired); this surface still decides HOW and WHEN to composite.
      case 'reveal':
        if (isActive) {
          merge({ simBootStalled: false });
          // FIELD MEASUREMENT. `detail` carries the durations the client computed for this exact
          // transition; the recorder is a no-op unless collection is enabled.
          try {
            const d = (detail ?? {}) as { totalMs?: number | null; prepareMs?: number | null;
              presentMs?: number | null; applyMs?: number | null };
            const pkgRev = rumPackageKey();
            if (pkgRev) rum().record({
              kind: 'transition',
              packageRevision: pkgRev,
              durations: {
                totalMs: d.totalMs ?? null, prepareMs: d.prepareMs ?? null,
                presentMs: d.presentMs ?? null, applyMs: d.applyMs ?? null,
              },
            });
          } catch { /* measurement must never affect what a viewer sees */ }
          // On the modern path this event IS the reveal decision, and it is the only writer of
          // simPresented:true. `modern-section-presented` fires earlier, before the gate has run,
          // and the gate can still refuse — compositing on that breadcrumb showed frames the gate
          // had rejected.
          mergePresentation({ simPresented: true, simFailure: false });
          revealSim();
        }
        return;
      case 'reveal-forced':
        if (isActive) { merge({ simBootStalled: false }); revealSim({ force: true }); }
        return;
      // ── the section could not be applied ──
      // SCRIPT_MISSING: the bridge ran NOTHING, so the document still shows the PREVIOUS section's
      // frozen frame — revealing it would present exactly the wrong-section frame the gate exists
      // to prevent. SCRIPT_ERROR: a body that threw mid-apply leaves partial state. The runtime
      // hides and silences the document either way; here the video simply plays on through the
      // section, with no spinner parked (a failure the viewer cannot act on).
      case 'script-missing':
      case 'script-error':
        if (isActive) {
          merge({ simBootStalled: false, simColdCover: false });
          try {
            const pkgRev = rumPackageKey();
            if (pkgRev) rum().record({
              kind: 'failure',
              packageRevision: pkgRev,
              code: event,
            });
          } catch { /* never affect the viewer */ }
        }
        return;
      // ── activation-scoped (v3) presentation ───────────────────────────────────────────────
      // THE gate the layered surface opens on. `presented` is set from this event and from nothing
      // else — not from a paint, not from a load, not from a timer. Each of those has in turn been
      // the thing that authorised a reveal here, and each in turn authorised a wrong one.
      case 'modern-section-presented':
        // The ACKNOWLEDGEMENT arrived — that is NOT permission to composite. The client emits this
        // breadcrumb before `reveal()` runs, and `reveal()` can still refuse (context lost, package
        // revision or document mismatch). Setting `simPresented` here made `poolVisible` true while
        // the runtime's own `state.visible` stayed false, so the viewer composited a frame the gate
        // had just rejected — a dead-context iframe stayed at full opacity for the rest of the
        // section, with nothing to clear it. Presentation permission has exactly one owner, and it
        // is the client's reveal decision below.
        if (isActive) mergePresentation({ simFailure: false });
        return;
      case 'modern-reveal-refused':
        // The gate refused — withdraw any permission a previous decision granted.
        if (isActive) mergePresentation({ simPresented: false });
        return;
      // A new activation on the same document: whatever was presented belongs to the section being
      // left. (The section change resets this too — this covers a re-activation of the SAME
      // section, e.g. a retry or a seek back into it, which no section change accompanies.)
      case 'modern-prepare':
        if (isActive) mergePresentation({ simPresented: false });
        return;
      case 'modern-failure':
        if (isActive) mergePresentation({ simPresented: false, simFailure: true });
        return;
      case 'modern-retry':
        if (isActive) mergePresentation({ simPresented: false, simFailure: false });
        return;
      // The presented frame's rendering context is gone, so its pixels are no longer what was
      // vouched for. The runtime has already hidden it; dropping `presented` is what brings the
      // cover back over it instead of leaving a half-composited scene on screen.
      case 'modern-context-lost':
        if (isActive) mergePresentation({ simPresented: false });
        return;
      default:
        return;
    }
  };

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
    const reloadsAtMount = simPristineReloadRef.current;
    const runtimesAtMount = simRuntimesRef.current;
    const rumAtMount = rumRef;
    const sentinelAtMount = boundarySentinelHandleRef;
    return () => {
      // The last batch is the most valuable one, and an armed sentinel must not outlive the tree:
      // its callback closes over a video element this component is about to release.
      try { rumAtMount.current?.dispose(); } catch { /* disposal must not throw into unmount */ }
      rumAtMount.current = null;
      try { sentinelAtMount.current?.cancel(); } catch { /* already gone */ }
      sentinelAtMount.current = null;
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
      hlsBrollRef.current?.destroy();
      hlsBrollStandbyRef.current?.destroy();
      clearTimeout(idleTimerRef.current ?? undefined);
      clearRevealTimers();
      vA.removeEventListener('playing', armPool);
      vA.removeEventListener('play', armPoolOnAttempt);
      if (armPoolTimer) clearTimeout(armPoolTimer);
      // Pristine reloads must not fire into an unmounted tree.
      for (const t of reloadsAtMount.values()) clearTimeout(t);
      reloadsAtMount.clear();
      // Disposing each client removes its window listener and makes every timer it owns
      // (deferred stop, apply stall, paint poll, legacy ceiling) inert — irreversibly.
      unmountedRef.current = true;
      for (const rt of runtimesAtMount.values()) rt.dispose();
      runtimesAtMount.clear();
      // Per-frame warm budgets must not fire into an unmounted tree.
      for (const m of poolMetaAtMount.values()) clearWarmCeil(m);
      // The branching choice countdown ticks every 250ms and, at zero, follows an edge into
      // detached video elements — it must never outlive the tree (review F2).
      if (choiceTimerRef.current) { clearInterval(choiceTimerRef.current); choiceTimerRef.current = null; }
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
      //
      // "Back to video" is an explicit "I'm done with this sim" — the next entry must start
      // pristine (user's in-sim changes discarded, by design). For a v2 DYNAMIC bridge,
      // stopScript already runs the section's full cleanup and the next activation's
      // startScript re-runs the body from its initial state — NO document reload, no network,
      // no shader recompile, and the frame stays painted for an instant re-entry. Only a
      // LEGACY (pre-v2) bridge falls back to a document reload for pristine state.
      const doneKey = activeSimUrlRef.current;
      const doneFrame = doneKey ? simPoolFramesRef.current.get(doneKey) : null;
      const doneRt = doneKey ? runtimeFor(doneKey) : null;
      if (doneKey && doneRt) {
        const m = poolMeta(doneKey);
        if (!doneFrame || doneRt.getState().dynamic !== true) {
          // Freeze + silence + close the guidance gate now, but NOT the deferred stopScript:
          // this exit is a NAVIGATION, and the reload is what restores pristine state.
          doneRt.deactivate({ teardown: false });
          cancelPristineReload(doneKey);
          if (doneFrame) {
            simTelemetry('reset-reload-legacy', { key: doneKey });
            // Registered in the pristine-reload map rather than run as a bare timer: that map is
            // what the window planner's mid-fade guard reads to keep a fading frame resident, and
            // what the unmount cleanup cancels. A bare timer here was invisible to both — the
            // planner could evict the frame mid-fade (hard cut instead of a fade) and the timer
            // then fired against a detached iframe and an orphaned meta object (audited).
            simPristineReloadRef.current.set(doneKey, setTimeout(() => {
              simPristineReloadRef.current.delete(doneKey);
              if (doneKey === activeSimUrlRef.current) return;   // re-entered during the fade
              m.expectReload = true;
              doneRt.handleFrameLoad();   // the document about to load has nothing applied
              clearWarmCeil(m);
              // Re-assigning src reloads the (cross-origin) document — location.reload() throws.
              const src = doneFrame.src;
              try { doneFrame.src = src; } catch { /* frame detached */ }
            }, SIM_EXIT_STOP_MS));
          }
        } else {
          simTelemetry('reset-stopscript', { key: doneKey });
          doneRt.deactivate();
        }
      }
      warmGenRef.current++;
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
      const dynamic = key ? runtimeState(key).dynamic === true : false;
      // Dynamic bridges must be re-pointed at the ACTIVE section's body — 'main' would
      // restart the frame URL's ?section default, which may be a different section.
      // dynamicScriptFor keys off the section URL's ?section= param (sim_script is the
      // literal 'main' on every generated row, so it must never win here).
      const script = dynamic ? dynamicScriptFor(sec) : (sec.sim_script ?? 'main');
      if (key) {
        const rt = runtimeFor(key);
        // stopScript FIRST, immediately (not deferred): the overlay is STAYING on screen, so
        // there is no fade to protect, and it is what clears the bridge's _lastSig so the
        // identical startScript below is not deduped.
        rt.stopNow();
        rt.activate({
          script,
          params: {
            simpleUi:   sec.simple_ui   ?? false,
            autoScript: sec.auto_script ?? true,
            ...(sec.ui_hide?.length ? { hideSelectors: sec.ui_hide } : {}),
          } satisfies SimStartScriptParams,
        });
      }
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
