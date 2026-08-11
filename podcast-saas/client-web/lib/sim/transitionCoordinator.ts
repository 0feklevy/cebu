/**
 * The bidirectional, frame-valid transition coordinator (audit P0.1, §4.2–§4.5).
 *
 * WHAT IS ACTUALLY WRONG WITHOUT IT
 * The simulation→video exit uncovers the video before anything has proven that the requested video
 * frame reached the compositor. `resumeFromSim()` freezes and MUTES the outgoing package, clears
 * `showSimOverlay`, and only then assigns `currentTime` and calls `play()`. The cover therefore
 * drops before the seek is even issued, so what the compositor presents in that window is whatever
 * was last composited into that video element — a stale frame, or black. The measured warm
 * post-roll case put `playing` at 24.6 ms after the click; a cold return is unbounded and
 * unmeasured. On the audio side the package is silenced at T0 while the incoming media is not yet
 * audible, which is an unintended silence with no owner.
 *
 * WHAT COUNTS AS EVIDENCE, AND WHAT DOES NOT
 * `readyState >= HAVE_CURRENT_DATA` says data exists for the current position. `seeked` says
 * seeking ended. `canplay` is an estimate about continued playback. `play()` resolving says
 * playback began. NONE of them says the frame belonging to THIS seek reached the compositor.
 * `requestVideoFrameCallback` runs when a frame is sent to the compositor and carries that frame's
 * own `mediaTime`, so it is the strongest portable JavaScript evidence available — and it is still
 * not proof that photons reached the display, may be one vsync late, and may never arrive at all
 * (no support, hidden or fully occluded page, some source-switch paths). So:
 *
 *   1. A frame is accepted only when it matches BOTH the current handoff generation AND the
 *      requested `mediaTime` within a small tolerance. A frame from a superseded handoff, or a
 *      frame at the pre-seek position, is rejected and the loop re-arms.
 *   2. Non-arrival is an explicit, first-class outcome (`RVFC_NON_ARRIVAL`), not a hang. It unlocks
 *      a LABELLED lower-confidence fallback: `seeked` + `readyState >= 2` + two VISIBLE animation
 *      frames. The label travels with the evidence so telemetry never conflates the two.
 *   3. A DEADLINE NEVER AUTHORISES A REVEAL (audit §21 rule 7). `DEADLINE` can only ever reach
 *      `CoveredFailure`, which holds a cover and offers a retry. This is the one rule that the
 *      whole module exists to enforce, and `revealsWithoutEvidence` below is its executable form.
 *   4. The cross-fade begins on a parent paint AFTER evidence, never on the evidence alone.
 *   5. Audio has its own readiness. Decoded pixels and audible samples are different signals, so
 *      the audio switch is driven by `AUDIO_INCOMING_AUDIBLE`, never by frame evidence. The
 *      outgoing gain is RETAINED until the declared `AudioIntent` is satisfied.
 *
 * WHY A PURE REDUCER
 * Same reason as `presentationPolicy.ts`, which this module deliberately reuses rather than
 * re-deciding: the combinations that produce a wrong reveal are only enumerable if the whole
 * decision is one total function over one input record. The tests walk the cartesian product of
 * intent × generation match/mismatch × evidence arrival/non-arrival × visibility × deadline and
 * assert the invariant over ALL of it. A timer, a DOM handle or a video element in here would make
 * that impossible, so there are none: every clock reading arrives as a field on an event.
 *
 * RELATIONSHIP TO `boundaryClock.ts`
 * That module is the only other rVFC user in the repo. It is an entry-side DETECTION sentinel for
 * section boundaries — it answers "has playback passed time T yet", and `timeupdate` remains its
 * safety net. This module answers a different question, "has the frame I asked for been submitted
 * to the compositor", and it has no safety net by design: without an answer, the cover stays.
 */

import {
  decidePresentation,
  DEFAULT_PRESENTATION_INPUTS,
  type OutgoingKind,
  type PresentationReason,
} from './presentationPolicy';

// ── identity ────────────────────────────────────────────────────────────────────────────────

/** What the player wants on screen. The coordinator is bidirectional; `video` is the exit. */
export type TransitionIntent = 'sim' | 'video';

/**
 * The audit's three named audio policies (§4.5). Carried explicitly so that "the outgoing source
 * keeps its gain" is a decision with a name, rather than the accident of which call site ran last.
 */
export type AudioIntent = 'narration-continuous' | 'simulation-exclusive' | 'mixed';

