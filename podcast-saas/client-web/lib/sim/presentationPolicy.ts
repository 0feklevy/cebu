/**
 * The presentation policy — which of the three layers the viewer is actually looking at, and what
 * each layer is allowed to contain while that is true.
 *
 * WHY A PURE FUNCTION AND NOT COMPONENT STATE
 * Every previous generation of this decision lived inside the player component as a handful of
 * booleans (`showSimOverlay`, `simColdCover`, `simBootStalled`, per-frame opacity) that were each
 * set from a different effect. The combinations that produced a wrong reveal were never written
 * down anywhere, so they could not be tested — they could only be reproduced, and most of them
 * depended on timer ordering, which meant they could not reliably be reproduced either. Moving the
 * whole decision into one total function over one input record makes the wrong combinations
 * enumerable: the tests walk the cartesian product and assert the invariants hold for ALL of it,
 * not for the handful of paths someone thought to try.
 *
 * THE THREE LAYERS
 *   top     the target poster, a neutral transition cover, or the recovery UI
 *   middle  the INCOMING live iframe
 *   bottom  the OUTGOING valid content — a still-playing video, a frozen last frame, or the
 *           simulation being left
 *
 * `layer` names which of them the user is looking at. The other fields say what may be true of the
 * layers that are NOT being looked at, and that is where the safety lives:
 *
 *   1. `incoming` may be 'revealed' ONLY when `layer === 'live'`, which is reachable only from
 *      `presented === true`. `presented` is the caller's `mayReveal()` result. There is no timer in
 *      this file and no input that stands in for one — a timeout can produce a FAILURE (which the
 *      caller passes in as `failure`), never a presentation.
 *
 *   2. `incoming` may be 'covered' (mounted at full opacity behind the cover, so the reveal is a
 *      cover removal with no compositing flash) ONLY when the cover is opaque AND has actually
 *      decoded. A transparent cover, or a poster whose bytes have not arrived, covers nothing —
 *      and an "optimisation" that assumed otherwise is exactly how an unconfigured frame becomes
 *      visible through poster alpha.
 *
 *   3. When the cover is transparent, `beneathCover` is 'outgoing' by construction: the pixels
 *      showing through the alpha are the still-valid outgoing content, never the incoming frame.
 */

import { shouldRevealLive, SIM_MIN_LIVE_DWELL_MS } from 'shared/src/sim/activationMachine';

export type PresentationLayer = 'poster' | 'live' | 'outgoing' | 'recovery';

/** What the player currently wants on screen. */
export type PresentationIntent = 'sim' | 'video';

/** What the top layer renders when it is showing. */
export type CoverKind = 'poster' | 'neutral' | 'none';

export type CoverOpacity = 'opaque' | 'transparent';

/** What the bottom layer paints under a showing cover. */
export type BeneathCover = 'outgoing' | 'opaque';

/**
 * 'hidden'    zero opacity — contributes no pixels.
 * 'covered'   full opacity, but an opaque, decoded cover is over it. Legal ONLY under rule 2.
 * 'revealed'  visible and interactive. Reachable only from `presented`.
 */
export type IncomingVisibility = 'hidden' | 'covered' | 'revealed';

export type OutgoingKind = 'video' | 'sim' | 'none';

/**
 * Every reason is a distinct literal so a test can pin the exact path taken rather than asserting
 * on a layer that several different paths happen to agree on. Two paths that produce the same
 * layer for different reasons are two behaviours, and a regression that swaps one for the other is
 * invisible to a layer-only assertion.
 */
export type PresentationReason =
  | 'exit-to-video'
  | 'exit-to-video-no-frame'
  | 'failed-awaiting-recovery'
  | 'retry-in-flight'
  | 'context-lost-covered'
  | 'context-lost-outgoing'
  | 'poster-only-device'
  | 'poster-only-no-poster-outgoing'
  | 'poster-only-no-poster-cover'
  | 'same-package-poster'
  | 'same-package-outgoing'
  | 'same-package-cover'
  | 'awaiting-presentation-poster'
  | 'awaiting-presentation-outgoing'
  | 'awaiting-presentation-cover'
  | 'insufficient-dwell-poster'
  | 'insufficient-dwell-outgoing'
  | 'insufficient-dwell-no-alternative'
  | 'presented-live';

