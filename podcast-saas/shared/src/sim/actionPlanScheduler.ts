/**
 * The action-plan scheduler — Phase 0 spike.
 *
 * Required by `md-files/ADR-ACTION-RECORDING-SEMANTICS.md` §6.5: "the scheduler is proven against
 * a fake clock: pause, resume, rate, restart-on-seek, adapter seek both directions." This is that
 * scheduler, and it is written so that a fake clock is the ONLY way to drive it — `now` and the
 * timer are constructor inputs, not ambient globals. A module that reaches for `Date.now()` can
 * only be tested by sleeping, and a test that sleeps proves timing on the machine it ran on.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES, AND WHY THE OBVIOUS VERSION IS WRONG
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The natural implementation is one `setTimeout` per recorded event, armed when the section
 * starts. The research review rejected it, and the existing code says why:
 *
 *   - `SimulationService.ts:1519-1652` — `pauseScript` only stops handles registered through
 *     `simDemoTimer`. A per-event timeout is not one, so "pause" would leave the recording running
 *     while the video is stopped.
 *   - the same block's resume re-arms with the FULL original delay, not the remaining one. So even
 *     a registered timer resumes to the wrong place.
 *
 * Hence: ONE handle, ever. The scheduler holds a cursor into the sorted step list, computes
 * logical time from the media clock, drains everything now due, and then arms exactly one timer —
 * for the next step only. Pause cancels that handle without advancing logical time; resume arms a
 * new one for the REMAINING logical delay. That is a different mechanism from "clear the timers",
 * and it is the one the viewer's existing pause/seek contracts can actually support.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO CLOCK POLICIES, and the honest limit of the first
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   entry-relative        logical = clamp(sectionOffset - activationOrigin, 0, duration)
 *                         The default. Follows the media during uninterrupted playback and
 *                         supports pause, resume and rate. A SEEK RESTARTS IT from zero, against
 *                         a pristine document.
 *
 *   section-synchronous   logical = clamp(sectionOffset, 0, duration)
 *                         Entering mid-section lands at the right offset. Requires an adapter that
 *                         implements an absolute, idempotent `seek`, because replaying each
 *                         slider's last-value-before-t reproduces the INPUTS, never the
 *                         accumulated state those inputs produced.
 *
 * The scheduler will not pretend the second is available. `mode` is fixed by the compiler into the
 * plan and this class cannot change it at runtime, which is the point: a seek that lands on a
 * plausible-and-wrong picture is worse than one that visibly restarts.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DRIFT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Between syncs the scheduler advances its own logical clock from `now()` and the rate. When the
 * next authoritative sync arrives it will disagree slightly — different clock domains, a dropped
 * frame, a busy main thread. The response is graded, because over-reacting to a 12ms disagreement
 * by reloading the document would be far worse than the disagreement:
 *
 *   |drift| <= SLEW_MAX_MS        absorb it. Re-anchor silently. No drain, no reload, no replay.
 *   drift forward > SLEW_MAX_MS   snap, and drain what is now due — ONCE.
 *   drift backward, same epoch    reject. Time does not run backwards inside an activation; a
 *                                 real discontinuity carries a new epoch.
 *
 * A cursor never regresses within an epoch. That is what makes an action fire at most once per
 * activation even when syncs arrive out of order or twice.
 */

/** The parent is the authority on time. This is the envelope it sends. */
export interface TimelineClockSyncV1 {
  /** Rises on seek, re-entry, reset, or a real discontinuity. Never otherwise. */
  epoch: number;
  /** Rises on every message. Monotonic per epoch. */
  seq: number;
  /** Playhead position within the section, in ms. */
  sectionOffsetMs: number;
  /** Where in the section this activation began. Ignored by section-synchronous. */
  activationOriginOffsetMs: number;
  /** False while the media is paused. */
  running: boolean;
  /** 1 is normal speed. */
  playbackRate: number;
}

/** One recorded step, already normalized and sorted by (atMs, seq) at compile time. */
export interface SchedulerStep {
  atMs: number;
  /** Index into the plan's action list — what the executor is handed. */
  index: number;
}

export type SchedulerMode = 'entry-relative' | 'section-synchronous';

export type ClockRejectReason =
  | 'stale-epoch'
  | 'stale-seq'
  | 'non-finite'
  | 'negative-duration'
  | 'rate-out-of-policy'
  | 'backward-within-epoch';

/** Why the cursor moved to a new position without playing through. */
export type DiscontinuityKind = 'restart' | 'adapter-seek' | 'snap';

export interface SchedulerCallbacks {
  /** Run these step indices now, in order. Never called with an empty list. */
  drain(indices: number[]): void;
  /**
   * A discontinuity the parent must act on before the scheduler is useful again.
   * `restart` means: this activation is over, create a new document and re-enter.
   * `adapter-seek` means: ask the adapter to seek absolutely to `toMs`, then resume.
   * `snap` is informational — a large forward correction was absorbed.
   */
  discontinuity(kind: DiscontinuityKind, toMs: number, epoch: number): void;
  /** A sync that was refused, and why. Never silently dropped. */
  rejected(reason: ClockRejectReason, sync: TimelineClockSyncV1): void;
}

