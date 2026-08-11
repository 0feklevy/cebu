/**
 * SimRuntimeClient — the simulation document lifecycle, owned in one place.
 *
 * WHY THIS EXISTS
 * The viewer, the editor timeline player, the section-editor preview and the avatar surfaces each
 * grew their own copy of "talk to a sim iframe": their own message listener, their own readiness
 * and paint flags, their own reveal policy, their own cleanup timers. Three consecutive audits
 * each found a real defect that existed *only* because one copy implemented a rule the others did
 * not — a frame revealed before its acknowledgement, a teardown that ran during the fade, a
 * document that came back permanently muted, a listener that answered another surface's iframe.
 * Consolidating the rules is the fix; the rules themselves are unchanged.
 *
 * TWO PROTOCOLS, ONE CLIENT
 * This client speaks BOTH the shipped v2 wire protocol and the activation-scoped v3 protocol
 * (shared/src/sim/runtimeProtocol.ts). They never mix: v2 rides window.postMessage, v3 rides a
 * transferred MessagePort, and the v3 path is unreachable unless `enableModern` was given a
 * canary-proven `managed-presentable` class AND the child adopted a port. Everything below the
 * `activate()` fork is the v2 path, unchanged — which is what makes the upgrade provably additive
 * for every package already in storage.
 *
 * THREADING MODEL
 * Framework-free and synchronous. One client instance owns ONE iframe document. It never touches
 * the DOM beyond the element handed to it, and it reports state changes through a subscription so
 * React components can stay thin (see SimSurface.tsx / useSimRuntime.ts).
 *
 * THE TWO RULES THAT CARRY THE GUARANTEES
 *  1. `painted` is per-DOCUMENT, not per-section. After the first section of a package has
 *     painted, a later switch may be revealed over the PREVIOUS section's frozen frame. So a
 *     document that has proven it acknowledges (`ackCapable`) must hold the reveal until the
 *     matching SCRIPT_APPLIED. A document that has never acknowledged must NEVER be made to wait
 *     on silence — it reveals immediately, exactly as before.
 *  2. A teardown (`stopScript`) restores whatever the section hid. It therefore runs only AFTER
 *     the fade has completed, and any activation cancels a pending one.
 */
import {
  asInbound,
  AUTO_PAUSED,
  AUTO_POLICY,
  CLEAR_BOOT_HIDE,
  GUIDANCE_GATE,
  PAUSE_SCRIPT,
  POLICY_RESULT,
  UI_POLICY,
  PING_SIM_PAINTED,
  PING_SIM_READY,
  SCRIPT_APPLIED,
  SCRIPT_ERROR,
  SCRIPT_MISSING,
  SIM_APPLY_STALL_MS,
  SIM_EXIT_STOP_MS,
  SIM_MUTE,
  SIM_PAINTED,
  SIM_PAUSE,
  SIM_READY,
  SIM_RELAYOUT,
  SIM_RESUME,
  SIM_UNMUTE,
  START_SCRIPT,
  STOP_SCRIPT,
  USER_INTERACTION,
  SIM_LEGACY_REVEAL_MS,
  type SimInboundMessage,
  type SimStartParams,
} from './protocol';
import { applyGateFor, capabilityOf, type ApplyGateDecision } from '../simApplyGate';
import { SimTransport } from './SimTransport';
import {
  computeDurations, summarize, deriveLeadMs,
  type TransitionMarks, type TransitionStage, type TransitionSummary,
} from 'shared/src/sim/transitionTiming';
import {
  ACTIVATE_SECTION,
  DISPOSE_DOCUMENT,
  DISPOSED,
  DOCUMENT_ERROR,
  DOCUMENT_READY,
  DOCUMENT_RESUMED,
  DOCUMENT_SUSPENDED,
  DOMAIN_EVENT,
  CONTEXT_LOST,
  CONTEXT_RESTORED,
  INIT_DOCUMENT,
  PAUSE_AUTOMATION,
  POLICY_APPLIED,
  POLICY_REFUSED,
  PREPARE_SECTION,
  PRESENT_SECTION,
  RELEASE_SECTION,
  RESUME_AUTOMATION,
  RESUME_DOCUMENT,
  SECTION_APPLIED,
  SECTION_ERROR,
  SECTION_PRESENTED,
  SET_AUDIBLE,
  SET_AUTOMATION_POLICY,
  SET_QUALITY,
  SET_UI_POLICY,
  SUSPEND_DOCUMENT,
  type AnySimEnvelope,
  type DisposedPayload,
  type DocumentReadyPayload,
  type PolicyAppliedPayload,
  type PolicyRefusedPayload,
  type SectionPresentedPayload,
  type SimResourceCounts,
} from 'shared/src/sim/runtimeProtocol';
import {
  mergePolicy,
  normalizeHideSelectors,
  paramsForPolicy,
  sameAutomationPolicy,
  sameUiPolicy,
  sectionPolicyOf,
  withSectionPolicy,
  type SimPolicyKind,
  type SimPolicyOutcome,
  type SimSectionPolicy,
} from 'shared/src/sim/simPolicy';
import {
  DEFAULT_PRESENTATION_CONFIG,
  computeConfigHash,
  newActivationId,
  newDocumentId,
  type PresentationIdentity,
  type SimPresentationConfig,
  type SimQualityProfile,
} from 'shared/src/sim/simIdentity';
import {
  acceptsCommands,
  documentReducer,
  initialDocumentState,
  type DocumentMachineState,
} from 'shared/src/sim/documentMachine';
import {
  activationReducer,
  initialActivationState,
  mayReveal,
  type ActivationMachineState,
} from 'shared/src/sim/activationMachine';
import {
  SIM_HANDSHAKE_TIMEOUT_MS,
  SIM_CONTEXT_RESTORE_TIMEOUT_MS,
  SIM_DISPOSE_TIMEOUT_MS,
  SIM_EVICT_GRACE_MS,
  SIM_PREPARE_TIMEOUT_MS,
  SIM_PRESENT_TIMEOUT_MS,
  allowsAggressivePreparation,
  initialBreaker,
  makeFailure,
  recordFailure,
  recordSuccess,
  type CircuitBreakerState,
  type FailureContext,
  type SimFailureState,
  type SimPackageClass,
} from 'shared/src/sim/simFailurePolicy';

/** Explicit lifecycle phases — replaces the scattered booleans each surface used to keep. */
export type SimPhase =
  | 'unmounted'      // no iframe element registered
  | 'mounting'       // element registered, document has not handshaken
  | 'ready'          // SIM_READY received; nothing drawn yet
  | 'painted'        // a real frame has been drawn (safe to consider revealing)
  | 'applying'       // startScript sent, not yet acknowledged / not gated
  | 'awaiting-ack'   // proven-modern switch: holding the reveal until SCRIPT_APPLIED
  | 'visible'        // presented to the user
  | 'fading-out'     // exit fade running; teardown deferred until it completes
  | 'hidden'         // not presented; document retained (paused + muted)
  | 'suspended'      // deliberately frozen in the background
  | 'failed'         // the document reported an unrecoverable script error
  | 'disposed';      // client torn down; all timers cleared, listener removed

export interface SimRuntimeState {
  phase: SimPhase;
  /** The document identity this client is bound to (the resolved iframe src). */
  documentKey: string | null;
  /** v2 dynamic dispatch capability; null until SIM_READY classifies the document. */
  dynamic: boolean | null;
  /**
   * Policy families the LOADED document can apply without a restart (audit P1.2). `null` until the
   * document classifies itself; an empty array is the honest answer for every package published
   * before the handlers existed, and it means "restart me instead".
   */
  policies: SimPolicyKind[] | null;
  /** True once this document has emitted at least one SCRIPT_APPLIED. */
  ackCapable: boolean | null;
  ready: boolean;
  painted: boolean;
  /** The script the document last applied or was last sent. */
  currentScript: string | null;
  /** A script sent but not yet acknowledged. */
  pendingScript: string | null;
  activationToken: number;
  /** A deferred stopScript tore the last section down: frozen frame + restored full UI. */
  stopped: boolean;
  /**
   * The apply hold reached its deadline WITHOUT an acknowledgement, so the owner must put a cover
   * (the poster, or the honest wait affordance over the held outgoing content) in front of the
   * user (audit §21 rule 7: a deadline selects a cover, never a reveal).
   *
   * Deliberately separate from `visible`. This is not "hidden" — the hold already hid it — it is
   * "hidden for longer than a viewer will accept in silence", which is the owner's cue to explain
   * itself. Cleared by the acknowledgement, by the next activation, and by any hide.
   */
  covered: boolean;
  visible: boolean;
  muted: boolean;
  interactive: boolean;
  lastError: string | null;
}

export interface SimRuntimeCallbacks {
  /** Any state field changed. */
  onState?: (s: SimRuntimeState) => void;
  /** The user touched a control inside the simulation. */
  onUserInteraction?: () => void;
  /** Structured breadcrumb — wired to the existing simTelemetry by the React layer. */
  onTelemetry?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ActivateOptions {
  script: string;
  params?: SimStartParams;
  /** Reveal policy override. 'auto' (default) applies the two rules above. */
  reveal?: 'auto' | 'never';
  /**
   * v2 only. This activation dispatches a key the caller KNOWS no body exists for — a raw package
   * presentation ("show the full simulation"). SCRIPT_MISSING is then the expected outcome and the
   * document must present AS LOADED, not be hidden: the hide exists to stop a wrong-section frame,
   * and for a raw activation the as-loaded document IS the right frame. The caller is responsible
   * for the document actually being pristine (the pool reloads a scripted document first).
   */
  presentAsLoaded?: boolean;
  /**
   * v3 only. The presentation configuration whose hash becomes part of this activation's identity.
   * Omitted on the v2 path, where it has nowhere to go — the legacy bridge has no field for it.
   */
  config?: SimPresentationConfig;
}

/**
 * What the owner must tell the client before it may use the activation-scoped protocol.
 *
 * `packageClass` is the CANARY's verdict, not a guess made here. The client refuses to offer a
 * bootstrap for anything below `managed-presentable`, so a package that can speak v3 but has never
 * been proven still runs on v2. That is the whole point of the canary: capability is what a
 * package CAN do, classification is what it has been OBSERVED doing, and only the second one is
 * allowed to change how the player behaves.
 */
export interface ModernSetup {
  playerSessionId: string;
  packageRevision: string;
  packageClass: SimPackageClass;
  /** Presentation configuration defaults for this document. */
  quality?: SimQualityProfile;
}

/**
 * How far an eviction has got, and therefore what is still reversible.
 *
 *   'none'      — not being evicted.
 *   'grace'     — marked, muted, frozen, section released. DISPOSE_DOCUMENT has NOT been sent, so
 *                 the document is intact and `cancelEviction()` restores it.
 *   'disposing' — DISPOSE_DOCUMENT is out. The child is releasing its scope and will close its
 *                 port; there is nothing left to come back to, so a re-entry must build a NEW
 *                 generation rather than resurrect this one.
 *   'evicted'   — the child confirmed, or the deadline passed. The owner may remove the element.
 */
export type SimEvictionPhase = 'none' | 'grace' | 'disposing' | 'evicted';

/** What phase one of an eviction proved, for the record. */
export interface SimEvictionOutcome {
  /**
   * 'clean'      — the child answered DISPOSED, and `counts` is its own report of what is left.
   * 'forced'     — the deadline passed with no answer; the element is removed anyway, unproven.
   * 'cancelled'  — a re-entry reclaimed the document inside the grace window.
   * 'no-document'— nothing was ever handshaken (a legacy or never-mounted frame): there is no ack
   *                to wait for, so eviction is immediate and honestly reported as unproven rather
   *                than as clean.
   */
  outcome: 'clean' | 'forced' | 'cancelled' | 'no-document';
  /** The child's own resource counters at dispose. Null unless it answered. */
  counts: SimResourceCounts | null;
  /** Resources the child could not release. A non-empty list is a leak, and it is reported. */
  leaked: string[];
  /** How long the parent actually waited for the acknowledgement. */
  waitedMs: number;
}

/** Everything the v3 path exposes that the v2 path has no equivalent for. */
export interface SimModernState {
  active: boolean;
  documentState: DocumentMachineState['state'];
  activationState: ActivationMachineState['state'] | 'none';
  contextLost: boolean;
  failure: SimFailureState | null;
  breakerOpen: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

const initialState = (): SimRuntimeState => ({
  phase: 'unmounted',
  documentKey: null,
  dynamic: null,
  policies: null,
  ackCapable: null,
  ready: false,
  painted: false,
  currentScript: null,
  pendingScript: null,
  activationToken: 0,
  stopped: false,
  covered: false,
  visible: false,
  muted: false,
  interactive: false,
  lastError: null,
});

export class SimRuntimeClient {
  private state: SimRuntimeState = initialState();
  private frame: HTMLIFrameElement | null = null;
  private cbs: SimRuntimeCallbacks;

  /** Bumped by every mount/navigation. Events carrying an older generation are ignored. */
  private generation = 0;
  /** Monotonic; echoed by the bridge so a superseded activation's ack can never satisfy a live one. */
  private tokenSeq = 0;

  /**
   * True while a gated switch is holding the presentation. This is deliberately separate from
   * `pendingScript` (which exists only to match acknowledgements): a NON-gated activation also
   * has a pending script, and blocking its reveal on that would make every legacy package —
   * which never acknowledges — permanently undisplayable.
   */
  private holding = false;

  /**
   * The PACKAGE's publication-time acknowledgement capability, told to this client by its owner
   * (PlayerConfig `bridge_ack_capable`, migration 055). Null until told, and null means UNKNOWN —
   * never "no". Kept off `SimRuntimeState` because nothing renders from it and a package fact does
   * not change when a document does; it survives navigations for exactly that reason.
   */
  private packageAckCapable: boolean | null = null;

