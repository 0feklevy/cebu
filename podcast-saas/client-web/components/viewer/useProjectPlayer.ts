'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerConfig, PlayerSegment, SimulationOverlay, TimelineSeg, BrollClip, ClipOverlay, ImageOverlayItem, AudioCutaway, PlayerBranchSequence, PlayerChoicePoint, PlayerBranchEdge } from './types';
import { releaseAvatarElement } from '../../lib/avatarAudioGraph';
// The ONE stacking rule the export calls too — see shared/src/timeline/overlayStack.ts.
import { OVERLAY_LAYER, topmostAt, type StackRank } from 'shared';
import type { SimStartScriptParams } from '../../lib/simUiControls';
import { canWarmUnpaused, learnCanEmitPaint } from '../../lib/simCapability';
import { resolveSimPoolMode } from '../../lib/simPoolMode';
// The media/timeline slop this file has always applied by hand. Named and shared so the EDITOR's
// section predicates use the same tolerance instead of a second epsilon of their own (audit §9.6).
import { SECTION_BOUNDARY_EPSILON_SEC, playheadFromMediaTime } from '../../lib/sectionInterval';
import { mergeSegmentUrls, shouldPrewarm } from './segmentReadiness';
import { collectSimPool, bootHideFor, dynamicScriptFor, flattenSimOccurrences, packageKeyOf, planWindowResidency, poolWithinWeightBudget, sectionKeyOf, SIM_POOL_CAP, type SimPoolFrameSpec } from '../../lib/simPool';
import { planResidency, type SimOccurrence } from 'shared/src/sim/occurrencePlanner';
import { resolveBudget } from 'shared/src/sim/prepareBudget';
import { nextQualityFor, INITIAL_QUALITY_STATE, type QualityState } from 'shared/src/sim/adaptiveQuality';
import { armBoundarySentinel, type BoundarySentinel } from '../../lib/sim/boundaryClock';
import { createRumRecorder, type RumRecorder } from '../../lib/sim/rumClient';
import { labStandardMs } from '../../lib/sim/qualityBudgets';
import { singleModeEvictions, hardCapEviction, overCapEvictions } from '../../lib/sim/poolResidency';
import { newPlayerSessionId } from 'shared/src/sim/simIdentity';
import { simTelemetry } from '../../lib/simTelemetry';
import { SimRuntimeClient } from '../../lib/sim/SimRuntimeClient';
// The atomic-exit bound lives in the shared protocol module — it is duplicated in the CSS fade
// and in the e2e harness, and all of them must agree. Importing (rather than re-declaring) is
// what keeps this surface from drifting away from the shared runtime again. The same-document
// apply bound is not needed here at all: the runtime owns that timer.
import { SIM_APPLY_STALL_MS, SIM_EXIT_STOP_MS } from '../../lib/sim/protocol';
// The transition coordinator (P0.1). The reducer is pure and lives in lib/sim/; this surface owns
// only the wiring — which DOM events feed it, and what its effects do to the player.
import {
  reduce as reduceTransition,
  INITIAL_TRANSITION_STATE,
  isRevealed,
  type TransitionEvent,
  type TransitionState,
  type AudioIntent,
} from '../../lib/sim/transitionCoordinator';
import {
  armFrameEvidence,
  supportsRequestVideoFrameCallback,
  type FrameEvidenceProbe,
} from '../../lib/sim/frameEvidence';

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
// LOAD-BEARING ORDERING (review F6, restated for audit P0.5).
//
// The apply hold's bound no longer RELEASES the hold — it selects a cover (`apply-deadline-cover`),
// because a deadline is not evidence about which sub-simulation is on the canvas. So the reason
// these constants are ordered has changed, and the old reason ("the hold is released first, so the
// stall path can never present a held switch") is no longer true and must not be relied on.
//
// The ordering that still matters: the cover must be UP before the terminal stall bound makes its
// decision. Inverted, the 5s path would fire into an unexplained pause and then hand the user a
// generic stall affordance for a wait the poster was about to explain properly. The stall path
// itself now refuses to force-reveal while the runtime is still holding a painted document — see
// its handler — so the safety property no longer depends on this ordering at all, only the
// presentation quality does.
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
  // First 'playing' event of the current playback session has fired — i.e. real frames are
  // being presented. The thumbnail cover hides on `started && videoLive`, so it outlives the
  // play click by exactly the source-warmup gap instead of dropping onto a black frame
  // (THUMB interim fix; the full rVFC first-frame gate is a later wave).
  videoLive:       boolean;
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
  // Does the ACTIVE section's package need import-map support to run at all (audit P0.8)? Recorded
  // at publication and delivered on the section; null means the publication never recorded an
  // answer, and the capability floor treats null as "no known requirement", never as "requires".
  // The BROWSER half of the question is not here — it is a property of the host, detected once per
  // mount by the surface that renders the layers, not per section by the hook.
  simRequiresImportMaps: boolean | null;
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

/**
 * play() with the rejection caught: resolves true when playback genuinely started, false when
 * the browser refused (NotAllowedError before a qualifying gesture, AbortError when a load()
 * interrupted the request). startPlayback reacts to `false` by restoring the poster + play
 * button (P0.6); every other call site is free to keep ignoring the result, exactly as before.
 */
async function safePlay(v: HTMLVideoElement): Promise<boolean> {
  try { await v.play(); return true; }
  catch (err) {
    // Debug level: rejections are routine, but WHICH error it was is what turns a
    // "black frame on load" report into something actionable.
    console.debug('[viewer] video.play() rejected:', err);
    return false;
  }
}

/**
 * One simulation→video handoff, as the transition coordinator's wiring sees it.
 *
 * `issueSeek` and `commit` are deliberately separate closures rather than one exit function: the
 * whole defect P0.1 fixes is that today's exit runs them in the wrong order (uncover, then seek).
 * Splitting them lets the flag-OFF path run `commit(); issueSeek();` — byte-for-byte today — while
 * the flag-ON path runs `issueSeek()` at T0 and holds `commit` until the frame is proven.
 */
interface CoordinatedExitArgs {
  /** The outgoing package's document key, for the freeze-now / mute-later split. */
  key: string | null;
  requestedMediaTime: number;
  seekRequested: boolean;
  audioIntent: AudioIntent;
  issueSeek: () => void;
  /** The caller's ORIGINAL uncover + teardown body. Runs only from COMMIT_REVEAL. */
  commit: () => void;
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
  /**
   * Global seconds to land on the first time playback starts — the `?t=` a language switch carries
   * so the viewer resumes where they left off. Applied ONCE, through the same code path a scrub
   * release uses, and then forgotten. Out-of-range values are clamped, never NaN-propagated.
   */
  initialSeekSec?: number;
}

/**
 * One overlay clip, as the shared stacking rule sees it.
 *
 * A clip's visible span is its global offset plus its own trimmed length — `end_sec`/`start_sec`
 * are in-points on the SOURCE, not on the timeline, which is the arithmetic every reader of this
 * config has to get right. `broll_clip` and `clip_overlay` are deliberately the SAME layer class:
 * they use the same overlay element and the export has always treated both as `kind: 'clip'`.
 */