/**
 * How the presented-frame claim was obtained. This is a CONFIDENCE LABEL, not a gate: both kinds
 * can authorise a reveal, and telemetry must be able to tell them apart afterwards.
 *
 *   rvfc      a compositor submission callback carrying the frame's own mediaTime.
 *   fallback  `seeked` + `readyState >= 2` + two visible animation frames, admissible only once
 *             rVFC is known to be unavailable or known not to have arrived.
 */
export type EvidenceKind = 'rvfc' | 'fallback';
export type EvidenceConfidence = 'high' | 'low';

/** The audit's §4.3 machine, plus the covered-failure state every wait can reach. */
export type TransitionPhase =
  | 'SimLive'
  | 'VideoRequested'
  | 'VideoBuffering'
  | 'VideoDecoded'
  | 'VideoSubmitted'
  | 'CrossFading'
  | 'VideoLive'
  | 'CoveredFailure';

/**
 * The phases in which incoming pixels are permitted to reach the viewer. `CrossFading` counts:
 * the cover's opacity starts falling the moment it is entered, so it is a reveal.
 */
export const REVEALED_PHASES: readonly TransitionPhase[] = ['CrossFading', 'VideoLive'];

export const isRevealed = (phase: TransitionPhase): boolean => REVEALED_PHASES.includes(phase);

export type TransitionFailureReason =
  | 'deadline'
  | 'fatal-media-error'
  | 'audio-blocked';

/** What the top layer holds while the incoming frame is unproven. */
export type TransitionCover = 'outgoing' | 'poster' | 'neutral' | 'none';

export interface FrameEvidence {
  kind: EvidenceKind;
  confidence: EvidenceConfidence;
  /** The handoff this frame belongs to. Never trusted across generations. */
  generation: number;
  /** The frame's own presentation timestamp, as reported by the source of the evidence. */
  mediaTime: number;
  atMs: number;
}

export interface AudioTransitionState {
  intent: AudioIntent;
  /**
   * The OUTGOING source still holds its gain. Starts true on every handoff and is cleared only
   * when the incoming media satisfies `intent` — which is what closes the unintended-silence gap.
   */
  outgoingRetained: boolean;
  /**
   * The incoming media reported AUDIBLE playback. Deliberately not derivable from frame evidence:
   * a decoded picture says nothing about samples reaching an output.
   */
  incomingAudible: boolean;
  /** `play()` / `AudioContext.resume()` was rejected. A covered, ACTIONABLE state — never a reveal. */
  blocked: boolean;
}

export interface TransitionReadiness {
  /** `HTMLMediaElement.readyState`. >= 2 (HAVE_CURRENT_DATA) is one third of the fallback. */
  readyState: number;
  seeked: boolean;
  /** Animation frames observed while the page was visible since the source was issued. */
  visibleFrames: number;
}

export interface TransitionState {
  phase: TransitionPhase;
  intent: TransitionIntent;
  /** Bumped by every request, retry and cancel. The ONLY thing that makes a late callback safe. */
  generation: number;

  /** The pixels being left, and whether they are still valid to show. */
  outgoing: { kind: OutgoingKind; valid: boolean };
  /** Identity of the media being brought up (segment id / element id). Diagnostics + mismatch. */
  incomingId: string | null;
  /** The media time this handoff asked for. Null outside a handoff. */
  requestedMediaTime: number | null;
  toleranceSec: number;
  /**
   * This handoff actually issued a seek (or a source switch).
   *
   * The audit's fallback names `seeked` as one of its three components because the exit it was
   * written for seeks. A mid-roll exit does not: the video never stopped, so no `seeked` event is
   * ever coming, and requiring one would make the fallback permanently inadmissible on exactly the
   * path where the incoming pixels are already valid.
   */
  seekRequested: boolean;

  readiness: TransitionReadiness;
  /** The accepted compositor-submission evidence, or null. Non-null is REQUIRED to reveal. */
  evidence: FrameEvidence | null;
  audio: AudioTransitionState;
  poster: { available: boolean; loaded: boolean };

  pageVisible: boolean;
  rvfc: {
    available: boolean;
    /** A callback is currently registered. Owned by the reducer so arm/cancel is testable. */
    armed: boolean;
    /** Bounded non-arrival was observed; the labelled fallback becomes admissible. */
    nonArrival: boolean;
  };

  /** Wall-clock deadline for the whole handoff. Read only to report it; never to reveal. */
  deadlineAt: number | null;
  failure: TransitionFailureReason | null;