  // ── Two-phase eviction ────────────────────────────────────────────────────────────────────
  // The protocol has always had the handshake and BOTH ends did their half except this one: the
  // child sets DISPOSING and posts DISPOSED with resource counts, `documentMachine` models
  // `DISPOSING: { DISPOSED: 'EVICTED' }` — and the parent sent DISPOSE_DOCUMENT and closed the
  // MessagePort in the same statement, so the acknowledgement it had asked for could not be
  // delivered and no handler existed to receive it. Every eviction was therefore FORCED, and
  // nothing recorded that, so a package leaking WebGL contexts on teardown looked identical to one
  // that shut down cleanly.
  private evictPhase: SimEvictionPhase = 'none';
  private evictGraceTimer: Timer | null = null;
  private evictDeadlineTimer: Timer | null = null;
  private evictStartedAt = 0;
  /** Resolves phase one. Held so DISPOSED, the deadline and a cancel all settle the SAME promise. */
  private evictSettle: ((o: SimEvictionOutcome) => void) | null = null;
  private evictPromise: Promise<SimEvictionOutcome> | null = null;
  /**
   * THE SUSPEND DEBT: this client has sent a SUSPEND_DOCUMENT that it has not yet sent the
   * matching RESUME_DOCUMENT for.
   *
   * WHY A FLAG AND NOT `docMachine.state === 'SUSPENDED'`.
   * The machine cannot answer this question, ON PURPOSE: `SUSPEND` maps DOCUMENT_READY to
   * DOCUMENT_READY because the state only advances on the CHILD's confirmation. So for the whole
   * round trip the machine still reads DOCUMENT_READY, and any resume gated on `SUSPENDED` sends
   * NOTHING. The confirmation then lands on a document nobody resumed, `acceptsCommands` goes false
   * for good, `modernActive()` with it, and the next activation dies in
   * `failModern('handshake-failed')` after holding the section hidden for the whole timeout.
   *
   * That hazard was found and fixed once, for `evict()`/`cancelEviction()` only, with a field that
   * recorded what THAT pair had sent. The other two pairs — `suspend()`/`resume()` and
   * `freeze()`/`thaw()` — still asked the machine, and `freeze()`/`thaw()` is the pair the resident
   * pool uses on every warm, every background frame and every coordinated exit. So the record is
   * now kept HERE, once, for every pair: `sendSuspendDocument` is the only place it is taken on and
   * `sendResumeDocument` the only place it is discharged, which is what stops a fourth pair from
   * reintroducing the same hole by asking the machine a question it is designed not to answer.
   *
   * Per-DOCUMENT, so `bumpGeneration` clears it: a new epoch has been sent nothing and owes nothing.
   */
  private suspendSent = false;
  /**
   * Was the outstanding suspend sent by an EVICTION? Only used to label the resume in telemetry, so
   * a cancelled eviction is still distinguishable from an ordinary thaw in the breadcrumb trail.
   */
  private evictSuspended = false;

  private applyStallTimer: Timer | null = null;
  private deferredStopTimer: Timer | null = null;
  private legacyRevealTimer: Timer | null = null;
  private paintPollTimer: ReturnType<typeof setInterval> | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;
  private disposed = false;

  // ── v3, activation-scoped path ────────────────────────────────────────────────────────────
  // Every field below is inert until `enableModern` is called with a canary-proven class AND the
  // child completes the handshake. Until then the v2 path above runs exactly as it always has —
  // which is what makes this addition provably safe for every stored package.
  private transport: SimTransport | null = null;
  private modernSetup: ModernSetup | null = null;
  private docMachine: DocumentMachineState = initialDocumentState();
  private actMachine: ActivationMachineState | null = null;
  private currentDocumentId: string | null = null;
  private breaker: CircuitBreakerState = initialBreaker();
  private failure: SimFailureState | null = null;
  private prepareTimer: Timer | null = null;
  private presentTimer: Timer | null = null;
  private contextTimer: Timer | null = null;
  private failureCtx: FailureContext = { hasPoster: false, hasVideo: true, canSkip: true };
  private attempt = 0;
  /**
   * The activation the owner most recently asked for, retained ONLY so the handshake completing
   * later can re-drive it (see DOCUMENT_READY). Cleared on deactivate/dispose so a stale intent can
   * never be resurrected onto a document the player has moved on from.
   */
  private pendingActivate: ActivateOptions | null = null;
  /**
   * True while an activation is parked waiting for the handshake to settle.
   *
   * Separate from `holding` on purpose. The bound below used to read `holding`, which made that
   * assignment load-bearing for a reason its own comment did not give (it claimed redundancy) and
   * left `holding` set for the life of the client once the deferral resolved modern — after which a
   * later transport downgrade could wedge the v2 path permanently. One flag, one meaning.
   */
  private handshakeDeferred = false;

  constructor(cbs: SimRuntimeCallbacks = {}) {
    this.cbs = cbs;
  }

  getState(): Readonly<SimRuntimeState> { return this.state; }

  private set(patch: Partial<SimRuntimeState>): void {
    if (this.disposed && patch.phase !== 'disposed') return;
    this.state = { ...this.state, ...patch };
    this.cbs.onState?.(this.state);
  }

  // ── Transition measurement (Priority 8.1) ────────────────────────────────────────────────────
  //
  // Nothing in this pipeline has ever measured a transition, and the child's own numbers — applyMs,
  // framesSubmitted, canvas — were computed, put on the wire and dropped here. Every stage below is
  // recorded but NOTHING reads a duration to make a decision: this is measurement only, so it
  // cannot change what the viewer sees. What reads it is the lead-time derivation, later.
  /** v2: the pending activation expects SCRIPT_MISSING and must present the document as loaded. */
  private pendingPresentAsLoaded = false;

  // ── policy (audit P1.2) ─────────────────────────────────────────────────────────────────
  /**
   * The policy the LIVE activation is running with. Kept here rather than in `SimRuntimeState`
   * because it is not render state: nothing draws from it, and putting it in the state object
   * would make every policy no-op emit a React update.
   *
   * Updated OPTIMISTICALLY on send. A refusal arrives asynchronously and re-activates, which
   * rebuilds this from the activation's own params — so an optimistic value can never survive
   * being wrong, while a pessimistic one would make a fast double-toggle send two messages the
   * package then has to recognise as duplicates.
   */
  private livePolicy: SimSectionPolicy | null = null;
  /** The last activation this client drove, so a refused policy can reproduce it exactly. */
  private lastActivate: ActivateOptions | null = null;
  private tmarks: TransitionMarks = { marks: {} };
  private tHistory: TransitionMarks[] = [];
  /** Bounded, with the drop counted. A silent cap makes a truncated sample look like a complete one. */
  private tDropped = 0;
  private static readonly T_HISTORY_CAP = 50;

  /** The clock, in one place, so a non-browser host cannot crash the runtime by lacking one. */
  private now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /**
   * Record a stage. First write wins per activation: a retried PREPARE must not re-stamp the
   * original request time, or the total would silently exclude everything before the retry — which
   * is exactly the slow case worth seeing.
   */
  private mark(stage: TransitionStage): void {
    if (this.tmarks.marks[stage] === undefined) this.tmarks.marks[stage] = this.now();
  }

  /** Close the current transition and start a fresh one. */
  private rollTransition(): void {
    if (Object.keys(this.tmarks.marks).length > 0) {
      if (this.tHistory.length >= SimRuntimeClient.T_HISTORY_CAP) {
        this.tHistory.shift();
        this.tDropped += 1;
      }
      this.tHistory.push(this.tmarks);
    }
    this.tmarks = { marks: {} };
  }

  /** What has been measured so far. Read by tests and, later, by the lead-time derivation. */
  timingSummary(): TransitionSummary & { dropped: number } {
    return { ...summarize(this.tHistory), dropped: this.tDropped };
  }

  /**
   * The lead time preparation should use, derived from what THIS session measured.
   *
   * `fallbackMs` is the caller's prior — best sourced from the package's publish-time canary, which
   * already records per-step ms for these exact bytes, and which is a far better guess than any
   * constant compiled into the client.
   */
  leadMs(fallbackMs: number): { leadMs: number; source: 'measured' | 'fallback' } {
    return deriveLeadMs({ summary: summarize(this.tHistory), fallbackMs });
  }

  private tel(event: string, detail?: Record<string, unknown>): void {
    this.cbs.onTelemetry?.(event, { key: this.state.documentKey, ...detail });
  }

  private post(msg: object): void {
    try { this.frame?.contentWindow?.postMessage(msg, '*'); } catch { /* cross-origin teardown */ }
  }

  /**
   * Close an in-flight eviction that this document can no longer complete, as FORCED.
   *
   * Forced and not clean, always: nothing was proven about the child's teardown, and filing an
   * unprovable disposal as a clean one would make the single metric the handshake exists to
   * produce read as a pass for every frame that was simply abandoned.
   */
  private settleEvictionAsForced(cause: string): void {
    if (!this.isEvicting()) return;
    this.tel('evict-forced-settle', { cause, phase: this.evictPhase });
    this.settleEviction({
      outcome: 'forced', counts: null, leaked: [], waitedMs: this.elapsedSinceEvictStart(),
    });
  }

  /**
   * Advance the document generation — the ONE place it may happen.
   *
   * WHY THIS IS A METHOD AND NOT `this.generation++` AT THREE SITES.
   * Every timer this client arms captures the generation and early-returns once it has moved, which
   * is what makes a stale callback harmless. An EVICTION is the one wait where "harmless" is wrong:
   * its grace and deadline callbacks are the only things that can settle `evictPromise`, so a bump
   * that strands them leaves the owner awaiting a promise nothing can ever resolve. The iframe and
   * its WebGL context then stay mounted for the rest of the session, the pool's own `isEvicting`
   * guard spares that frame from every later residency pass, and the 'single' kill switch's
   * one-resident-document promise is broken on exactly the weak devices it exists for.
   *
   * `attach()` was safe only because it happens to call `clearAllTimers()` first (which settles).
   * `handleFrameLoad()` bumped the generation and did not — a native `load` landing inside the
   * grace window wedged the eviction permanently (audited, reproduced). Making the bump itself
   * settle removes the possibility rather than adding a third call site that must remember to.
   */
  private bumpGeneration(cause: string): void {
    this.settleEvictionAsForced(cause);
    // A NEW EPOCH OWES NOTHING. `suspendSent` records a SUSPEND_DOCUMENT sent to a specific
    // document; the one that replaces it has been sent nothing, and carrying the debt across would
    // make the next `thaw()` post a RESUME_DOCUMENT to a child that never suspended.
    this.suspendSent = false;
    this.evictSuspended = false;
    this.generation++;
  }

  // ── mounting ────────────────────────────────────────────────────────────────────────────

  /**
   * Bind to an iframe element. Passing a different documentKey (or null element) means a NEW
   * document: every per-document flag resets and in-flight timers are cancelled, so a late event
   * or timer from the previous document can never act on the new one.
   */
  attach(frame: HTMLIFrameElement | null, documentKey: string | null): void {
    if (this.disposed) return;
    const sameDoc = documentKey === this.state.documentKey;
    this.frame = frame;
    if (!frame || !documentKey) {
      this.clearAllTimers();
      this.bumpGeneration('detach');
      this.livePolicy = null;
      this.set({ ...initialState(), phase: 'unmounted' });
      return;
    }
    if (!sameDoc) {
      this.clearAllTimers();
      this.bumpGeneration('attach');
      this.livePolicy = null;   // a different document has its own policy support and its own state
      this.set({
        ...initialState(),
        phase: 'mounting',
        documentKey,
        // Visibility/mute are presentation state the owner re-asserts; they do not survive a
        // document change, and a fresh document starts unmuted and hidden.
      });
      this.ensureListener();
      // A different src is a different DOCUMENT EPOCH. The old epoch is tombstoned inside the
      // transport before the new offer goes out, so an envelope still in flight from it cannot be
      // accepted during the changeover — the failure mode `contentWindow` comparison could never
      // catch, because the element is the same element.
      //
      // The activation dies with the epoch. Leaving it would carry a PRESENTED proof earned on the
      // PREVIOUS document into the new one, where a later reveal could act on it.
      this.actMachine = null;
      this.clearPrepareTimer();
      this.clearPresentTimer();
      if (this.modernSetup) this.openTransport();
    } else {
      this.ensureListener();
      // Same document, but the ELEMENT may have arrived only now — the resident pool registers its
      // frame after the player has already armed the modern path. Without this the handshake would
      // simply never be offered for that document, and the package would silently run on v2 while
      // reporting itself as canary-proven.
      if (this.modernSetup && !this.transport) this.openTransport();
    }
  }

  /**
   * The iframe fired a native `load`. A freshly loaded document has drawn nothing and applied
   * nothing — every readiness flag must reset, or a stale latch lets a later poll early-exit and
   * reveal a blank document.
   */
  handleFrameLoad(): void {
    if (this.disposed) return;
    // AN EVICTION IN FLIGHT DIES WITH THE DOCUMENT IT WAS STARTED FOR. The browser has replaced
    // that document, so no DISPOSED can ever arrive for it — and the bump below would otherwise
    // strand both eviction callbacks on their generation check, leaving the owner's promise
    // unresolved and the frame permanently un-evictable. `bumpGeneration` settles it, forced.
    this.bumpGeneration('frame-load');
    this.cancelDeferredStop();
    this.cancelPendingApply();
    // A NEW DOCUMENT knows nothing about the old one's policy — and, since `policies` resets with
    // the rest of the readiness flags below, it has not yet said what it can do about a new one.
    this.livePolicy = null;
    this.set({
      phase: 'mounting',
      ready: false,
      painted: false,
      dynamic: null,
      policies: null,
      ackCapable: null,
      currentScript: null,
      pendingScript: null,
      stopped: false,
      lastError: null,
    });
    this.tel('frame-load');
    // The browser replaced the document under us. Mint a NEW epoch and re-handshake: the previous
    // documentId is tombstoned by the transport, so nothing the old document still sends can be
    // mistaken for the new one's answers.
    if (this.modernSetup) {
      this.clearPrepareTimer();
      this.clearPresentTimer();
      this.actMachine = null;
      if (this.currentDocumentId) this.transport?.tombstone(this.currentDocumentId);
      // No id here on purpose: openTransport mints the new epoch and MOUNTs it. Passing one now
      // would name an epoch no transport is bound to yet.
      this.docMachine = documentReducer(this.docMachine, { type: 'NAVIGATE' });
      this.openTransport();
    }
  }

  private ensureListener(): void {
    if (this.listener || typeof window === 'undefined') return;
    this.listener = (e: MessageEvent) => this.onMessage(e);
    window.addEventListener('message', this.listener);
  }

  // ── inbound protocol ────────────────────────────────────────────────────────────────────

