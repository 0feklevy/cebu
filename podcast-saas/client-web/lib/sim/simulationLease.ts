/**
 * Page-wide simulation lease (audit P1.1c).
 *
 * At most one simulation surface should be doing real work on screen at a time. Before this
 * broker existed the only arbitration was the `sim-preview-active` CustomEvent pact between the
 * section editor and the timeline player — a one-shot signal that a pair of later effects
 * (the timeline's ready effect and its boundary effect) simply bypassed, which is how a section
 * boundary crossed mid-preview could resurrect the timeline sim under the editor's preview.
 *
 * This is a module singleton on purpose: the section editor (a modal) and the timeline player
 * have no common ancestor that could own the state, exactly like TimelinePanel's
 * `acquireFilmstripSlot` decode gate. It is a BROKER, not an enforcer — it never touches a
 * runtime. Surfaces cooperate:
 *
 *   - a surface that wants the screen ACQUIRES a lease at its priority and releases it when it
 *     stops (React effect cleanup makes release automatic on unmount/section change);
 *   - a surface about to activate/resume a simulation QUERIES `simulationLeaseAllows(...)` first
 *     and, if blocked, records its desire and re-evaluates on `subscribeSimulationLease(...)`
 *     instead of latching a one-shot ref.
 *
 * Priorities: 'preview-visible' > 'timeline-visible' > 'warm'. A priority may run unless some
 * HELD lease outranks it — equal ranks never block each other (blocking a peer would deadlock
 * two surfaces that both legitimately hold the screen, and the pact never blocked peers either).
 *
 * NOTE for the SET_UI_POLICY wave (P1.2): this module is the intended home for any future
 * page-wide "who may drive the document" decisions — extend the priority table, do not add a
 * second channel.
 */

export type SimLeasePriority = 'preview-visible' | 'timeline-visible' | 'warm';

const PRIORITY_RANK: Record<SimLeasePriority, number> = {
  'preview-visible': 2,
  'timeline-visible': 1,
  warm: 0,
};

export interface SimLeaseOwner {
  /** Stable identity of the acquiring surface — used only for the double-acquire assert. */
  id: string;
  priority: SimLeasePriority;
}

export interface SimulationLease {
  readonly id: string;
  readonly priority: SimLeasePriority;
  /** True once release() ran — or the lease was superseded by a double-acquire of the same id. */
  readonly released: boolean;
  /** Idempotent: the second and every later call is a no-op (no double notification). */
  release(): void;
}

interface LeaseRecord {
  owner: SimLeaseOwner;
  released: boolean;
}

let holders: LeaseRecord[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  // Snapshot: a listener may subscribe/unsubscribe (or acquire/release) reentrantly.
  for (const listener of [...listeners]) listener();
}

/**
 * Pure form of the arbitration rule, for direct unit testing and for callers that already hold
 * a snapshot: `priority` may run unless some held lease strictly outranks it.
 */
export function leaseAllows(
  held: ReadonlyArray<SimLeasePriority>,
  priority: SimLeasePriority,
): boolean {
  const rank = PRIORITY_RANK[priority];
  return !held.some((h) => PRIORITY_RANK[h] > rank);
}

/** May a surface at `priority` run right now, given every lease currently held on the page? */
export function simulationLeaseAllows(priority: SimLeasePriority): boolean {
  return leaseAllows(holders.map((h) => h.owner.priority), priority);
}

/**
 * Notified after every change to the held set (acquire and release). Listeners re-query
 * `simulationLeaseAllows(...)` and re-derive their desired state — the broker deliberately does
 * not tell them WHAT changed, so a listener cannot build a one-shot latch on the payload.
 * Returns the unsubscribe function.
 */
