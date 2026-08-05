/**
 * Adaptive quality with hysteresis (Priority 8.8).
 *
 * WHAT THIS MAY AND MAY NOT DO
 * Quality is inside `configHash`, and `configHash` is one of the five axes the reveal invariant
 * compares. So a quality change is only safe where it happens BEFORE an identity is minted — it
 * produces a different `configHash`, which correctly invalidates the poster keyed on it. This module
 * therefore decides a quality for the NEXT activation and never mutates a live one. Nothing here
 * may be consulted by the reveal gate.
 *
 * HYSTERESIS IS THE POINT
 * A controller that reacts to every sample oscillates: one slow transition drops quality, the next
 * fast one raises it, and each change re-mints an identity and discards the poster for the old one.
 * The cost of changing quality is therefore much higher than the cost of being one step wrong for a
 * while, and the thresholds here are deliberately asymmetric — quick to protect a struggling
 * device, slow to re-expand a recovering one.
 */

export type QualityProfile = 'high' | 'balanced' | 'low';

/** Ordered worst → best, so a step is an index move rather than a lookup table. */
export const QUALITY_LADDER: readonly QualityProfile[] = ['low', 'balanced', 'high'];

export interface QualitySignals {
  /** p90 of completed transitions so far, or null before there are enough. */
  p90TotalMs: number | null;
  /** How many completed transitions the p90 is built from. */
  samples: number;
  /** The budget this package is expected to meet, from resolveBudget. */
  budgetMs: number;
}

export interface QualityState {
  current: QualityProfile;
  /** Consecutive decisions that pointed the same way. Reset whenever the direction changes. */
  streak: number;
  /** Direction of the current streak. */
  direction: 'down' | 'up' | 'none';
}

export const INITIAL_QUALITY_STATE: QualityState = {
  current: 'high', streak: 0, direction: 'none',
};

/** Minimum completed transitions before ANY adaptation. Below this the p90 is mostly noise. */
export const MIN_SAMPLES = 5;
/**
 * Consecutive over-budget decisions before dropping. Deliberately small: a device that is
 * struggling is failing the viewer right now.
 */
export const DOWN_STREAK = 2;
/**
 * Consecutive comfortable decisions before rising. Deliberately larger: raising quality re-mints an
 * identity and discards the poster keyed on the old one, so the evidence must be stronger than the
 * evidence required to protect a viewer.
 */
export const UP_STREAK = 6;
/** Over budget by this factor counts as struggling. */
export const OVER_FACTOR = 1.0;
/** Under budget by this factor counts as comfortable. There is a deliberate dead band between. */
export const UNDER_FACTOR = 0.5;

export interface QualityDecision {
  next: QualityProfile;
  state: QualityState;
  changed: boolean;
  reason: 'insufficient-samples' | 'over-budget' | 'comfortable' | 'dead-band' | 'at-limit';
}

/**
 * Decide the quality for the NEXT activation.
 *
 * Pure: the caller owns the state and passes it back in. That keeps the controller testable without
 * a harness and makes the hysteresis auditable — the streak is data, not a hidden counter.
 */
export function decideQuality(state: QualityState, s: QualitySignals): QualityDecision {
  const keep = (reason: QualityDecision['reason'], st: QualityState = state): QualityDecision =>
    ({ next: st.current, state: st, changed: false, reason });

  if (s.samples < MIN_SAMPLES || s.p90TotalMs === null || !Number.isFinite(s.p90TotalMs)) {
    // No adaptation without evidence, and the streak is RESET rather than preserved: evidence that
    // stopped arriving is not evidence that continued.
    return keep('insufficient-samples', { ...state, streak: 0, direction: 'none' });
  }
  if (!Number.isFinite(s.budgetMs) || s.budgetMs <= 0) return keep('insufficient-samples');

  const idx = QUALITY_LADDER.indexOf(state.current);
  const over = s.p90TotalMs > s.budgetMs * OVER_FACTOR;
  const comfortable = s.p90TotalMs < s.budgetMs * UNDER_FACTOR;

  if (over) {
    // Being at the limit is a FACT, checked before the streak. Accumulating evidence toward a change
    // that cannot happen is pointless state, and it made `at-limit` surface only on the samples
    // where the streak happened to complete — so a caller logging the reason saw 'over-budget' most
    // of the time for a controller that had nothing left to give.
    if (idx <= 0) return keep('at-limit', { ...state, streak: 0, direction: 'none' });
    const streak = state.direction === 'down' ? state.streak + 1 : 1;
    const next: QualityState = { ...state, streak, direction: 'down' };
    if (streak < DOWN_STREAK) return keep('over-budget', next);
    const lowered = QUALITY_LADDER[idx - 1]!;
    // The streak resets on an actual change, so the NEXT change needs fresh evidence rather than
    // riding the momentum of the decision that already acted.
    return { next: lowered, state: { current: lowered, streak: 0, direction: 'none' }, changed: true, reason: 'over-budget' };
  }

  if (comfortable) {
    if (idx >= QUALITY_LADDER.length - 1) {
      return keep('at-limit', { ...state, streak: 0, direction: 'none' });
    }
    const streak = state.direction === 'up' ? state.streak + 1 : 1;
    const next: QualityState = { ...state, streak, direction: 'up' };
    if (streak < UP_STREAK) return keep('comfortable', next);
    const raised = QUALITY_LADDER[idx + 1]!;
    return { next: raised, state: { current: raised, streak: 0, direction: 'none' }, changed: true, reason: 'comfortable' };
  }

  // The dead band. Between UNDER_FACTOR and OVER_FACTOR nothing happens and the streak is cleared,
  // so a run of borderline samples cannot accumulate into a change that no single sample justified.
  return keep('dead-band', { ...state, streak: 0, direction: 'none' });
}
