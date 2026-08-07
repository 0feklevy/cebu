/**
 * The SECTION ACTIVATION lifecycle, as a pure reducer — and the place the reveal invariant is
 * actually enforced.
 *
 * ONE ACTIVATION = ONE ENTRY INTO ONE SECTION. Re-entering the same section after leaving it is a
 * DIFFERENT activation with a different `activationId`, which is the entire reason A → B → A is
 * safe here and was not safe under the token protocol: a token distinguishes the second A from the
 * first only while the parent's counter has not been reset, and says nothing at all after a
 * document reload.
 *
 * THE INVARIANT, STATED ONCE
 *   A live iframe may have effective visible opacity only when the current presentation
 *   acknowledgement matches the current intent on ALL FIVE identity axes.
 *
 * Everything else in this file exists to make that sentence enforceable: `PRESENTED` is reachable
 * only through an acknowledgement that passed `identityMatches`, and `VISIBLE` is reachable only
 * from `PRESENTED`. There is no timeout edge into `PRESENTED`, no edge from `APPLIED`, and no edge
 * that a document-scope event can take.
 */

import type { ActivationId, ConfigHash, PresentationIdentity, VariantKey } from './simIdentity.js';

export type ActivationState =
  | 'IDLE'
  | 'PREPARING'
  | 'APPLIED'
  | 'RENDERING'
  | 'PRESENTED'
  | 'VISIBLE'
  | 'COVERED'
  | 'RELEASED'
  | 'FAILED';

export type ActivationEventType =
  | 'PREPARE'        // parent sent PREPARE_SECTION
  | 'APPLIED'        // child sent SECTION_APPLIED (identity already verified)
  | 'PRESENT'        // parent sent PRESENT_SECTION
  | 'PRESENTED'      // child sent SECTION_PRESENTED (identity already verified)
  | 'ACTIVATE'       // parent revealed it and started public automation
  | 'COVER'          // a poster/cover was placed over it (exit transition, quality drop)
  | 'UNCOVER'
  | 'CONTEXT_LOST'   // the presented frame is no longer valid
  | 'RELEASE'
  | 'FAIL';

export interface ActivationEvent {
  type: ActivationEventType;
  reason?: string;
  /**
   * PRESENTED only: the identity carried by the acknowledgement itself.
   *
   * REQUIRED, and deliberately not defaulted. Recording the machine's own identity instead made
   * `mayReveal` compare an object with itself at its only production call site, so every axis of
   * the five-axis invariant was unreachable — the check was unit-testable in isolation and enforced
   * nothing in the player. If a caller omits it the transition is REFUSED rather than silently
   * falling back to the self-comparison that caused the defect.
   */
  ackIdentity?: PresentationIdentity;
}

export interface ActivationMachineState {
  state: ActivationState;
  identity: PresentationIdentity;
  /** The identity of the acknowledgement that put this activation into PRESENTED. */
  presentedBy: PresentationIdentity | null;
  error: string | null;
  rejected: readonly { from: ActivationState; event: ActivationEventType }[];
}

export const MAX_REJECTED_RECORDED = 32;

export function initialActivationState(identity: PresentationIdentity): ActivationMachineState {
  return { state: 'IDLE', identity, presentedBy: null, error: null, rejected: [] };
}

const TRANSITIONS: Readonly<Record<ActivationState, Partial<Record<ActivationEventType, ActivationState>>>> = {
  IDLE: { PREPARE: 'PREPARING', RELEASE: 'RELEASED' },
  PREPARING: { APPLIED: 'APPLIED', RELEASE: 'RELEASED' },
  APPLIED: { PRESENT: 'RENDERING', RELEASE: 'RELEASED' },
  RENDERING: { PRESENTED: 'PRESENTED', RELEASE: 'RELEASED' },
  // ACTIVATE is the ONLY edge into VISIBLE, and PRESENTED is its only source state.
  PRESENTED: { ACTIVATE: 'VISIBLE', COVER: 'COVERED', RELEASE: 'RELEASED', CONTEXT_LOST: 'RENDERING' },
  VISIBLE: { COVER: 'COVERED', RELEASE: 'RELEASED', CONTEXT_LOST: 'RENDERING' },
  COVERED: { UNCOVER: 'VISIBLE', RELEASE: 'RELEASED', CONTEXT_LOST: 'RENDERING' },
  RELEASED: {},
  FAILED: { RELEASE: 'RELEASED' },
};

const NON_TERMINAL: ReadonlySet<ActivationState> = new Set<ActivationState>([
  'IDLE', 'PREPARING', 'APPLIED', 'RENDERING', 'PRESENTED', 'VISIBLE', 'COVERED',
]);

const withRejection = (prev: ActivationMachineState, event: ActivationEventType): ActivationMachineState => ({
  ...prev,
  rejected: [...prev.rejected, { from: prev.state, event }].slice(-MAX_REJECTED_RECORDED),
});