  private onMessage(e: MessageEvent): void {
    if (this.disposed) return;
    // ONLY this client's own document may drive it. Several surfaces can host simulations at the
    // same time (the editor timeline player and the section-editor preview do so by design), and
    // a listener without this check answers the other surface's handshake as if it were its own.
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const msg = asInbound(e.data);
    if (!msg) return;

    switch (msg.type) {
      case SIM_READY:      return this.onReady(msg);
      case SIM_PAINTED:    return this.onPainted();
      case SCRIPT_APPLIED: return this.onApplied(msg.script ?? null, msg.token);
      case SCRIPT_MISSING: return this.onMissing(msg.script ?? null, msg.token);
      case SCRIPT_ERROR:   return this.onError(msg.message ?? 'script error', msg.token, msg.phase, msg.script ?? null);
      case AUTO_PAUSED:    this.tel('auto-paused'); return;
      case POLICY_RESULT:  return this.onPolicyResult(msg);
      case USER_INTERACTION: this.cbs.onUserInteraction?.(); return;
      default: return;
    }
  }

  private onReady(msg: SimInboundMessage): void {
    // `dynamic` is how the document tells us it can switch sections IN PLACE. The shipping v2
    // bridge advertises `dispatch: 'dynamic'`; anything else is a load-time-locked document that
    // needs a per-section URL. Classify ONLY from that field — an earlier version keyed off a
    // numeric `v` that no bridge has ever sent, which would have left every real document
    // classified `null` and, since the gate only holds for proven-dynamic documents, silently
    // disabled the apply gate in production while every test still passed.
    //
    // Never DOWNGRADE on a re-fire: PING_SIM_READY is answered with the same builder, but a
    // hand-rolled or partial re-post without `dispatch` must not demote a proven dynamic frame.
    const advertised = msg.dispatch === 'dynamic' ? true : msg.dispatch ? false : null;
    const dynamic = advertised ?? this.state.dynamic;
    // POLICY IS FEATURE-DETECTED, NOT ASSUMED. A package published before the handlers existed
    // sends no `policy` field at all, and the honest reading of that silence is `[]` — every
    // policy request for it falls back to a full re-activation, loudly. Same never-downgrade rule
    // as `dynamic`: a partial PING_SIM_READY re-fire must not un-prove a proven document.
    const advertisedPolicies = Array.isArray(msg.policy)
      ? msg.policy.filter((k): k is SimPolicyKind => k === 'ui' || k === 'automation')
      : null;
    const policies = advertisedPolicies ?? this.state.policies ?? [];
    this.set({ ready: true, dynamic, policies, phase: this.state.painted ? 'painted' : 'ready' });
    this.tel('sim-ready', { dynamic, dispatch: msg.dispatch ?? null, policies });
  }

  /**
   * A v2 policy outcome. The only branch that DOES anything is a refusal, and what it does is the
   * honest fallback: re-activate the section, and say so. A refusal that quietly changed nothing
   * would leave the user's toggle with no effect at all — strictly worse than the restart this
   * finding set out to avoid, because at least the restart worked.
   */
  private onPolicyResult(msg: SimInboundMessage): void {
    const kind = msg.kind ?? null;
    if (msg.token !== undefined && msg.token !== this.state.activationToken) {
      this.tel('policy-stale-result-ignored', { kind, token: msg.token ?? null });
      return;
    }
    if (msg.applied) {
      this.tel('policy-applied', {
        kind, changed: msg.changed ?? null, bodyHook: msg.bodyHook ?? null,
        stopped: msg.stopped ?? null, restarted: msg.restarted ?? null,
        unrestorable: msg.unrestorable ?? null,
      });
      return;
    }
    this.tel('policy-refused', { kind, reason: msg.reason ?? null, unrestorable: msg.unrestorable ?? null });
    // `requiresRestart: false` is how a package refuses WITHOUT asking to be torn down — today only
    // a stale policy does that, and restarting for it would evict the activation that superseded it.
    if (msg.requiresRestart === false) return;
    this.reactivateForPolicy(msg.reason ?? 'unsupported');
  }

  private onPainted(): void {
    this.stopPaintPoll();
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }
    this.set({ painted: true, phase: this.state.visible ? 'visible' : 'painted' });
    this.tel('sim-painted');
    // A paint can be the event that releases a reveal, but never one that is gated on an ack.
    this.maybeReveal();
  }

  private onApplied(script: string | null, token?: number): void {
    // The document proved it acknowledges. This is what makes the gate safe for legacy packages:
    // capability is LEARNED from the first activation, never assumed.
    this.set({ ackCapable: true });
    if (!this.matchesPending(script, token)) { this.tel('stale-ack-ignored', { script, token }); return; }
    this.clearApplyStall();
    this.holding = false;
    // `covered: false` — the acknowledgement is exactly the evidence the cover was standing in
    // for, so it retires with it. Left set, it would keep the poster over a section the bridge has
    // now vouched for.
    this.set({ currentScript: script, pendingScript: null, stopped: false, covered: false });
    this.tel('script-applied', { script });
    this.maybeReveal();
  }

  private onMissing(script: string | null, token?: number): void {
    if (!this.matchesPending(script, token)) return;
    this.clearApplyStall();
    this.holding = false;
    if (this.pendingPresentAsLoaded) {
      // The caller DISPATCHED a no-body key on purpose: a raw package presentation. Missing is the
      // expected outcome, and the as-loaded document is the right frame — hiding it here is what
      // made the full-simulation finale vanish. The pool guarantees the document is pristine (a
      // scripted document is reloaded before a raw activation reaches it), so presenting cannot
      // show another section's leftovers.
      this.set({ currentScript: null, pendingScript: null, stopped: false, covered: false });
      // A DISTINCT EVENT NAME, because this outcome is a SUCCESS. Reporting it as `script-missing`
      // with a discriminator in `detail` meant the parent's FAILURE handler ran on every raw
      // presentation: it cleared `simColdCover`/`simBootStalled` — tearing down the poster and the
      // spinner at the instant the bridge answered, while `maybeReveal()` below still cannot reveal
      // a document that has not painted — and it wrote a RUM `kind: 'failure'` row, poisoning the
      // field signal used to judge whether a package is healthy. No consumer ever read the
      // discriminator. From here the reveal path governs the affordance, as it does everywhere else.
      this.tel('presented-as-loaded', { script });
      this.maybeReveal();
      return;
    }
    // The bridge deliberately ran NOTHING and the caller expected a body. Presenting the document
    // would show whatever was on it before — degrade to the underlying content instead of a wrong
    // or parked frame.
    this.set({ pendingScript: null, covered: false, lastError: `missing section: ${script}` });
    this.tel('script-missing', { script });
    this.hideAndSilence();
  }

  private onError(message: string, token?: number, phase?: string, script?: string | null): void {
    // The bridge's stopScript emits a SCRIPT_ERROR with NO token and NO script when the OUTGOING
    // section's cleanup throws — and startScript runs stopScript first, so it fires in the middle
    // of every switch away from a section whose cleanup throws. It describes the section being
    // torn down, never the one being applied, so it must not touch the live activation: doing so
    // dropped the pending apply, after which the real SCRIPT_APPLIED was rejected as stale and the
    // incoming section ran correctly but was never shown. WebKit's timing made this reproducible;
    // the other engines hid it. Matching on `null` script was not enough — a null script skips the
    // script comparison, so the unscoped error still matched. Identify it explicitly.
    const unscoped = token === undefined && !script;
    if (unscoped || phase === 'cleanup') {
      this.tel('cleanup-error-ignored', { message, phase: phase ?? null });
      return;
    }
    if (!this.matchesPending(script ?? null, token)) { this.tel('stale-error-ignored', { message }); return; }
    this.clearApplyStall();
    this.holding = false;
    this.set({ phase: 'failed', pendingScript: null, covered: false, lastError: message });
    this.tel('script-error', { message });
    this.hideAndSilence();
  }

  /** An ack satisfies the live activation only if BOTH the script and the token match. */
  private matchesPending(script: string | null, token?: number): boolean {
    if (this.state.pendingScript === null) return false;
    if (script !== null && script !== this.state.pendingScript) return false;
    // A tokenless ack comes from a pre-v2.1 bridge that cannot echo tokens; accept it on script
    // alone (it has no way to be stale, because such bridges are never gated).
    if (token !== undefined && token !== this.state.activationToken) return false;
    return true;
  }

  // ── activation ──────────────────────────────────────────────────────────────────────────

  /**
   * Present a section on this document. Sends the full activation sequence and then decides —
   * per the two rules — whether it may be revealed now or must wait for the acknowledgement.
   */
  activate(opts: ActivateOptions): void {
    if (this.disposed || !this.frame) return;
    // A DISPOSING DOCUMENT IS NOT A RESIDENT ONE. Past DISPOSE_DOCUMENT the child has released its
    // managed scope — timers, listeners, GL objects — and is closing its port, so activating it
    // would install a section into a runtime that has thrown away everything the section needs and
    // can no longer answer for it. The owner's correct move is a fresh generation (navigate the
    // frame, mint a new document epoch), and refusing loudly here is what tells it so.
    if (this.evictPhase === 'disposing' || this.evictPhase === 'evicted') {
      this.tel('activate-refused-disposing', { script: opts.script, phase: this.evictPhase });
      return;
    }

    // A SUSPENDED DOCUMENT CANNOT RUN THE SECTION IT IS BEING HANDED.
    //
    // The v2 path below posts `SIM_RESUME` for exactly this reason, and `activateModern` has no
    // equivalent — nor could `SIM_RESUME` serve, because it does not undo the v3 child's
    // `scope.pause()` (only RESUME_DOCUMENT does). So every owner that froze a document had to
    // remember to thaw it before re-activating, and the viewer's re-entry path did not: the pool
    // freezes the outgoing frame on a coordinated exit and on every background pass, and
    // `updateSimOverlay`'s warm-frame branch calls `activate()` with no resume at all. Once the
    // child's DOCUMENT_SUSPENDED landed, `modernActive()` was false, the activation fell into the
    // handshake-window deferral, and the section played as bare video behind a hidden frame until
    // `failModern('handshake-failed')` — on every re-entry, until the breaker opened.
    //
    // Paying the debt HERE makes that unforgettable: an activation is a statement that this
    // document must run, so it is the right place to own the resume. It is sent BEFORE
    // `activateModern` so the child sees SUSPEND → RESUME → PREPARE_SECTION in order, and if the
    // suspend is already confirmed the deferral below holds the section for the one round trip it
    // takes DOCUMENT_RESUMED to re-drive `pendingActivate`.
    this.sendResumeDocument('activate');

    // The policy baseline for everything that follows (audit P1.2). Recorded here, before any
    // branch, because EVERY path below installs a section — including the modern one and the
    // background warm — and a `setPolicy` call that could not name the live policy would have to
    // guess whether a change is a change.
    this.lastActivate = opts;
    this.livePolicy = opts.config
      ? sectionPolicyOf(opts.config)
      : {
        simpleUi: !!opts.params?.simpleUi,
        // `?? null` and not `?? []`: an omitted hide set means "the body decides", which is a
        // different instruction from an empty one. See simPolicy.ts.
        hideSelectors: opts.params?.hideSelectors ?? null,
        autoScript: opts.params?.autoScript !== false,
      };

    // Remembered BEFORE the branch: the handshake is asynchronous and this call is not, so
    // DOCUMENT_READY (or the fallback to legacy) needs to know what to drive when it settles. A
    // background warm (`reveal: 'never'`) is deliberately not remembered — it is not a request to
    // present anything.
    if (opts.reveal !== 'never' && this.modernSetup) this.pendingActivate = opts;

    // Modern path first — reachable only for a canary-proven package whose child has adopted a port
    // and reported DOCUMENT_READY.
    if (this.modernActive() && opts.reveal !== 'never') {
      this.activateModern(opts);
      return;
    }

    // HANDSHAKE STILL UNDECIDED: defer rather than run v2 now.
    //
    // A regenerated package carries BOTH listeners. Running the v2 `startScript` here and then the
    // v3 `PREPARE_SECTION` when the handshake lands would apply the same section body twice — once
    // outside the managed scope, where its timers and listeners are untracked. Deferring is bounded
    // by SIM_BOOTSTRAP_TIMEOUT_MS: the transport settles on `legacy` and `onMode` drives exactly
    // this activation down the v2 path instead. For a warm resident frame the child has already
    // sent its hello, so the first offer is adopted in one in-process round trip and the deferral
    // is imperceptible.
    // The window is "armed but not yet ready", not merely "still offering". Between the child
    // adopting the port and DOCUMENT_READY arriving there are two more hops, and an activation
    // landing in that gap took the v2 path — after which `pendingActivate` re-drove the SAME
    // section as PREPARE_SECTION on readiness. That is the double-apply this deferral exists to
    // prevent: the body would run once outside the managed scope, where its timers and listeners
    // are untracked.
    if (
      opts.reveal !== 'never' &&
      this.modernSetup !== null &&
      !this.modernActive() &&
      this.transport !== null &&
      this.transport.getMode() !== 'legacy' &&
      this.transport.getMode() !== 'closed'
    ) {
      this.tel('modern-activate-deferred', { variantKey: opts.script });
      // HOLD, and hide, for the whole deferral.
      //
      // Returning without setting the hold left the v2 reveal path live: a SIM_PAINTED arriving
      // during the handshake window reached maybeReveal with `holding` false, and because the
      // transport had not settled yet `modernActive()` was still false, so reveal() took the LEGACY
      // branch and presented a document that had been sent no startScript and no PREPARE_SECTION —
      // a frame with nothing applied to it at all. The deferral is bounded by
      // SIM_BOOTSTRAP_TIMEOUT_MS, and both exits clear the hold: activateModern() installs its own,
      // and the legacy fallback re-enters activate(), whose cancelPendingApply() releases it.
      // Blocks the v2 paint path for the duration of the deferral. A regenerated package carries
      // BOTH listeners, so a SIM_PAINTED arriving here would otherwise reach `maybeReveal` — and
      // while the reveal gate above independently refuses an armed-but-not-active reveal today,
      // relying on that would leave this branch correct only by coincidence. `handshakeDeferred`
      // (not this flag) is what arms the bound below; the two were previously the same field, which
      // made this assignment load-bearing for a reason its comment did not state.
      this.holding = true;
      this.set({
        phase: 'awaiting-ack',
        pendingScript: opts.script,
        lastError: null,
        visible: false,
        interactive: false,
      });
      // BOUND IT. While the transport is still `offering` its own deadline settles the matter, but
      // once it has adopted a port there is no timer anywhere: a child that takes the port and then
      // goes silent before DOCUMENT_READY would hold the section hidden for the whole session with
      // no failure raised and nothing to recover from. Every wait in this protocol has a bound that
      // leads somewhere; this one leads to the same bounded failure a prepare timeout does.
      this.handshakeDeferred = true;
      const gen = this.generation;
      this.clearPrepareTimer();
      this.prepareTimer = setTimeout(() => {
        this.prepareTimer = null;
        if (this.generation !== gen || this.disposed) return;
        if (this.modernActive() || !this.handshakeDeferred) return;   // readiness landed
        this.failModern('handshake-failed', 'the document adopted a port but never became ready');
      }, SIM_HANDSHAKE_TIMEOUT_MS + SIM_PREPARE_TIMEOUT_MS);
      return;
    }

    const { script, params } = opts;
    const presentAsLoaded = opts.presentAsLoaded === true;

    // Any activation supersedes a pending teardown: the bridge's own startScript runs stopScript
    // first, and a late deferred stop would tear down the LIVE section instead.
    this.cancelDeferredStop();
    this.cancelPendingApply();
    // The paint-recovery ceiling force-reveals, and force bypasses the hold. Left armed across an
    // activation it would present the OLD section mid-switch — the exact frame the gate exists to
    // prevent. The owner re-arms it after this activation if the document still needs it.
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }

