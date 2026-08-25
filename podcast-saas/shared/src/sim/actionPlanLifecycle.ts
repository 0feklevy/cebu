/**
 * The reset-generation coordinator — Phase 0 spike.
 *
 * Required by `md-files/ADR-ACTION-RECORDING-SEMANTICS.md` §6.6: "the full lifecycle is proven —
 * single reset generation, READY/PAINTED/PLAN barriers, deadlines, fail-closed." This is that
 * coordinator, and like the scheduler beside it, its clock is an injected input so the proof is a
 * fake clock rather than a sleep.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `ActionPlanScheduler` answers a seek in `entry-relative` mode by ending the activation and
 * emitting `discontinuity('restart')`. Something then has to bring up a genuinely new document and
 * decide when it may be shown. That is this.
 *
 * The sequence the research review specified:
 *
 *     activation becomes dirty
 *     → cover + cancel scheduler/adapter + increment epoch
 *     → create OR JOIN exactly one reset generation
 *     → real navigation / remount
 *     → matching READY(documentId, generation)
 *     → PAINTED
 *     → PREPARE_SECTION
 *     → PLAN_READY  (and CLOCK_APPLIED when the policy is seekable)
 *     → re-check freshness / baseline
 *     → reveal
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FOUR PROPERTIES, AND WHY EACH ONE IS HERE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ONE GENERATION. A viewer can produce several reasons to reset before the first one finishes —
 * a seek during a seek, a re-entry while the document is still loading. Each must JOIN the reset
 * already in flight, not start another. Two navigations in flight means two documents, two READY
 * messages and a race over which one is current, which is the shape `SIM-RUNTIME-PROTOCOL-V3.md`
 * §1 says every wrong-frame incident in this pipeline has had.
 *
 * BARRIERS ARE ORDERED AND GENERATION-STAMPED. `SECTION_APPLIED` from the previous document is a
 * true statement about a dead activation. It is rejected for being from the wrong generation —
 * reported, never silently dropped, because a rejection that cannot say why is indistinguishable
 * from a bug.
 *
 * EVERY BARRIER HAS A DEADLINE. A document that loads and then says nothing must not leave the
 * viewer covered forever. The deadline fires, the generation fails, and the failure is bounded and
 * visible.
 *
 * FAIL CLOSED. `reveal()` is emitted from exactly one place, after every required barrier for the
 * declared policy has been met **in order**, in the current generation. There is no timeout edge
 * into reveal, no "good enough" path, and no way for a caller to force one. `SIM-RUNTIME-PROTOCOL-V3.md`
 * §7 lists what has, at various times, wrongly authorised a reveal here; each entry on that list
 * was a shortcut that looked reasonable.
 *
 * WHY A NONCE. Assigning the same URL to an iframe's `src` does not navigate. The generation nonce
 * exists so the parent can force a real document swap, and it is deliberately NOT part of package
 * or plan identity — it must never reach a hash or change what the simulation computes.
 */

/** The ordered gates a new document passes before it may be shown. */
export const BARRIER_SEQUENCE = ['ready', 'painted', 'prepared', 'plan-ready', 'clock-applied'] as const;
export type Barrier = typeof BARRIER_SEQUENCE[number];

export type LifecycleState =
  | 'idle'          // nothing activated
  | 'resetting'     // dirty; waiting for the parent to perform a real navigation
  | 'awaiting'      // navigated; collecting barriers
  | 'revealed'
  | 'failed';

export type FailureKind =
  | 'barrier-timeout'
  | 'freshness-mismatch'
  | 'document-error'
  | 'abandoned';

export type RejectReason =
  | 'stale-generation'
  | 'out-of-order-barrier'
  | 'duplicate-barrier'
  | 'barrier-not-required'
  | 'wrong-document';

export interface FreshnessEvidence {
  documentId: string;
  revisionId: string;
  packageHash: string;
  baselineControlHash: string;
}