  /** Diagnostics. Counters only — nothing in this module ever gates on them. */
  rejected: { staleGeneration: number; wrongMediaTime: number; inadmissibleFallback: number };
}

// ── events ──────────────────────────────────────────────────────────────────────────────────

export interface ExitRequestedEvent {
  type: 'EXIT_REQUESTED';
  generation: number;
  incomingId: string | null;
  requestedMediaTime: number;
  /** False for a mid-roll exit, where playback simply continues. See `TransitionState.seekRequested`. */
  seekRequested: boolean;
  audioIntent: AudioIntent;
  outgoing: { kind: OutgoingKind; valid: boolean };
  poster?: { available: boolean; loaded: boolean };
  rvfcAvailable: boolean;
  pageVisible: boolean;
  deadlineAt: number | null;
  toleranceSec?: number;
}

export type TransitionEvent =
  | ExitRequestedEvent
  /** The source/seek has been issued. ONLY now may a frame callback be registered. */
  | { type: 'SOURCE_ISSUED'; generation: number }
  | { type: 'MEDIA_READY'; generation: number; readyState: number; seeked: boolean }
  | { type: 'VISIBLE_FRAME'; generation: number }
  | { type: 'FRAME_PRESENTED'; generation: number; mediaTime: number; kind: EvidenceKind; atMs: number }
  | { type: 'VISIBILITY'; visible: boolean }
  | { type: 'RVFC_NON_ARRIVAL'; generation: number }
  | { type: 'PARENT_PAINT'; generation: number }
  | { type: 'FADE_COMPLETE'; generation: number }
  | { type: 'DEADLINE'; generation: number; atMs: number }
  | { type: 'FATAL'; generation: number; reason: TransitionFailureReason }
  | { type: 'RETRY'; generation: number; requestedMediaTime?: number; deadlineAt?: number | null }
  | { type: 'CANCEL'; generation: number }
  | { type: 'AUDIO_INCOMING_AUDIBLE'; generation: number }
  | { type: 'AUDIO_BLOCKED'; generation: number }
  /** Outgoing pixels stopped being valid mid-handoff (the frame was torn down or lost). */
  | { type: 'OUTGOING_INVALIDATED'; generation: number }
  | { type: 'POSTER_LOADED'; generation: number };

// ── effects ─────────────────────────────────────────────────────────────────────────────────

/**
 * What the wiring must DO. Returned rather than inferred by diffing state, because the two things
 * a diff cannot express are exactly the two that matter here: "cancel and re-arm" (arm→arm looks
 * like no change) and "this reveal is authorised NOW" (which must fire once, not per render).
 */
export type TransitionEffect =
  | { type: 'ARM_FRAME_EVIDENCE'; generation: number }
  | { type: 'CANCEL_FRAME_EVIDENCE'; generation: number }
  /** Release the outgoing source's gain — i.e. mute the package. Audio-driven, never frame-driven. */
  | { type: 'RELEASE_OUTGOING_AUDIO'; generation: number }
  /** Evidence is in and the parent has painted: drop the cover and run the caller's teardown. */
  | { type: 'COMMIT_REVEAL'; generation: number; evidence: FrameEvidence }
  /**
   * A covered failure has become RECONSIDERABLE: re-issue this handoff.
   *
   * NOT a reveal, and deliberately not one: the wiring's only correct response is to start a new
   * handoff, which walks the whole evidence path again from `EXIT_REQUESTED`. It exists because a
   * `CoveredFailure` cannot re-arm in place — the phase is not a WAIT_PHASE, so no callback, no
   * frame and no readiness signal is admitted while the state sits there — and the one thing that
   * can make the failure obsolete (the page coming back to the front) is not a retryable event the
   * wiring's own timer would ever notice.
   */
  | { type: 'REQUEST_RETRY'; generation: number; reason: 'visibility' }
  | { type: 'HOLD_COVER'; cover: TransitionCover; reason: PresentationReason | 'revealed' }
  | { type: 'TELEMETRY'; event: string; detail: Record<string, unknown> };

export interface TransitionResult {
  state: TransitionState;
  effects: TransitionEffect[];
}

// ── constants ───────────────────────────────────────────────────────────────────────────────

/**
 * How far a presented frame's `mediaTime` may sit from the requested time and still be accepted.
 *
 * A browser seek lands on a real frame at or near the request, so the FIRST frame presented after
 * the seek is the target. 250 ms is ~7 frames at 30 fps: wide enough to absorb a seek snapped to a
 * nearby frame, narrow enough that a pre-seek frame from elsewhere in a multi-minute timeline can
 * never pass. It is not a latency budget — a frame outside it is rejected and the loop re-arms.
 */