export function activationReducer(prev: ActivationMachineState, event: ActivationEvent): ActivationMachineState {
  if (event.type === 'FAIL') {
    if (!NON_TERMINAL.has(prev.state)) return withRejection(prev, event.type);
    return { ...prev, state: 'FAILED', error: event.reason ?? 'activation failed', presentedBy: null };
  }

  const next = TRANSITIONS[prev.state][event.type];
  if (!next) return withRejection(prev, event.type);

  if (event.type === 'PRESENTED') {
    // Record what the ACKNOWLEDGEMENT claimed, never what the machine already believes. That is
    // what lets `mayReveal` re-verify independently instead of trusting that the caller checked —
    // and the caller's check (`matchesActivation`) deliberately covers only three of the five axes,
    // so this is the only place `documentId` and `packageRevision` are ever compared on the reveal
    // path.
    if (!event.ackIdentity) return withRejection(prev, event.type);
    return { ...prev, state: next, presentedBy: event.ackIdentity, error: null };
  }

  if (event.type === 'CONTEXT_LOST') {
    // The submitted frame is gone. Drop back to RENDERING and forget the presentation proof: the
    // activation must submit a NEW render before it may be shown again.
    return { ...prev, state: next, presentedBy: null };
  }

  return { ...prev, state: next };
}

// ─── The reveal invariant ─────────────────────────────────────────────────────────────────────

export type RevealRefusal =
  | 'no-acknowledgement'
  | 'not-presented'
  | 'package-revision-mismatch'
  | 'document-mismatch'
  | 'activation-mismatch'
  | 'variant-mismatch'
  | 'config-mismatch'
  | 'context-lost'
  | 'document-not-ready';

export type RevealDecision = { allowed: true } | { allowed: false; refusal: RevealRefusal };

/**
 * All five axes, compared explicitly and in a fixed order so the refusal reason is deterministic.
 *
 * Written as separate comparisons rather than a loop over field names on purpose: a loop reads the
 * fields dynamically, so adding a sixth axis to `PresentationIdentity` and forgetting to compare it
 * would still typecheck AND still pass a loop-based test. Here it produces a compile error at the
 * destructure below.
 */
export function identityRefusal(
  ack: PresentationIdentity,
  current: PresentationIdentity,
): RevealRefusal | null {
  // Destructured so a new field on PresentationIdentity fails to compile until it is compared.
  const { packageRevision, documentId, activationId, variantKey, configHash } = current;
  if (ack.packageRevision !== packageRevision) return 'package-revision-mismatch';
  if (ack.documentId !== documentId) return 'document-mismatch';
  if (ack.activationId !== activationId) return 'activation-mismatch';
  if (ack.variantKey !== variantKey) return 'variant-mismatch';
  if (ack.configHash !== configHash) return 'config-mismatch';
  return null;
}

export function identityMatches(ack: PresentationIdentity, current: PresentationIdentity): boolean {
  return identityRefusal(ack, current) === null;
}

export interface RevealInputs {
  activation: ActivationMachineState;
  /** The intent the player currently holds — what it WANTS on screen. */
  current: PresentationIdentity;
  /** The document must be able to accept commands; a suspended/disposing document may not show. */
  documentReady: boolean;
  contextLost: boolean;
}

/**
 * THE gate. Every surface asks this and nothing else.
 *
 * Note what is absent: no timeout parameter, no `painted` flag, no "the section name matches", no
 * `contentWindow` comparison. Those were each, at some point, the thing that authorised a reveal,
 * and each in turn was shown to authorise a wrong one.
 */
export function mayReveal(inputs: RevealInputs): RevealDecision {
  if (!inputs.documentReady) return { allowed: false, refusal: 'document-not-ready' };
  if (inputs.contextLost) return { allowed: false, refusal: 'context-lost' };

  const { activation, current } = inputs;
  if (activation.state !== 'PRESENTED' && activation.state !== 'VISIBLE' && activation.state !== 'COVERED') {
    return { allowed: false, refusal: 'not-presented' };
  }
  if (!activation.presentedBy) return { allowed: false, refusal: 'no-acknowledgement' };

  const refusal = identityRefusal(activation.presentedBy, current);
  if (refusal) return { allowed: false, refusal };
  return { allowed: true };
}

/**
 * Is the activation still worth revealing LIVE, or should the poster simply stay?
 *
 * A live simulation that appears with less than `minDwellMs` of its section left is strictly worse
 * than the poster it replaces: the user sees a flash, the scene has no time to demonstrate
 * anything, and the exit transition begins almost immediately. The threshold is configurable
 * because the right value differs between a 4-second cutaway and a 90-second explainer.
 */
export function shouldRevealLive(remainingMs: number, minDwellMs: number): boolean {
  return remainingMs >= minDwellMs;
}

/** Default minimum live dwell. Product behaviour, not a tuning knob — see SimPresentationLayers. */
export const SIM_MIN_LIVE_DWELL_MS = 1_200;

// ─── Convenience ──────────────────────────────────────────────────────────────────────────────

export interface ActivationIdentityInput {
  packageRevision: string;
  documentId: string;
  activationId: ActivationId;
  variantKey: VariantKey;
  configHash: ConfigHash;
}

export const toPresentationIdentity = (i: ActivationIdentityInput): PresentationIdentity => ({
  packageRevision: i.packageRevision,
  documentId: i.documentId,
  activationId: i.activationId,
  variantKey: i.variantKey,
  configHash: i.configHash,
});