export interface PresentationInputs {
  intent: PresentationIntent;

  /**
   * The caller's `mayReveal({...}).allowed`. THE gate.
   *
   * Passed in rather than computed here on purpose: `mayReveal` needs the activation machine, the
   * current intent identity and the document's context-loss flag, none of which belong in a
   * presentation policy — and a policy that could synthesise its own `presented` would eventually
   * synthesise it from something cheaper, which is the whole history of this bug class.
   */
  presented: boolean;

  /**
   * The incoming section is served by the SAME document as the outgoing one (sections of one
   * package share a document and are switched by dynamic dispatch). There is therefore no separate
   * incoming frame to warm behind a cover: the single document mutates in place, and everything it
   * shows between the two configurations is wrong. That is why this case must be covered.
   */
  samePackage: boolean;

  /**
   * The pixels BENEATH this component are still valid to show — a playing video, a frozen last
   * frame, or an outgoing simulation that has not been torn down. False on a cold seek, on a
   * sim-first project before any video has decoded, and during a same-package handover with
   * nothing behind it.
   */
  outgoingValid: boolean;
  outgoingKind: OutgoingKind;

  /** A poster matching the TARGET identity (posterIdentity.ts) exists and is fetchable. */
  posterAvailable: boolean;
  /** Its bytes have decoded. An undecoded poster covers nothing, however available it is. */
  posterLoaded: boolean;

  /** The target section renders over video: its cover must preserve the video beneath it. */
  transparentSection: boolean;

  /** Milliseconds of the TARGET section still to run. */
  remainingMs: number;
  /** Below this, a live reveal is a flash and the poster is the better picture. */
  minDwellMs?: number;

  /** A bounded failure from simFailurePolicy has been raised for this activation. */
  failure: boolean;
  /** A retry is in flight — the recovery surface stays, but stops offering actions. */
  retrying: boolean;

  /**
   * The device/breaker has decided no live frame will be brought up for this section at all.
   * Distinct from `failure`: nothing is broken, the player has simply chosen the poster.
   */
  posterOnlyMode: boolean;

  /** The presented frame's rendering context was lost. Its pixels are no longer trustworthy. */
  contextLost: boolean;

  /**
   * Minimal UI is configured for the section currently occupying the iframe — the incoming one
   * while entering, the outgoing one while exiting.
   */
  simpleUi: boolean;

  /**
   * The iframe contributes zero visible pixels right now (its fade-out finished, or an opaque
   * cover is fully painted over it). Defaults to the conservative value at every call site: while
   * this is unknown, Minimal UI must stay on.
   */
  iframeFullyCovered: boolean;

  reducedMotion: boolean;
}

export interface PresentationDecision {
  layer: PresentationLayer;
  reason: PresentationReason;
  /** What the top layer renders. 'none' means the top layer is not showing at all. */
  cover: CoverKind;
  coverOpacity: CoverOpacity;
  beneathCover: BeneathCover;
  incoming: IncomingVisibility;
  /**
   * A DISTINCT incoming document may be brought up / kept up while covered. False for a
   * same-package handover (there is no distinct document — the shared one is reconfigured in
   * place) and false on a constrained device, which is the point of staying poster-only.
   */
  prepareIncoming: boolean;
  showRecoveryActions: boolean;
  minimalUiActive: boolean;
  crossFade: boolean;
}

/**
 * The ordered chain. Precedence is the specification, so it is written as one straight-line
 * sequence of guards rather than as composed predicates: reading it top to bottom IS reading the
 * priority order, and inserting a case in the wrong place is visible in the diff.
 *
 * Failure outranks context loss because an unrecovered context loss is *reported* as a failure by
 * the caller; reaching the context-loss branch means recovery is still expected. Poster-only
 * outranks everything below it because a constrained device has already decided the answer.
 */