    const token = ++this.tokenSeq;
    const priorScript = this.state.currentScript;
    const wasStopped = this.state.stopped;

    // MEASURE THE v2 PATH TOO.
    //
    // The marks were originally only on the v3 modern path, which no stored package uses yet — so
    // in the field the measurement layer produced nothing at all, and a perf run reported zero
    // transitions while the viewer was plainly performing them. v2 has no PREPARE/PRESENT split, so
    // `requested` -> `revealed` is the whole observable span, which is exactly the number a viewer
    // experiences.
    this.rollTransition();
    this.mark('requested');
    this.mark('prepare-sent');

    this.pendingPresentAsLoaded = presentAsLoaded;
    this.set({ activationToken: token, pendingScript: script, phase: 'applying', lastError: null });

    this.post({ type: SIM_RESUME });
    this.post({ type: START_SCRIPT, script, params: params ?? {}, token });
    this.post({ type: CLEAR_BOOT_HIDE });   // startScript's own hide set is definitive
    this.post({ type: SIM_RELAYOUT });
    this.post({ type: SIM_UNMUTE });
    this.set({ muted: false });

    // Record what the child was SENT, immediately — an abandoned switch must not leave
    // currentScript pointing at a section the document was already told to stop running.
    this.set({ currentScript: script, stopped: false });

    if (opts.reveal === 'never') {
      // Background warm/preload: never leave it sounding. A hidden frame that keeps audio is the
      // defect VideoPlayer's exit mute exists for.
      this.post({ type: SIM_MUTE });
      this.set({ phase: 'hidden', muted: true, visible: false, interactive: false });
      return;
    }

    const decision = this.gateFor({ prior: priorScript, next: script, wasStopped });
    if (decision !== 'reveal-now') {
      // Hide FIRST. The outgoing section is still on the canvas (this is one document), so
      // leaving it presented while the new body applies is exactly the wrong-sub-simulation
      // frame the gate exists to prevent — holding a reveal is not enough when already visible.
      this.holding = true;
      // Emitted so the hold is OBSERVABLE. The gate's effect is invisible in rendered frames when
      // a body applies instantly, and a body that takes real time blocks the shared process — so
      // without this breadcrumb the single most important safety property has no viewer-level
      // signal at all (audited: a dead gate passed the whole e2e suite unchanged).
      //
      // `capability` and `firstActivation` name WHY the hold was taken. Before P0.5 a first
      // activation could not hold at all, so the field that would have shown the hole was the one
      // nobody could see.
      this.tel('apply-hold', {
        script,
        decision,
        capability: capabilityOf(this.gateMeta(priorScript, wasStopped)),
        firstActivation: priorScript === null,
      });
      this.set({ phase: 'awaiting-ack', visible: false, interactive: false, covered: false });
      const gen = this.generation;
      this.applyStallTimer = setTimeout(() => {
        this.applyStallTimer = null;
        if (this.generation !== gen || this.state.activationToken !== token) return;
        // AN UNKNOWN PACKAGE THAT WAS ASKED AND DID NOT ANSWER HAS ANSWERED (audit P0.5 follow-up).
        //
        // `await-ack-bounded` is the UNKNOWN case, and unknown is the state EVERY package already
        // in the database is in: migration 055 shipped the column nullable with no backfill, so a
        // `dispatch:'dynamic'` package published before SCRIPT_APPLIED existed reads unknown, holds
        // here, and — since a deadline never reveals — stayed covered for the whole of every
        // section, every entry. That is a regression this gate created, not a hazard it found.
        //
        // The release is EVIDENCE, not a timer authorising unproven pixels: this document was sent
        // a section and given the full bound to acknowledge it, and did not. That is the definition
        // of a silent bridge, so it is recorded as one — in-session, on the DOCUMENT, which resets
        // on every navigation — and the gate then treats it exactly as a package the record already
        // proved silent: reveal, as the product did before P0.5.
        //
        // It can never apply to a package KNOWN capable. Those take `await-ack`, whose deadline
        // still only covers, and `capabilityOf` answers 'capable' from the record even once
        // `ackCapable` is false — so a proven bridge that goes quiet keeps holding, forever if need
        // be, which is the property this whole gate exists for.
        if (decision === 'await-ack-bounded') { this.concludeAckSilent(script); return; }
        // NOT a force-reveal. See coverUnacknowledged: the hold survives its own deadline and the
        // owner is told to cover instead, because "the user has waited long enough" is not evidence
        // about which sub-simulation is on the canvas.
        this.coverUnacknowledged(script, decision, SIM_APPLY_STALL_MS);
      }, SIM_APPLY_STALL_MS);
    } else {
      this.holding = false;
      this.maybeReveal();
    }
  }

  // ── v3 activation-scoped protocol ───────────────────────────────────────────────────────
  // Everything from here to `gateFor` is the modern path. It never runs unless enableModern() was
  // given a canary-proven class AND the child answered the bootstrap.

  /**
   * Arm the modern path for this document. Safe to call on every render: it is a no-op unless the
   * setup actually changed, so a re-render cannot tear down a live transport mid-activation.
   */
  enableModern(setup: ModernSetup, opts?: { failureContext?: Partial<FailureContext> }): void {
    if (this.disposed) return;
    if (opts?.failureContext) this.failureCtx = { ...this.failureCtx, ...opts.failureContext };

    if (!allowsAggressivePreparation(setup.packageClass)) {
      // Not canary-proven. Say so once, and stay on v2 — this is the honest outcome, not a
      // degradation: an unproven package has not earned the guarantees the modern path assumes.
      if (this.modernSetup) this.teardownModern();
      this.modernSetup = null;
      this.tel('modern-declined', { packageClass: setup.packageClass });
      return;
    }
    const same =
      this.modernSetup?.playerSessionId === setup.playerSessionId &&
      this.modernSetup?.packageRevision === setup.packageRevision;
    this.modernSetup = setup;
    // A transport that settled on `legacy` for a package the canary certified is a FAILED
    // handshake, not a legacy package — this method already refused everything below
    // `managed-presentable`, so by construction this document does speak v3. Re-opening mints a new
    // document epoch, which is the only offer the child will adopt after it has taken one; without
    // this, a single missed handshake left the modern path dead for the rest of the session.
    const settledLegacy = this.transport?.getMode() === 'legacy';
    if (same && this.transport && !settledLegacy) return;
    if (settledLegacy) this.tel('modern-retry-handshake');
    this.openTransport();
  }

  /** True once the child has adopted a port AND reported DOCUMENT_READY. */
  modernActive(): boolean {
    return !!this.transport?.isModern() && acceptsCommands(this.docMachine);
  }

  getModernState(): SimModernState {
    return {
      active: this.modernActive(),
      documentState: this.docMachine.state,
      activationState: this.actMachine?.state ?? 'none',
      contextLost: this.docMachine.contextLost,
      failure: this.failure,
      breakerOpen: this.breaker.open,
    };
  }

  private openTransport(): void {
    const setup = this.modernSetup;
    const frame = this.frame;
    // The FRAME'S OWN src, never the stored documentKey.
    //
    // A stored sim URL carries whatever API origin minted it, and `resolveSimUrl` rebases it onto
    // this environment's origin before assigning it — so on any environment that is not the one the
    // row was saved under, the two disagree. The offer would then be addressed to an origin the
    // child is not at, the browser would silently discard it (port and all), and the deadline would
    // report `transport-legacy-no-answer` — indistinguishable from a package that does not speak
    // v3 at all. Reading the element is the only source that cannot drift from what was loaded.
    const src = frame?.src || this.state.documentKey;
    if (!setup || !frame || !src) return;
    if (this.breaker.open) { this.tel('modern-breaker-open'); return; }

    if (!this.transport) {
      this.transport = new SimTransport({
        onEnvelope: (env) => this.onEnvelope(env),
        onRejected: (reason, detail) => this.tel('modern-rejected', { reason, detail }),
        onTelemetry: (event, detail) => this.tel(event, detail),
        onMode: (mode) => {
          this.tel('transport-mode', { mode });
          // A transport that settles on `legacy` is not a failure — it means this document does not
          // speak v3, and the v2 path is already running underneath. Nothing to recover from.
          if (mode === 'legacy') {
            this.docMachine = initialDocumentState();
            // The deferral above ends here: this document does not speak v3, so the activation it
            // was holding runs on v2 exactly as it always would have. Without this, an activation
            // requested during the handshake window would simply never happen.
            const deferred = this.pendingActivate;
            this.pendingActivate = null;
            if (deferred) {
              this.tel('modern-activate-fallback-legacy', { variantKey: deferred.script });
              this.activate(deferred);
            }
          }
          // The port being live is NOT readiness. The child stays silent until it is initialised,
          // so without this the handshake would complete and DOCUMENT_READY would never arrive —
          // the document would look permanently un-ready while the transport reported success.
          if (mode === 'modern') this.sendInitDocument();
        },
      });
    }
    const documentId = newDocumentId();
    this.currentDocumentId = documentId;
    this.docMachine = documentReducer(initialDocumentState(), { type: 'MOUNT', documentId });
    this.transport.open({
      frame,
      src,
      playerSessionId: setup.playerSessionId,
      packageRevision: setup.packageRevision,
      documentId,
    });
  }

  private sendInitDocument(): void {
    const setup = this.modernSetup;
    if (!setup || !this.transport) return;
    this.transport.send(INIT_DOCUMENT, {}, {
      parentOrigin: typeof window !== 'undefined' ? window.location.origin : '',
      quality: setup.quality ?? 'high',
      // A document is BORN silent and hidden. The owner lifts both explicitly once it has decided
      // to present — a fresh document that arrives audible is the defect the exit-mute exists for.
      audible: { muted: true, volume: 0 },
    });
  }

