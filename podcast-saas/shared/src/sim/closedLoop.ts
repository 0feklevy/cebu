/**
 * Closed-loop adaptation from field measurements (Priority 8.10).
 *
 * WHAT THIS IS ALLOWED TO DO
 * Take an aggregate computed from RUM and turn it into ONE number: the preparation budget a package
 * should be given. Nothing else. It cannot change what is presented, cannot touch the reveal
 * invariant, and cannot make a package visible or invisible — the worst a wrong answer can do is
 * prepare too early (wasted work) or too late (the pre-existing behaviour).
 *
 * WHY IT REFUSES MORE THAN IT ACCEPTS
 * The input is derived from an UNAUTHENTICATED endpoint. Anyone can post measurements, so an
 * aggregate is a hostile-influenced value, not a trusted one. The guards below are therefore not
 * defensive nicety — they are the boundary between "we measured this" and "someone told us this":
 *
 *   • too few samples          → the lab number stands
 *   • an implausible magnitude → refused outright, because a plausible-looking lie is the dangerous
 *                                kind and there is no honest reading of a 4-hour transition
 *   • a heavily truncated feed → refused, because a sample whose drops outnumber its events
 *                                describes whatever survived the ring, not the session
 *   • a wild move from the lab → clamped to a bounded step, so poisoning is slow and visible
 *                                rather than instant
 *
 * Every refusal keeps the previous value. There is no input that makes this return "no budget".
 */

import { resolveBudget, MIN_BUDGET_MS, MAX_BUDGET_MS, type Budget } from './prepareBudget.js';

/** Below this many completed transitions a p90 is mostly noise. */
export const MIN_FIELD_SAMPLES = 30;
/** No real transition takes longer than this; anything beyond is corrupt or hostile. */
export const IMPLAUSIBLE_MS = 120_000;
/** A field budget may differ from the lab number by at most this factor, in either direction. */
export const MAX_LAB_DEVIATION = 4;
/** A feed whose drop count exceeds this share of its events describes only what survived the ring. */
export const MAX_DROP_RATIO = 0.5;

export interface FieldAggregate {
  samples: number;
  p50TotalMs: number | null;
  p90TotalMs: number | null;
  /** Events the clients' rings discarded across the aggregated batches. */
  dropped?: number;
}

export type LoopRejection =
  | 'insufficient-samples' | 'no-p90' | 'implausible' | 'truncated' | 'inverted';

export interface LoopDecision extends Budget {
  /** Present when the field aggregate was refused and the lab/floor value stands. */
  rejected?: LoopRejection;
  /** True when the field number was clamped toward the lab number rather than taken as given. */
  clamped?: boolean;
}

/**
 * Decide a package's budget from the lab number and a field aggregate.
 *
 * `canaryMs` is trusted (it is produced by our own canary on our own hardware). The aggregate is
 * not. When the aggregate is refused, the result is exactly what `resolveBudget` would have
 * returned without it — so a hostile feed can, at worst, achieve nothing.
 */
export function decideBudget(opts: {
  canaryMs: number | null;
  field: FieldAggregate | null;
}): LoopDecision {
  const lab = resolveBudget({ measuredP90Ms: null, canaryMs: opts.canaryMs });
  const f = opts.field;

  const refuse = (rejected: LoopRejection): LoopDecision => ({ ...lab, rejected });

  if (!f || !Number.isFinite(f.samples) || f.samples < MIN_FIELD_SAMPLES) {
    return refuse('insufficient-samples');
  }
  const p90 = f.p90TotalMs;
  if (typeof p90 !== 'number' || !Number.isFinite(p90) || p90 <= 0) return refuse('no-p90');
  if (p90 > IMPLAUSIBLE_MS) return refuse('implausible');

  // A p90 below the p50 is arithmetically impossible for any real dataset, so it identifies a
  // fabricated or corrupted aggregate more reliably than any magnitude check.
  if (typeof f.p50TotalMs === 'number' && Number.isFinite(f.p50TotalMs) && p90 < f.p50TotalMs) {
    return refuse('inverted');
  }

  const dropped = typeof f.dropped === 'number' && Number.isFinite(f.dropped) ? f.dropped : 0;
  if (dropped > f.samples * MAX_DROP_RATIO) return refuse('truncated');

  // Clamp toward the lab number. Without a bound, one poisoned aggregate moves the budget as far
  // as it likes in a single step; with it, an attacker needs many accepted rounds and each one is
  // visible in the recorded decision.
  const anchor = opts.canaryMs && opts.canaryMs > 0 ? opts.canaryMs : MIN_BUDGET_MS;
  const lo = anchor / MAX_LAB_DEVIATION;
  const hi = anchor * MAX_LAB_DEVIATION;
  const bounded = Math.min(hi, Math.max(lo, p90));
  const clamped = bounded !== p90;

  const ms = Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(bounded * 1.25)));
  return { ms, source: 'measured', ...(clamped ? { clamped: true } : {}) };
}