export const DEFAULT_FRAME_TOLERANCE_SEC = 0.25;

/** `HTMLMediaElement.HAVE_CURRENT_DATA`, spelled out so the fallback rule reads as the audit wrote it. */
export const HAVE_CURRENT_DATA = 2;

/** Two VISIBLE animation frames, per §4.3. Frames observed while hidden do not count. */
export const FALLBACK_VISIBLE_FRAMES = 2;

/** Phases that are waiting for evidence — every one of them can reach `CoveredFailure`. */
const WAIT_PHASES: readonly TransitionPhase[] = [
  'VideoRequested', 'VideoBuffering', 'VideoDecoded', 'VideoSubmitted',
];

const isWaiting = (p: TransitionPhase): boolean => WAIT_PHASES.includes(p);

export const INITIAL_TRANSITION_STATE: TransitionState = {
  phase: 'SimLive',
  intent: 'sim',
  generation: 0,
  outgoing: { kind: 'sim', valid: true },
  incomingId: null,
  requestedMediaTime: null,
  toleranceSec: DEFAULT_FRAME_TOLERANCE_SEC,
  seekRequested: false,
  readiness: { readyState: 0, seeked: false, visibleFrames: 0 },
  evidence: null,
  audio: {
    intent: 'narration-continuous',
    outgoingRetained: false,
    incomingAudible: false,
    blocked: false,
  },
  poster: { available: false, loaded: false },
  pageVisible: true,
  rvfc: { available: false, armed: false, nonArrival: false },
  deadlineAt: null,
  failure: null,
  rejected: { staleGeneration: 0, wrongMediaTime: 0, inadmissibleFallback: 0 },
};

// ── pure predicates ─────────────────────────────────────────────────────────────────────────

/**
 * Does this frame belong to the handoff we are actually waiting for, at the time we asked for?
 *
 * BOTH halves are load-bearing and neither is sufficient. Generation alone accepts the pre-seek
 * frame still sitting in the compositor (right handoff, wrong picture). mediaTime alone accepts a
 * frame from a superseded handoff that happens to be near the same timestamp — which is precisely
 * the case a scrub back into a sim and out again produces.
 */
export function frameMatches(
  state: TransitionState,
  frame: { generation: number; mediaTime: number },
): boolean {
  if (frame.generation !== state.generation) return false;
  if (state.requestedMediaTime === null) return false;
  if (!Number.isFinite(frame.mediaTime)) return false;
  return Math.abs(frame.mediaTime - state.requestedMediaTime) <= state.toleranceSec;
}

/**
 * May a `fallback`-kind claim be accepted right now?
 *
 * Only once rVFC has been ruled out — absent, or bounded non-arrival observed — and only with all
 * three of the audit's components present. Admitting it while rVFC is alive and merely slow would
 * turn the lower-confidence path into the normal path, which is how a labelled fallback quietly
 * becomes the only thing that ever runs.
 */
export function fallbackAdmissible(state: TransitionState): boolean {
  if (state.rvfc.available && !state.rvfc.nonArrival) return false;
  if (!state.pageVisible) return false;
  return seekSettled(state)
    && state.readiness.readyState >= HAVE_CURRENT_DATA
    && state.readiness.visibleFrames >= FALLBACK_VISIBLE_FRAMES;
}

/** The seek component of the fallback: satisfied trivially when no seek was issued. */
export const seekSettled = (state: TransitionState): boolean =>
  !state.seekRequested || state.readiness.seeked;

/**
 * Is the outgoing source's gain allowed to be released yet?
 *
 * `mixed` never releases it: both sources are meant to sound, so a release would be the overlap
 * invariant's opposite failure — an unintended silence chosen by the coordinator itself.
 */
export function audioPolicySatisfied(audio: AudioTransitionState): boolean {
  if (audio.blocked) return false;
  if (audio.intent === 'mixed') return false;
  return audio.incomingAudible;
}

/**
 * The cover the viewer is holding, decided by the EXISTING presentation policy rather than
 * re-derived here.
 *
 * `presentationPolicy`'s `exit-to-video` / `exit-to-video-no-frame` verdicts already encode the
 * audit's priority order — outgoing valid pixels first, then the decoded target poster, then a
 * neutral cover — but they were unreachable from the player, because the layered surface mounts
 * only while a sim is active and always with `intent: 'sim'`, so the exit was expressed by that
 * component UNMOUNTING. Routing the exit through the same total function is what makes those two
 * verdicts reachable, and it keeps one owner for "what may be visible".
 */