export interface LifecycleCallbacks {
  /** Hold the outgoing frame. Emitted once per generation, before any navigation. */
  cover(generation: number): void;
  /**
   * Perform a REAL navigation. `nonce` is what makes assigning the same URL actually navigate; it
   * is not part of package or plan identity and must never reach a hash.
   */
  navigate(generation: number, nonce: string): void;
  /** Every barrier met, in order, in this generation, and freshness re-checked. Show it. */
  reveal(generation: number): void;
  /** Bounded, visible failure. The cover stays; the old document is never re-exposed. */
  fail(kind: FailureKind, generation: number, barrier?: Barrier): void;
  /** A message that was refused, and why. */
  rejected(reason: RejectReason, generation: number, barrier?: Barrier): void;
}

export interface LifecycleDeps {
  now(): number;
  /** Nonce factory. Injected because `Math.random` is not available to workflow-grade determinism. */
  nonce(generation: number): string;
}

export interface LifecycleOptions {
  /**
   * Which barriers this activation requires. `clock-applied` belongs only to a seekable
   * (adapter) policy — requiring it of a generic plan would hang forever waiting for a message
   * the child will never send.
   */
  required: readonly Barrier[];
  /** Per-barrier deadline in ms, measured from when the barrier became the one being waited on. */
  barrierTimeoutMs: number;
  /** The freshness contract the new document must satisfy before reveal. */
  expected: FreshnessEvidence;
}

export class ResetCoordinator {
  private readonly required: readonly Barrier[];
  private readonly timeoutMs: number;
  private readonly expected: FreshnessEvidence;
  private readonly deps: LifecycleDeps;
  private readonly cbs: LifecycleCallbacks;

  private state: LifecycleState = 'idle';
  private generation = 0;
  private met: Barrier[] = [];
  private waitingSince = 0;
  private documentId: string | null = null;
  /** Counts navigations actually requested — the "one generation" property is asserted on this. */
  private navigations = 0;

  constructor(opts: LifecycleOptions, deps: LifecycleDeps, cbs: LifecycleCallbacks) {
    for (let i = 1; i < opts.required.length; i++) {
      const prev = BARRIER_SEQUENCE.indexOf(opts.required[i - 1]);
      if (BARRIER_SEQUENCE.indexOf(opts.required[i]) <= prev) {
        throw new Error('ResetCoordinator: required barriers must follow BARRIER_SEQUENCE order');
      }
    }
    if (opts.required.length === 0) {
      // A generation with no barriers would reveal on navigation alone — which is the "a new
      // documentId means pristine" assumption the review rejected outright.
      throw new Error('ResetCoordinator: at least one barrier is required');
    }
    this.required = opts.required;
    this.timeoutMs = opts.barrierTimeoutMs;
    this.expected = opts.expected;
    this.deps = deps;
    this.cbs = cbs;
  }

  currentState(): LifecycleState { return this.state; }
  currentGeneration(): number { return this.generation; }
  navigationCount(): number { return this.navigations; }
  metBarriers(): readonly Barrier[] { return this.met; }

  /** The barrier currently being waited on, or null when none is outstanding. */
  pendingBarrier(): Barrier | null {
    if (this.state !== 'awaiting') return null;
    return this.required.find((b) => !this.met.includes(b)) ?? null;
  }

  /**
   * The activation is no longer valid — an exit, a seek, a discontinuity.
   *
   * Called again while a reset is already in flight, this JOINS that reset: same generation, no
   * second cover, no second navigation. That is the property; everything else here is bookkeeping.
   */
  markDirty(): void {
    if (this.state === 'resetting' || this.state === 'awaiting') return;   // join, do not restart
    this.generation++;
    this.met = [];
    this.documentId = null;
    this.evidence = null;
    this.state = 'resetting';
    this.cbs.cover(this.generation);
    this.beginNavigation();
  }

  /** A re-entry request. Identical to `markDirty` by design — it is the same reset. */
  requestEntry(): void {
    this.markDirty();
  }

  /**
   * The parent performed the navigation and a document announced itself.
   *
   * The document is adopted here rather than at `navigate()` because the parent cannot know the new
   * documentId until the child speaks.
   */
  onNavigated(generation: number, documentId: string): void {
    if (generation !== this.generation) {
      this.cbs.rejected('stale-generation', generation);
      return;
    }
    if (this.state !== 'resetting') {
      this.cbs.rejected('wrong-document', generation);
      return;
    }
    this.documentId = documentId;
    this.state = 'awaiting';
    this.waitingSince = this.deps.now();
  }