  private onEnvelope(env: AnySimEnvelope): void {
    if (this.disposed) return;
    switch (env.type) {
      case DOCUMENT_READY: {
        const payload = env.payload as DocumentReadyPayload;
        this.docMachine = documentReducer(this.docMachine, { type: 'READY', capabilities: payload.capabilities });
        // POLICY SUPPORT, NEGOTIATED (audit P1.2). Deliberately NOT read from `capabilities`: that
        // record is the reveal-path contract the canary classifies, and a package that cannot
        // hot-swap chrome is not thereby unable to draw a correct frame. Absent ⇒ `[]` ⇒ every
        // policy change for this package falls back to a full re-activation, loudly.
        const policies = Array.isArray(payload.policies)
          ? payload.policies.filter((k): k is SimPolicyKind => k === 'ui' || k === 'automation')
          : [];
        this.set({ policies });
        this.tel('modern-document-ready', { variants: payload.variants?.length ?? 0, policies });
        // THE HANDSHAKE IS ASYNCHRONOUS AND THE ACTIVATION IS NOT.
        //
        // `enableModern()` and `activate()` are called in the same synchronous block by every
        // surface, and readiness is five message hops away — so the first activation of a package
        // ALWAYS took the v2 branch, `activateModern` never ran, and no PREPARE_SECTION was ever
        // sent. The document then reported ready, the player switched to the modern presentation,
        // and nothing could ever satisfy it: no acknowledgement was possible, and no timer existed
        // to fail. The section played its whole duration behind a cover with no recovery.
        //
        // Re-driving the pending activation here is what makes the modern path reachable at all.
        if (this.pendingActivate && this.modernActive()) {
          const opts = this.pendingActivate;
          this.tel('modern-activate-on-ready', { variantKey: opts.script });
          this.activateModern(opts);
        }
        return;
      }
      case DOCUMENT_SUSPENDED:
        this.docMachine = documentReducer(this.docMachine, { type: 'SUSPENDED' });
        return;
      case DISPOSED: {
        // THE ACKNOWLEDGEMENT THE PARENT NEVER LISTENED FOR. `grep DISPOSED` in this file used to
        // return nothing: the message was defined, sent by the child with real resource counts, and
        // modelled by the document machine, but the port was closed before it could arrive and no
        // case here would have handled it if it had.
        const payload = (env.payload ?? {}) as Partial<DisposedPayload>;
        const counts = (payload.counts ?? null) as SimResourceCounts | null;
        const leaked = Array.isArray(payload.leaked) ? payload.leaked.map(String) : [];
        this.docMachine = documentReducer(this.docMachine, { type: 'DISPOSED', ...(counts ? { counts } : {}) });
        this.settleEviction({
          outcome: 'clean', counts, leaked, waitedMs: this.elapsedSinceEvictStart(),
        });
        return;
      }
      case DOCUMENT_RESUMED:
        // WITHOUT THIS THE DOCUMENT NEVER COMES BACK. The child sends DOCUMENT_RESUMED, the
        // protocol accepts it, and the machine's only edge out of SUSPENDED is `RESUMED` — but
        // nothing dispatched it, so a document that confirmed one suspend stayed SUSPENDED for the
        // rest of the session. `modernActive()` then read false forever, which the reveal gate and
        // the handshake deferral both treat as "not ready yet": the section was held, hidden, with
        // no timer able to release it. The resident pool suspends frames routinely while warming
        // them, so this was reachable on an ordinary scrub-away-and-return.
        this.docMachine = documentReducer(this.docMachine, { type: 'RESUMED' });
        this.tel('modern-document-resumed');
        // A hold that was waiting on readiness can now proceed.
        if (this.pendingActivate && this.modernActive()) {
          const opts = this.pendingActivate;
          this.tel('modern-activate-on-resume', { variantKey: opts.script });
          this.activateModern(opts);
        }
        return;
      case CONTEXT_LOST:
        this.docMachine = documentReducer(this.docMachine, { type: 'CONTEXT_LOST' });
        if (this.actMachine) this.actMachine = activationReducer(this.actMachine, { type: 'CONTEXT_LOST' });
        // A lost context invalidates the presented frame. Hiding is not optional: the canvas the
        // user is looking at is now undefined content, and leaving it up is showing a wrong state.
        this.set({ visible: false, interactive: false });
        this.tel('modern-context-lost');
        // BOUND IT. The present timer has already been cleared by the acknowledgement, so a context
        // that is lost and never restored left the activation parked in RENDERING with no failure,
        // no recovery surface and no retry — the section simply ran to its end behind the cover.
        // SIM_CONTEXT_RESTORE_TIMEOUT_MS existed for exactly this and was referenced by nothing.
        if (this.contextTimer) clearTimeout(this.contextTimer);
        {
          const gen = this.generation;
          this.contextTimer = setTimeout(() => {
            this.contextTimer = null;
            if (this.generation !== gen || this.disposed) return;
            if (!this.docMachine.contextLost) return;   // restored in the meantime
            this.failModern('context-lost-unrecovered', 'the rendering context was lost and never restored');
          }, SIM_CONTEXT_RESTORE_TIMEOUT_MS);
        }
        return;
      case CONTEXT_RESTORED:
        this.docMachine = documentReducer(this.docMachine, { type: 'CONTEXT_RESTORED' });
        if (this.contextTimer) { clearTimeout(this.contextTimer); this.contextTimer = null; }
        this.tel('modern-context-restored');
        return;
      case SECTION_APPLIED:
        if (!this.matchesActivation(env)) { this.tel('modern-stale-applied'); return; }
        this.clearPrepareTimer();
        // THE REDUCER'S REFUSAL IS A DECISION, NOT A NO-OP.
        //
        // `matchesActivation` compares identity only — activationId/variantKey/configHash — never
        // state. APPLIED is legal exclusively from PREPARING, so a SECTION_APPLIED arriving once
        // the activation is FAILED (a prepare-timeout already fired), RELEASED (the viewer scrubbed
        // away mid-apply) or VISIBLE (the package re-acked) is refused — and `activationReducer`
        // signals that by returning the SAME state object with a rejection breadcrumb. Assigning it
        // back unchecked read as success and fell through to `sendPresent()`, which posted
        // PRESENT_SECTION for a section that is failed, released or already on screen and armed the
        // TERMINAL present bound behind it. That bound is guarded only by (generation,
        // activationId) — neither changed by a refusal — so it later fired
        // `failModern('present-timeout')`: a second breaker failure for one real fault, a fabricated
        // failure kind replacing the true one, and in the VISIBLE case a working simulation hidden
        // behind the recovery surface mid-section.
        {
          const applied = activationReducer(this.actMachine!, { type: 'APPLIED' });
          if (applied.state !== 'APPLIED') {
            this.tel('modern-applied-refused', { state: this.actMachine!.state });
            return;
          }
          this.actMachine = applied;
        }
        this.mark('applied');
        // The child measured its own body cost and has been sending it since the protocol shipped;
        // it was read off the wire and discarded here. Kept separate from our prepareMs, which
        // includes two postMessage hops the child's number does not.
        {
          const ap = (env.payload as { applyMs?: number } | undefined)?.applyMs;
          if (typeof ap === 'number') this.tmarks.applyMs = ap;
        }
        this.tel('modern-section-applied', { variantKey: env.variantKey, applyMs: this.tmarks.applyMs ?? null });
        this.sendPresent();
        this.mark('present-sent');
        return;
      case SECTION_PRESENTED: {
        if (!this.matchesActivation(env)) { this.tel('modern-stale-presented'); return; }
        const payload = env.payload as SectionPresentedPayload;
        // `undefined < 1` is FALSE, so the obvious form of this guard lets an acknowledgement with
        // no `framesSubmitted` at all fall straight through to the reveal — the precise case the
        // check exists for, since a conforming child always sends a count.
        if (!payload || !(payload.framesSubmitted >= 1)) {
          // An acknowledgement that admits it submitted no frame is not a presentation. Accepting
          // it would make SECTION_PRESENTED mean "the child got the message", which is the exact
          // conflation between readiness and presentation this protocol exists to end.
          this.tel('modern-presented-without-frame');
          return;
        }
        // The identity matched — but the MACHINE may still refuse, and the case that matters is a
        // released activation: after a deactivate its identity is unchanged, so a late
        // acknowledgement still matches while the activation is over. `mayReveal` would refuse it
        // anyway, but reporting success and resetting the breaker for a presentation that was
        // rejected makes the telemetry describe something that did not happen.
        // Carry the ACKNOWLEDGEMENT's identity into the machine. Recording the machine's own
        // identity instead made `mayReveal` compare an object with itself, so every *-mismatch
        // branch of the five-axis invariant was unreachable from production code — the check
        // existed, was unit-tested in isolation, and enforced nothing where it was actually called.
        const advanced = activationReducer(this.actMachine!, {
          type: 'PRESENTED',
          ackIdentity: {
            packageRevision: env.packageRevision,
            documentId: env.documentId,
            activationId: env.activationId!,
            variantKey: env.variantKey!,
            configHash: env.configHash!,
          },
        });
        if (advanced.state !== 'PRESENTED') {
          // CLEAR THE BOUND BEFORE RETURNING. This path returned one line above the clear, so a
          // refused acknowledgement left the terminal present timer armed on an activation that had
          // in fact rendered — and it later fired `failModern('present-timeout')` against it.
          this.clearPresentTimer();
          this.tel('modern-presented-refused', { state: this.actMachine!.state });
          return;
        }
        this.clearPresentTimer();
        this.actMachine = advanced;
        this.breaker = recordSuccess(this.breaker);
        this.failure = null;
        this.mark('presented');
        this.tmarks.framesSubmitted = payload.framesSubmitted;
        // `canvas` proves something real was sized and drawn. It was validated on arrival and then
        // dropped; it is the only signal that distinguishes a presented frame from a presented
        // nothing, which is what an adaptive-quality controller would need first.
        if (payload.canvas) this.tmarks.canvas = payload.canvas;
        this.tel('modern-section-presented', {
          variantKey: env.variantKey, frames: payload.framesSubmitted,
          canvas: payload.canvas ?? null,
        });
        this.reveal(false);
        return;
      }
      case POLICY_APPLIED: {
        // Activation-scoped, like every other acknowledgement here: a policy result for a
        // superseded activation describes a section that is no longer on screen.
        if (!this.matchesActivation(env)) { this.tel('policy-stale-result-ignored', { modern: true }); return; }
        const payload = env.payload as PolicyAppliedPayload;
        this.tel('policy-applied', {
          kind: payload?.kind ?? null, changed: payload?.changed ?? null,
          bodyHook: payload?.bodyHook ?? null, stopped: payload?.stopped ?? null,
          restarted: payload?.restarted ?? null, unrestorable: payload?.unrestorable ?? null,
          modern: true,
        });
        return;
      }
      case POLICY_REFUSED: {
        if (!this.matchesActivation(env)) { this.tel('policy-stale-result-ignored', { modern: true }); return; }
        const payload = env.payload as PolicyRefusedPayload;
        this.tel('policy-refused', { kind: payload?.kind ?? null, reason: payload?.reason ?? null, modern: true });
        // The honest fallback. It DOES reset the section, which is why it is never silent.
        this.reactivateForPolicy(payload?.reason ?? 'unsupported');
        return;
      }
      case SECTION_ERROR:
        if (!this.matchesActivation(env)) return;
        this.failModern('section-error', String((env.payload as { message?: string })?.message ?? 'section error'));
        return;
      case DOCUMENT_ERROR:
        this.failModern('document-error', String((env.payload as { message?: string })?.message ?? 'document error'));
        return;
      case DOMAIN_EVENT: {
        const payload = env.payload as { event?: string };
        // Activation-scoped: a domain event from a superseded activation is history, not news.
        if (!this.matchesActivation(env)) { this.tel('modern-stale-domain-event'); return; }
        if (payload?.event === 'userInteraction') this.cbs.onUserInteraction?.();
        this.tel('modern-domain-event', { event: payload?.event ?? null });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Identity check for an inbound activation-scoped envelope.
   *
   * The transport has already proven the envelope belongs to this session, this package revision
   * and this document epoch. What is left — and what a token could never express — is whether it
   * belongs to the activation that is live RIGHT NOW.
   */
  private matchesActivation(env: AnySimEnvelope): boolean {
    const act = this.actMachine;
    if (!act) return false;
    return (
      env.activationId === act.identity.activationId &&
      env.variantKey === act.identity.variantKey &&
      env.configHash === act.identity.configHash
    );
  }

  private activateModern(opts: ActivateOptions): void {
    const setup = this.modernSetup;
    const documentId = this.currentDocumentId;
    if (!setup || !documentId || !this.transport) return;

    this.clearPrepareTimer();
    this.clearPresentTimer();
    // A new activation ends the previous transition, whatever stage it reached. Rolling it here is
    // what makes an ABANDONED transition visible: without this the next `mark('requested')` would
    // be discarded by the first-write-wins rule and the two would silently merge into one bogus
    // measurement spanning both. Where transitions die is data — a package that always stops at
    // `applied` is failing differently from one that stops at `prepare-sent`.
    this.rollTransition();
    // The deferral, if any, ends here: the modern gate governs from now on. Leaving `holding` set
    // would outlive the deferral for the life of the client, so a later transport downgrade to
    // legacy would find `maybeReveal`, `present()` and the legacy ceiling all permanently refusing.
    this.handshakeDeferred = false;
    this.holding = false;
    // Release the outgoing activation before preparing the next. One document serves many
    // sections; leaving the previous one registered is how a resident pool grows without bound.
    if (this.actMachine && this.actMachine.state !== 'RELEASED') {
      this.transport.send(RELEASE_SECTION, this.actMachine.identity, {});
      this.actMachine = activationReducer(this.actMachine, { type: 'RELEASE' });
    }

    const config: SimPresentationConfig = opts.config ?? {
      ...DEFAULT_PRESENTATION_CONFIG,
      simpleUi: !!opts.params?.simpleUi,
      hideSelectors: opts.params?.hideSelectors ?? [],
      autoScript: opts.params?.autoScript !== false,
      quality: setup.quality ?? 'high',
    };
    const identity: PresentationIdentity = {
      packageRevision: setup.packageRevision,
      documentId,
      activationId: newActivationId(),
      variantKey: opts.script,
      configHash: computeConfigHash(config),
    };
    this.actMachine = initialActivationState(identity);
    this.attempt += 1;

    // HIDE FIRST. The outgoing section is still on the canvas, and this is one document — leaving
    // it presented while the incoming body installs is the wrong-sub-simulation frame itself.
    this.set({
      phase: 'awaiting-ack',
      visible: false,
      interactive: false,
      currentScript: opts.script,
      pendingScript: opts.script,
      stopped: false,
      lastError: null,
    });
    this.tel('modern-prepare', { variantKey: opts.script, activationId: identity.activationId });

    this.actMachine = activationReducer(this.actMachine, { type: 'PREPARE' });
    this.mark('requested');
    this.transport.send(PREPARE_SECTION, identity, { variantKey: identity.variantKey, config });
    this.mark('prepare-sent');

    const gen = this.generation;
    const actId = identity.activationId;
    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      if (this.generation !== gen || this.actMachine?.identity.activationId !== actId) return;
      this.failModern('prepare-timeout', 'the package did not acknowledge PREPARE_SECTION');
    }, SIM_PREPARE_TIMEOUT_MS);
  }

  private sendPresent(): void {
    const act = this.actMachine;
    if (!act || !this.transport) return;
    // CLEAR BEFORE ARMING, like every other timer path here. `SECTION_APPLIED` calls this
    // unconditionally after `matchesActivation`, and a duplicate SECTION_APPLIED with a higher
    // `seq` passes both `validateEnvelope` and `matchesActivation` — the reducer then refuses the
    // illegal transition by returning the SAME state object rather than throwing. The previous
    // timer handle was overwritten and became unclearable, while its guard (generation +
    // activationId) still passed, so it later fired `failModern('present-timeout')` against an
    // activation that had already presented: a working simulation hidden and replaced by the
    // recovery surface.
    this.clearPresentTimer();
    // REDUCE FIRST, THEN SEND AND ARM. PRESENT is legal only from APPLIED, so if the activation has
    // moved on this refuses — and posting PRESENT_SECTION for a failed, released or already-visible
    // section, then arming a terminal bound behind it, is exactly the wrong thing to do. The
    // SECTION_APPLIED caller already guards this; the check is repeated here so the invariant
    // belongs to the method that arms the bound rather than to its caller.
    const advanced = activationReducer(act, { type: 'PRESENT' });
    if (advanced.state !== 'RENDERING') {
      this.tel('modern-present-refused', { state: act.state });
      return;
    }
    this.transport.send(PRESENT_SECTION, act.identity, {});
    this.actMachine = advanced;

    const gen = this.generation;
    const actId = act.identity.activationId;
    this.presentTimer = setTimeout(() => {
      this.presentTimer = null;
      if (this.generation !== gen || this.actMachine?.identity.activationId !== actId) return;
      // NEVER a force-reveal. The package promised SECTION_PRESENTED by completing the handshake;
      // showing a frame it never vouched for would reintroduce the exact defect the whole protocol
      // exists to close, and "the user waited long enough" is not evidence about what is on screen.
      this.failModern('present-timeout', 'the package did not submit a render for this activation');
    }, SIM_PRESENT_TIMEOUT_MS);
  }

  private failModern(kind: Parameters<typeof recordFailure>[1], message: string): void {
    this.clearPrepareTimer();
    this.clearPresentTimer();
    // A failure ends the hold. Leaving it set would make the bounded failure unbounded in practice:
    // the recovery surface would be offered over a document nothing could ever reveal.
    this.holding = false;
    this.pendingActivate = null;
    if (this.actMachine) this.actMachine = activationReducer(this.actMachine, { type: 'FAIL', reason: message });
    this.breaker = recordFailure(this.breaker, kind);
    this.failure = makeFailure(kind, message, this.attempt, this.failureCtx, this.breaker);
    this.set({ visible: false, interactive: false, phase: 'failed', pendingScript: null, lastError: message });
    this.tel('modern-failure', { kind, message, attempt: this.attempt, breakerOpen: this.breaker.open });
    this.hideAndSilence();
  }

  /** Retry the current activation. Refused once the breaker is open — that is what a breaker is. */
  retryModern(): boolean {
    if (this.disposed || this.breaker.open || !this.modernActive()) return false;
    const act = this.actMachine;
    if (!act) return false;
    this.tel('modern-retry', { attempt: this.attempt + 1 });
    this.activateModern({ script: act.identity.variantKey });
    return true;
  }

  private clearPrepareTimer(): void {
    if (this.prepareTimer) { clearTimeout(this.prepareTimer); this.prepareTimer = null; }
  }

  private clearPresentTimer(): void {
    if (this.presentTimer) { clearTimeout(this.presentTimer); this.presentTimer = null; }
  }

  private clearContextTimer(): void {
    if (this.contextTimer) { clearTimeout(this.contextTimer); this.contextTimer = null; }
  }

  private teardownModern(): void {
    // RELEASE THE HOLD. The handshake-window deferral sets `holding` and returns, expecting one of
    // two exits to clear it: activateModern on DOCUMENT_READY, or the legacy fallback in onMode.
    // Tearing the modern path down takes neither — it drops `pendingActivate` on the floor — so a
    // deferral interrupted by a teardown left `holding` true with nothing able to clear it, and
    // `maybeReveal` returns early while it is set. The document would then never be shown again,
    // by any path. Reachable when enableModern is re-armed with a class below managed-presentable
    // (a canary verdict published between two activations) while a deferral is in flight.
    this.holding = false;
    this.handshakeDeferred = false;
    this.pendingActivate = null;
    this.clearPrepareTimer();
    this.clearPresentTimer();
    if (this.transport) {
      // NOT WHILE A TWO-PHASE EVICTION IS IN FLIGHT. That path has already sent RELEASE_SECTION,
      // may already have sent DISPOSE_DOCUMENT, and is holding the port open ON PURPOSE so the
      // child's DISPOSED can arrive. Re-sending here and closing underneath it would recreate the
      // exact defect the two-phase path exists to fix, from the other direction.
      const evicting = this.evictPhase === 'grace' || this.evictPhase === 'disposing';
      if (!evicting && this.currentDocumentId && this.docMachine.state !== 'EVICTED') {
        // Best effort: a document that is going away should be told, so it can release GPU memory
        // now rather than when the browser eventually collects the frame. This is the SYNCHRONOUS
        // teardown (a re-armed enableModern, a navigation, an unmount) — there is no owner left to
        // hand an acknowledgement to, so it is forced by construction.
        if (this.actMachine) this.transport.send(RELEASE_SECTION, this.actMachine.identity, {});
        this.transport.send(DISPOSE_DOCUMENT, {}, {});
      }
      this.transport.close();
      this.transport = null;
    }
    this.docMachine = initialDocumentState();
    this.actMachine = null;
    this.currentDocumentId = null;
  }

  /**
   * The presentation gate. Kept as a pure method so the policy can be unit-tested and so every
   * surface provably shares it.
   */
  private gateFor(a: { prior: string | null; next: string; wasStopped: boolean }): ApplyGateDecision {
    // Delegates to the SHIPPING, separately unit-tested policy. Reimplementing it here would have
    // recreated the duplication this whole module exists to remove — two copies of the one rule
    // that decides whether a wrong sub-simulation can be shown (audited).
    return applyGateFor(this.gateMeta(a.prior, a.wasStopped), a.next);
  }

  /** The gate's inputs, assembled once so the decision and its telemetry cannot disagree. */
  private gateMeta(prior: string | null, wasStopped: boolean) {
    return {
      dynamic: this.state.dynamic,
      ackCapable: this.state.ackCapable,
      // The publication-time record (audit P0.5). Without it the FIRST activation of every package
      // was a guess, and the guess revealed — over whatever the pooled document had already drawn.
      packageAckCapable: this.packageAckCapable,
      // Pixels-on-canvas, not activation history. A document that has drawn nothing cannot be
      // showing the wrong sub-simulation, and a pooled one has almost always drawn its boot scene
      // before the section it was mounted for is ever requested.
      painted: this.state.painted,
      lastScript: prior,
      stopped: wasStopped,
    };
  }

  /**
   * Tell this client what PUBLICATION recorded about the package: does its bridge post
   * SCRIPT_APPLIED? `null` means no record exists (every package published before migration 055),
   * which the gate handles as its own case rather than as either answer.
   *
   * Safe to call on every render — it only writes when the answer actually changes, so a re-render
   * cannot disturb a live hold.
   */
  setPackageAckCapable(capable: boolean | null): void {
    if (this.disposed) return;
    if (this.packageAckCapable === capable) return;
    this.packageAckCapable = capable;
    this.tel('package-ack-capability', { capable });
  }

  /** True while a gated activation is holding the presentation — nothing may present over it. */
  isHoldingApply(): boolean { return this.holding; }

  /**
   * The apply hold reached its deadline with no acknowledgement.
   *
   * A DEADLINE SELECTS A COVER, NEVER A REVEAL (audit §21 rule 7). This used to call
   * `reveal(true)`, on the reasoning that "after this bound the child has almost certainly applied
   * the switch" — which is a belief about elapsed time, not evidence about what is on the canvas,
   * and it is exactly the reasoning every wrong-frame incident in this pipeline has been built on.
   * The hold therefore SURVIVES the deadline; what changes is that the owner is told to explain the
   * wait, so the user sees the poster (or the honest wait affordance over the held outgoing
   * content) rather than an unexplained pause or an unverified frame.
   *
   * The population that reaches this is reported, because it is the only measurement that can say
   * whether the bound is set correctly.
   */
  /**
   * The bounded wait on an UNKNOWN package expired: conclude, in-session, that its bridge is silent.
   *
   * WHY THIS IS EVIDENCE AND NOT A TIMER. Every other deadline in this file is asked to authorise
   * pixels it knows nothing about, and each is refused. This one is asked a different question:
   * "does this bridge acknowledge?" — and the answer is now known, because the bridge was sent a
   * section, given the whole bound, and said nothing. A silent bridge is exactly what
   * `bridge_ack_capable: false` records, so recording it here from observation is the same fact
   * reached the same way the publication path reaches it, only later.
   *
   * SCOPED TO THE DOCUMENT, deliberately. `ackCapable` lives on `SimRuntimeState` and is reset by
   * `attach()` and `handleFrameLoad()`, so a republished package on a fresh document is asked
   * again. The PACKAGE record is never written from here — a stale in-session conclusion must not
   * be able to outlive the document that produced it.
   */
  private concludeAckSilent(script: string): void {
    if (this.disposed || !this.holding) return;
    this.set({ ackCapable: false });
    this.tel('apply-unknown-concluded-silent', { script, waitedMs: SIM_APPLY_STALL_MS });
    this.holding = false;
    // The hold is over, so nothing is left for a cover to explain.
    this.set({ pendingScript: null, covered: false });
    // Still gated on `painted`: a document that has drawn nothing has nothing to show, and the
    // owner's own paint machinery governs that case exactly as it does for a legacy package.
    this.maybeReveal();
  }

  private coverUnacknowledged(script: string, decision: ApplyGateDecision, waitedMs: number): void {
    if (this.disposed || !this.holding) return;
    this.set({ covered: true });
    this.tel('apply-deadline-cover', {
      script,
      // 'await-ack' means the package is PROVEN to acknowledge and has not — the strongest reason
      // of all to keep covering. 'await-ack-bounded' means nobody knows whether it can.
      proven: decision === 'await-ack',
      waitedMs,
    });
  }

  /** Reveal if — and only if — every precondition still holds. The single writer of visible:true. */
  private maybeReveal(): void {
    if (this.holding) return;
    if (!this.state.painted) return;
    this.reveal(false);
  }

  private reveal(force: boolean): void {
    if (this.disposed) return;

    // ── THE REVEAL INVARIANT ────────────────────────────────────────────────────────────────
    // On the modern path there is NO force. `force` exists on the v2 path as the escape hatch for
    // packages that never promised anything; a v3 package promised SECTION_PRESENTED by completing
    // the handshake, so every reveal must be justified by an acknowledgement whose five identity
    // axes match the intent the player currently holds. A timeout, a paint, a matching section
    // name and a matching contentWindow have each in turn been the thing that authorised a reveal
    // here, and each in turn was shown to authorise a wrong one.
    // ARMED, not ACTIVE. Gating on `modernActive()` left a hole big enough to drive the whole
    // invariant through: `modernActive()` requires `acceptsCommands(docMachine)`, which goes FALSE
    // the moment the child confirms DOCUMENT_SUSPENDED — and the resident pool suspends frames
    // routinely while it warms them (freeze()/thaw()). With it false, reveal() fell through to the
    // LEGACY branch, whose only conditions are `painted` and `holding`. A regenerated package
    // carries both listeners, so a v2 SIM_PAINTED then revealed it — and it revealed even for an
    // acknowledgement carrying a DIFFERENT packageRevision, because mayReveal was never consulted
    // at all. Once a client has armed the modern path, the modern gate is the only gate.
    // ARMED AND VIABLE. Not simply "armed": a transport that settled on `legacy` means this
    // document does not speak v3 after all, and the v2 path is then the correct and only way it can
    // ever be shown — gating on `modernSetup` alone left such a package permanently invisible.
    const modernArmed =
      this.modernSetup !== null &&
      this.transport !== null &&
      this.transport.getMode() !== 'legacy' &&
      this.transport.getMode() !== 'closed';
    if (modernArmed) {
      if (!this.modernActive()) {
        this.tel('modern-reveal-refused', { refusal: 'document-not-ready' });
        return;
      }
      const act = this.actMachine;
      if (!act) { this.tel('modern-reveal-refused', { refusal: 'no-activation' }); return; }
      // `current` is the LIVE intent, rebuilt from what the client wants on screen right now —
      // not the activation's own stored copy. Passing `act.identity` for both sides is what made
      // this a tautology.
      const live: PresentationIdentity = {
        packageRevision: this.modernSetup!.packageRevision,
        documentId: this.currentDocumentId!,
        activationId: act.identity.activationId,
        variantKey: act.identity.variantKey,
        configHash: act.identity.configHash,
      };
      const decision = mayReveal({
        activation: act,
        current: live,
        documentReady: acceptsCommands(this.docMachine),
        contextLost: this.docMachine.contextLost,
      });
      if (!decision.allowed) {
        this.tel('modern-reveal-refused', { refusal: decision.refusal, forced: force });
        return;
      }
      this.actMachine = activationReducer(act, { type: 'ACTIVATE' });
      this.transport?.send(ACTIVATE_SECTION, act.identity, {});
      this.stopPaintPoll();
      this.set({ phase: 'visible', visible: true, interactive: true, pendingScript: null, covered: false });
      // The only stage a human perceives. Marked AFTER the reveal is authorised and committed, so a
      // refused reveal can never contribute a total — a transition that was rejected did not
      // complete, and counting it would make the p90 describe frames nobody saw.
      this.mark('revealed');
      this.tel('reveal', computeDurations(this.tmarks) as unknown as Record<string, unknown>);
      this.rollTransition();
      return;
    }

    if (!force && !this.state.painted) return;
    // CENTRAL GUARD: a gated switch is never presented, no matter which path called reveal (a
    // late paint, a poll, an owner nudge). Only the ack handlers and the terminal bound clear it.
    if (!force && this.holding) return;
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }
    this.stopPaintPoll();
    this.set({ phase: 'visible', visible: true, interactive: true, covered: false });
    // ONLY MEASURE A TRANSITION THAT WAS ACTUALLY OPENED.
    //
    // `reveal()` runs for reasons that are not section transitions — a first paint, a poll, an owner
    // nudge — and it is not idempotent. Stamping presented/revealed unconditionally MANUFACTURED a
    // transition: `rollTransition` pushes whenever the mark map is non-empty, which those two marks
    // had just guaranteed, so the history filled with entries that had no `requested`. They can
    // never be complete, so no percentile moved — but they were counted in `samples` and tallied
    // into `abandonedAt.revealed`, the field that answers "where do transitions die". It read as a
    // fleet dying at reveal when nothing had died at all. A transition is open exactly when
    // `activate()` stamped `requested`.
    if (this.tmarks.marks.requested !== undefined) {
      this.mark('presented');
      this.mark('revealed');
      this.tel(force ? 'reveal-forced' : 'reveal',
        computeDurations(this.tmarks) as unknown as Record<string, unknown>);
      this.rollTransition();
    } else {
      this.tel(force ? 'reveal-forced' : 'reveal', { unmeasured: true });
    }
  }