export function coverFor(state: TransitionState): { cover: TransitionCover; reason: PresentationReason | 'revealed' } {
  if (isRevealed(state.phase)) return { cover: 'none', reason: 'revealed' };
  if (state.phase === 'SimLive') return { cover: 'outgoing', reason: 'exit-to-video' };

  const decision = decidePresentation({
    ...DEFAULT_PRESENTATION_INPUTS,
    intent: 'video',
    outgoingValid: state.outgoing.valid,
    outgoingKind: state.outgoing.kind,
    posterAvailable: state.poster.available,
    posterLoaded: state.poster.loaded,
  });

  if (decision.layer === 'outgoing') return { cover: 'outgoing', reason: decision.reason };
  // `cover` is 'poster' only when a poster exists AND decoded; otherwise the neutral recovery cover.
  const usable = decision.cover === 'poster' && state.poster.loaded;
  return { cover: usable ? 'poster' : 'neutral', reason: decision.reason };
}

/**
 * THE INVARIANT, as an executable predicate rather than as prose in a test.
 *
 * Exported so the reducer's own tests can assert it over the full cartesian product, and so any
 * future caller can assert it too. True means the state machine has been broken.
 */
export function revealsWithoutEvidence(state: TransitionState): boolean {
  if (!isRevealed(state.phase)) return false;
  const e = state.evidence;
  if (!e) return true;
  if (e.generation !== state.generation) return true;
  if (state.requestedMediaTime === null) return true;
  return Math.abs(e.mediaTime - state.requestedMediaTime) > state.toleranceSec;
}

// ── the reducer ─────────────────────────────────────────────────────────────────────────────

const tel = (event: string, detail: Record<string, unknown> = {}): TransitionEffect =>
  ({ type: 'TELEMETRY', event, detail });

/** Emitted alongside every phase change so the wiring never has to re-derive the cover itself. */
function withCover(state: TransitionState, effects: TransitionEffect[]): TransitionResult {
  const { cover, reason } = coverFor(state);
  return { state, effects: [...effects, { type: 'HOLD_COVER', cover, reason }] };
}

const unchanged = (state: TransitionState): TransitionResult => ({ state, effects: [] });

/**
 * A stale event is the normal case, not an error: every superseded handoff leaves callbacks,
 * timers and listeners in flight that cannot be synchronously unregistered. They are counted and
 * dropped.
 */
function stale(state: TransitionState, event: TransitionEvent, gen: number): TransitionResult {
  return {
    state: { ...state, rejected: { ...state.rejected, staleGeneration: state.rejected.staleGeneration + 1 } },
    effects: [tel('transition-stale-event', { event: event.type, eventGeneration: gen, generation: state.generation })],
  };
}

