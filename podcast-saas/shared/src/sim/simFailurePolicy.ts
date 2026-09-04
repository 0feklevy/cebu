/**
 * What the player does when a simulation will not come up — stated as policy, not as scattered
 * timeouts.
 *
 * THE RULE THAT SEPARATES MODERN FROM LEGACY
 * A MODERN package has promised, by completing the v3 handshake, that it will send
 * `SECTION_PRESENTED` for the exact activation it was asked to present. So when it does not, the
 * honest response is a bounded, VISIBLE failure — never a force-reveal, because a force-reveal
 * shows a frame that nothing has vouched for, which is precisely the class of defect the
 * activation-scoped protocol exists to eliminate.
 *
 * A LEGACY package promised nothing. It cannot be held to a guarantee it never made, so it gets a
 * bounded compatibility behaviour instead — and is classified honestly rather than being described
 * as modern with an asterisk.
 *
 * WHAT IS FORBIDDEN ON BOTH PATHS
 *   • a permanent spinner — every wait has a bound, and the bound leads somewhere;
 *   • silently substituting another section — showing the wrong demonstration is worse than
 *     showing none, because the user cannot tell;
 *   • presenting a state known to be wrong merely to avoid waiting.
 */

import type { SimRuntimeCapabilities } from './runtimeProtocol.js';

// ─── Package capability classification ────────────────────────────────────────────────────────

/**
 * How much a package can be trusted, from most to least. This is the same vocabulary the
 * publish-time canary emits, so a runtime classification and a canary verdict are directly
 * comparable — a package the canary called `managed-presentable` that behaves as `legacy-opaque`
 * at runtime is a reportable contradiction rather than two unrelated opinions.
 */
export type SimPackageClass =
  /** Full v3: activation-scoped, managed lifecycle, provable presentation and suspension. */
  | 'managed-presentable'
  /** Speaks v3 but is missing at least one guarantee (no on-demand render, cannot suspend, …). */
  | 'managed-partial'
  /** No v3, but the v2 bridge acknowledges applies and can emit a paint. */
  | 'legacy-cooperative'
  /** No v3 and no usable acknowledgement — only a load event and a hope. */
  | 'legacy-opaque'
  /** Proven broken: the canary could not bring it up at all. */
  | 'failed';

export const PACKAGE_CLASS_ORDER: readonly SimPackageClass[] = [
  'managed-presentable', 'managed-partial', 'legacy-cooperative', 'legacy-opaque', 'failed',
];

/** Only the top class may be prepared aggressively and revealed live without a poster underneath. */
export function allowsAggressivePreparation(cls: SimPackageClass): boolean {
  return cls === 'managed-presentable';
}

/** Everything except `failed` may be shown at all. `failed` is never presented to a user. */
export function isPresentable(cls: SimPackageClass): boolean {
  return cls !== 'failed';
}

/**
 * Classify from the capability report a document actually sent. Deliberately strict: EVERY
 * capability must be present for `managed-presentable`, because "presentable" is a promise about
 * the reveal path and a package missing on-demand render cannot honestly make it.
 */
export function classifyFromCapabilities(caps: SimRuntimeCapabilities | null): SimPackageClass {
  if (!caps) return 'legacy-opaque';
  if (!caps.activationScoped) return 'legacy-opaque';
  const full =
    caps.activationScoped && caps.managedLifecycle && caps.onDemandRender &&
    caps.contextEvents && caps.suspendable && caps.audioControl && caps.qualityControl;
  return full ? 'managed-presentable' : 'managed-partial';
}

/**
 * Classify a LEGACY (v2) document from what it has demonstrated. `ackCapable` is learned from a
 * real `SCRIPT_APPLIED`, never assumed — the same rule the v2 apply gate already uses.
 */
export function classifyLegacy(o: { ackCapable: boolean; canEmitPaint: boolean }): SimPackageClass {
  return o.ackCapable && o.canEmitPaint ? 'legacy-cooperative' : 'legacy-opaque';
}

// ─── Bounded failure ──────────────────────────────────────────────────────────────────────────