function asStackedClip<T extends { id: string; global_offset_sec: number; start_sec: number; end_sec: number }>(
  clip: T,
): StackRank & { clip: T } {
  return {
    id: clip.id,
    layer: OVERLAY_LAYER.clip,
    start: clip.global_offset_sec,
    end: clip.global_offset_sec + (clip.end_sec - clip.start_sec),
    clip,
  };
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

  // A URL THAT ARRIVES AFTER MOUNT MUST REACH THE PLAYER.
  //
  // `segmentsRef` is seeded once from `initialSegments` and thereafter rewritten only on sequence
  // navigation. So when the viewer's poll finally delivered a config in which a still-transcoding
  // segment had become ready, the new URL never reached playback: the player kept its mount-time
  // copy with `hls_url: null` and froze at that boundary — the exact failure the poll was added to
  // prevent. The poll worked; nothing was listening.
  //
  // Fill in ONLY segments that currently have no URL, matched by id, across every sequence in the
  // config so this stays correct after a branch navigation. A segment that already has a URL is
  // never touched: rewriting one mid-playback is how a shot gets swapped out from under a viewer.
  useEffect(() => {
    segmentsRef.current = mergeSegmentUrls(segmentsRef.current, config);
  }, [config]);
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
  // P0.1. Read ONCE into a ref, like the three switches above: the server value is authoritative
  // for the whole session, and a mid-session flip would leave a handoff half-owned.
  const transitionCoordinatorRef = useRef<boolean>(config.sim_transition_coordinator === true);
  /** Per-simulation lab preparation cost, from the package's own canary. */
  const labBudgetsRef = useRef<Record<string, number>>(config.sim_lab_budget_ms ?? {});
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
    // `?simpool` is DOWNGRADE-ONLY outside dev (KILLSW): 'single' always wins, 'adaptive' may
    // upgrade the server's decision only in development. resolveSimPoolMode owns the rule (and
    // its unit tests own the combination table) — previously any production URL could upgrade
    // a server-side 'single' back to 'adaptive', defeating the operator kill switch.
    const serverMode: 'adaptive' | 'single' = config.sim_pool_mode === 'single' ? 'single' : 'adaptive';
    const q = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('simpool')
      : null;
    simPoolModeRef.current = resolveSimPoolMode(serverMode, q, process.env.NODE_ENV === 'development');
  }
  // Residency tier, decided once per mount. 'all': every active-path PACKAGE mounts up front
  // (strong devices; ≤SIM_POOL_CAP). 'window': only active + next package resident (weak/touch/
  // Data-Saver). 'single': kill-switch — nothing up front; only the active package is ever
  // mounted, dropped on leave (approximates the pre-pool single navigating iframe).
  const poolTierRef = useRef<'all' | 'window' | 'single' | null>(null);
  // Per-package cost, joined ONCE from the server maps (keyed by simulation id) onto package
  // keys (what the pool and runtimes are keyed by). Feeds two decisions: the byte half of the
  // tier choice below, and each runtime's prepare failure bound (sim-review 2026-09-04, P1).
  const packageCostByKeyRef = useRef<Record<string, { prepareBudgetMs: number | null; weightTotalBytes: number | null }> | null>(null);
  if (packageCostByKeyRef.current === null) {
    const weights = config.sim_weight_bytes ?? {};
    const costs: Record<string, { prepareBudgetMs: number | null; weightTotalBytes: number | null }> = {};
    for (const seg of config.segments ?? []) {
      for (const sec of seg.simulations ?? []) {
        if (!sec.simulation_url || !sec.simulation_id) continue;
        const key = packageKeyOf(sec.simulation_url);
        if (!(key in costs)) {
          costs[key] = {
            prepareBudgetMs: prepareBudgetsRef.current[sec.simulation_id] ?? null,
            weightTotalBytes: weights[sec.simulation_id] ?? null,
          };
        }
      }
    }
    packageCostByKeyRef.current = costs;
  }
  if (poolTierRef.current === null) {
    // Device gate first (unchanged), then the byte gate: a strong device still mounts nothing
    // up front when the pooled set is byte-heavy — the window planner mounts each package by
    // media-time lead instead of pulling tens of MB speculatively at t=0.
    const weightByKey = Object.fromEntries(
      Object.entries(packageCostByKeyRef.current)
        .filter(([, c]) => typeof c.weightTotalBytes === 'number')
        .map(([k, c]) => [k, c.weightTotalBytes as number]),
    );
    poolTierRef.current = simPoolModeRef.current === 'single' ? 'single'
      : !canWarmUnpaused() ? 'window'
      : poolWithinWeightBudget(collectSimPool(config, SIM_POOL_CAP), weightByKey) ? 'all'
      : 'window';
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
    const opensOnSim = (initialSegments[0]?.simulations ?? []).some((sec) => !!sec.simulation_url && sec.start_sec <= SECTION_BOUNDARY_EPSILON_SEC);
    const simFirstSeed = poolTierRef.current === 'window' && opensOnSim ? 1 : 0;
    const cap = poolTierRef.current === 'all' ? SIM_POOL_CAP : simFirstSeed;
    initialSimPoolRef.current = collectSimPool(config, cap);
  }
  // Does the timeline OPEN on a sim (no leading video)? Then pool frames must arm immediately —
  // there is no video boot to protect.
  const simFirst = (initialSegments[0]?.simulations ?? []).some((s) => !!s.simulation_url && s.start_sec <= SECTION_BOUNDARY_EPSILON_SEC);

  const [state, setState] = useState<ProjectPlayerState>({
    playing:          false,
    started:          false,
    videoLive:        false,
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
    simRequiresImportMaps: null,
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
    | 'simOutgoingValid' | 'simSectionEndSec' | 'simRequiresImportMaps'
  >;
  const simPresentationRef = useRef<SimPresentationFields>({
    simModern: false,
    simPresented: false,
    simFailure: false,
    simPosterUrl: null,
    simPosterTransparent: false,
    simOutgoingValid: false,
    simSectionEndSec: null,
    simRequiresImportMaps: null,
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
      next.simSectionEndSec === cur.simSectionEndSec &&
      next.simRequiresImportMaps === cur.simRequiresImportMaps
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
      // Forgotten with the section, like the poster: the requirement describes THAT package, and a
      // stale `true` would keep the next section covered for a need it does not have.
      simRequiresImportMaps: null,
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
  // ── FLAT-OVERLAY CONFIG REVISIONS (broll-player-001) ────────────────────────────────────
  //
  // `onTick` is `useCallback(fn, [])` — frozen at mount — so every flat-overlay updater it calls
  // closes over the MOUNT-TIME `config` object. `ViewerPage` replaces that object post-mount (its
  // fetch effect re-runs whenever the auth context hands it a fresh `getIdToken` identity, and
  // calls `setConfig` with the new payload), so reading the parameter meant an editorial
  // correction landed in React state and was then ignored for the rest of the session: the viewer
  // played the clip list it fetched on first load, forever.
  //
  // The lanes therefore read `overlayConfigRef` — the COMMITTED revision — exactly as the segment
  // and timeline branches of the same function read `segmentsRef` / `timelineRef`.
  //
  // A bare "latest config" ref is NOT the fix. Read mid-shot it deletes or swaps the clip the
  // viewer is currently watching (a deleted clip tears down its live hls instance on the next
  // timeupdate — a visible cut to main video mid-shot). So `pendingOverlayConfigRef` holds the
  // newest revision React has handed us, and `commitOverlayConfig` promotes it only at a shot
  // boundary — atomically, for every lane and for the prewarm plan at once, so the schedule and
  // the prewarm plan can never be reading two different revisions.
  //
  // STRUCTURAL main-timeline data (segments, timeline, branching) is deliberately NOT routed
  // through here: it stays session-snapshotted at mount, which is the existing contract.
  const overlayConfigRef = useRef<PlayerConfig>(config);
  const pendingOverlayConfigRef = useRef<PlayerConfig>(config);
  pendingOverlayConfigRef.current = config;

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
  // First-'playing' latch mirrored into state.videoLive (see ProjectPlayerState). Ref'd so the
  // 'playing' listener (which fires on every stall recovery/seek) merges state exactly once.
  const videoLiveRef  = useRef(false);
  // ── async-init readiness (P0.6 quick win) ──────────────────────────────────
  // The setup effect's init is async (dynamic hls.js import → construct → loadSource →
  // attachMedia). Until that has completed there is nothing to play, so startPlayback must not
  // flip `started` (dropping the poster over a sourceless element) — it parks its intent in
  // pendingStartRef instead, and initAsync flushes it through the SAME path once the source is
  // attached. onInitReadyRef carries callbacks that must wait for readiness (the autoStart
  // effect arms its pacing timer through it, so its 600ms counts AFTER readiness).
  const initReadyRef    = useRef(false);
  const pendingStartRef = useRef(false);
  const onInitReadyRef  = useRef<Array<() => void>>([]);
  const volumeRef     = useRef(1);
  const mutedRef      = useRef(false);
  const scrubbingRef  = useRef(false);

  /** The scrub effect's seek implementation, so the one-shot `?t=` can reuse it verbatim. */
  const seekRef = useRef<((targetGlobal: number, resumePlaying: boolean) => void) | null>(null);
  /** Consumed once, on the first startPlayback; null afterwards. */
  const pendingInitialSeekRef = useRef<number | null>(
    typeof options.initialSeekSec === 'number' && Number.isFinite(options.initialSeekSec)
      ? Math.max(0, options.initialSeekSec)
      : null,
  );  const wasPlayingRef = useRef(false);
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
      // The COMMITTED revision, for the same reason the lane itself reads it: a correction must
      // not change the gain of the cutaway already playing. It reaches the next one.
      const active = (overlayConfigRef.current.audio_cutaways ?? []).find((cut) => cut.id === activeAudioCutawayIdRef.current);
      audioCutawayRef.current.volume = Math.max(0, Math.min(1, (active?.broll_volume ?? 1) * volume));
      audioCutawayRef.current.muted = mutedRef.current;
    }
    if (guidanceAudioRef.current) {
      guidanceAudioRef.current.volume = volume;
      guidanceAudioRef.current.muted = mutedRef.current;
    }
  }, [refs.videoA, refs.videoB]);

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
    try { simPoolFramesRef.current.get(key)?.contentWindow?.postMessage(msg, '*'); } catch { /* a torn-down frame cannot receive — nothing to do */ }
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
      // Per-package prepare cost → the runtime's prepare failure bound. A heavy package gets
      // the extra seconds its bytes measurably need; an unmeasured one keeps the 5s default.
      rt.packageCost = packageCostByKeyRef.current?.[key] ?? null;
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
  /**
   * Packages whose eviction has STARTED but whose iframe is still mounted (two-phase eviction).
   *
   * The element has to survive phase one: the parent is waiting for the child's DISPOSED, and a
   * child cannot answer from a detached frame. So the spec stays in `simPoolSpecsRef` — which is
   * what React renders — and this set is what every admission, selection and residency decision
   * consults instead of the spec list, so an evicting frame is invisible to them while remaining
   * present to the browser.
   */
  const simEvictingRef = useRef<Set<string>>(new Set());
  /** True while a two-phase eviction owes this frame a disposal handshake. */
  const isEvicting = (key: string): boolean => simEvictingRef.current.has(key);
  /** The guards every residency pass must respect. One object so no site can pass only one. */
  const residencyGuards = { isFadingOut: (k: string) => isFadingOut(k), isEvicting };
  /**
   * Take the element out of the DOM and forget the package. Phase TWO, and only ever from there.
   *
   * `evicted` IDENTIFIES WHAT MAY BE REMOVED, and removing by key alone is what made this unsafe.
   *
   * Phase two runs from a `.then()`, so it is always at least one microtask behind the settlement
   * that scheduled it — and `SimRuntimeClient.dispose()` SETTLES a pending eviction (as forced, so
   * the owner is never left awaiting a promise nothing can resolve). `ensurePooledSpec`'s re-entry
   * path calls exactly that: past the grace window it disposes the dying runtime and calls
   * `navigateFrame`, which mints a fresh runtime and a fresh document under the SAME key,
   * synchronously. The queued `.then` then ran and removed that brand-new frame — disposing a
   * runtime one line old and filtering its spec out, so the section the user had just re-entered
   * lost its iframe. Reproduced A→B→A at `sim_pool_mode:'single'`:
   * `attach:pkgA·s1 … dispose … attach:pkgA·s3 … dispose`, and pkgA had no iframe afterwards. At
   * 'single' and 'all' nothing re-adds it, so the section is covered for its whole duration, every
   * time, for the rest of the session.
   *
   * A pass may therefore only remove the runtime INSTANCE its own eviction was started for. That is
   * structural rather than a timing tweak: any future path that replaces a runtime mid-eviction —
   * a navigation, a re-admission, a second re-entry — invalidates the stale removal by
   * construction, without having to know that this hazard exists.
   */
  const removePooled = (key: string, reason: string, outcome: string, evicted?: SimRuntimeClient) => {
    if (evicted !== undefined && simRuntimesRef.current.get(key) !== evicted) {
      // The frame under this key is NOT the one that was evicted. Whatever replaced it owns the key
      // now and has its own lifecycle; this eviction's only remaining job was to remove an element
      // that no longer exists.
      simTelemetry('pool-evict-superseded', { key, reason, outcome });
      return;
    }
    simEvictingRef.current.delete(key);
    const meta = simPoolMetaRef.current.get(key);
    if (meta) clearWarmCeil(meta);
    // The client is disposed only NOW. Disposing it at the start of eviction removed the message
    // listener that the acknowledgement arrives on, which is one of the two reasons no parent has
    // ever seen a DISPOSED (the other was closing the port in the same statement as the send).
    simRuntimesRef.current.get(key)?.dispose();
    // …AND THE META IS DROPPED AFTER THAT DISPOSAL, NOT BEFORE IT.
    //
    // `dispose()` can emit telemetry SYNCHRONOUSLY — `settleEvictionAsForced` reports
    // `evict-forced-settle` and `evict-complete` for an eviction still in flight — and every
    // runtime event lands in `runtimeEventRef`, whose first statement is a get-or-CREATE
    // `poolMeta(key)`. Deleting first therefore makes this function's own teardown able to put the
    // entry straight back: one orphan `PoolMeta` per such disposal, for the life of the session,
    // carrying a stale `scriptedEver`/`canEmitPaint` into any later document that reuses the key.
    //
    // No caller reaches that today — every path here runs from an eviction's own `.then`, by which
    // point `evictionPhase()` is already `evicted` and the disposal is silent (measured, not
    // assumed) — so this is ordering, not a bug fix. It costs nothing and it stops the invariant
    // from depending on a property of the CALLERS: bookkeeping is dropped after the thing that can
    // write to it is gone, not before.
    simPoolMetaRef.current.delete(key);
    simRuntimesRef.current.delete(key);
    cancelPristineReload(key);
    simPoolSpecsRef.current = simPoolSpecsRef.current.filter((s) => s.key !== key);
    merge({ simPool: simPoolSpecsRef.current });
    simTelemetry('pool-spec-evict', { key, reason, outcome });
  };
  /**
   * PHASE ONE of eviction — and deliberately not `async`.
   *
   * Every caller is on a path a user is watching (a section change, a residency tick, the
   * single-mode kill switch), so none of them may wait for a teardown handshake. The frame is
   * excluded from admission and silenced synchronously, here; the element is removed later, when
   * the child has answered or the deadline has passed. A user never waits on eviction, and the
   * eviction never cuts a frame the user is still being shown.
   */
  const dropPooled = (key: string, reason: string) => {
    if (simEvictingRef.current.has(key)) return;   // already leaving — never evict one frame twice
    // Excluded from admission FIRST, before anything asynchronous can interleave: from this point
    // no pass may select, warm or present it, which is what makes the rest of the sequence safe to
    // finish out of band.
    simEvictingRef.current.add(key);
    warmQueueRef.current = warmQueueRef.current.filter((k) => k !== key);
    finishWarm(key);
    const rt = simRuntimesRef.current.get(key);
    if (!rt) { removePooled(key, reason, 'no-runtime'); return; }
    simTelemetry('pool-spec-evicting', { key, reason });
    rt.evict({ reason })
      .then((res) => {
        // A cancelled eviction is the ONE outcome that must not remove anything: the user came
        // back inside the grace window and this frame is theirs again.
        if (res.outcome === 'cancelled') { simEvictingRef.current.delete(key); return; }
        simTelemetry('pool-evict-settled', {
          key, reason, outcome: res.outcome, waitedMs: res.waitedMs, leaked: res.leaked.length,
        });
        // `rt`, not the key: by the time this microtask runs the key may belong to a runtime this
        // eviction never touched. See removePooled.
        removePooled(key, reason, res.outcome, rt);
      })
      // The element must go even if the handshake machinery itself threw. A rejected eviction that
      // left the iframe mounted would be a leak created by the leak detector.
      .catch(() => removePooled(key, reason, 'error', rt));
  };
  // Grow the pool at section entry (on-demand adds mount immediately — no stagger). A hard
  // ceiling protects the browser's live-WebGL-context budget: beyond it, evict the first
  // non-active, non-warming frame.
  const SIM_POOL_HARD_CAP = 6;
  /**
   * The user came back for a frame that is being evicted. Two-phase eviction exists so this has an
   * answer better than "too late".
   *
   * Returns true when the DOCUMENT was reclaimed intact — the grace window had not closed, so no
   * DISPOSE_DOCUMENT was ever sent and the frame the user left is the frame they get back.
   * Returns false once disposal has begun: the child has released its managed scope and is closing
   * its port, so there is nothing to resurrect and the caller must build a FRESH GENERATION. The
   * caller does that by letting the spec be re-added, or by navigating the existing element, both
   * of which mint a new document epoch.
   */
  const reclaimEvicting = (key: string): boolean => {
    if (!simEvictingRef.current.has(key)) return true;   // not leaving at all
    const reclaimed = simRuntimesRef.current.get(key)?.cancelEviction() === true;
    simTelemetry(reclaimed ? 'pool-evict-reclaimed' : 'pool-evict-too-late', { key });
    if (reclaimed) simEvictingRef.current.delete(key);
    return reclaimed;
  };

  const ensurePooledSpec = (spec: SimPoolFrameSpec) => {
    if (simPoolSpecsRef.current.some((s) => s.key === spec.key)) {
      // RE-ENTRY DURING EVICTION. Inside the grace window the document comes back whole. Past it,
      // the element is still mounted but the runtime behind it is disposing, so the only correct
      // move is a new generation: `navigateFrame` re-attaches the client under a fresh document
      // identity, which resets every per-document flag and mints a new epoch. Resurrecting the
      // disposing one would install a section into a runtime that has thrown its resources away.
      if (simEvictingRef.current.has(spec.key) && !reclaimEvicting(spec.key)) {
        simEvictingRef.current.delete(spec.key);
        simRuntimesRef.current.get(spec.key)?.dispose();
        simRuntimesRef.current.delete(spec.key);
        navigateFrame(spec.key, spec.src, spec.bootHide ?? null);
      }
      return;
    }
    // Single mode: strictly one resident frame — evict every non-active package before adding.
    //
    // A frame still inside its EXIT FADE is spared, exactly as the window planner spares it.
    // `deactivateSim` clears `activeSimUrlRef` BEFORE this runs, so the outgoing frame is no longer
    // "active" and was dropped here while still being animated: the simulation cut to video instead
    // of fading, and the deferred stopScript fired into a dead frame. It is collected by a later
    // residency pass once the fade has resolved — the per-tick loop applies the SAME rule, which it
    // previously did not, so this sparing was undone within the same tick.
    if (poolTierRef.current === 'single') {
      for (const key of singleModeEvictions([...simPoolSpecsRef.current], activeSimUrlRef.current, residencyGuards)) {
        dropPooled(key, 'single-mode');
      }
    }
    const capVictim = hardCapEviction(
      simPoolSpecsRef.current, spec.key, activeSimUrlRef.current, warmingSimUrlRef.current,
      SIM_POOL_HARD_CAP, residencyGuards,
    );
    if (capVictim) dropPooled(capVictim, 'hard-cap');
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
  /**
   * How many times one reveal may be re-armed after a generation bump lands inside its double rAF.
   *
   * Three, because the bumps that can legitimately interleave with a single composition are
   * countable — a boundary tick, a lease sync, a scrub landing back in the same section — and a
   * fourth means something is bumping continuously, which is not a case a retry can win. The bound
   * is what makes this a recovery and not a loop.
   */
  const REVEAL_REARM_LIMIT = 3;
  /**
   * Cancellers for reveal compositions still in flight — the second half of "a reveal is a managed
   * thing", and the half that makes the re-arm above safe to add at all.
   *
   * A DEFERRED REVEAL MUST NOT OUTLIVE THE PLAYER. The composition is two animation frames long and
   * NOTHING owned it: an unmount cancelled `simPaintDeadlineRef` and `simBootStalledRef` (the two
   * timers `clearRevealTimers` knows about) and left the frames queued. The callback then ran
   * against a dead tree, and because `activeSimRef`/`activeSimUrlRef` are refs that an unmount does
   * not clear, it got past its own guards as far as `simPainted(url)` — which is `runtimeFor(key)`,
   * which CREATES a `SimRuntimeClient` when the map has none. So unmounting the viewer during a
   * reveal built a fresh runtime for a player that no longer exists: never disposed (the cleanup
   * that would have disposed it has already run), owning a window `message` listener the moment
   * anything attaches it, and merging state into a tree React has thrown away. Reproduced by
   * execution — the object graph outlived the component, which is the leak, and the state write is
   * the visible half of it.
   *
   * Cancelling on unmount is structural rather than a guard bolted onto one call site: any future
   * work scheduled through `scheduleRevealFrames` inherits the lifetime, and nothing has to
   * remember that this particular callback can allocate.
   */
  const revealFrameCancelsRef = useRef<Set<() => void>>(new Set());
  const cancelPendingRevealFrames = () => {
    for (const cancel of [...revealFrameCancelsRef.current]) cancel();
    revealFrameCancelsRef.current.clear();
  };
  /**
   * Run `cb` after a double animation frame, so the opacity flip composites on a real frame — and
   * never after the player is gone.
   */
  const scheduleRevealFrames = (cb: () => void) => {
    const hasRaf = typeof requestAnimationFrame === 'function';
    let handle: number | ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const cancel = () => {
      live = false;
      if (handle === null) return;
      if (hasRaf) cancelAnimationFrame(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
      handle = null;
    };
    const step = (next: () => void) => {
      handle = hasRaf
        ? requestAnimationFrame(() => { handle = null; next(); })
        : setTimeout(() => { handle = null; next(); }, 16);
    };
    revealFrameCancelsRef.current.add(cancel);
    step(() => {
      if (!live || unmountedRef.current) return;
      step(() => {
        revealFrameCancelsRef.current.delete(cancel);
        // Belt and braces with the canceller: a callback already dequeued by the event loop cannot
        // be cancelled, so it re-reads the flag rather than trusting that it was.
        if (!live || unmountedRef.current) return;
        cb();
      });
    });
  };
  const revealSim = (opts?: { force?: boolean; rearm?: number }) => {
    const gen = warmGenRef.current;
    // WHAT THIS REVEAL IS FOR. `warmGenRef` answers "has anything moved", which is not the same
    // question as "is this reveal still wanted" — see the re-arm below.
    const forSectionId = activeSimRef.current?.id ?? null;
    const rearm = opts?.rearm ?? 0;
    clearRevealTimers();
    awaitingPaintSimIdRef.current = null;
    scheduleRevealFrames(() => {
      if (warmGenRef.current !== gen) {
        // THE GENERATION MOVED — RE-EVALUATE, DO NOT DISCARD.
        //
        // `warmGenRef` is bumped by `deactivateSim`, by entering a sim section from video, and by
        // the back-to-video reset. Only the first and last of those mean "this reveal is stale";
        // the middle one is a bump for the very section being revealed. Dropping on the counter
        // alone was survivable while a first activation on a painted pooled document was
        // `reveal-now` — `maybeReveal()` then ran in the same tick that bumped the generation, so
        // the window between capturing `gen` and reading it was empty. P0.5 holds that case until
        // SCRIPT_APPLIED, one or more macrotasks later, which is squarely where a bump lands: the
        // window is now wide, nothing retried, and the stall timer no longer force-reveals, so a
        // dropped reveal was final and the section stayed covered for its whole duration.
        //
        // So the intent is checked against the SECTION it was raised for, which is what actually
        // makes it stale or not, and re-armed against the new generation when it still holds.
        // Bounded by REVEAL_REARM_LIMIT so a continuously-moving generation ends in a reported
        // drop rather than an unbounded chain.
        const stillWanted = forSectionId !== null && activeSimRef.current?.id === forSectionId;
        if (!stillWanted || rearm >= REVEAL_REARM_LIMIT) {
          simTelemetry('reveal-dropped', { section: forSectionId, rearm, stillWanted });
          return;
        }
        simTelemetry('reveal-rearmed', { section: forSectionId, rearm: rearm + 1 });
        revealSim({ ...opts, rearm: rearm + 1 });
        return;
      }
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
    });
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

  // ── The transition coordinator (P0.1) ──────────────────────────────────────
  //
  // WHAT THIS CHANGES. Today's simulation→video exit freezes and MUTES the package, clears
  // `showSimOverlay`, and only THEN assigns `currentTime` and calls `play()` — so the cover drops
  // before the seek is even issued and the compositor shows whatever was last in that element.
  // Under the flag, the outgoing (frozen, still-audible) package IS the cover, and it is held
  // until a frame callback proves the requested frame reached the compositor at the requested
  // media time. The decision lives in the pure reducer; this block is only the wiring.
  //
  // FLAG OFF IS BYTE-FOR-BYTE TODAY. Every call site below asks `beginCoordinatedExit(...)`
  // whether the coordinator took ownership; when it returns false the caller runs exactly the
  // statements, in exactly the order, it ran before this existed.
  //
  // A DEADLINE NEVER UNCOVERS (audit §21 rule 7). The only effect that drops the cover is
  // COMMIT_REVEAL, which the reducer emits from `PARENT_PAINT` and only out of `VideoSubmitted`.

  /** Bound on a whole handoff. Selects a cover and a retry — never a reveal. */
  const TRANSITION_DEADLINE_MS = 4_000;
  /** Bound before rVFC silence is reported, unlocking the LABELLED lower-confidence fallback. */
  const TRANSITION_NON_ARRIVAL_MS = 400;
  /**
   * Automatic attempts at the SAME handoff after a covered failure, before the player stops
   * retrying and leaves the (still covered) recovery control to the viewer. Re-issuing the seek is
   * the audit's `CoveredFailure → VideoRequested` edge; it is a recovery, not a reveal, so a
   * handoff that never succeeds simply stays covered.
   */
  const TRANSITION_MAX_RETRIES = 3;
  const TRANSITION_RETRY_DELAY_MS = 250;

  const transitionRef = useRef<TransitionState>(INITIAL_TRANSITION_STATE);
  const handoffGenRef = useRef(0);
  const handoffActiveRef = useRef(false);
  const evidenceProbeRef = useRef<FrameEvidenceProbe | null>(null);
  const handoffDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handoffFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The caller's own uncover + teardown body. Run ONLY from COMMIT_REVEAL. */
  const handoffCommitRef = useRef<(() => void) | null>(null);
  /** Release the outgoing package's gain. Run ONLY from the audio channel, never from pixels. */
  const handoffAudioRef = useRef<(() => void) | null>(null);
  const handoffCleanupRef = useRef<(() => void) | null>(null);
  const handoffCoverRef = useRef<string>('');
  /** The current handoff's own arguments, so a retry replays THIS handoff, not a recomputed one. */
  const handoffArgsRef = useRef<CoordinatedExitArgs | null>(null);
  const handoffAttemptsRef = useRef(0);
  const handoffRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * True only while `issueSeek` is running. The exit's own seek can go through `loadSegment`, and
   * `loadSegment` cancels handoffs — without this the handoff would cancel itself the instant it
   * started, on exactly the cross-segment return the coordinator matters most for.
   */
  const handoffIssuingRef = useRef(false);
  /** Set by the definition below; used by `resumeFromSim`, which is declared much later. */
  const retryCoordinatedExitRef = useRef<() => boolean>(() => false);

  /**
   * The cross-fade timer, cleared on its OWN, from anywhere.
   *
   * `COMMIT_REVEAL` arms it *after* `endHandoff()` has already dropped `handoffActiveRef` — so the
   * one timer that outlives the handoff was the one timer no owner could reach: `endHandoff` had
   * run, `cancelCoordinatedExit` early-returns on `!handoffActiveRef.current`, and the unmount
   * cleanup goes through that same cancel. Giving it its own clear (called unconditionally by both,
   * before either can decide there is nothing to do) is what makes it owned.
   */
  const clearHandoffFade = () => {
    if (handoffFadeRef.current) { clearTimeout(handoffFadeRef.current); handoffFadeRef.current = null; }
  };

  /** Drop every in-flight observer for the current handoff. Does NOT touch what is on screen. */
  const endHandoff = () => {
    evidenceProbeRef.current?.cancel();
    evidenceProbeRef.current = null;
    if (handoffDeadlineRef.current) { clearTimeout(handoffDeadlineRef.current); handoffDeadlineRef.current = null; }
    clearHandoffFade();
    if (handoffRetryRef.current) { clearTimeout(handoffRetryRef.current); handoffRetryRef.current = null; }
    handoffCleanupRef.current?.();
    handoffCleanupRef.current = null;
    handoffActiveRef.current = false;
  };

  /** Is the page in front of the user right now? SSR and jsdom without the API count as visible. */
  const pageIsVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden';

  /**
   * Arm the bounded replay of a covered failure — but never while the page is hidden.
   *
   * A retry issued to a hidden page cannot succeed: rVFC and rAF do not run there, so the reducer
   * disarms evidence on `EXIT_REQUESTED`'s `pageVisible: false` and the new handoff burns its whole
   * 4 s deadline to reach the same covered failure. Three of those exhaust the budget while the
   * viewer is looking at another tab, and the handoff that is left when they come back has no
   * attempts to spend on the one condition that had actually changed. So the budget is spent only
   * on attempts that can produce evidence, and the return to visibility is what re-arms this
   * (`REQUEST_RETRY`).
   */
  const scheduleHandoffRetry = (reason: string) => {
    if (handoffRetryRef.current) return;
    if (handoffAttemptsRef.current >= TRANSITION_MAX_RETRIES) return;
    if (!pageIsVisible()) { simTelemetry('transition-retry-deferred-hidden', { reason }); return; }
    handoffRetryRef.current = setTimeout(() => {
      handoffRetryRef.current = null;
      // Re-checked at fire time: the page can hide inside the delay, and issuing there would spend
      // an attempt on the same unprovable handoff.
      if (!pageIsVisible()) { simTelemetry('transition-retry-deferred-hidden', { reason }); return; }
      retryCoordinatedExitRef.current();
    }, TRANSITION_RETRY_DELAY_MS);
  };

  const dispatchTransition = (event: TransitionEvent): void => {
    const before = transitionRef.current.phase;
    const { state: next, effects } = reduceTransition(transitionRef.current, event);
    transitionRef.current = next;

    for (const effect of effects) {
      switch (effect.type) {
        case 'ARM_FRAME_EVIDENCE': {
          const v = videoRef.current;
          if (!v || effect.generation !== handoffGenRef.current) break;
          evidenceProbeRef.current?.cancel();
          evidenceProbeRef.current = armFrameEvidence({
            video: v,
            generation: effect.generation,
            nonArrivalMs: TRANSITION_NON_ARRIVAL_MS,
            onFrame: (f) => dispatchTransition({ type: 'FRAME_PRESENTED', ...f }),
            onVisibleFrame: (generation) => dispatchTransition({ type: 'VISIBLE_FRAME', generation }),
            onNonArrival: (generation) => dispatchTransition({ type: 'RVFC_NON_ARRIVAL', generation }),
          });
          break;
        }
        case 'CANCEL_FRAME_EVIDENCE':
          evidenceProbeRef.current?.cancel();
          evidenceProbeRef.current = null;
          break;
        case 'RELEASE_OUTGOING_AUDIO':
          // The ONE place the outgoing package is silenced under the coordinator, and it is
          // reached only from AUDIO_INCOMING_AUDIBLE — never from frame evidence.
          handoffAudioRef.current?.();
          handoffAudioRef.current = null;
          break;
        case 'COMMIT_REVEAL': {
          const commit = handoffCommitRef.current;
          handoffCommitRef.current = null;
          const gen = effect.generation;
          endHandoff();
          // A handoff that reveals without ever releasing the outgoing gain would leave the
          // package audible under the video. Pixels do not authorise the switch, but a completed
          // handoff does close it.
          handoffAudioRef.current?.();
          handoffAudioRef.current = null;
          commit?.();
          // Armed AFTER `endHandoff()` on purpose — that call clears this very ref, so arming
          // first would cancel the fade before it started. The consequence is that this timer is
          // the one thing here that outlives `handoffActiveRef`, which is why `clearHandoffFade`
          // exists and why `cancelCoordinatedExit` runs it ahead of its own early return.
          handoffFadeRef.current = setTimeout(() => {
            handoffFadeRef.current = null;
            dispatchTransition({ type: 'FADE_COMPLETE', generation: gen });
          }, SIM_EXIT_STOP_MS);
          break;
        }
        case 'REQUEST_RETRY':
          // The reducer has decided this covered failure is reconsiderable (the page came back).
          // It does NOT uncover and cannot: the replay re-enters `VideoRequested` and has to prove
          // its own frame, exactly as the first attempt did.
          simTelemetry('transition-reconsider', { reason: effect.reason, generation: effect.generation });
          scheduleHandoffRetry(effect.reason);
          break;
        case 'HOLD_COVER': {
          // Diagnostics only — the cover is held by NOT committing, so there is nothing to apply.
          // Deduplicated because the reducer re-derives it on every phase change.
          const sig = `${effect.cover}:${effect.reason}`;
          if (sig !== handoffCoverRef.current) {
            handoffCoverRef.current = sig;
            simTelemetry('transition-cover', { cover: effect.cover, reason: effect.reason });
          }
          break;
        }
        case 'TELEMETRY':
          simTelemetry(effect.event, effect.detail);
          break;
      }
    }

    // The cross-fade may begin only on a PARENT PAINT after evidence (audit §4.3). Scheduling it
    // here — rather than inside the reducer — keeps the reducer free of any clock.
    if (before !== 'VideoSubmitted' && next.phase === 'VideoSubmitted') {
      const gen = next.generation;
      const paint = () => dispatchTransition({ type: 'PARENT_PAINT', generation: gen });
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => paint());
      else setTimeout(paint, 0);
    }

    // A covered failure is a RECOVERY state, and a recovery the viewer cannot leave is a wedge.
    // Two ways out, neither of which uncovers: bounded automatic replays of the same handoff, and
    // the player's existing back-to-video control, which `resumeFromSim` routes into the same
    // replay rather than into a fresh (and, mid-roll, wrongly-targeted) exit.
    if (before !== 'CoveredFailure' && next.phase === 'CoveredFailure') {
      resumeActionRef.current = 'backToVideo';
      merge({ showResumeBtn: true, resumeAction: 'backToVideo', controlsVisible: true });
      scheduleHandoffRetry('covered-failure');
    }
  };

  /**
   * Hand an exit-to-video's COVER DROP and AUDIO RELEASE to the coordinator.
   *
   * Returns false when the coordinator is off or unusable — the caller must then do exactly what
   * it did before. Returns true when it took ownership, in which case `commit` runs later, from
   * COMMIT_REVEAL, or never (a covered failure that the caller's own control can retry).
   */
  const beginCoordinatedExit = (args: CoordinatedExitArgs, isRetry = false): boolean => {
    const v = videoRef.current;
    if (!transitionCoordinatorRef.current || !v) return false;

    if (handoffActiveRef.current) {
      // Already owned. A second exit request during the same handoff (the tick's own
      // `updateSimOverlay` → `deactivateSim` runs while the seek is in flight) must NOT restart it
      // and must NOT uncover — that is the whole point of returning true here.
      if (!isRevealed(transitionRef.current.phase) && transitionRef.current.phase !== 'CoveredFailure') return true;
      // A covered failure IS retryable, and the control that reaches this is the same "go back to
      // video" button the viewer is already looking at (audit §4.3, CoveredFailure → VideoRequested).
      endHandoff();
    }

    const gen = ++handoffGenRef.current;
    const key = args.key;
    handoffActiveRef.current = true;
    handoffCoverRef.current = '';   // a new handoff's first cover is news, even if it looks the same
    handoffArgsRef.current = args;
    handoffAttemptsRef.current = isRetry ? handoffAttemptsRef.current + 1 : 0;
    handoffCommitRef.current = args.commit;
    handoffAudioRef.current = key
      ? () => { try { runtimeFor(key).mute(); } catch { /* frame detached */ } }
      : null;

    // T0. Freeze the outgoing scene — that preserves the last VALID frame, which is the cover —
    // but do NOT mute it. Muting is the audio channel's decision and it waits for the incoming
    // media to be audible. This is the split `SimRuntimeClient.deactivate()` cannot express,
    // because it freezes and silences together; the full deactivate still runs, inside `commit`.
    if (key) { try { runtimeFor(key).freeze(); } catch { /* frame detached */ } }

    const onSeeked = () => dispatchTransition({ type: 'MEDIA_READY', generation: gen, readyState: v.readyState, seeked: true });
    const onData   = () => dispatchTransition({ type: 'MEDIA_READY', generation: gen, readyState: v.readyState, seeked: false });
    const onPlaying = () => dispatchTransition({ type: 'AUDIO_INCOMING_AUDIBLE', generation: gen });
    const onError = () => dispatchTransition({ type: 'FATAL', generation: gen, reason: 'fatal-media-error' });
    const onVisibility = () => dispatchTransition({ type: 'VISIBILITY', visible: document.visibilityState !== 'hidden' });
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadeddata', onData);
    v.addEventListener('canplay', onData);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibility);
    handoffCleanupRef.current = () => {
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('loadeddata', onData);
      v.removeEventListener('canplay', onData);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibility);
    };

    dispatchTransition({
      type: 'EXIT_REQUESTED',
      generation: gen,
      incomingId: timelineRef.current[curIdxRef.current]?.id ?? null,
      requestedMediaTime: args.requestedMediaTime,
      seekRequested: args.seekRequested,
      audioIntent: args.audioIntent,
      // The video element retains its last decoded frame, and the frozen package is still
      // composited — so on this path there IS valid outgoing content, which is what the cover holds.
      outgoing: { kind: 'sim', valid: true },
      poster: { available: false, loaded: false },
      rvfcAvailable: supportsRequestVideoFrameCallback(v),
      pageVisible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      deadlineAt: Date.now() + TRANSITION_DEADLINE_MS,
    });

    // The seek is issued BEFORE the callback is registered, which is the ordering rVFC requires:
    // a callback armed against the pre-seek source reports the frame we are trying to replace.
    handoffIssuingRef.current = true;
    try { args.issueSeek(); } finally { handoffIssuingRef.current = false; }
    dispatchTransition({ type: 'SOURCE_ISSUED', generation: gen });
    // Seed readiness from the element as it stands: a mid-roll exit never fires another media
    // event, because playback never stopped.
    dispatchTransition({ type: 'MEDIA_READY', generation: gen, readyState: v.readyState, seeked: false });

    handoffDeadlineRef.current = setTimeout(() => {
      handoffDeadlineRef.current = null;
      dispatchTransition({ type: 'DEADLINE', generation: gen, atMs: Date.now() });
    }, TRANSITION_DEADLINE_MS);
    return true;
  };

  /**
   * Replay the CURRENT handoff after a covered failure — the same target, the same commit.
   *
   * Replaying rather than recomputing matters on the automatic (mid-roll) exit: that handoff's
   * target is the position the video was already playing, which nothing outside this closure
   * records. Recomputing it from `simReturnGlobalSecRef` — the only stored return point, and one
   * that is written for post-roll sections only — would seek somewhere else entirely.
   */
  const retryCoordinatedExit = (): boolean => {
    const args = handoffArgsRef.current;
    if (!args || !handoffActiveRef.current) return false;
    if (transitionRef.current.phase !== 'CoveredFailure') return false;
    return beginCoordinatedExit(args, true);
  };
  retryCoordinatedExitRef.current = retryCoordinatedExit;

  /**
   * Abandon a handoff (re-entry, unmount, an explicit navigation elsewhere).
   *
   * `runPendingCommit` is NOT a reveal of the unproven frame — it is disposal of a deferred
   * teardown whose destination no longer exists. A scrub or a segment load replaces the incoming
   * media entirely and brings its own presentation path with it; leaving this handoff's `commit`
   * unrun would strand the outgoing simulation on screen over content it has nothing to do with.
   * Re-entering the SAME simulation is the opposite case and must NOT run it: the overlay the
   * commit would tear down is the one coming back.
   */
  const cancelCoordinatedExit = (reason: string, opts?: { runPendingCommit?: boolean }) => {
    // BEFORE the early return, because the cross-fade timer OUTLIVES the handoff that armed it:
    // `COMMIT_REVEAL` calls `endHandoff()` (which drops `handoffActiveRef`) and only then arms it.
    // Every caller of this function — a re-entry, a segment load, the unmount cleanup — is asking
    // for every timer this handoff owns to stop, and that one is reachable from nowhere else.
    clearHandoffFade();
    if (!handoffActiveRef.current) return;
    const pending = handoffCommitRef.current;
    endHandoff();
    handoffCommitRef.current = null;
    handoffArgsRef.current = null;
    handoffAttemptsRef.current = 0;
    simTelemetry('transition-cancel', { reason, phase: transitionRef.current.phase });
    dispatchTransition({ type: 'CANCEL', generation: ++handoffGenRef.current });
    // The outgoing package must not be left audible under whatever comes next.
    handoffAudioRef.current?.();
    handoffAudioRef.current = null;
    if (opts?.runPendingCommit) pending?.();
  };

  // ── simulation overlay (resident pool) ────────────────────────────────────
  // Deactivate the current section's pool frame — ATOMIC EXIT ORDER (audited):
  //   1. freeze (simPause) + silence (simMute) + close the guidance gate — the fade shows the
  //      last VALID frame, and a hidden resident frame must never keep sounding or polling;
  //   2. start the opacity fade;
  //   3. stopScript only AFTER the fade (deferred) — it restores hidden controls/cleanup, which
  //      used to flash the full UI mid-fade. The frame STAYS mounted and painted.
  //
  // `exitToVideo` marks the ONE call that is a genuine simulation→video handoff (a section ending
  // with video underneath). Only that call may be routed through the transition coordinator: every
  // other caller is a segment load, a missing segment or a sim→sim change, where there is no
  // incoming video frame to prove and holding a cover would be holding it for nothing.
  const deactivateSim = (opts?: { exitToVideo?: boolean }) => {
    warmGenRef.current++;                    // invalidate any pending reveal
    const key = activeSimUrlRef.current;
    // A HANDOFF IN FLIGHT OWNS THIS EXIT — later ticks must not exit it again behind its back.
    //
    // This runs on every video-only tick, and during a hold the residency ref DELIBERATELY stays
    // set (it is what keeps the cover resident at the 'window' tier). Before that, the T0 tick's
    // unconditional `activeSimUrlRef.current = null` made every later tick a no-op here BY
    // ACCIDENT — `key` was null, the branch never re-entered. With the ref alive, the very next
    // tick (~250 ms later) re-entered, asked the coordinator for a second handoff, was refused —
    // one exit, one handoff — and fell through to the flag-off `uncover()`, dropping the cover a
    // tick after T0 and re-running the whole teardown. No existing test drove a second tick
    // between T0 and the commit, which is how the fallthrough stayed invisible at every tier.
    if (handoffActiveRef.current) return;
    // An armed apply hold must never survive the section it belonged to: its terminal bound would
    // fire later and force-reveal a document this exit has deliberately taken off screen.
    if (key) runtimeFor(key).cancelPendingApply();
    if (key && (activeSimRef.current || showSimOverlayRef.current)) {
      // Freeze + silence + close the guidance gate NOW, tear the section down only after the
      // fade — all three, in that order, are SimRuntimeClient.deactivate().
      const uncover = () => {
        runtimeFor(key).deactivate();
        // DELIBERATELY NOT RELEASED HERE: the residency ref (`activeSimUrlRef`). Its release has
        // exactly ONE owner — the tail of `deactivateSim`, guarded on `!handoffActiveRef` — and
        // the commit ending the handoff is precisely what re-arms that owner: the next video tick
        // (≤ ~250 ms) runs it and the 'window' planner reclaims the frame then. A second release
        // here would be a second owner of the same fact, and two owners disagreeing about "which
        // frame is on screen" during a hold is the exact bug this block exists to prevent — it
        // was also proven redundant by mutation (removing it changed no observable behaviour).
        //
        // `activeSimUrl` is released HERE and not at T0 — see the note below the coordinator call.
        // It rides in the same merge as `showSimOverlay` so the two halves of "the cover is gone"
        // land in one render: `SimPoolFrame` shows a frame on `active && visible`, and dropping
        // either one alone starts the 200 ms opacity fade by itself.
        merge({ showSimOverlay: false, simBootStalled: false, simColdCover: false, activeSimUrl: null });
      };
      const v = videoRef.current;
      const coordinated = opts?.exitToVideo === true && beginCoordinatedExit({
        key,
        // Mid-roll: the video clock never stopped, so the frame to prove is the one at the
        // position it is already playing — and no seek is issued at all.
        requestedMediaTime: v?.currentTime ?? 0,
        seekRequested: false,
        audioIntent: 'narration-continuous',
        issueSeek: () => {},
        commit: uncover,
      });
      if (!coordinated) uncover();
    }
    clearRevealTimers();
    // The layered surface describes ONE activation. Carrying any of it into the next section is how
    // a poster of the section just left ends up covering the section just entered.
    resetPresentation();
    // …AND SO DOES `activeSimUrl` — BUT NOT WHILE THE COORDINATOR IS HOLDING THE COVER.
    //
    // It was written on entry and by nothing on the way out, so after the first simulation of a
    // session it was permanently non-null — which silently disarmed the one guard that reads it:
    // `HLSPlayerShell`'s `floorBlocked = !floor.runnable && state.activeSimUrl !== null` degenerated
    // to `!floor.runnable`, i.e. "is a section up" was answered by a value that could no longer say
    // no. The ref beside it was already cleared here; the rendered copy was not.
    //
    // Clearing it UNCONDITIONALLY, though, drops the coordinator's own cover at T0. The frozen
    // simulation frame IS that cover, and `SimPoolOverlay` composites a frame on
    // `spec.key === activeKey && visible` — so nulling the rendered key starts the 200 ms opacity
    // fade the instant the handoff begins, while the coordinator still believes it is holding and
    // has committed nothing. Worst exactly where the hold matters most: the deadline /
    // `CoveredFailure` / retry paths, where nothing ever commits and the cover is the whole answer.
    // So while a handoff owns the exit, the release belongs to `uncover` — i.e. to COMMIT_REVEAL,
    // the one effect allowed to drop a cover — and this line only ever runs for an exit the
    // coordinator declined (flag off, no video element) or for a tick with nothing to release.
    //
    // Written through the updater's own bail-out rather than `merge`, for the same reason
    // `mergePresentation` keeps a mirror ref: `deactivateSim` runs on EVERY tick that is not
    // inside a sim section, and `merge` allocates unconditionally. Returning the SAME object is
    // React's documented no-op, so clearing a key that is already null costs nothing.
    if (!handoffActiveRef.current) {
      setState((s) => (s.activeSimUrl === null ? s : { ...s, activeSimUrl: null }));
    }
    awaitingPaintSimIdRef.current = null;
    desiredSimRef.current = null;
    pendingSimRef.current = null;
    activeSimRef.current = null;
    // THE REF FOLLOWS THE SAME RULE AS THE RENDERED KEY ABOVE, and it must: they are two owners
    // of one fact ("which frame is on screen"), and letting them disagree during a hold is the
    // bug. The rendered key kept the cover COMPOSITED; this ref is what keeps it RESIDENT — the
    // 'window' planner's `keep.add(activeSimUrlRef.current)` is its only defence for a frame
    // whose occurrence has passed and whose exit fade has not begun. Nulling it at T0 had the
    // planner dropPooled() the element the coordinator was holding, on the first tick of every
    // coordinated exit, on every device the 'window' tier exists for. The post-roll exit already
    // does this correctly (its release rides inside `commit`); this brings the mid-roll exit to
    // the same rule. Under a hold, `uncover` releases both together at COMMIT_REVEAL.
    if (!handoffActiveRef.current) activeSimUrlRef.current = null;
  };

  const updateSimOverlay = (segmentIdx: number, localTime: number) => {
    const seg = segmentsRef.current[segmentIdx];
    if (!seg) {
      deactivateSim();
      merge({ badgeText: '', badgeMode: '' });
      return;
    }

    // CLAMPED, because a media timeline need not start at zero — see `playheadFromMediaTime`.
    // Linux WebKit reports `currentTime: -0.04` on this fixture's HLS stream with a full buffer and
    // `played: []`, and `-0.04 >= 0` is false, so a section starting at 0 matched nothing at all.
    const playhead   = playheadFromMediaTime(localTime);
    const section    = seg.simulations.find((s) => playhead >= s.start_sec && playhead < s.end_sec) ?? null;
    const simSection = section?.simulation_url ? section : null;
    const segmentDuration = timelineRef.current[segmentIdx]?.duration ?? seg.duration_sec;
    const isPostRollSim = !!simSection &&
      simSection.type === 'simulation' &&
      simSection.start_sec >= segmentDuration - SECTION_BOUNDARY_EPSILON_SEC;

    if (simSection !== null && simSection?.id === activeSimRef.current?.id) return;

    // Section is CHANGING — stop/hide/freeze the outgoing sim (frame stays resident).
    const hadActive = !!activeSimRef.current;
    // The automatic exit: a section ended and video is what comes next. This is the second of the
    // two paths the audit named (the explicit "back to video" button is the other), and the only
    // `deactivateSim` call that hands its uncover to the transition coordinator.
    if (hadActive || !simSection) deactivateSim({ exitToVideo: hadActive && !simSection });
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
      // A frame still inside its EXIT FADE survives to a later pass, exactly as the window planner
      // protects it: unmounting mid-fade removes the element being animated, so the simulation CUTS
      // to video instead of fading, and the deferred stopScript fires into a dead frame. The kill
      // switch's promise is at most one resident document in STEADY STATE, not one during a
      // transition — and 'single' is the mode an operator selects during an incident, which is the
      // worst moment to add a visible glitch. Same shared rule as the other two single-mode sites.
      if (poolTierRef.current === 'single') {
        for (const evictKey of singleModeEvictions([...simPoolSpecsRef.current], key, residencyGuards)) {
          dropPooled(evictKey, 'single-mode-switch');
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
          // THE LAB NUMBER, AND ONLY THE LAB NUMBER — no fallback to the lead time.
          //
          // `sim_prepare_budget_ms` is the preparation LEAD TIME, refined by field data once >=30
          // credible rows exist; at that point it IS the fleet p90 x 1.25. Judging a device's p90
          // against it asks whether `p90 > 1.25 x p90`, which is the circularity this call site was
          // fixed to remove — and the `??` fallback below reintroduced it for exactly the packages
          // the fix was written to protect. The old comment justified the fallback with "there the
          // two are equal", which is true ONLY for a package that has a canary and no field data;
          // a package with NO canary and plenty of field data is the case that matters, and there
          // the lead time is pure field data masquerading as a standard.
          //
          // The server already emits `sim_lab_budget_ms` only when a real canary number exists
          // (buildPlayerConfig: `if (lab !== null) simLabBudgets[simId] = lab`), so absent here
          // means genuinely un-canaried. `nextQualityFor` answers 'no-lab-budget' for that, holding
          // the prior profile rather than degrading the package against `MIN_BUDGET_MS` (250ms) —
          // a floor is not a measurement, and an ordinary transition exceeds it.
          const lab = labStandardMs(
            { sim_lab_budget_ms: labBudgetsRef.current },
            simSection.simulation_id,
          );
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
            labBudgetMs: lab,
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
      // Re-entering a simulation abandons any exit still waiting for video evidence (a scrub back
      // into the section, a branch). Without the generation bump its rVFC callback, deadline and
      // media listeners would still be live and could uncover the section just entered.
      cancelCoordinatedExit('sim-activated');
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

      // WHAT PUBLICATION RECORDED ABOUT THIS PACKAGE'S BRIDGE (audit P0.5). Told to the runtime
      // BEFORE the activation below, because it is the input that decides whether the FIRST
      // activation on this document may be revealed on sight or must wait for the acknowledgement
      // — and in-session evidence, by definition, does not exist yet at that moment. `?? null` is
      // load-bearing: absent means UNKNOWN, which the gate handles as its own case, and coercing it
      // to `false` would restore the hole by way of a default.
      rt.setPackageAckCapable(simSection.bridge_ack_capable ?? null);

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
        // WHAT THIS PACKAGE NEEDS FROM THE BROWSER (audit P0.8), carried through unflattened.
        // `?? null` and not `?? false`: absent means the publication never recorded an answer, and
        // the floor must be able to tell that apart from a recorded "does not need import maps".
        simRequiresImportMaps: simSection.requires_import_maps ?? null,
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

      // THAW BEFORE DRIVING IT, on EVERY branch.
      //
      // This pool freezes constantly: a background frame is frozen the moment it paints, a warm
      // frame is frozen when its budget expires, and a coordinated exit freezes the OUTGOING frame
      // at T0 so its last valid frame can be the cover. Only one of the branches below ever undid
      // that — the cold one, which calls `rt.resume()` with a comment explaining exactly why a
      // frozen document cannot be driven. The two warm branches, which are the ones a re-entry
      // takes, did not.
      //
      // On v2 the omission was invisible: `activate()` posts SIM_RESUME itself. On v3 SIM_RESUME
      // does not undo the child's `scope.pause()` — only RESUME_DOCUMENT does — so a re-entered
      // section held hidden until `failModern('handshake-failed')` and then played as bare video
      // for its whole duration, every time. `SimRuntimeClient.activate()` now pays that debt too,
      // which is the backstop for any owner that forgets; this is the owner not forgetting.
      rt.thaw();

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

      // `rawNeedsNav` BELONGS HERE for the same reason `legacyNeedsNav` does: both just called
      // `navigateFrame`, so `wasReady && wasPainted` describes the document that was thrown away,
      // not the blank one now booting. Omitting it meant a raw-reset reload armed NOTHING: no
      // `startSimPoll` (no readiness/paint polling, no legacy reveal ceiling), no paint deadline,
      // no `simColdCover` (so neither poster nor spinner over a blank frame), and no 5s stall
      // affordance with its terminal force-reveal. The only remaining bound was the iframe's
      // native `load`, which waits for every subresource — and if one hangs, nothing was armed at
      // all and the section never revealed for its entire duration.
      if (!(wasReady && wasPainted) || legacyNeedsNav || rawNeedsNav) {
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
          // NEVER OVER A LIVE APPLY HOLD ON A DOCUMENT THAT HAS PIXELS (audit P0.5). The force
          // below is the compatibility escape for a document that has drawn NOTHING and can
          // acknowledge nothing — there are no wrong pixels on a blank canvas, so showing it
          // best-effort is honest. A document that HAS painted and is holding an unacknowledged
          // switch is the opposite case: its pixels are the boot scene, the previous section or a
          // warm pass, and forcing them up is exactly the frame the gate is holding back. Keep the
          // cover instead; the acknowledgement reveals it whenever it lands.
          if (simPainted(key) && runtimeFor(key).isHoldingApply()) {
            simTelemetry('stall-hold-covered', { key });
            merge({ simBootStalled: false, simColdCover: true });
            return;
          }
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

  // Recover a b-roll instance in place on fatal errors rather than leaving it frozen over the
  // main video (network → retry the load; anything else → media recover). Shared by the cold
  // load path and the warm-standby promotion, which previously had no recovery at all.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachBrollRecovery = (hls: any, HlsLib: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hls.on(HlsLib?.Events?.ERROR ?? 'hlsError', (_: string, d: any) => {
      if (!d.fatal) return;
      if (d.type === 'networkError') { setTimeout(() => { try { hls.startLoad(); } catch { /* detached */ } }, 1000); }
      else { try { hls.recoverMediaError(); } catch { /* detached */ } }
    });
  };

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
      attachBrollRecovery(hls, HlsLib);
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

    const standbyEl = refs.videoBrollStandby?.current ?? null;
    const hasWarm = standbyBrollClipIdRef.current === clip.id && hlsBrollStandbyRef.current && standbyEl;

    if (!hasWarm) {
      // Cold path — unchanged: tear down whatever was active, stream the clip fresh.
      if (hlsBrollRef.current) {
        hlsBrollRef.current.stopLoad();
        hlsBrollRef.current.detachMedia();
        hlsBrollRef.current.destroy();
        hlsBrollRef.current = null;
      }
      loadBrollHls(clip.hls_url, seekTo, HlsLib);
      return;
    }

    // PROMOTE the warm standby (P0.7): swap element ROLES — z-order and refs — exactly like the
    // main path's swapVideos(). The prewarmed instance KEEPS the element it buffered into. The
    // old "transfer" (detachMedia → attachMedia(brollEl)) threw the warmth away: in hls.js,
    // detachMedia() ends the MediaSource and drops every SourceBuffer, so the clip arrived cold
    // on the active element after all. Elements are never reparented and never detached here.

    // The outgoing active instance is stale — its clip just ended — so destroy it cleanly on
    // the element it owns (which becomes the new standby slot for the next prewarm).
    if (hlsBrollRef.current) {
      hlsBrollRef.current.stopLoad();
      hlsBrollRef.current.detachMedia();
      hlsBrollRef.current.destroy();
      hlsBrollRef.current = null;
    }
    brollEl.pause();

    // The promoted instance is consumed as a standby; a later prewarmBroll finds the standby
    // ref empty and warms the NEXT clip onto the demoted element — it can never tear down the
    // instance being promoted here.
    hlsBrollRef.current = hlsBrollStandbyRef.current;
    hlsBrollStandbyRef.current = null;
    standbyBrollClipIdRef.current = null;

    // Role swap. The shell binds opacity to `showBrollOverlay` on BOTH b-roll slots and keeps
    // each slot's zIndex constant in JSX, so visibility tracks whichever element is on top and
    // React never fights these imperative writes (same contract as videoA/videoB).
    standbyEl.style.zIndex = '8';
    brollEl.style.zIndex = '-1';
    refs.videoBroll.current = standbyEl;
    if (refs.videoBrollStandby) refs.videoBrollStandby.current = brollEl;

    // The instance was created with the standby buffer budget — give the now-active clip the
    // active budget (mirrors swapVideos' re-application; hls.config is mutable at runtime).
    hlsBrollRef.current.config.maxBufferLength = HLS_OPTS_BROLL.maxBufferLength;
    // Prewarm never attached fatal-error recovery; the ACTIVE overlay must have it.
    attachBrollRecovery(hlsBrollRef.current, HlsLib);

    standbyEl.currentTime = Math.max(0, seekTo);
    standbyEl.addEventListener('seeked', () => {
      if (!videoRef.current?.paused) safePlay(standbyEl);
    }, { once: true });
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
    // Merge broll_clips and clip_overlays — both use the same video overlay mechanism.
    //
    // WHICH ONE WINS IS NOT THIS FILE'S DECISION ANY MORE (broll-player-002). This used to be
    // `.find(...)` — the FIRST array match — which meant a `clip_overlay` could never beat a
    // `broll_clip` however much later it started, and that array order, not the timeline, decided
    // what a viewer saw. The export resolved the same overlap by layer then later-start, so the
    // two surfaces disagreed and what an author previewed was not what the master contained.
    // `topmostAt` is now the single rule both call.
    const cfg = overlayConfigRef.current;
    const overlayClips = [...(cfg.broll_clips ?? []), ...(cfg.clip_overlays ?? [])];
    const clip = topmostAt(overlayClips.map(asStackedClip), gt)?.clip ?? null;

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
    const cuts: AudioCutaway[] = overlayConfigRef.current.audio_cutaways ?? [];
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
    const overlays = overlayConfigRef.current.image_overlays ?? [];
    const active = overlays.find(
      (o) => gt >= o.global_offset_sec && gt < o.global_offset_sec + o.duration_sec,
    ) ?? null;

    if (active?.id !== activeImageIdRef.current) {
      activeImageIdRef.current = active?.id ?? null;
      merge({ activeImageOverlay: active ?? null });
    }
  };

  // ── committing a flat-overlay revision (broll-player-001) ─────────────────────────────────

  /** The b-roll lane as the scheduler sees it: generated clips and manual clip overlays. */
  const flatBrollLaneOf = (cfg: PlayerConfig): Array<BrollClip | ClipOverlay> =>
    [...(cfg.broll_clips ?? []), ...(cfg.clip_overlays ?? [])];

  /**
   * Is any lane still MID-SHOT at `gt` under the COMMITTED revision?
   *
   * The pin is per shot, not per poll, and it is evaluated against `gt` rather than against "is
   * something active right now" — so it releases on the very tick the shot's own boundary passes.
   * Testing liveness instead would hold the revision back one extra tick and clip the first ~250ms
   * off a corrected clip that starts exactly where the old one ended.
   */
  const overlayShotInProgress = (gt: number): boolean => {
    const cfg = overlayConfigRef.current;
    const clip = activeBrollRef.current;
    if (clip && gt >= clip.global_offset_sec && gt < clip.global_offset_sec + (clip.end_sec - clip.start_sec)) return true;
    const cutId = activeAudioCutawayIdRef.current;
    if (cutId) {
      const cut = (cfg.audio_cutaways ?? []).find((c) => c.id === cutId);
      if (cut && gt >= cut.global_offset_sec && gt < cut.global_offset_sec + (cut.end_sec - cut.start_sec)) return true;
    }
    const imgId = activeImageIdRef.current;
    if (imgId) {
      const img = (cfg.image_overlays ?? []).find((o) => o.id === imgId);
      if (img && gt >= img.global_offset_sec && gt < img.global_offset_sec + img.duration_sec) return true;
    }
    return false;
  };

  /** Drop a standby warmed from a superseded revision; the next prewarm rebuilds it. */
  const discardStandbyBroll = () => {
    if (hlsBrollStandbyRef.current) {
      hlsBrollStandbyRef.current.stopLoad();
      hlsBrollStandbyRef.current.detachMedia();
      hlsBrollStandbyRef.current.destroy();
      hlsBrollStandbyRef.current = null;
    }
    standbyBrollClipIdRef.current = null;
  };

  /**
   * Promote the newest published revision — every flat-overlay lane at once — but only where no
   * shot is on screen at `gt`. A revision that lands mid-shot is not dropped; it simply waits for
   * the boundary, which is what makes an editorial correction unable to flash or swap mid-shot.
   */
  const commitOverlayConfig = (gt: number) => {
    const next = pendingOverlayConfigRef.current;
    const prev = overlayConfigRef.current;
    if (next === prev) return;
    if (overlayShotInProgress(gt)) return;      // pinned — the shot plays out under `prev`

    overlayConfigRef.current = next;

    // The warm standby was chosen from `prev`. `prewarmBroll` dedupes on clip ID ALONE, so a clip
    // whose url or placement was corrected under the same id would otherwise keep its stale warm
    // buffer for the rest of the session and play the superseded media. Discarding it here — in
    // the same step that moves the revision — is what keeps the schedule and the prewarm plan on
    // ONE revision instead of letting them drift apart.
    const warmId = standbyBrollClipIdRef.current;
    if (warmId) {
      const was = flatBrollLaneOf(prev).find((c) => c.id === warmId);
      const now = flatBrollLaneOf(next).find((c) => c.id === warmId);
      const unchanged = !!was && !!now
        && now.hls_url === was.hls_url
        && now.global_offset_sec === was.global_offset_sec
        && now.start_sec === was.start_sec
        && now.end_sec === was.end_sec;
      if (!unchanged) discardStandbyBroll();
    }
  };

  /**
   * ONE flat-overlay pass. Every caller (the tick and all three seek paths) goes through this so
   * the commit point and the three lanes can never be wired up inconsistently at a later edit.
   */
  const updateFlatOverlays = (gt: number, isPlaying: boolean) => {
    commitOverlayConfig(gt);
    updateBrollOverlay(gt);
    updateImageOverlay(gt);
    updateAudioCutaway(gt, isPlaying);
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
    const standby = standbyRef.current;
    // Narrowed here only so TypeScript can see they are non-null below; the DECISION — including
    // the URL check whose ordering was the bug — belongs to `shouldPrewarm`.
    if (!id || !standby) return;
    if (!shouldPrewarm({
      segmentId: id,
      claimedId: standbyIdRef.current,
      url: getSegmentUrl(segIdx),
      hasStandby: true,
    })) return;
    // The URL check lives inside `shouldPrewarm` — see there for why its ORDER was the bug.
    // Leaving `standbyIdRef` untouched when there is no URL is what lets the next prewarm call
    // (they are frequent — every timeupdate near the boundary) retry once the URL arrives.
    standbyIdRef.current = id;
    attachHlsSource(standby, segIdx, hlsStandbyRef.current);
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
    //
    // A load that is NOT this handoff's own seek replaces the incoming media, so the handoff has
    // nothing left to prove — abandon it and run its deferred teardown, or the outgoing simulation
    // stays composited over the new segment.
    if (!handoffIssuingRef.current) cancelCoordinatedExit('segment-load', { runPendingCommit: true });
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
      updateFlatOverlays(gt, !videoRef.current?.paused);

      // Pre-warm next broll clip 15s before its start (flat overlays are disabled in
      // branching mode — their global offsets don't map onto per-sequence timelines).
      if (!branching) {
        // PREWARM WHAT WILL ACTUALLY BE SHOWN, not whichever row sits first in the array — the
        // second half of broll-player-002. Take the earliest start in the look-ahead window, then
        // ask the shared rule who wins AT that instant across every overlay lane; a clip that will
        // be covered by a later-starting one is not worth prewarming. Only b-roll can be prewarmed
        // (the standby element is a b-roll element), so a `clip_overlay` winner simply means
        // nothing to do — which is what happened before for every clip_overlay anyway.
        const liveCfg = overlayConfigRef.current;
        const brollClips = liveCfg.broll_clips ?? [];
        const allOverlays = [...brollClips, ...(liveCfg.clip_overlays ?? [])].map(asStackedClip);
        const upcoming = brollClips
          .filter((b) => gt < b.global_offset_sec && gt + 15 >= b.global_offset_sec)
          .sort((a, b) => a.global_offset_sec - b.global_offset_sec);
        const soonest = upcoming[0] ?? null;
        const winnerAtStart = soonest
          ? topmostAt(allOverlays, soonest.global_offset_sec)?.clip ?? null
          : null;
        const nextBroll = winnerAtStart && brollClips.some((b) => b.id === winnerAtStart.id)
          ? (winnerAtStart as typeof brollClips[number])
          : null;
        if (nextBroll && nextBroll.id !== standbyBrollClipIdRef.current && nextBroll.id !== activeBrollRef.current?.id) {
          prewarmBroll(nextBroll, hlsLibRef.current);
        }
      }

      // Residency. 'single' tier (kill switch): keep ONLY the active package's frame; drop
      // everything else each tick, so at most one sim document ever lives in STEADY STATE
      // (approximates the pre-pool navigating iframe). The active frame mounts on activation via
      // ensurePooled.
      //
      // THIS is the eviction that actually runs at a section boundary, and it had no fade guard:
      // `deactivateSim` clears `activeSimUrlRef` first, so the outgoing frame is not "active" here
      // and was dropped mid-fade on the very next timeupdate — defeating the guards at both
      // `ensurePooledSpec` and the section-change site within the same tick. It now applies the
      // same shared rule they do.
      if (poolTierRef.current === 'single') {
        for (const key of singleModeEvictions([...simPoolSpecsRef.current], activeSimUrlRef.current, residencyGuards)) {
          dropPooled(key, 'single-mode');
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
            // `mode` records WHICH mechanism armed — rvfc, timeout, or none.
            //
            // THIS IS NOT FIELD DATA. `simTelemetry` is inert unless the URL carries `?simdebug=1`
            // and its only sink is an in-memory array; nothing transmits it. So this answers "which
            // path did THIS session take" for someone debugging, and does NOT answer "what fraction
            // of sessions get the frame-accurate path" — an earlier version of this comment claimed
            // it did. Answering that needs `mode` routed through the RUM path.
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
        // A frame already in two-phase eviction is kept for the same mechanical reason: its
        // element must stay mounted until the child answers, and `dropPooled` would be a no-op for
        // it anyway. Naming it here keeps the `keep` set an honest description of the DOM.
        for (const spec of simPoolSpecsRef.current) {
          if (isFadingOut(spec.key) || isEvicting(spec.key)) keep.add(spec.key);
        }
        for (const occ of [plan.active, plan.next]) {
          if (occ && !simPoolSpecsRef.current.some((s) => s.key === occ.packageKey)) {
            ensurePooledSpec({ key: occ.packageKey, src: occ.src, bootHide: occ.bootHide });
          }
        }
        for (const spec of [...simPoolSpecsRef.current]) {
          if (!keep.has(spec.key)) dropPooled(spec.key, 'window-slide');
        }
      }

      // THE HARD CAP IS A CEILING, NOT ONLY AN ADMISSION RULE.
      //
      // `ensurePooledSpec` admits over the cap whenever every eviction candidate has to be spared —
      // a frame mid-exit-fade, or one whose disposal handshake has not finished — because cutting a
      // live transition to hold an internal number is the worse trade. That overshoot is described
      // as self-clearing, and it was not: nothing looked at the cap again after admission, so the
      // extra frame's WebGL context stayed allocated for the rest of the session. This is the pass
      // that comes back for it, once the fade or the handshake that forced the overshoot resolves.
      //
      // Runs at EVERY tier: 'single' and 'window' have their own keep sets and will normally have
      // collected it first, but the cap is a device-safety limit rather than a tier preference, and
      // 'all' has no other eviction rule at all. A pool at or under the cap yields no victims, so
      // this is inert in the ordinary case.
      for (const key of overCapEvictions(
        simPoolSpecsRef.current, activeSimUrlRef.current, warmingSimUrlRef.current,
        SIM_POOL_HARD_CAP, residencyGuards,
      )) {
        dropPooled(key, 'hard-cap-sweep');
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
      seg.duration >= s.start_sec - SECTION_BOUNDARY_EPSILON_SEC &&
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
    // The session is over and `started` drops, so the thumbnail cover returns; the live latch
    // resets with it so a replay covers until its OWN first frame presents (never a shorter
    // cover than today — `started` alone already re-showed the poster here).
    videoLiveRef.current = false;
    merge({ started: false, videoLive: false, controlsVisible: true });
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
      // APPLY THE SECTION COVERING THE CURRENT TIME, NOW — do not wait for `timeupdate`.
      //
      // `updateSimOverlay` is the only function that applies a section and reveals the overlay,
      // and until this line every path to it required the timeline to have MOVED: the `timeupdate`
      // tick, a segment swap, or a seek. A viewer sitting at t=0 that has never played and never
      // seeked had reached none of them, so **a project whose timeline OPENS on a simulation had
      // no simulation applied at all**. Proven rather than reasoned: an instrumented boot logs no
      // call to `updateSimOverlay`, the overlay stays at opacity 0 on the bare `sim-overlay` class,
      // and the child reports section "none" — the same signature the WebKit CI failure dumps.
      //
      // The sim-first case was already half-handled: the pool is SEEDED and the arm gate opens
      // immediately for it, so the package is warm and the iframe exists. Only the activation was
      // still waiting for a clock that had not started.
      //
      // `play` rather than `playing` or `loadeddata`: `play` fires when playback is REQUESTED,
      // which is the earliest moment the viewer has committed to showing the timeline — and it
      // fires even when the media then fails to advance, which is precisely the case that had no
      // recovery. `playing` would inherit the same dependency on frames actually arriving.
      //
      // Not restricted to the first play, and not conditional on `simFirst`. `updateSimOverlay`
      // early-returns when the active section is unchanged, so a resume mid-section costs one
      // comparison; and a resume whose section DID change while paused is a case that wants this
      // too. Guarding it would trade a real fix for a narrower one that needs the guard to be
      // right.
      //
      // Second effect, on every browser: `timeupdate` fires at roughly 4 Hz, so the first tick
      // after pressing play was up to ~250 ms late. For a sim-first project that was a visible
      // flash of the video's first frame before the simulation appeared.
      onTick();
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
    // First frame genuinely presenting (THUMB): 'playing' — not 'play' — is the event that
    // means decoded frames are advancing, so only now may the thumbnail cover drop
    // (state gate: `started && videoLive`). Latched once per session; every later 'playing'
    // (seeks, stall recoveries, segment swaps) is a no-op here.
    v.addEventListener('playing', () => {
      if (v !== videoRef.current || videoLiveRef.current) return;
      videoLiveRef.current = true;
      merge({ videoLive: true });
    });
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
      // ── the apply hold reached its deadline with no acknowledgement ────────────────────────
      // A DEADLINE SELECTS A COVER, NEVER A REVEAL (audit §21 rule 7). The runtime keeps holding —
      // elapsed time is not evidence about which sub-simulation is on the canvas — and this is the
      // owner's cue to stop being silent about the wait. `simColdCover` is the existing cover: the
      // section's poster when one was captured for this exact identity, and the honest wait
      // affordance over the held outgoing video frame when none was.
      case 'apply-deadline-cover':
        if (isActive) merge({ simColdCover: true, simBootStalled: false });
        return;
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
    // This mount is alive. The ref survives React's dev double-mount (StrictMode), so without
    // this reset the second mount would inherit `true` from the first cleanup and every
    // unmount guard in the tree (F4, the init gate below) would see a phantom unmount.
    unmountedRef.current = false;
    // Effect-scoped cancellation for the async init below (P0.6a). unmountedRef alone is NOT
    // enough: under the double-mount the remount resets it to false BEFORE the first mount's
    // in-flight hls.js import resolves, so a stale initAsync would then construct a second,
    // orphaned Hls instance on top of the fresh mount's.
    let cancelled = false;
    const vA = refs.videoA.current!;
    const vB = refs.videoB.current!;
    videoRef.current   = vA;
    standbyRef.current = vB;
    vA.style.zIndex = '2';
    vB.style.zIndex = '1';
    // The b-roll slots follow the same role convention (activateBrollClip promotes a warm
    // standby by swapping these imperatively, exactly like swapVideos) — pin the starting
    // roles here so a dev remount can never inherit swapped z-indexes with un-swapped refs.
    if (refs.videoBroll.current) refs.videoBroll.current.style.zIndex = '8';
    if (refs.videoBrollStandby?.current) refs.videoBrollStandby.current.style.zIndex = '-1';

    const initAsync = async () => {
      if (typeof window === 'undefined') return;
      const HlsLib = (await import('hls.js')).default;
      // The one await above: if the player unmounted while the chunk loaded, stop HERE —
      // before this line nothing has been constructed, so there is nothing to destroy, and
      // proceeding would leak an Hls instance no cleanup ever sees (P0.6a).
      if (cancelled) return;
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

      // Source attached — the player is startable (P0.6b). Flush everything that queued on
      // readiness through the NORMAL start path: first the waiters (the autoStart effect arms
      // its pacing timer here), then a start the viewer already requested with a click.
      initReadyRef.current = true;
      const waiters = onInitReadyRef.current.splice(0);
      for (const fn of waiters) fn();
      if (pendingStartRef.current) {
        pendingStartRef.current = false;
        startPlayback();
      }
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
      // FIRST, before any teardown: everything that fires after this line — the in-flight
      // hls.js import above, pool timers, late acks — must already see the tree as gone.
      // (This used to be set near the END of the cleanup, so an unmount during the import
      // left an orphan Hls instance no destroy ever reached — P0.6a.)
      cancelled = true;
      unmountedRef.current = true;
      // The last batch is the most valuable one, and an armed sentinel must not outlive the tree:
      // its callback closes over a video element this component is about to release.
      try { rumAtMount.current?.dispose(); } catch { /* disposal must not throw into unmount */ }
      rumAtMount.current = null;
      try { sentinelAtMount.current?.cancel(); } catch { /* already gone */ }
      sentinelAtMount.current = null;
      // A handoff holds an rVFC callback, an rAF loop, media listeners and a deadline, all closing
      // over a video element this component is about to release. No commit on unmount: there is
      // nothing left to uncover.
      cancelCoordinatedExit('unmount');
      hlsRef.current?.destroy();
      hlsStandbyRef.current?.destroy();
      hlsBrollRef.current?.destroy();
      hlsBrollStandbyRef.current?.destroy();
      clearTimeout(idleTimerRef.current ?? undefined);
      clearRevealTimers();
      // …and the reveal COMPOSITIONS, which `clearRevealTimers` does not own: a queued double
      // animation frame is not a timer this component tracked, and running one after unmount
      // allocates a `SimRuntimeClient` nothing will ever dispose. See `revealFrameCancelsRef`.
      cancelPendingRevealFrames();
      vA.removeEventListener('playing', armPool);
      vA.removeEventListener('play', armPoolOnAttempt);
      if (armPoolTimer) clearTimeout(armPoolTimer);
      // Pristine reloads must not fire into an unmounted tree.
      for (const t of reloadsAtMount.values()) clearTimeout(t);
      reloadsAtMount.clear();
      // Disposing each client removes its window listener and makes every timer it owns
      // (deferred stop, apply stall, paint poll, legacy ceiling) inert — irreversibly.
      // (unmountedRef was already raised at the top of this cleanup.)
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
      applySeek(getPct(cx) * totalDurRef.current, wasPlayingRef.current);
    };

    /**
     * Land the player on a global timestamp. Extracted verbatim from the scrub release so the
     * initial `?t=` seek travels the SAME path — including the in-flight-swap rule below, which
     * exists because getting it wrong once wedged the player permanently.
     */
    const applySeek = (targetGlobal: number, resumePlaying: boolean) => {
      const tl = timelineRef.current;
      setProgress(targetGlobal, totalDurRef.current);
      merge({ globalTime: targetGlobal });

      let targetIdx = 0;
      for (let i = tl.length - 1; i >= 0; i--) {
        if (tl[i].offset <= targetGlobal) { targetIdx = i; break; }
      }
      const targetSeg = tl[targetIdx];
      const localTime = Math.max(0, targetGlobal - targetSeg.offset);

      // NOT WHILE A SWAP INTO THIS SEGMENT IS STILL IN FLIGHT.
      //
      // `loadSegment` sets `curIdxRef` at T0 but promotes the standby only from `finishSwap`, so
      // between the two this test says "same segment" while `videoRef.current` is still the
      // OUTGOING element. Two things then went wrong together: the seek below assigned the NEW
      // segment's local time to the OLD segment's media (and played it), and `swapGenRef.current++`
      // cancelled the in-flight swap — which nothing re-arms, because `swappingRef` is cleared
      // only inside `finishSwap`. The player was then wedged permanently: the wrong segment on
      // screen, and `onTick`'s whole overlay/sim/residency block skipped for the rest of the
      // session (a b-roll revealed by this very call stays at opacity 1 forever). Reproduced by
      // two ordinary scrubs — one across a boundary, one landing in the same segment before its
      // media became playable.
      //
      // Re-issuing the load is the correct answer rather than merely skipping the bump: it mints a
      // fresh generation, re-arms the completion path on the standby (whose source is already
      // attached, so nothing reloads), and lands the viewer at the position they released.
      if (targetIdx === curIdxRef.current && !swappingRef.current) {
        swapGenRef.current++;
        // A scrub retargets the media the handoff was waiting on, so its evidence rule can never
        // be satisfied and its retry would seek back to where the viewer just left.
        cancelCoordinatedExit('scrub', { runPendingCommit: true });
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
        updateFlatOverlays(targetGlobal, resumePlaying);
        if (resumePlaying && localTime < targetSeg.duration - 0.01) safePlay(videoRef.current!);
      } else {
        loadSegment(targetIdx, localTime, resumePlaying);
      }
    };

    // The scrub effect owns the only seek implementation; this ref is how a non-pointer caller
    // (the initial `?t=`) reaches it without a second, divergent copy of the logic.
    seekRef.current = applySeek;

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
    // Init-readiness gate (P0.6b): before the async init has attached a source there is
    // nothing to play. Park the intent — poster and play button STAY — and initAsync flushes
    // it through this same path the moment the source is attached. When init has already
    // completed (the overwhelmingly common case) this branch is never taken and the behavior
    // below is exactly the pre-gate behavior.
    if (!initReadyRef.current) { pendingStartRef.current = true; return; }
    startedRef.current = true;
    merge({ started: true });
    applyMediaVolume();
    // A carried-over position (`?t=` from a language switch) lands BEFORE the first play, through
    // the scrub path, so segment resolution and HLS handling are identical to a manual seek. It is
    // consumed once: a later pause/resume must not teleport the viewer back here.
    const pendingSeek = pendingInitialSeekRef.current;
    if (pendingSeek !== null) {
      pendingInitialSeekRef.current = null;
      const target = Math.max(0, Math.min(pendingSeek, Math.max(0, totalDurRef.current - 0.25)));
      if (target > 0 && seekRef.current) { seekRef.current(target, true); return; }
    }
    void safePlay(videoRef.current!).then((ok) => {
      // Rejected play (autoplay policy without a qualifying gesture, a load() interrupting
      // the request): revert to the actionable poster + play button instead of a black
      // frame (P0.6c). Never revert a video that is actually playing — another path (a
      // second click, Space) may have started it while this promise settled.
      if (ok || unmountedRef.current) return;
      const v = videoRef.current;
      if (v && !v.paused) return;
      startedRef.current = false;
      merge({ started: false });
    });
    scheduleHide();
    // (Sims need no warm-up here: the resident pool mounted them at player render.)
  }, [scheduleHide, applyMediaVolume]);

  // Auto-start (playlist videos 2..N): a user gesture already occurred in the lobby, so begin
  // playing as soon as the first segment is ready. Armed only once the async init has attached
  // a source (P0.6d) — every trigger below (readyState probe, canplay, the 600ms pacing timer)
  // counts from READINESS, so the happy path keeps today's pacing while a slow init no longer
  // gets a blind timer start against a sourceless element.
  useEffect(() => {
    if (!options.autoStart) return;
    let done = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const v = refs.videoA.current;
    const start = () => { if (done) return; done = true; startPlayback(); };
    const onCan = () => start();
    const arm = () => {
      if (done) return;
      if (v) {
        if (v.readyState >= 2) { start(); return; }
        v.addEventListener('canplay', onCan, { once: true });
      }
      t = setTimeout(start, 600);
    };
    if (initReadyRef.current) arm();
    else onInitReadyRef.current.push(arm);
    return () => { done = true; v?.removeEventListener('canplay', onCan); if (t) clearTimeout(t); };
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

        // Same in-flight-swap rule as `endScrub` — see the note there. `curIdxRef` is already the
        // incoming segment while `videoRef.current` is still the outgoing element, so an arrow key
        // pressed inside the swap window seeks and PLAYS the previous segment's media at the new
        // segment's time. (No `swapGenRef` bump here, so this path did not wedge — it just showed
        // and sounded the wrong shot, then discarded the seek when the swap landed.)
        if (targetIdx === curIdxRef.current && !swappingRef.current) {
          videoRef.current!.currentTime = Math.min(localTime, tl[targetIdx].duration);
          updateSimOverlay(targetIdx, localTime);
          updateFlatOverlays(newGlobal, wasPlaying);
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
    // A handoff that timed out is COVERED, not finished. The control the viewer just pressed is
    // the recovery action for it, so it replays that handoff rather than starting a new one —
    // and it can never uncover, because only COMMIT_REVEAL does that.
    if (retryCoordinatedExitRef.current()) return;
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
      //
      // Captured HERE, at T0, not read inside `commit`. Under the coordinator `commit` runs after
      // the seek, and the seek's own `updateSimOverlay` tick has already cleared `activeSimUrlRef`
      // by then — so reading the refs late would silently skip the pristine reload / stopScript.
      const doneKey = activeSimUrlRef.current;
      const doneFrame = doneKey ? simPoolFramesRef.current.get(doneKey) : null;
      const doneRt = doneKey ? runtimeFor(doneKey) : null;

      const commit = () => {
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
        // `activeSimUrl` travels with `showSimOverlay`, for the reason `deactivateSim` spells out:
        // the pool frame is composited on `active && visible`, so releasing the rendered key is
        // half of dropping the cover and belongs to the commit — under the coordinator this whole
        // body runs from COMMIT_REVEAL, and the tick that seeks past the section deliberately
        // leaves the key alone while the handoff is still holding.
        merge({ showResumeBtn: false, showSimOverlay: false, simBootStalled: false, simColdCover: false, activeSimUrl: null, resumeAction: 'resume', controlsVisible: true, globalTime: targetGlobal });
        setProgress(targetGlobal);
        updateFlatOverlays(targetGlobal, wasPlayingRef.current);
      };

      const issueSeek = () => {
        if (targetSeg && targetIdx === curIdxRef.current) {
          videoRef.current!.currentTime = Math.min(localTime, targetSeg.duration);
          updateSimOverlay(targetIdx, localTime);
          void safePlay(videoRef.current!).then((ok) => {
            // A refused play() is a covered, ACTIONABLE state, not a silent failure: the incoming
            // media will never become audible, so the outgoing package must keep its gain. Guarded
            // on an active handoff so the flag-OFF path is exactly today's fire-and-forget call.
            if (!ok && handoffActiveRef.current) {
              dispatchTransition({ type: 'AUDIO_BLOCKED', generation: handoffGenRef.current });
            }
          });
        } else if (targetSeg) {
          loadSegment(targetIdx, localTime, true);
        }
      };

      // FLAG OFF: `commit(); issueSeek();` is exactly the statements, in exactly the order, this
      // function ran before the coordinator existed. FLAG ON inverts them and puts the frame
      // evidence in between.
      const coordinated = beginCoordinatedExit({
        key: doneKey,
        requestedMediaTime: targetSeg ? Math.min(localTime, targetSeg.duration) : 0,
        seekRequested: true,
        // Returning to video restores the narration this section interrupted. The package keeps
        // its gain until the video is actually audible, which is what closes the silence gap.
        audioIntent: 'narration-continuous',
        issueSeek,
        commit,
      });
      if (!coordinated) { commit(); issueSeek(); }
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