export interface SchedulerDeps {
  /** Monotonic milliseconds. Injected so tests drive it. */
  now(): number;
  /** Arm ONE timer. Returns an opaque handle. */
  setTimer(delayMs: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

/** Disagreements at or below this are absorbed rather than snapped. */
export const SLEW_MAX_MS = 120;

/** Rates outside this range are refused rather than clamped — a clamp hides a protocol bug. */
export const MIN_RATE = 0.0625;
export const MAX_RATE = 16;

export interface SchedulerOptions {
  mode: SchedulerMode;
  durationMs: number;
  /** Sorted ascending by atMs. The compiler guarantees this; the constructor re-checks. */
  steps: readonly SchedulerStep[];
}

export class ActionPlanScheduler {
  private readonly mode: SchedulerMode;
  private readonly durationMs: number;
  private readonly steps: readonly SchedulerStep[];
  private readonly deps: SchedulerDeps;
  private readonly cbs: SchedulerCallbacks;

  /** Index of the next step that has NOT yet been drained. Never decreases within an epoch. */
  private cursor = 0;
  private epoch = -1;
  private lastSeq = -1;
  private running = false;
  private rate = 1;
  /** Logical ms into the recording at the moment of `anchorWall`. */
  private anchorLogical = 0;
  private anchorWall = 0;
  /** The single timer. There is never a second one. */
  private handle: unknown = null;
  /** Counts every timer ever armed — the property "one handle" is asserted on this in tests. */
  private timersArmed = 0;
  private disposed = false;

  constructor(opts: SchedulerOptions, deps: SchedulerDeps, cbs: SchedulerCallbacks) {
    for (let i = 1; i < opts.steps.length; i++) {
      if (opts.steps[i].atMs < opts.steps[i - 1].atMs) {
        throw new Error('ActionPlanScheduler: steps must be sorted ascending by atMs');
      }
    }
    if (!Number.isFinite(opts.durationMs) || opts.durationMs < 0) {
      throw new Error('ActionPlanScheduler: durationMs must be a finite, non-negative number');
    }
    this.mode = opts.mode;
    this.durationMs = opts.durationMs;
    this.steps = opts.steps;
    this.deps = deps;
    this.cbs = cbs;
  }

  /** Logical position right now, extrapolated from the last anchor at the current rate. */
  position(): number {
    if (!this.running) return this.anchorLogical;
    const elapsed = (this.deps.now() - this.anchorWall) * this.rate;
    return this.clamp(this.anchorLogical + elapsed);
  }

  /** How many timers this scheduler has ever armed. One handle at a time is the invariant. */
  armedCount(): number {
    return this.timersArmed;
  }

  /** True while a timer is outstanding. */
  isArmed(): boolean {
    return this.handle !== null;
  }

  /** Steps already drained in this epoch. */
  cursorIndex(): number {
    return this.cursor;
  }

  /**
   * Apply an authoritative clock sync. This is the only way time moves.
   *
   * Everything that can go wrong here is REPORTED, never absorbed: a sync from a superseded
   * activation, a sync that went backwards, a rate the product does not allow. A scheduler that
   * silently ignores a bad sync is indistinguishable from one that is wedged.
   */
  applySync(sync: TimelineClockSyncV1): void {
    if (this.disposed) return;

    if (!Number.isFinite(sync.sectionOffsetMs) ||
        !Number.isFinite(sync.activationOriginOffsetMs) ||
        !Number.isFinite(sync.playbackRate) ||
        !Number.isInteger(sync.epoch) ||
        !Number.isInteger(sync.seq)) {
      this.cbs.rejected('non-finite', sync);
      return;
    }
    if (sync.playbackRate < MIN_RATE || sync.playbackRate > MAX_RATE) {
      // Refused, not clamped: a rate outside policy means the parent and child disagree about
      // what the product allows, and clamping would hide that behind plausible playback.
      this.cbs.rejected('rate-out-of-policy', sync);
      return;
    }
    if (sync.epoch < this.epoch) {
      this.cbs.rejected('stale-epoch', sync);
      return;
    }
    if (sync.epoch === this.epoch && sync.seq <= this.lastSeq) {
      // `<=` on purpose: a duplicate seq is as stale as an older one, and admitting it would let
      // one action fire twice.
      this.cbs.rejected('stale-seq', sync);
      return;
    }

    const target = this.clamp(this.positionFor(sync));

    if (this.epoch < 0) {
      // The FIRST sync of an activation is not a discontinuity — it is the start. Treating it as
      // one would announce a restart before anything had run, and the parent would tear down the
      // document it had just brought up.
      this.onFirstSync(sync, target);
      return;
    }
    if (sync.epoch > this.epoch) {
      this.onNewEpoch(sync, target);
      return;
    }

    // ── Same epoch: a continuation. ─────────────────────────────────────────
    const predicted = this.position();
    const drift = target - predicted;

    if (drift < -SLEW_MAX_MS) {
      // Time does not run backwards inside an activation. A real seek carries a new epoch, and
      // accepting this would rewind the cursor — replaying actions the viewer already saw.
      this.cbs.rejected('backward-within-epoch', sync);
      return;
    }

    this.lastSeq = sync.seq;
    this.rate = sync.playbackRate;
    this.running = sync.running;
    this.reanchor(target);

    if (drift > SLEW_MAX_MS) {
      // A large forward correction. Absorbed, and whatever became due is drained ONCE — not
      // replayed step by step, and emphatically not a reload.
      this.cbs.discontinuity('snap', target, this.epoch);
    }

    this.drainDue(target);
    this.arm();
  }

  /** Release the timer. Idempotent. After this the scheduler ignores everything. */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private positionFor(sync: TimelineClockSyncV1): number {
    return this.mode === 'section-synchronous'
      ? sync.sectionOffsetMs
      : sync.sectionOffsetMs - sync.activationOriginOffsetMs;
  }

  private clamp(v: number): number {
    return v < 0 ? 0 : v > this.durationMs ? this.durationMs : v;
  }

  /**
   * Adopt the first authoritative clock of an activation.
   *
   * Entry-relative starts at zero by construction (`sectionOffset - activationOrigin` is 0 at
   * entry), so the normal case is simply: drain whatever sits at t=0 and arm for the next step.
   *
   * Section-synchronous is the one that can legitimately BEGIN mid-recording — that is the whole
   * capability it exists for — so a non-zero start defers to the adapter exactly as a later seek
   * would, rather than replaying every earlier step at once.
   */
  private onFirstSync(sync: TimelineClockSyncV1, target: number): void {
    this.epoch = sync.epoch;
    this.lastSeq = sync.seq;
    this.rate = sync.playbackRate;
    this.running = sync.running;
    this.reanchor(target);

    if (this.mode === 'section-synchronous' && target > 0) {
      while (this.cursor < this.steps.length && this.steps[this.cursor].atMs <= target) this.cursor++;
      this.cbs.discontinuity('adapter-seek', target, this.epoch);
      this.arm();
      return;
    }

    this.drainDue(target);
    this.arm();
  }

  private onNewEpoch(sync: TimelineClockSyncV1, target: number): void {
    this.epoch = sync.epoch;
    this.lastSeq = sync.seq;
    this.rate = sync.playbackRate;
    this.running = sync.running;
    this.cancel();

    if (this.mode === 'entry-relative') {
      // The honest limit, made mechanical. There is no way to ask this scheduler to land at t=8s
      // against a document that has been running: restoring each control's last value before 8s
      // reproduces the inputs, not the accumulated state. So the activation ends and the parent
      // creates a pristine document.
      this.cursor = 0;
      this.reanchor(0);
      this.cbs.discontinuity('restart', 0, this.epoch);
      return;
    }

    // section-synchronous: the adapter is responsible for putting the simulation into the state
    // that belongs at `target`. The scheduler advances its cursor past everything before that
    // point WITHOUT executing it — those actions are the adapter's job now, not the executor's.
    this.cursor = 0;
    while (this.cursor < this.steps.length && this.steps[this.cursor].atMs <= target) this.cursor++;
    this.reanchor(target);
    this.cbs.discontinuity('adapter-seek', target, this.epoch);
    this.arm();
  }

  private reanchor(logical: number): void {
    this.anchorLogical = logical;
    this.anchorWall = this.deps.now();
  }

  private drainDue(upToMs: number): void {
    const due: number[] = [];
    while (this.cursor < this.steps.length && this.steps[this.cursor].atMs <= upToMs) {
      due.push(this.steps[this.cursor].index);
      this.cursor++;
    }
    if (due.length > 0) this.cbs.drain(due);
  }

  private cancel(): void {
    if (this.handle !== null) {
      this.deps.clearTimer(this.handle);
      this.handle = null;
    }
  }

  /**
   * Arm the ONE timer, for the next step only.
   *
   * Pause is expressed here rather than as a separate code path: a paused scheduler simply has no
   * outstanding handle, and its `anchorLogical` stops moving because `position()` short-circuits
   * on `running`. Resume re-enters this function and computes the delay from the CURRENT logical
   * position, which is what makes the remaining delay remaining rather than whole.
   */
  private arm(): void {
    this.cancel();
    if (this.disposed || !this.running) return;
    if (this.cursor >= this.steps.length) return;

    const logical = this.position();
    const wallDelay = Math.max(0, (this.steps[this.cursor].atMs - logical) / this.rate);
    const armedEpoch = this.epoch;
    this.timersArmed++;
    this.handle = this.deps.setTimer(wallDelay, () => {
      this.handle = null;
      // A timer that outlived its epoch belongs to a superseded activation. Firing it would apply
      // a past activation's action to the present — the exact class of bug the v3 identity model
      // exists to end.
      if (this.disposed || armedEpoch !== this.epoch) return;
      this.drainDue(this.position());
      this.arm();
    });
  }
}