function chooseLayer(
  i: PresentationInputs,
  minDwellMs: number,
): { layer: PresentationLayer; reason: PresentationReason } {
  // ── 1. Exit ────────────────────────────────────────────────────────────────────────────────
  if (i.intent === 'video') {
    // The video may not have decoded yet (a seek out of a post-roll sim, a source switch). Showing
    // an un-decoded video element means showing whatever was last composited there, so it is
    // covered until the caller says the frame is valid.
    return i.outgoingValid
      ? { layer: 'outgoing', reason: 'exit-to-video' }
      : { layer: 'poster', reason: 'exit-to-video-no-frame' };
  }

  // ── 2. Bounded failure ─────────────────────────────────────────────────────────────────────
  // `posterOnlyMode` wins over a failure: choosing poster-only is how the user (or the breaker)
  // DISMISSES the recovery surface, so continuing to show it afterwards would be a dead end.
  if (i.failure && !i.posterOnlyMode) {
    return { layer: 'recovery', reason: i.retrying ? 'retry-in-flight' : 'failed-awaiting-recovery' };
  }

  // ── 3. Poster-only ─────────────────────────────────────────────────────────────────────────
  if (i.posterOnlyMode) {
    if (i.posterAvailable) return { layer: 'poster', reason: 'poster-only-device' };
    return i.outgoingValid
      ? { layer: 'outgoing', reason: 'poster-only-no-poster-outgoing' }
      : { layer: 'poster', reason: 'poster-only-no-poster-cover' };
  }

  // ── 4. Context loss ────────────────────────────────────────────────────────────────────────
  // A lost context leaves the frame showing a blank or a half-composited scene. Cover it at once;
  // the activation machine has already dropped back to RENDERING, so `presented` will be false
  // again by the next tick and the normal wait path takes over.
  if (i.contextLost) {
    if (i.posterAvailable) return { layer: 'poster', reason: 'context-lost-covered' };
    return i.outgoingValid
      ? { layer: 'outgoing', reason: 'context-lost-outgoing' }
      : { layer: 'poster', reason: 'context-lost-covered' };
  }

  // ── 5. Not yet presented ───────────────────────────────────────────────────────────────────
  if (!i.presented) {
    if (i.samePackage) {
      if (i.posterAvailable) return { layer: 'poster', reason: 'same-package-poster' };
      // No poster for B. The shared document is mid-reconfiguration so its pixels are wrong, but a
      // real video frame beneath is right: sim A → video → sim B is an ugly double cut and still
      // strictly better than showing a grey rectangle, or than showing A's scene relabelled as B's.
      return i.outgoingValid
        ? { layer: 'outgoing', reason: 'same-package-outgoing' }
        : { layer: 'poster', reason: 'same-package-cover' };
    }
    // Cross-package: the poster is preferred over the still-valid outgoing content, because the
    // poster is pixel-identical to the frame that will replace it — so the eventual reveal is
    // invisible. Holding the video instead only defers a cut that then happens at a moment the
    // player does not control.
    if (i.posterAvailable) return { layer: 'poster', reason: 'awaiting-presentation-poster' };
    return i.outgoingValid
      ? { layer: 'outgoing', reason: 'awaiting-presentation-outgoing' }
      : { layer: 'poster', reason: 'awaiting-presentation-cover' };
  }

  // ── 6. Presented, but late ─────────────────────────────────────────────────────────────────
  if (!shouldRevealLive(i.remainingMs, minDwellMs)) {
    if (i.posterAvailable) return { layer: 'poster', reason: 'insufficient-dwell-poster' };
    if (i.outgoingValid) return { layer: 'outgoing', reason: 'insufficient-dwell-outgoing' };
    // Nothing else exists to show. A brief live simulation beats a grey rectangle for the rest of
    // the section — the dwell rule exists to avoid a WORSE picture, not to enforce a blank one.
    return { layer: 'live', reason: 'insufficient-dwell-no-alternative' };
  }

  return { layer: 'live', reason: 'presented-live' };
}