  /**
   * A barrier acknowledgement from the child.
   *
   * Order is enforced, not merely recorded: `plan-ready` before `painted` means the child is
   * reporting on state it cannot have reached, and admitting it would let an activation reveal on
   * an incomplete document that happened to answer out of sequence.
   */
  onBarrier(generation: number, documentId: string, barrier: Barrier): void {
    if (this.state === 'failed' || this.state === 'revealed') {
      this.cbs.rejected('stale-generation', generation, barrier);
      return;
    }
    if (generation !== this.generation) {
      this.cbs.rejected('stale-generation', generation, barrier);
      return;
    }
    if (this.state !== 'awaiting' || documentId !== this.documentId) {
      this.cbs.rejected('wrong-document', generation, barrier);
      return;
    }
    if (!this.required.includes(barrier)) {
      // Not "ignored". A child announcing CLOCK_APPLIED for a plan whose policy never asked for it
      // disagrees with the parent about the plan, and that is worth seeing.
      this.cbs.rejected('barrier-not-required', generation, barrier);
      return;
    }
    if (this.met.includes(barrier)) {
      this.cbs.rejected('duplicate-barrier', generation, barrier);
      return;
    }
    if (barrier !== this.pendingBarrier()) {
      this.cbs.rejected('out-of-order-barrier', generation, barrier);
      return;
    }

    this.met.push(barrier);
    this.waitingSince = this.deps.now();
    if (this.pendingBarrier() === null) this.finish();
  }

  /** The child reported an error. Fails the generation without waiting for the deadline. */
  onDocumentError(generation: number): void {
    if (generation !== this.generation || this.state === 'failed' || this.state === 'revealed') {
      this.cbs.rejected('stale-generation', generation);
      return;
    }
    this.failGeneration('document-error');
  }

  /** Drive deadlines. The caller ticks this; nothing here schedules itself. */
  tick(): void {
    if (this.state !== 'awaiting') return;
    if (this.deps.now() - this.waitingSince < this.timeoutMs) return;
    this.failGeneration('barrier-timeout', this.pendingBarrier() ?? undefined);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private beginNavigation(): void {
    this.navigations++;
    this.cbs.navigate(this.generation, this.deps.nonce(this.generation));
    this.waitingSince = this.deps.now();
  }

  /**
   * The single place `reveal` is emitted.
   *
   * Freshness is re-checked HERE, after every barrier, rather than at navigation. A new documentId
   * proves a new document; it does not prove the right revision, the right package, or a pristine
   * baseline — `localStorage`, a service worker or a server-side side effect all survive a reload.
   */
  private finish(): void {
    // The evidence is STAMPED with the generation that produced it, and the stamp is checked here
    // rather than relying on a `markDirty` somewhere else having cleared the field. Found by the
    // test that reports freshness for a superseded generation: without the stamp, generation 1's
    // evidence vouched for generation 2 whenever both happened to land on the same documentId —
    // which, after a reload of the same section, is the ordinary case rather than a rare one.
    const actual = this.evidence && this.evidence.generation === this.generation
      ? this.evidence.value
      : null;
    if (!actual ||
        actual.documentId !== this.documentId ||
        actual.revisionId !== this.expected.revisionId ||
        actual.packageHash !== this.expected.packageHash ||
        actual.baselineControlHash !== this.expected.baselineControlHash) {
      this.failGeneration('freshness-mismatch');
      return;
    }
    this.state = 'revealed';
    this.cbs.reveal(this.generation);
  }

  private evidence: { generation: number; value: FreshnessEvidence } | null = null;

  /**
   * The freshness the new document actually reports. Supplied by the parent before the last barrier
   * completes; absent evidence is a mismatch, never an assumption of health.
   */
  reportFreshness(generation: number, evidence: FreshnessEvidence): void {
    if (generation !== this.generation) {
      this.cbs.rejected('stale-generation', generation);
      return;
    }
    this.evidence = { generation, value: evidence };
  }

  private failGeneration(kind: FailureKind, barrier?: Barrier): void {
    this.state = 'failed';
    this.cbs.fail(kind, this.generation, barrier);
  }
}