export type SimFailureKind =
  | 'prepare-timeout'
  | 'present-timeout'
  | 'section-error'
  | 'document-error'
  | 'context-lost-unrecovered'
  | 'transport-closed'
  | 'handshake-failed';

/** What the user is offered. Ordered by preference; the first applicable one is used. */
export type SimRecoveryAction = 'retry' | 'skip' | 'back-to-video' | 'poster-only';

export interface SimFailureState {
  kind: SimFailureKind;
  message: string;
  /** Attempt number that produced this failure, 1-based. */
  attempt: number;
  actions: readonly SimRecoveryAction[];
  /** True once the breaker has opened — no further automatic attempts for this package/session. */
  breakerOpen: boolean;
}

export interface FailureContext {
  /** Does a usable poster exist for this exact activation? */
  hasPoster: boolean;
  /** Is there video to fall back to (false for a sim-only project or a post-roll sim)? */
  hasVideo: boolean;
  /** Can the player advance past this section? */
  canSkip: boolean;
}

/**
 * The offered actions, in the order the UI should present them.
 *
 * `poster-only` is FIRST when a poster exists: it is the only option that shows the user the right
 * picture immediately, and it costs nothing. Retry comes next because it is the only one that can
 * still deliver the interactive experience.
 */
export function recoveryActionsFor(ctx: FailureContext, breakerOpen: boolean): readonly SimRecoveryAction[] {
  const actions: SimRecoveryAction[] = [];
  if (ctx.hasPoster) actions.push('poster-only');
  if (!breakerOpen) actions.push('retry');
  if (ctx.canSkip) actions.push('skip');
  if (ctx.hasVideo) actions.push('back-to-video');
  // A failure with NO action is a dead end the user cannot leave. If nothing else applies, offer
  // skip regardless — advancing past a broken section is always better than being stuck on it.
  if (actions.length === 0) actions.push('skip');
  return actions;
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────────────────────

/**
 * Per package, per player session.
 *
 * WHY PER SESSION AND NOT GLOBAL: a package that fails because the device ran out of GPU memory
 * will fail again in this session and should stop being retried, but the same package on the same
 * user's next visit deserves a fresh chance — the condition that broke it was environmental. A
 * breaker that outlived the session would turn one bad afternoon into a permanently dead package.
 */
export interface CircuitBreakerState {
  failures: number;
  open: boolean;
  /** Failure kinds seen, for the report. */
  reasons: readonly SimFailureKind[];
}

/** Consecutive failures before automatic preparation stops for this package in this session. */
export const SIM_BREAKER_THRESHOLD = 3;

export const initialBreaker = (): CircuitBreakerState => ({ failures: 0, open: false, reasons: [] });

export function recordFailure(prev: CircuitBreakerState, kind: SimFailureKind): CircuitBreakerState {
  const failures = prev.failures + 1;
  return {
    failures,
    open: failures >= SIM_BREAKER_THRESHOLD,
    reasons: [...prev.reasons, kind].slice(-SIM_BREAKER_THRESHOLD * 2),
  };
}

/**
 * A SUCCESS resets the breaker completely. Half-open states and decay windows were considered and
 * rejected: they make the breaker's behaviour depend on wall-clock timing, which is exactly what
 * made the previous generation of reveal bugs irreproducible.
 */
export function recordSuccess(_prev: CircuitBreakerState): CircuitBreakerState {
  return initialBreaker();
}

// ─── Timeouts ─────────────────────────────────────────────────────────────────────────────────

/**
 * Bounds on each protocol step. These are FAILURE bounds, not reveal timers: reaching one produces
 * a `SimFailureState`, never a presentation. That distinction is the whole point — the old
 * `SIM_APPLY_STALL_MS` reveal-on-timeout still exists for LEGACY documents (which never promised
 * anything) and is deliberately absent here.
 */
export const SIM_HANDSHAKE_TIMEOUT_MS = 1_500;
export const SIM_PREPARE_TIMEOUT_MS = 5_000;

/**
 * Ceiling on any per-package prepare allowance. Past this a poster is the better answer, and a
 * package that cannot prepare in 15s on the viewer's connection should be classified, not waited
 * on forever — the breaker exists to stop exactly that.
 */
export const SIM_PREPARE_TIMEOUT_MAX_MS = 15_000;

/**
 * The prepare FAILURE bound for one package — `SIM_PREPARE_TIMEOUT_MS` was a single constant for
 * every package, which made a heavy-but-healthy one fail deterministically: a 30MB GLB package
 * legitimately spends ~6s in prepare() on a cold pool miss at 40Mbps, tripping the 5s bound and,
 * three strikes later, the breaker — auto-preparation dead for the whole session on a connection
 * that was never the problem (sim-review 2026-09-04, P1).
 *
 * Two per-package signals extend the floor, both server-published in the player config:
 *  • `prepareBudgetMs` — the package's own measured prepare cost (publish-time canary, refined by
 *    field data). A failure bound must sit ABOVE what the package measurably needs, with headroom.
 *  • `weightTotalBytes` — the revision's total package weight. Covers the cold-miss case the
 *    budget deliberately excludes (asset fetch): ~1s per 2MB beyond the first 5MB.
 *
 * Absent signals (older configs, unmeasured packages) leave the historical 5s floor untouched, and
 * the ceiling keeps a hostile or absurd published number from disabling failure detection.
 */
export function prepareTimeoutMsFor(pkg?: {
  prepareBudgetMs?: number | null;
  weightTotalBytes?: number | null;
}): number {
  const budget = typeof pkg?.prepareBudgetMs === 'number' && Number.isFinite(pkg.prepareBudgetMs) && pkg.prepareBudgetMs > 0
    ? pkg.prepareBudgetMs * 1.5
    : 0;
  const weight = typeof pkg?.weightTotalBytes === 'number' && Number.isFinite(pkg.weightTotalBytes) && pkg.weightTotalBytes > 5_000_000
    ? SIM_PREPARE_TIMEOUT_MS + Math.ceil((pkg.weightTotalBytes - 5_000_000) / 2_000_000) * 1_000
    : 0;
  return Math.min(SIM_PREPARE_TIMEOUT_MAX_MS, Math.max(SIM_PREPARE_TIMEOUT_MS, budget, weight));
}

export const SIM_PRESENT_TIMEOUT_MS = 5_000;
export const SIM_SUSPEND_TIMEOUT_MS = 2_000;
export const SIM_DISPOSE_TIMEOUT_MS = 2_000;
/**
 * The cancellation window between the parent DECIDING to evict a document and DISPOSE_DOCUMENT
 * going out (two-phase eviction).
 *
 * It exists because the two halves of eviction are irreversible at different moments. Everything
 * before DISPOSE_DOCUMENT — marking the frame EVICTING, excluding it from admission, muting and
 * freezing it, aborting its loaders, RELEASE_SECTION — is undoable: the document is intact and a
 * user who scrubs back gets the frame they left. DISPOSE_DOCUMENT is not: the child releases its
 * managed scope and closes its port, so "cancelling" after it would mean presenting a document
 * that has thrown its resources away. This window is what makes the reversible half observable
 * rather than theoretical.
 *
 * Sized just over the exit fade (SIM_EXIT_STOP_MS = 280): a viewer who changes their mind does so
 * as the transition completes, and eviction is off the visible path, so a third of a second of
 * extra residency costs nothing anyone can see.
 */
export const SIM_EVICT_GRACE_MS = 300;
/** How long a lost WebGL context may stay lost before the activation is declared failed. */
export const SIM_CONTEXT_RESTORE_TIMEOUT_MS = 6_000;

export function makeFailure(
  kind: SimFailureKind,
  message: string,
  attempt: number,
  ctx: FailureContext,
  breaker: CircuitBreakerState,
): SimFailureState {
  return {
    kind,
    message,
    attempt,
    actions: recoveryActionsFor(ctx, breaker.open),
    breakerOpen: breaker.open,
  };
}