export function decidePresentation(input: PresentationInputs): PresentationDecision {
  const minDwellMs = input.minDwellMs ?? SIM_MIN_LIVE_DWELL_MS;
  const { layer, reason } = chooseLayer(input, minDwellMs);

  // A transparent section is composited OVER the video. An opaque cover there paints a black
  // rectangle across the video the section is supposed to sit on — visually the exact defect
  // posters exist to prevent. So the cover goes transparent, but ONLY while there is valid content
  // beneath it to see through to; with nothing valid underneath, transparency reveals stale
  // compositor contents and opaque is correct.
  const coverOpacity: CoverOpacity =
    input.intent === 'sim' && input.transparentSection && input.outgoingValid ? 'transparent' : 'opaque';

  // Invariant by construction: `coverOpacity === 'transparent'` implies `outgoingValid`, so this is
  // 'outgoing' in every transparent case. The transparent cover can therefore never expose the
  // incoming unprepared frame — only the outgoing valid content.
  const beneathCover: BeneathCover = input.outgoingValid ? 'outgoing' : 'opaque';

  const topShowing = layer === 'poster' || layer === 'recovery';
  const cover: CoverKind = topShowing ? (input.posterAvailable ? 'poster' : 'neutral') : 'none';
  // A neutral cover is a painted div — it is ready the moment it exists. A poster is an image and
  // is ready only once its bytes have decoded.
  const coverReady = cover === 'neutral' || (cover === 'poster' && input.posterLoaded);

  const prepareIncoming =
    input.intent === 'sim' &&
    !input.posterOnlyMode &&
    !input.samePackage &&
    (layer !== 'recovery' || input.retrying);

  const incoming: IncomingVisibility =
    layer === 'live'
      ? 'revealed'
      : topShowing && coverOpacity === 'opaque' && coverReady && prepareIncoming
        ? 'covered'
        : 'hidden';

  // Exiting = the section that owns the iframe is being left. Derived rather than passed, because
  // a caller that gets it wrong silently drops Minimal UI one frame early and the section's full
  // chrome flashes on the way out — a defect with no failing assertion anywhere.
  const exiting = input.intent === 'video' || (input.samePackage && !input.presented);

  // With reduced motion there is no fade: the cut lands whole in a single paint, so "the iframe is
  // no longer contributing pixels" is true as soon as it is hidden. With a cross-fade it is true
  // only when the caller says the transition finished.
  const fullyCovered = input.iframeFullyCovered || (input.reducedMotion && incoming === 'hidden');

  return {
    layer,
    reason,
    cover,
    coverOpacity,
    beneathCover,
    incoming,
    prepareIncoming,
    showRecoveryActions: layer === 'recovery' && !input.retrying,
    minimalUiActive: input.simpleUi && !(exiting && fullyCovered),
    crossFade: !input.reducedMotion,
  };
}

/**
 * Conservative defaults, so a caller that omits a field gets the SAFE answer rather than the
 * convenient one: nothing is presented, nothing beneath is valid, no poster exists, Minimal UI
 * stays on. Every default here errs towards covering.
 */
export const DEFAULT_PRESENTATION_INPUTS: PresentationInputs = {
  intent: 'sim',
  presented: false,
  samePackage: false,
  outgoingValid: false,
  outgoingKind: 'none',
  posterAvailable: false,
  posterLoaded: false,
  transparentSection: false,
  remainingMs: 0,
  minDwellMs: SIM_MIN_LIVE_DWELL_MS,
  failure: false,
  retrying: false,
  posterOnlyMode: false,
  contextLost: false,
  simpleUi: false,
  iframeFullyCovered: false,
  reducedMotion: false,
};