  /**
   * Drive a document that has not painted yet: ping for the acks, and arm the bounded ceiling that
   * keeps a pre-gate package (which can never emit SIM_PAINTED) displayable.
   */
  startPaintRecovery(opts?: { legacyCeilingMs?: number }): void {
    if (this.disposed || this.state.painted) return;
    this.stopPaintPoll();
    let attempts = 0;
    this.paintPollTimer = setInterval(() => {
      if (this.disposed || this.state.painted || ++attempts > 40) { this.stopPaintPoll(); return; }
      this.post({ type: this.state.ready ? PING_SIM_PAINTED : PING_SIM_READY });
    }, 300);

    const gen = this.generation;
    if (this.legacyRevealTimer) clearTimeout(this.legacyRevealTimer);
    this.legacyRevealTimer = setTimeout(() => {
      this.legacyRevealTimer = null;
      if (this.generation !== gen || this.disposed) return;
      if (this.state.painted) return;
      // NEVER through a live apply hold. reveal(force) deliberately bypasses the hold for the
      // TERMINAL bound — which clears the pending apply as it fires — but this ceiling is not
      // terminal for the hold: firing through it presented a section before its acknowledgement
      // (proven by execution in review). The hold's own 3s bound is the sole terminal release,
      // so a held document is never parked forever by skipping the ceiling here.
      if (this.holding) { this.tel('legacy-ceiling-deferred-to-hold'); return; }
      this.tel('legacy-ceiling-reveal');
      this.reveal(true);
    }, opts?.legacyCeilingMs ?? SIM_LEGACY_REVEAL_MS);
  }

  private stopPaintPoll(): void {
    if (this.paintPollTimer) { clearInterval(this.paintPollTimer); this.paintPollTimer = null; }
  }

  // ── exit ────────────────────────────────────────────────────────────────────────────────