export function reduce(state: TransitionState, event: TransitionEvent): TransitionResult {
  switch (event.type) {
    // ── request ──────────────────────────────────────────────────────────────────────────────
    case 'EXIT_REQUESTED': {
      const next: TransitionState = {
        ...state,
        phase: 'VideoRequested',
        intent: 'video',
        generation: event.generation,
        outgoing: event.outgoing,
        incomingId: event.incomingId,
        requestedMediaTime: event.requestedMediaTime,
        toleranceSec: event.toleranceSec ?? DEFAULT_FRAME_TOLERANCE_SEC,
        seekRequested: event.seekRequested,
        readiness: { readyState: 0, seeked: false, visibleFrames: 0 },
        evidence: null,
        audio: {
          intent: event.audioIntent,
          // The whole point: the outgoing package keeps its gain from T0.
          outgoingRetained: true,
          incomingAudible: false,
          blocked: false,
        },
        poster: event.poster ?? { available: false, loaded: false },
        pageVisible: event.pageVisible,
        rvfc: { available: event.rvfcAvailable, armed: false, nonArrival: false },
        deadlineAt: event.deadlineAt,
        failure: null,
      };
      return withCover(next, [
        // Whatever the previous handoff had registered belongs to a generation that no longer exists.
        { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
        tel('transition-requested', {
          generation: event.generation,
          mediaTime: event.requestedMediaTime,
          audioIntent: event.audioIntent,
          rvfc: event.rvfcAvailable,
          outgoingValid: event.outgoing.valid,
        }),
      ]);
    }

    // ── the source is live: only NOW may a callback be registered ────────────────────────────
    case 'SOURCE_ISSUED': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (state.phase !== 'VideoRequested') return unchanged(state);
      const next: TransitionState = {
        ...state,
        phase: 'VideoBuffering',
        rvfc: { ...state.rvfc, armed: state.pageVisible && state.rvfc.available },
      };
      // Hidden pages get no callback: rVFC is suppressed for hidden/occluded video, so arming
      // there produces a wait that can never end. `VISIBILITY` re-arms when the page comes back.
      return withCover(next, state.pageVisible
        ? [{ type: 'ARM_FRAME_EVIDENCE', generation: state.generation }]
        : [tel('transition-arm-deferred-hidden', { generation: state.generation })]);
    }

    // ── readiness (weak signals — recorded, never sufficient on their own) ────────────────────
    case 'MEDIA_READY': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (!isWaiting(state.phase)) return unchanged(state);
      const readiness: TransitionReadiness = {
        ...state.readiness,
        readyState: event.readyState,
        seeked: state.readiness.seeked || event.seeked,
      };
      const decoded = seekSettled({ ...state, readiness })
        && readiness.readyState >= HAVE_CURRENT_DATA;
      // Only ever a FORWARD move to VideoDecoded, and never past it: `VideoSubmitted` outranks it,
      // and dropping back would discard evidence already accepted.
      const phase: TransitionPhase =
        state.phase === 'VideoBuffering' && decoded ? 'VideoDecoded' : state.phase;
      return { state: { ...state, readiness, phase }, effects: [] };
    }

    case 'VISIBLE_FRAME': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (!state.pageVisible || !isWaiting(state.phase)) return unchanged(state);
      return {
        state: { ...state, readiness: { ...state.readiness, visibleFrames: state.readiness.visibleFrames + 1 } },
        effects: [],
      };
    }

    case 'POSTER_LOADED': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      return withCover({ ...state, poster: { available: true, loaded: true } }, []);
    }

    case 'OUTGOING_INVALIDATED': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      // The cover must fall back to the poster/neutral chain — it may NOT fall through to the
      // unproven incoming frame, which is what `coverFor` guarantees.
      return withCover({ ...state, outgoing: { ...state.outgoing, valid: false } },
        [tel('transition-outgoing-invalidated', { generation: state.generation })]);
    }

    // ── the evidence ─────────────────────────────────────────────────────────────────────────
    case 'FRAME_PRESENTED': {
      if (event.generation !== state.generation) {
        // A callback that arrives after a cancel or a retry lands here. Counted, dropped, and
        // NOT re-armed: its generation no longer owns anything.
        return stale(state, event, event.generation);
      }
      if (!isWaiting(state.phase)) return unchanged(state);

      if (!frameMatches(state, event)) {
        return {
          state: { ...state, rejected: { ...state.rejected, wrongMediaTime: state.rejected.wrongMediaTime + 1 } },
          effects: [
            tel('transition-frame-rejected', {
              generation: state.generation,
              mediaTime: event.mediaTime,
              requested: state.requestedMediaTime,
              tolerance: state.toleranceSec,
              kind: event.kind,
            }),
            // Keep looking. The pre-seek frame is expected to be presented first.
            ...(state.pageVisible ? [{ type: 'ARM_FRAME_EVIDENCE' as const, generation: state.generation }] : []),
          ],
        };
      }

      // NOTE ON VISIBILITY. An `rvfc` claim is accepted whatever `pageVisible` says. Visibility
      // governs whether a callback is ARMED — hiding cancels it, because a hidden surface will not
      // produce one — but a callback that genuinely did fire reports a frame that genuinely was
      // submitted, and discarding it would strand a viewer who tabbed away mid-handoff behind a
      // cover until the deadline. The `fallback` claim gets no such latitude: it is an INFERENCE
      // from `currentTime` and two animation frames, and both of those are meaningless while
      // hidden, which is why `fallbackAdmissible` checks visibility and this branch does not.
      if (event.kind === 'fallback' && !fallbackAdmissible(state)) {
        return {
          state: {
            ...state,
            rejected: { ...state.rejected, inadmissibleFallback: state.rejected.inadmissibleFallback + 1 },
          },
          effects: [tel('transition-fallback-inadmissible', {
            generation: state.generation,
            rvfcAvailable: state.rvfc.available,
            nonArrival: state.rvfc.nonArrival,
            seeked: state.readiness.seeked,
            readyState: state.readiness.readyState,
            visibleFrames: state.readiness.visibleFrames,
          })],
        };
      }

      const evidence: FrameEvidence = {
        kind: event.kind,
        confidence: event.kind === 'rvfc' ? 'high' : 'low',
        generation: event.generation,
        mediaTime: event.mediaTime,
        atMs: event.atMs,
      };
      return withCover(
        { ...state, phase: 'VideoSubmitted', evidence, rvfc: { ...state.rvfc, armed: false } },
        [
          { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
          tel('transition-frame-accepted', {
            generation: state.generation,
            kind: evidence.kind,
            confidence: evidence.confidence,
            mediaTime: evidence.mediaTime,
            requested: state.requestedMediaTime,
          }),
        ],
      );
    }

    case 'RVFC_NON_ARRIVAL': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (!isWaiting(state.phase)) return unchanged(state);
      return {
        state: { ...state, rvfc: { ...state.rvfc, nonArrival: true } },
        effects: [tel('transition-rvfc-non-arrival', {
          generation: state.generation,
          readyState: state.readiness.readyState,
          seeked: state.readiness.seeked,
          visibleFrames: state.readiness.visibleFrames,
        })],
      };
    }

    // ── visibility ───────────────────────────────────────────────────────────────────────────
    case 'VISIBILITY': {
      if (event.visible === state.pageVisible) return unchanged(state);
      if (!event.visible) {
        // Cancel unconditionally. A callback registered against a hidden surface will not fire,
        // and the visible-frame count restarts because frames accrued before a hide say nothing
        // about what the compositor is doing now.
        return withCover(
          {
            ...state,
            pageVisible: false,
            rvfc: { ...state.rvfc, armed: false },
            readiness: { ...state.readiness, visibleFrames: 0 },
          },
          [
            { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
            tel('transition-hidden', { generation: state.generation, phase: state.phase }),
          ],
        );
      }
      // Back in front of the user. Re-arm, but only where a callback is meaningful: the source
      // must already be issued, and the handoff must still be waiting for a frame.
      const rearm = isWaiting(state.phase) && state.phase !== 'VideoRequested'
        && state.phase !== 'VideoSubmitted' && state.rvfc.available;
      // A HANDOFF THAT FAILED WHILE HIDDEN IS NOT A HANDOFF THAT FAILED.
      //
      // Hiding cancels evidence and disarms rVFC (neither rVFC nor rAF runs on a hidden page), so
      // the 4 s deadline fires with nothing to show for it and lands in `CoveredFailure`. That
      // phase is not in WAIT_PHASES — by design, so no stale callback can revive a failed handoff —
      // which means the re-arm above cannot reach it and NOTHING else ever will: `COMMIT_REVEAL`
      // never runs, the caller's `commit`/`uncover` never runs, and the frozen simulation stays at
      // full opacity over a playing, audible video for the rest of the section.
      //
      // The repair is to RECONSIDER, never to reveal (audit §21 rule 7): the deadline that produced
      // this failure grants nothing, and the retry the wiring issues has to prove its own frame
      // from scratch. Emitted only on a genuine hidden→visible edge, because the guard at the top
      // of this case drops a VISIBILITY that reports what is already true.
      const reconsider = state.phase === 'CoveredFailure';
      return withCover(
        { ...state, pageVisible: true, rvfc: { ...state.rvfc, armed: rearm } },
        [
          ...(rearm ? [{ type: 'ARM_FRAME_EVIDENCE' as const, generation: state.generation }] : []),
          ...(reconsider
            ? [{ type: 'REQUEST_RETRY' as const, generation: state.generation, reason: 'visibility' as const }]
            : []),
          tel('transition-visible', {
            generation: state.generation, phase: state.phase, rearmed: rearm, reconsidered: reconsider,
          }),
        ],
      );
    }

    // ── reveal, and only from evidence ───────────────────────────────────────────────────────
    case 'PARENT_PAINT': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (state.phase !== 'VideoSubmitted') return unchanged(state);
      // Belt and braces: `VideoSubmitted` is only reachable through `frameMatches`, but this is
      // the single line that authorises pixels, so it re-checks rather than trusting the phase.
      const e = state.evidence;
      if (!e || !frameMatches(state, e)) return unchanged(state);
      return withCover({ ...state, phase: 'CrossFading' }, [
        { type: 'COMMIT_REVEAL', generation: state.generation, evidence: e },
        tel('transition-reveal', {
          generation: state.generation,
          confidence: e.confidence,
          kind: e.kind,
          audioReleased: !state.audio.outgoingRetained,
        }),
      ]);
    }

    case 'FADE_COMPLETE': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (state.phase !== 'CrossFading') return unchanged(state);
      return withCover({ ...state, phase: 'VideoLive' }, [tel('transition-live', { generation: state.generation })]);
    }

    // ── audio, on its own clock ──────────────────────────────────────────────────────────────
    case 'AUDIO_INCOMING_AUDIBLE': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (state.audio.incomingAudible) return unchanged(state);
      const audio: AudioTransitionState = { ...state.audio, incomingAudible: true };
      const release = audioPolicySatisfied(audio);
      return {
        state: { ...state, audio: { ...audio, outgoingRetained: !release } },
        effects: [
          ...(release ? [{ type: 'RELEASE_OUTGOING_AUDIO' as const, generation: state.generation }] : []),
          tel('transition-audio-incoming', { generation: state.generation, intent: audio.intent, released: release }),
        ],
      };
    }

    case 'AUDIO_BLOCKED': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      // The outgoing gain stays. The handoff does NOT fail visually — pixels and samples are
      // independent — so the phase is untouched and the cover logic is unaffected.
      return {
        state: { ...state, audio: { ...state.audio, blocked: true, outgoingRetained: true } },
        effects: [tel('transition-audio-blocked', { generation: state.generation, intent: state.audio.intent })],
      };
    }

    // ── bounded recovery. NEITHER of these may reveal. ────────────────────────────────────────
    case 'DEADLINE': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (!isWaiting(state.phase)) return unchanged(state);
      return withCover(
        {
          ...state,
          phase: 'CoveredFailure',
          failure: 'deadline',
          rvfc: { ...state.rvfc, armed: false },
        },
        [
          { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
          tel('transition-deadline', {
            generation: state.generation,
            phase: state.phase,
            atMs: event.atMs,
            hadEvidence: state.evidence !== null,
            readyState: state.readiness.readyState,
            seeked: state.readiness.seeked,
          }),
        ],
      );
    }

    case 'FATAL': {
      if (event.generation !== state.generation) return stale(state, event, event.generation);
      if (state.phase === 'CoveredFailure') return unchanged(state);
      return withCover(
        { ...state, phase: 'CoveredFailure', failure: event.reason, rvfc: { ...state.rvfc, armed: false } },
        [
          { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
          tel('transition-fatal', { generation: state.generation, reason: event.reason, phase: state.phase }),
        ],
      );
    }

    case 'RETRY': {
      // A retry is a NEW handoff. Everything the old one proved is discarded with its generation.
      const next: TransitionState = {
        ...state,
        phase: 'VideoRequested',
        generation: event.generation,
        requestedMediaTime: event.requestedMediaTime ?? state.requestedMediaTime,
        readiness: { readyState: 0, seeked: false, visibleFrames: 0 },
        evidence: null,
        rvfc: { ...state.rvfc, armed: false, nonArrival: false },
        deadlineAt: event.deadlineAt === undefined ? state.deadlineAt : event.deadlineAt,
        failure: null,
        audio: { ...state.audio, outgoingRetained: true, incomingAudible: false, blocked: false },
      };
      return withCover(next, [
        { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
        tel('transition-retry', { generation: event.generation, from: state.generation }),
      ]);
    }

    case 'CANCEL': {
      // Back to the simulation. The generation bump is what makes every callback still in flight
      // — rVFC, deadline, rAF, media events — harmless from this instant.
      const next: TransitionState = {
        ...INITIAL_TRANSITION_STATE,
        generation: event.generation,
        pageVisible: state.pageVisible,
        outgoing: state.outgoing,
        poster: state.poster,
        rvfc: { available: state.rvfc.available, armed: false, nonArrival: false },
      };
      return withCover(next, [
        { type: 'CANCEL_FRAME_EVIDENCE', generation: state.generation },
        tel('transition-cancelled', { from: state.generation, to: event.generation, phase: state.phase }),
      ]);
    }

    default: {
      // Exhaustiveness: a new event variant must be handled, not silently ignored.
      const _never: never = event;
      return unchanged(state as TransitionState & typeof _never);
    }
  }
}

/** Fold a sequence of events. Convenience for tests and for replaying a recorded handoff. */
export function reduceAll(
  state: TransitionState,
  events: readonly TransitionEvent[],
): TransitionResult {
  let s = state;
  const effects: TransitionEffect[] = [];
  for (const e of events) {
    const r = reduce(s, e);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}
