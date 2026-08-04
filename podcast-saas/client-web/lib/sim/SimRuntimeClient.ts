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
  CLEAR_BOOT_HIDE,
  GUIDANCE_GATE,
  PAUSE_SCRIPT,
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
  type SimStartParams,
} from './protocol';
import { applyGateFor } from '../simApplyGate';
import { SimTransport } from './SimTransport';
import {
  ACTIVATE_SECTION,
  DISPOSE_DOCUMENT,
  DOCUMENT_ERROR,
  DOCUMENT_READY,
  DOCUMENT_RESUMED,
  DOCUMENT_SUSPENDED,
  DOMAIN_EVENT,
  CONTEXT_LOST,
  CONTEXT_RESTORED,
  INIT_DOCUMENT,
  PAUSE_AUTOMATION,
  PREPARE_SECTION,
  PRESENT_SECTION,
  RELEASE_SECTION,
  RESUME_AUTOMATION,
  RESUME_DOCUMENT,
  SECTION_APPLIED,
  SECTION_ERROR,
  SECTION_PRESENTED,
  SET_AUDIBLE,
  SET_QUALITY,
  SUSPEND_DOCUMENT,
  type AnySimEnvelope,
  type DocumentReadyPayload,
  type SectionPresentedPayload,
} from 'shared/src/sim/runtimeProtocol';
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
  ackCapable: null,
  ready: false,
  painted: false,
  currentScript: null,
  pendingScript: null,
  activationToken: 0,
  stopped: false,
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

  private tel(event: string, detail?: Record<string, unknown>): void {
    this.cbs.onTelemetry?.(event, { key: this.state.documentKey, ...detail });
  }

  private post(msg: object): void {
    try { this.frame?.contentWindow?.postMessage(msg, '*'); } catch { /* cross-origin teardown */ }
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
      this.generation++;
      this.set({ ...initialState(), phase: 'unmounted' });
      return;
    }
    if (!sameDoc) {
      this.clearAllTimers();
      this.generation++;
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
    this.generation++;
    this.cancelDeferredStop();
    this.cancelPendingApply();
    this.set({
      phase: 'mounting',
      ready: false,
      painted: false,
      dynamic: null,
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
      case USER_INTERACTION: this.cbs.onUserInteraction?.(); return;
      default: return;
    }
  }

  private onReady(msg: { dispatch?: string; sections?: string[] }): void {
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
    this.set({ ready: true, dynamic, phase: this.state.painted ? 'painted' : 'ready' });
    this.tel('sim-ready', { dynamic, dispatch: msg.dispatch ?? null });
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
    this.set({ currentScript: script, pendingScript: null, stopped: false });
    this.tel('script-applied', { script });
    this.maybeReveal();
  }

  private onMissing(script: string | null, token?: number): void {
    if (!this.matchesPending(script, token)) return;
    this.clearApplyStall();
    this.holding = false;
    // The bridge deliberately ran NOTHING. Presenting the document would show whatever was on it
    // before — degrade to the underlying content instead of a wrong or parked frame.
    this.set({ pendingScript: null, lastError: `missing section: ${script}` });
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
    this.set({ phase: 'failed', pendingScript: null, lastError: message });
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
    if (decision === 'await-ack') {
      // Hide FIRST. The outgoing section is still on the canvas (this is one document), so
      // leaving it presented while the new body applies is exactly the wrong-sub-simulation
      // frame the gate exists to prevent — holding a reveal is not enough when already visible.
      this.holding = true;
      // Emitted so the hold is OBSERVABLE. The gate's effect is invisible in rendered frames when
      // a body applies instantly, and a body that takes real time blocks the shared process — so
      // without this breadcrumb the single most important safety property has no viewer-level
      // signal at all (audited: a dead gate passed the whole e2e suite unchanged).
      this.tel('apply-hold', { script });
      this.set({ phase: 'awaiting-ack', visible: false, interactive: false });
      const gen = this.generation;
      this.applyStallTimer = setTimeout(() => {
        this.applyStallTimer = null;
        if (this.generation !== gen || this.state.activationToken !== token) return;
        // TERMINAL, never a permanent hold: after this bound the child has almost certainly
        // applied the switch, and holding forever — especially a post-roll sim with the video
        // paused — is worse than a best-effort reveal.
        this.tel('apply-ack-timeout-reveal', { script });
        this.holding = false;
        this.set({ pendingScript: null });
        this.reveal(true);
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
        this.tel('modern-document-ready', { variants: payload.variants?.length ?? 0 });
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
        this.actMachine = activationReducer(this.actMachine!, { type: 'APPLIED' });
        this.tel('modern-section-applied', { variantKey: env.variantKey });
        this.sendPresent();
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
          this.tel('modern-presented-refused', { state: this.actMachine!.state });
          return;
        }
        this.clearPresentTimer();
        this.actMachine = advanced;
        this.breaker = recordSuccess(this.breaker);
        this.failure = null;
        this.tel('modern-section-presented', { variantKey: env.variantKey, frames: payload.framesSubmitted });
        this.reveal(false);
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
    this.transport.send(PREPARE_SECTION, identity, { variantKey: identity.variantKey, config });

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
    this.transport.send(PRESENT_SECTION, act.identity, {});
    this.actMachine = activationReducer(act, { type: 'PRESENT' });

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
      if (this.currentDocumentId && this.docMachine.state !== 'EVICTED') {
        // Best effort: a document that is going away should be told, so it can release GPU memory
        // now rather than when the browser eventually collects the frame.
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
  private gateFor(a: { prior: string | null; next: string; wasStopped: boolean }): 'reveal-now' | 'await-ack' {
    // Delegates to the SHIPPING, separately unit-tested policy. Reimplementing it here would have
    // recreated the duplication this whole module exists to remove — two copies of the one rule
    // that decides whether a wrong sub-simulation can be shown (audited).
    return applyGateFor(
      { dynamic: this.state.dynamic, ackCapable: this.state.ackCapable, lastScript: a.prior, stopped: a.wasStopped },
      a.next,
    );
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
      this.set({ phase: 'visible', visible: true, interactive: true, pendingScript: null });
      this.tel('reveal');
      return;
    }

    if (!force && !this.state.painted) return;
    // CENTRAL GUARD: a gated switch is never presented, no matter which path called reveal (a
    // late paint, a poll, an owner nudge). Only the ack handlers and the terminal bound clear it.
    if (!force && this.holding) return;
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }
    this.stopPaintPoll();
    this.set({ phase: 'visible', visible: true, interactive: true });
    this.tel(force ? 'reveal-forced' : 'reveal');
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

  /** Freeze a retained background document so it stops burning CPU/GPU. */
  suspend(): void {
    if (this.disposed) return;
    this.cancelPendingApply();   // a frozen frame must never force-reveal itself at the bound
    this.post({ type: SIM_PAUSE });
    this.post({ type: SIM_MUTE });
    if (this.modernActive()) {
      this.transport?.send(SUSPEND_DOCUMENT, {}, {});
      this.docMachine = documentReducer(this.docMachine, { type: 'SUSPEND' });
    }
    this.set({ phase: 'suspended', muted: true, visible: false, interactive: false });
  }

  resume(): void {
    if (this.disposed) return;
    this.post({ type: SIM_RESUME });
    if (this.transport?.isModern()) {
      this.transport.send(RESUME_DOCUMENT, {}, {});
      this.docMachine = documentReducer(this.docMachine, { type: 'RESUME' });
    }
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
    if (this.modernActive()) {
      this.transport?.send(SUSPEND_DOCUMENT, {}, {});
      this.docMachine = documentReducer(this.docMachine, { type: 'SUSPEND' });
    }
  }

  /** Undo `freeze()`. Presentation state is untouched, exactly as on the way in. */
  thaw(): void {
    if (this.disposed) return;
    this.post({ type: SIM_RESUME });
    if (this.transport?.isModern() && this.docMachine.state === 'SUSPENDED') {
      this.transport.send(RESUME_DOCUMENT, {}, {});
      this.docMachine = documentReducer(this.docMachine, { type: 'RESUME' });
    }
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
    if (this.state.pendingScript !== null) this.set({ pendingScript: null });
  }

  cancelDeferredStop(): void {
    if (this.deferredStopTimer) { clearTimeout(this.deferredStopTimer); this.deferredStopTimer = null; }
  }

  /** True while an exit fade is still holding a teardown — the owner must not evict the frame. */
  hasDeferredStop(): boolean { return this.deferredStopTimer !== null; }

  private clearAllTimers(): void {
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

  /** Idempotent. After this the client is inert: no timer can fire, no message can be handled. */
  dispose(): void {
    if (this.disposed) return;
    this.teardownModern();
    this.clearAllTimers();
    if (this.listener && typeof window !== 'undefined') window.removeEventListener('message', this.listener);
    this.listener = null;
    this.frame = null;
    this.disposed = true;
    this.set({ phase: 'disposed', visible: false, interactive: false });
  }
}