  /**
   * Atomic exit. Freeze and silence FIRST, fade, and only then tear the section down — running
   * stopScript at the boundary restores the controls the section hid and renders them for the
   * whole fade, which is a deterministic Minimal-UI flash on every exit.
   */
  deactivate(opts?: { teardown?: boolean; fadeMs?: number }): void {
    if (this.disposed) return;
    const teardown = opts?.teardown !== false;
    this.cancelPendingApply();
    this.post({ type: SIM_PAUSE });
    this.post({ type: SIM_MUTE });
    this.post({ type: GUIDANCE_GATE, active: false });
    this.set({ phase: 'fading-out', visible: false, interactive: false, muted: true });
    this.tel('deactivate', { teardown });

    // Modern: releasing is explicit and immediate. It disposes SECTION-owned resources while the
    // document keeps its renderer and loaded assets, which is exactly the distinction a single
    // cleanup function could not express — and the reason a resident pool can re-enter a section
    // without paying the whole document cost again.
    this.pendingActivate = null;   // the owner left the section; nothing to re-drive
    this.livePolicy = null;        // no live section, so nothing to compare a policy against
    if (this.modernActive() && this.actMachine) {
      this.clearPrepareTimer();
      this.clearPresentTimer();
      this.transport?.send(RELEASE_SECTION, this.actMachine.identity, {});
      this.transport?.send(SET_AUDIBLE, {}, { muted: true, volume: 0 });
      this.actMachine = activationReducer(this.actMachine, { type: 'RELEASE' });
    }

    if (!teardown) { this.set({ phase: 'hidden' }); return; }

    const gen = this.generation;
    this.cancelDeferredStop();
    this.deferredStopTimer = setTimeout(() => {
      this.deferredStopTimer = null;
      if (this.disposed || this.generation !== gen) return;
      this.post({ type: STOP_SCRIPT });
      // The section is torn down: its cleanup restored whatever it had hidden. Mark the document
      // `stopped` — NOT merely script-less, which would read as a fresh document and reveal
      // immediately on the next entry.
      this.set({ currentScript: null, stopped: true, phase: 'hidden' });
      this.tel('deferred-stop');
    }, opts?.fadeMs ?? SIM_EXIT_STOP_MS);
  }

  /**
   * Hide AND silence — for the paths where the document is still running something the user must
   * not hear. activate() resumes and unmutes before the ack arrives, so on SCRIPT_MISSING the
   * PREVIOUS section is left running, audible, under the video with nothing on screen.
   */
  private hideAndSilence(): void {
    this.post({ type: SIM_PAUSE });
    this.post({ type: SIM_MUTE });
    this.set({ muted: true });
    this.hide();
  }

  /** Hide without tearing down (missing section, error, or an owner-driven hide). */
  hide(): void {
    if (this.disposed) return;
    // Cancel the apply hold with it: an armed stall timer would fire later and force-reveal a
    // document the owner has deliberately hidden.
    this.cancelPendingApply();
    this.set({ visible: false, interactive: false, phase: this.state.phase === 'failed' ? 'failed' : 'hidden' });
  }