export function subscribeSimulationLease(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Debug/test introspection: the owners currently holding leases, in acquisition order. */
export function heldSimulationLeases(): ReadonlyArray<SimLeaseOwner> {
  return holders.map((h) => ({ ...h.owner }));
}

/**
 * Take a lease. Release is idempotent; the expected wiring is a React effect whose cleanup calls
 * `release()`, which makes unmount/section-change auto-release structural rather than remembered.
 *
 * Double-acquire (same owner id while a live lease with that id exists) is a wiring bug — it
 * would let a leaked lease block the page forever. Fail safe: warn in dev, supersede the stale
 * lease (its handle reports `released` and its own late `release()` becomes a no-op), and grant
 * the new one.
 */
export function acquireSimulationLease(owner: SimLeaseOwner): SimulationLease {
  const stale = holders.find((h) => h.owner.id === owner.id);
  if (stale) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[simulationLease] double-acquire for owner "${owner.id}" — superseding the stale lease. `
        + 'Every acquire must be paired with exactly one release (React cleanup).',
      );
    }
    stale.released = true;
    holders = holders.filter((h) => h !== stale);
  }
  const record: LeaseRecord = { owner: { ...owner }, released: false };
  holders.push(record);
  notify();
  return {
    id: record.owner.id,
    priority: record.owner.priority,
    get released() {
      return record.released;
    },
    release() {
      if (record.released) return;
      record.released = true;
      holders = holders.filter((h) => h !== record);
      notify();
    },
  };
}

/** Tests only: drop every holder and listener so suites cannot leak state into each other. */
export function __resetSimulationLeaseForTests(): void {
  holders = [];
  listeners.clear();
}

// ─── pure fire-time / release-time decisions ─────────────────────────────────────────────────
// The two racy call sites this audit wave fixes both defer work (a 150ms debounce, a blocked
// activation). Deferred work must RE-DECIDE when it finally runs, from live state — these
// helpers are that decision, extracted so the rule itself is unit-testable without mounting the
// 3,000-line surfaces that use it.

/**
 * (P1.1a) Should the section editor's debounced Minimal-UI picker re-apply still activate when
 * its 150ms timer fires?
 *
 * - `scheduledEpoch !== currentEpoch`: the preview's identity or run-state was torn down after
 *   scheduling (stop, section/picker reset, document change, a generation landing). The timer
 *   belongs to a world that no longer exists — drop it. This is what used to drive the NEW
 *   document with the OLD script/params: the runtime keeps one client across document changes,
 *   so a stale timer's activate() was honored.
 * - `previewRunning` / `simpleUi` are re-read LIVE because Stop alone flips them without any
 *   reset running; the schedule-time closure captured the old values.
 *
 * `uiDirty` needs no re-check: it only ever flips false in the picker reset, which bumps the
 * epoch.
 */
export function shouldFirePickerActivation(input: {
  scheduledEpoch: number;
  currentEpoch: number;
  previewRunning: boolean;
  simpleUi: boolean;
}): boolean {
  return (
    input.scheduledEpoch === input.currentEpoch
    && input.previewRunning
    && input.simpleUi
  );
}

/** What the timeline player must do for its sim the moment the blocking lease frees. */
export type TimelineLeaseAction =
  /** An activation was skipped while blocked and the document is ready: post it now. */
  | 'activate'
  /** The sim was running when the lease suspended it: resume + unmute + re-present. */
  | 'resume-presented'
  /** Suspended mid-boot: unfreeze and drive the handshake; SIM_READY will activate. */
  | 'resume-boot'
  /** The timeline is not inside a sim section (any earlier desire was withdrawn): nothing. */
  | 'none';

/**
 * (P1.1c) Replaces the one-shot `simPreviewHidRef` latch, which could only undo exactly what it
 * saw at suspend time: a boundary crossed DURING the preview either resurrected the sim under
 * the preview (the bypassing effects) or left it dead after (the latch saw `visible === false`).
 * Decided from CURRENT desire instead, at the moment the lease frees.
 */
export function timelineActionOnLeaseFree(input: {
  /** Is the timeline inside a sim section right now (activeSimUrl non-null)? */
  wantsSim: boolean;
  /** Was an activate skipped while the lease was held? */
  pendingActivation: boolean;
  /** Runtime state: has the mounted document completed its handshake? */
  ready: boolean;
}): TimelineLeaseAction {
  if (!input.wantsSim) return 'none';
  if (!input.ready) return 'resume-boot';
  return input.pendingActivation ? 'activate' : 'resume-presented';
}
