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
 * WHAT IT IS NOT
 * Not the activation-scoped protocol redesign. No MessageChannel, no documentId/packageRevision,
 * no PREPARE_SECTION. Same wire messages, same timings, same legacy compatibility — deliberately.
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
    } else {
      this.ensureListener();
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

  /** Freeze a retained background document so it stops burning CPU/GPU. */
  suspend(): void {
    if (this.disposed) return;
    this.cancelPendingApply();   // a frozen frame must never force-reveal itself at the bound
    this.post({ type: SIM_PAUSE });
    this.post({ type: SIM_MUTE });
    this.set({ phase: 'suspended', muted: true, visible: false, interactive: false });
  }

  resume(): void {
    if (this.disposed) return;
    this.post({ type: SIM_RESUME });
    this.set({ phase: this.state.painted ? 'painted' : 'ready' });
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

  mute(): void { this.post({ type: SIM_MUTE }); this.set({ muted: true }); }
  unmute(): void { this.post({ type: SIM_UNMUTE }); this.set({ muted: false }); }
  relayout(): void { this.post({ type: SIM_RELAYOUT }); }
  setGuidance(active: boolean): void { this.post({ type: GUIDANCE_GATE, active }); }

  /** Stop automation WITHOUT tearing the section down (the user grabbed a control). */
  pauseAutomation(): void { this.post({ type: PAUSE_SCRIPT }); }

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
    this.holding = false;   // never leave a hold armed with no timer able to release it
    if (this.state.pendingScript !== null) this.set({ pendingScript: null });
  }

  cancelDeferredStop(): void {
    if (this.deferredStopTimer) { clearTimeout(this.deferredStopTimer); this.deferredStopTimer = null; }
  }

  /** True while an exit fade is still holding a teardown — the owner must not evict the frame. */
  hasDeferredStop(): boolean { return this.deferredStopTimer !== null; }

  private clearAllTimers(): void {
    this.holding = false;
    this.clearApplyStall();
    this.cancelDeferredStop();
    if (this.legacyRevealTimer) { clearTimeout(this.legacyRevealTimer); this.legacyRevealTimer = null; }
    this.stopPaintPoll();
  }

  /** Idempotent. After this the client is inert: no timer can fire, no message can be handled. */
  dispose(): void {
    if (this.disposed) return;
    this.clearAllTimers();
    if (this.listener && typeof window !== 'undefined') window.removeEventListener('message', this.listener);
    this.listener = null;
    this.frame = null;
    this.disposed = true;
    this.set({ phase: 'disposed', visible: false, interactive: false });
  }
}