  /**
   * Record that the OWNER has decided to treat this document as painted, even though it never
   * emitted SIM_PAINTED — the bounded-hold escape used for packages whose gate cannot ack a paint.
   *
   * This exists so `painted` has exactly ONE owner. When the pool kept its own "treat as painted"
   * latch, the runtime never learned of it: `painted` stayed false, so `maybeReveal` never granted
   * visibility, and once the viewer's reveal became gated on that grant a never-painting package
   * was permanently invisible on re-entry — no spinner, no timer left armed to release it
   * (audited: introduced by making the runtime's permission authoritative without giving the
   * runtime the latch).
   */
  markPaintedByPolicy(reason: string): void {
    if (this.disposed || this.state.painted) return;
    this.stopPaintPoll();
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }
    this.set({ painted: true, phase: this.state.visible ? 'visible' : 'painted' });
    this.tel('painted-by-policy', { reason });
    // The hold, if any, still governs: a gated switch is not released by a policy paint.
    this.maybeReveal();
  }

  // ── the v3 quiescence pair, in ONE place ──────────────────────────────────────────────────
  // Every suspend this client sends goes through `sendSuspendDocument` and every resume through
  // `sendResumeDocument`, so the debt described on `suspendSent` is taken on and discharged in
  // exactly two statements. `suspend()`, `freeze()` and `evict()` are then three POLICIES over one
  // mechanism rather than three implementations of it.

  /** Ask the child to go quiescent, and RECORD that a resume is now owed. */
  private sendSuspendDocument(): void {
    if (!this.modernActive()) return;
    this.transport?.send(SUSPEND_DOCUMENT, {}, {});
    this.docMachine = documentReducer(this.docMachine, { type: 'SUSPEND' });
    this.suspendSent = true;
  }

  /**
   * Pay the debt: send RESUME_DOCUMENT if — and only if — this client has an unmatched suspend.
   *
   * The reducer is driven ONLY from `SUSPENDED`, because that is the one state with a legal
   * `RESUME` edge. In the unconfirmed window the machine still reads DOCUMENT_READY and the
   * dispatch would be recorded as a REFUSED transition — telemetry that means "a surface is driving
   * this machine wrongly", which this is not. The child processes its port in order, so the pending
   * DOCUMENT_SUSPENDED then DOCUMENT_RESUMED walk the machine back to DOCUMENT_READY on their own.
   */
  private sendResumeDocument(cause: string): void {
    if (!this.suspendSent) return;
    this.suspendSent = false;
    const wasEvict = this.evictSuspended;
    this.evictSuspended = false;
    if (!this.transport?.isModern()) return;
    this.transport.send(RESUME_DOCUMENT, {}, {});
    if (this.docMachine.state === 'SUSPENDED') {
      this.docMachine = documentReducer(this.docMachine, { type: 'RESUME' });
    }
    if (wasEvict) this.tel('evict-cancel-resume', { state: this.docMachine.state });
    // `state` distinguishes the two windows this method now covers, which is the whole point of
    // the change: `DOCUMENT_READY` means the resume overtook a suspend the child has not confirmed
    // yet (the window that used to send nothing at all), `SUSPENDED` means it had.
    this.tel('modern-resume-sent', { cause, state: this.docMachine.state, evictCancel: wasEvict });
  }

  /** Freeze a retained background document so it stops burning CPU/GPU. */
  suspend(): void {
    if (this.disposed) return;
    this.cancelPendingApply();   // a frozen frame must never force-reveal itself at the bound
    this.post({ type: SIM_PAUSE });
    this.post({ type: SIM_MUTE });
    this.sendSuspendDocument();
    this.set({ phase: 'suspended', muted: true, visible: false, interactive: false });
  }

  resume(): void {
    if (this.disposed) return;
    this.post({ type: SIM_RESUME });
    this.sendResumeDocument('resume');
    this.set({ phase: this.state.painted ? 'painted' : 'ready' });
  }

  /**
   * Ask the package to switch quality profile. A package that cannot answers `unsupported`, which
   * is reported rather than treated as applied — an adaptive-quality policy built on an unverified
   * assumption that the switch landed would be tuning against a value nothing changed.
   */
  setQuality(profile: SimQualityProfile): void {
    if (this.disposed || !this.modernActive()) return;
    this.transport?.send(SET_QUALITY, {}, { profile });
  }

  /**
   * Give back a presentation the OWNER took away — the editor's `sim-preview-active` pact
   * suspends the timeline sim while the section-editor's own iframe is live, and must restore it
   * exactly as it was when the preview closes. Deliberately NOT gated on `painted`: it restores a
   * presentation that was already granted, and a legacy document revealed at the bounded ceiling
   * never paints, so requiring a paint here would hide it forever. It still refuses while an
   * activation is holding — a gated switch is never presented from here.
   */
  present(): void {
    if (this.disposed || this.holding) return;
    this.reveal(true);
  }

  /**
   * Stop a BACKGROUND document burning CPU, without touching presentation state.
   *
   * Deliberately narrower than `suspend()`. The resident pool freezes and thaws frames while it
   * warms them, long before any of them is a candidate for presentation, and it tracks that
   * progress in its own bookkeeping. Routing those through `suspend()` would additionally mute the
   * document, mark it hidden and move it to the `suspended` phase — three state changes the pool
   * neither asked for nor accounts for. Before this existed the pool posted the message itself,
   * which is exactly the second lifecycle implementation this module was built to eliminate.
   *
   * On the modern path a frozen document ALSO goes properly quiescent, because there it can
   * actually prove it (the child answers with resource counts).
   */
  freeze(): void {
    if (this.disposed) return;
    this.post({ type: SIM_PAUSE });
    this.sendSuspendDocument();
  }

  /** Undo `freeze()`. Presentation state is untouched, exactly as on the way in. */
  thaw(): void {
    if (this.disposed) return;
    this.post({ type: SIM_RESUME });
    this.sendResumeDocument('thaw');
  }

  mute(): void {
    this.post({ type: SIM_MUTE });
    this.transport?.send(SET_AUDIBLE, {}, { muted: true, volume: 0 });
    this.set({ muted: true });
  }

  unmute(): void {
    this.post({ type: SIM_UNMUTE });
    this.transport?.send(SET_AUDIBLE, {}, { muted: false, volume: 1 });
    this.set({ muted: false });
  }
  relayout(): void { this.post({ type: SIM_RELAYOUT }); }
  setGuidance(active: boolean): void { this.post({ type: GUIDANCE_GATE, active }); }

  // ── section policy (audit P1.2) ─────────────────────────────────────────────────────────

  /** The policy the live activation is running with, or null when nothing is running. */
  getLivePolicy(): SimSectionPolicy | null {
    return this.livePolicy ? { ...this.livePolicy } : null;
  }

  /**
   * Change Minimal-UI / Auto-Script on the section that is ALREADY RUNNING.
   *
   * THE WHOLE POINT: a chrome or automation change must not reset the simulation. Before this,
   * every such change arrived as an activation — v2 fell through `stopScript` (cleanup, timers
   * cleared, body re-run) and v3 minted a new `configHash`, which IS a new activation by
   * construction. Either way, hiding a slider restarted the physics.
   *
   * The return value is not a boolean on purpose. "The toggle took effect" and "the toggle took
   * effect by restarting the section" are exactly the two outcomes this finding is about telling
   * apart, and the caller — plus telemetry — gets to see which one happened.
   *
   * A patch that omits a field leaves it alone. `hideSelectors: null` is a real value meaning "no
   * mechanical hide set", and is NOT the same as `[]` on the restart path (see simPolicy.ts).
   */
  setPolicy(patch: Partial<SimSectionPolicy>): SimPolicyOutcome {
    if (this.disposed || !this.frame) return 'no-activation';
    const base = this.livePolicy;
    // Nothing is running: there is no activation to police, and inventing one here would race the
    // owner's own activation logic (which knows about run/stop chrome, epochs and leases).
    if (!base || (!this.modernActive() && this.state.currentScript === null)) return 'no-activation';

    const next = mergePolicy(base, patch);
    const uiChanged = !sameUiPolicy(base, next);
    const autoChanged = !sameAutomationPolicy(base, next);
    if (!uiChanged && !autoChanged) return 'unchanged';   // idempotent re-post costs nothing

    const supported = this.policySupport();
    const needed: SimPolicyKind[] = [
      ...(uiChanged ? (['ui'] as const) : []),
      ...(autoChanged ? (['automation'] as const) : []),
    ];
    const missing = needed.filter((k) => !supported.includes(k));
    if (missing.length > 0) {
      // AN OLD PACKAGE. Its bridge predates the handlers, so the message would land on nothing at
      // all. Restart, and name the reason — a silent fallback here is indistinguishable from the
      // policy path quietly never having worked.
      this.tel('policy-unsupported', { missing, needed, advertised: supported });
      // THE ANSWER FOLLOWS WHAT HAPPENED. `reactivateForPolicy` can decline — with no prior
      // activation to reproduce there is nothing to re-run, and it says so with
      // `policy-fallback-impossible`. Reporting 'reactivated' anyway told the caller the toggle had
      // taken effect by restarting the section when the section had not been touched at all, and
      // the advance of `livePolicy` made the NEXT setPolicy compare against a policy nothing is
      // running, so an identical retry returned 'unchanged' and sent nothing either. Advance the
      // live policy only when the restart that will realise it actually ran.
      const prior = this.livePolicy;
      this.livePolicy = next;
      if (this.reactivateForPolicy('unsupported')) return 'reactivated';
      this.livePolicy = prior;
      return 'no-activation';
    }

    this.livePolicy = next;
    if (this.modernActive() && this.actMachine) {
      const identity = this.actMachine.identity;
      if (uiChanged) {
        this.transport?.send(SET_UI_POLICY, identity, {
          simpleUi: next.simpleUi,
          hideSelectors: normalizeHideSelectors(next.hideSelectors),
        });
      }
      if (autoChanged) {
        this.transport?.send(SET_AUTOMATION_POLICY, identity, { autoScript: next.autoScript });
      }
    } else {
      // The v2 activation token IS the activation identity here — deliberately not a second,
      // parallel one. The bridge refuses a policy carrying a token it was not started with.
      const token = this.state.activationToken;
      if (uiChanged) {
        this.post({
          type: UI_POLICY,
          simpleUi: next.simpleUi,
          hideSelectors: normalizeHideSelectors(next.hideSelectors),
          token,
        });
      }
      if (autoChanged) this.post({ type: AUTO_POLICY, autoScript: next.autoScript, token });
    }
    this.tel('policy-sent', { ui: uiChanged, automation: autoChanged, modern: this.modernActive() });
    return 'policy';
  }

  /** Policy families the LOADED document has actually advertised. Never assumed. */
  private policySupport(): SimPolicyKind[] {
    // On the modern path the child answers in DOCUMENT_READY; on v2 it answers in SIM_READY. Both
    // land in the same field, so there is one rule rather than two that can drift.
    return this.state.policies ?? [];
  }

  /**
   * The fallback every refusal ends in: re-run the section with the new policy folded into its
   * params. This DOES reset the section — that is what makes it a fallback and not a fix — so it
   * is always accompanied by telemetry naming the package's reason.
   *
   * Returns whether the restart actually ran. The only caller that has an outcome to report was
   * reporting 'reactivated' unconditionally, including for the branch that gives up.
   */
  private reactivateForPolicy(reason: string): boolean {
    const prior = this.lastActivate;
    const policy = this.livePolicy;
    if (!prior || !policy) {
      this.tel('policy-fallback-impossible', { reason });
      return false;
    }
    this.tel('policy-fallback-restart', { reason, script: prior.script });
    // `paramsForPolicy` REPLACES rather than merges: it is total over SimStartParams, and merging
    // would let the prior activation's `hideSelectors` survive a policy that deliberately has none.
    this.activate({
      ...prior,
      params: paramsForPolicy(policy),
      ...(prior.config ? { config: withSectionPolicy(prior.config, policy) } : {}),
    });
    return true;
  }

  /** Stop automation WITHOUT tearing the section down (the user grabbed a control). */
  pauseAutomation(): void {
    this.post({ type: PAUSE_SCRIPT });
    if (this.modernActive() && this.actMachine) {
      this.transport?.send(PAUSE_AUTOMATION, this.actMachine.identity, {});
    }
  }

  /** Resume automation the user's interaction paused. Modern path only — v2 has no such command. */
  resumeAutomation(): void {
    if (this.modernActive() && this.actMachine) {
      this.transport?.send(RESUME_AUTOMATION, this.actMachine.identity, {});
    }
  }

  /** Immediate teardown — only for owners that are about to unmount the document anyway. */
  stopNow(): void {
    this.cancelDeferredStop();
    this.post({ type: STOP_SCRIPT });
    // The section is gone, so there is no live policy to compare against. Leaving the old one here
    // would make the next setPolicy() report `unchanged` for a section that is not running.
    this.livePolicy = null;
    this.set({ currentScript: null, stopped: true });
  }

  // ── timers / disposal ───────────────────────────────────────────────────────────────────

  private clearApplyStall(): void {
    if (this.applyStallTimer) { clearTimeout(this.applyStallTimer); this.applyStallTimer = null; }
  }

  /** Cancel a pending apply AND its hold, together — never one without the other. */
  cancelPendingApply(): void {
    this.clearApplyStall();
    this.holding = false;
    this.handshakeDeferred = false;   // never leave a hold armed with no timer able to release it
    // The cover exists only to explain a live hold. Cancelling the hold without retiring it would
    // leave the poster up over a document nothing is waiting for.
    if (this.state.pendingScript !== null || this.state.covered) this.set({ pendingScript: null, covered: false });
  }

  cancelDeferredStop(): void {
    if (this.deferredStopTimer) { clearTimeout(this.deferredStopTimer); this.deferredStopTimer = null; }
  }

  /** True while an exit fade is still holding a teardown — the owner must not evict the frame. */
  hasDeferredStop(): boolean { return this.deferredStopTimer !== null; }

  private clearAllTimers(): void {
    // An eviction whose timers are about to be cleared can never complete: its grace and deadline
    // callbacks are the only things that would have settled it, and both also guard on
    // `generation`, which every caller of this method is about to bump. Settle it FORCED here
    // rather than leaving the owner awaiting a promise nothing can resolve.
    this.settleEvictionAsForced('timers-cleared');
    if (this.evictGraceTimer) { clearTimeout(this.evictGraceTimer); this.evictGraceTimer = null; }
    if (this.evictDeadlineTimer) { clearTimeout(this.evictDeadlineTimer); this.evictDeadlineTimer = null; }
    this.holding = false;
    this.handshakeDeferred = false;
    this.clearContextTimer();
    this.clearPrepareTimer();
    this.clearPresentTimer();
    this.clearApplyStall();
    this.cancelDeferredStop();
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }
    this.stopPaintPoll();
  }

  // ── Two-phase eviction (audit: the parent never waited for DISPOSED) ────────────────────
  //
  //   mark EVICTING → exclude from future admission → mute/freeze → abort activation/loaders
  //   → RELEASE_SECTION → [grace] → DISPOSE_DOCUMENT → wait up to SIM_DISPOSE_TIMEOUT_MS for
  //   DISPOSED(resource counts) → the owner removes the iframe REGARDLESS at the deadline
  //   → record clean vs forced.
  //
  // WHY THE OWNER MUST NOT AWAIT THIS ON A VISIBLE PATH. Nothing here is on the way to showing a
  // user anything: the frame is already excluded from admission and already silent, so the only
  // thing the wait buys is EVIDENCE — the child's own resource counters, and the difference between
  // a package that shut down cleanly and one that did not. A user must never wait for evidence.

  /** How far an eviction has got. The pool reads this to keep an evicting frame out of admission. */
  evictionPhase(): SimEvictionPhase { return this.evictPhase; }

  /** True while this document is being evicted — it must not be selected, warmed or presented. */
  isEvicting(): boolean { return this.evictPhase !== 'none' && this.evictPhase !== 'evicted'; }

  /**
   * PHASE ONE of eviction. Resolves when the child confirms DISPOSED or at the deadline, whichever
   * comes first; the owner removes the element when it resolves, and the outcome says which
   * happened. Idempotent — a second call returns the SAME promise rather than starting a second
   * teardown of one document.
   */
  evict(opts?: { graceMs?: number; deadlineMs?: number; reason?: string }): Promise<SimEvictionOutcome> {
    if (this.evictPromise) return this.evictPromise;
    const immediate = (o: SimEvictionOutcome): Promise<SimEvictionOutcome> => {
      this.evictPhase = 'evicted';
      this.tel('evict-complete', { ...o, reason: opts?.reason ?? null });
      return Promise.resolve(o);
    };
    // NOTHING LEFT TO TEAR DOWN. Phase one already ran to completion: the transport is closed, the
    // activation and document ids are gone, and no acknowledgement could reach anyone. Answering
    // `no-document` is the same answer `beginDisposal` gives when a document cannot acknowledge,
    // and it is a FRESH answer — `settleEviction` releases `evictPromise` precisely so a second
    // call cannot be handed the first call's outcome as if it described this one.
    if (this.disposed || this.evictPhase === 'evicted') {
      return immediate({ outcome: 'no-document', counts: null, leaked: [], waitedMs: 0 });
    }

    this.evictStartedAt = Date.now();
    this.evictPhase = 'grace';
    // Held in a local as well as on the instance: `settleEviction` now releases the field the
    // moment phase one closes, so returning the field at the end of this method would return null
    // for any eviction that settles synchronously inside it.
    const evicting = new Promise<SimEvictionOutcome>((resolve) => { this.evictSettle = resolve; });
    this.evictPromise = evicting;
    this.tel('evict-begin', { reason: opts?.reason ?? null, modern: this.modernActive() });

    // ABORT EVERYTHING IN FLIGHT. A document on its way out must not be able to reveal itself, tear
    // down a section it no longer owns, or fail an activation nobody is waiting for — each of which
    // is a timer that outlives the decision to evict.
    this.pendingActivate = null;
    this.cancelPendingApply();
    this.cancelDeferredStop();
    this.clearPrepareTimer();
    this.clearPresentTimer();
    this.clearContextTimer();
    this.stopPaintPoll();
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }

    // MUTE AND FREEZE. Ordered before the release so nothing is audible for the length of the
    // handshake — an evicting document that keeps its audio is the exit-mute defect with a longer
    // window to be noticed in.
    this.post({ type: SIM_PAUSE });
    this.post({ type: SIM_MUTE });
    this.set({ visible: false, interactive: false, muted: true, covered: false });
    if (this.modernActive()) {
      this.transport?.send(SET_AUDIBLE, {}, { muted: true, volume: 0 });
      // The debt this takes on is recorded by `sendSuspendDocument`, so `cancelEviction` can be the
      // exact inverse of this line rather than an inverse of whatever the child has got round to
      // admitting. `evictSuspended` only labels the resume in telemetry.
      this.sendSuspendDocument();
      this.evictSuspended = this.suspendSent;
    }
    // RELEASE THE SECTION before disposing the document — the same order every other teardown here
    // uses, and the one the child's own state machine expects.
    if (this.transport && this.actMachine && this.actMachine.state !== 'RELEASED') {
      this.transport.send(RELEASE_SECTION, this.actMachine.identity, {});
      this.actMachine = activationReducer(this.actMachine, { type: 'RELEASE' });
    }

    // THE GRACE WINDOW is the whole of the cancellable half. See SIM_EVICT_GRACE_MS.
    const gen = this.generation;
    this.evictGraceTimer = setTimeout(() => {
      this.evictGraceTimer = null;
      if (this.disposed || this.generation !== gen || this.evictPhase !== 'grace') return;
      this.beginDisposal(opts?.deadlineMs ?? SIM_DISPOSE_TIMEOUT_MS, opts?.reason ?? null);
    }, opts?.graceMs ?? SIM_EVICT_GRACE_MS);

    return evicting;
  }

  /**
   * The irreversible half: ask the child to release everything, and WAIT for it to say it did.
   *
   * The port stays open across the wait. Closing it here — which is what `teardownModern` did, in
   * the statement immediately after the send — is precisely why no DISPOSED ever reached a parent.
   */
  private beginDisposal(deadlineMs: number, reason: string | null): void {
    this.evictPhase = 'disposing';
    this.docMachine = documentReducer(this.docMachine, { type: 'DISPOSE' });

    const canAck = !!this.transport && this.transport.isModern() && !!this.currentDocumentId;
    if (!canAck) {
      // A v2 (or never-handshaken) document has no DISPOSED to give. Reported as `no-document`
      // rather than `clean`: nothing was proven, and calling that clean would make the one metric
      // this handshake exists to produce read as a pass for every legacy package in the pool.
      this.settleEviction({ outcome: 'no-document', counts: null, leaked: [], waitedMs: this.elapsedSinceEvictStart() });
      return;
    }

    this.transport!.send(DISPOSE_DOCUMENT, {}, {});
    this.tel('evict-dispose-sent', { reason, deadlineMs });

    const gen = this.generation;
    this.evictDeadlineTimer = setTimeout(() => {
      this.evictDeadlineTimer = null;
      if (this.disposed || this.generation !== gen || this.evictPhase !== 'disposing') return;
      // THE ELEMENT GOES REGARDLESS. A child that cannot answer must not be able to pin a WebGL
      // context for the rest of the session — but the removal is recorded as FORCED, with no
      // counts, so an unprovable teardown is never filed as a clean one.
      this.settleEviction({ outcome: 'forced', counts: null, leaked: [], waitedMs: this.elapsedSinceEvictStart() });
    }, deadlineMs);
  }

  /**
   * Reclaim a document the owner had decided to evict.
   *
   * Only legal BEFORE DISPOSE_DOCUMENT. After it the child has released its managed scope and is
   * closing its port, so there is nothing to come back to — the caller must build a fresh
   * generation instead, and the `false` return is how it learns that.
   */
  cancelEviction(): boolean {
    if (this.evictPhase !== 'grace') {
      if (this.evictPhase !== 'none') this.tel('evict-cancel-refused', { phase: this.evictPhase });
      return false;
    }
    if (this.evictGraceTimer) { clearTimeout(this.evictGraceTimer); this.evictGraceTimer = null; }
    this.tel('evict-cancelled', { waitedMs: this.elapsedSinceEvictStart() });
    // Settle FIRST, then clear the phase: the owner's `.then()` must not observe a half-cancelled
    // client. Mute is deliberately left in place — the activation that follows lifts it, and a
    // document that came back audible before it was presented is a defect this codebase has had.
    const settle = this.evictSettle;
    this.evictSettle = null;
    this.evictPromise = null;
    this.evictPhase = 'none';
    // THE EXACT INVERSE OF WHAT `evict()` FROZE, and `thaw()` is now able to be it. The resume is
    // driven by what THIS client sent (`suspendSent`), not by what the child has admitted to yet,
    // so it fires throughout the unconfirmed window as well as after the confirmation. This call
    // used to need a private helper beside it, because `thaw()` consulted
    // `docMachine.state === 'SUSPENDED'` — a state `documentReducer` deliberately does not reach
    // until the child answers — and so sent nothing at all for the whole of the grace window.
    this.thaw();
    settle?.({ outcome: 'cancelled', counts: null, leaked: [], waitedMs: this.elapsedSinceEvictStart() });
    return true;
  }

  private elapsedSinceEvictStart(): number {
    return this.evictStartedAt ? Math.max(0, Date.now() - this.evictStartedAt) : 0;
  }

  /** Close phase one exactly once, whatever ended it, and release the transport at that point. */
  private settleEviction(outcome: SimEvictionOutcome): void {
    if (this.evictPhase === 'none' || this.evictPhase === 'evicted') return;
    if (this.evictGraceTimer) { clearTimeout(this.evictGraceTimer); this.evictGraceTimer = null; }
    if (this.evictDeadlineTimer) { clearTimeout(this.evictDeadlineTimer); this.evictDeadlineTimer = null; }
    this.evictPhase = 'evicted';
    // The suspend is only owed a resume while the eviction is still CANCELLABLE. Past that the
    // document is gone, so the debt is written off rather than carried into anything later.
    this.evictSuspended = false;
    this.suspendSent = false;
    // NOW the port may go: the acknowledgement has either arrived or provably will not.
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    this.docMachine = documentReducer(this.docMachine, { type: 'EVICT' });
    this.actMachine = null;
    this.currentDocumentId = null;
    this.tel('evict-complete', {
      outcome: outcome.outcome,
      waitedMs: outcome.waitedMs,
      leaked: outcome.leaked,
      // The child's own numbers, kept whole. A leak is diagnosed from WHICH counter is non-zero,
      // so summing them here would throw away the only part that identifies the cause.
      counts: (outcome.counts ?? null) as unknown as Record<string, unknown> | null,
    });
    const settle = this.evictSettle;
    this.evictSettle = null;
    // RELEASE THE PROMISE WITH THE SETTLE. `evict()` returns `this.evictPromise` when one is in
    // flight so a second call joins the first rather than starting a second teardown of one
    // document — but a promise left here after it has resolved makes a LATER eviction resolve
    // instantly with the previous one's outcome, so a caller that evicted, re-admitted and evicted
    // again would remove its element on the strength of a settlement that described a different
    // eviction. In flight it must be shared; settled it must not exist. Callers already holding it
    // are unaffected: they hold the promise object, not this field.
    this.evictPromise = null;
    settle?.(outcome);
  }

  /** Idempotent. After this the client is inert: no timer can fire, no message can be handled. */
  dispose(): void {
    if (this.disposed) return;
    // An eviction that was still waiting for its acknowledgement will never get one now: the
    // listener goes, the port goes, and the owner is unmounting. Settle it as FORCED rather than
    // leaving the promise pending forever — an unresolved eviction is a caller stuck on a `.then()`
    // that can no longer run, and it would also be missing from the clean-vs-forced record.
    this.settleEvictionAsForced('dispose');
    this.teardownModern();
    this.clearAllTimers();
    if (this.listener && typeof window !== 'undefined') window.removeEventListener('message', this.listener);
    this.listener = null;
    this.frame = null;
    this.disposed = true;
    this.set({ phase: 'disposed', visible: false, interactive: false });
  }
}
