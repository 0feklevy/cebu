/**
 * Which number adaptive quality is allowed to judge a device against.
 *
 * This exists as a named production function rather than an expression inside `useProjectPlayer`
 * because the defect it encodes against was a ONE-TOKEN fallback in that expression:
 *
 *     labBudgetsRef.current[id] ?? prepareBudgetsRef.current[id]     // circular
 *
 * `sim_prepare_budget_ms` is the preparation LEAD TIME. The server refines it with field data once
 * a package has >=30 credible RUM rows, at which point it IS the fleet p90 x 1.25. Judging a
 * device's p90 against that asks whether `p90 > 1.25 x p90` — a tautology that pins every device to
 * its current profile no matter how badly it is doing. `sim_lab_budget_ms` is the publish-time
 * canary number: a property of the package's BYTES and of nobody's device, which is what a standard
 * has to be.
 *
 * A missing lab number means "this package was never canaried", NOT "this package is instant". The
 * caller must pass the resulting null through to `nextQualityFor`, which holds the prior profile
 * and reports 'no-lab-budget' rather than degrading the package against the 250ms floor.
 *
 * Kept in its own module so the server -> config -> viewer path can be tested end to end without
 * rendering the player, and so a future edit to the hook cannot quietly reintroduce the fallback
 * without changing a function that has its own tests.
 */

/** The shape the player config carries; both maps are keyed by `simulation_id`. */
export interface QualityBudgetConfig {
  /** Publish-time canary numbers. Absent for a package with no canary — never defaulted. */
  sim_lab_budget_ms?: Record<string, number> | null;
  /** Preparation lead times, field-refined. NOT a quality standard. */
  sim_prepare_budget_ms?: Record<string, number> | null;
}

/**
 * The lab standard for one simulation, or null when the package has never been canaried.
 *
 * Returns null — never a fallback, never a floor — for: no simulation id, no map, no entry, or an
 * entry that is not a usable positive finite number.
 */
export function labStandardMs(
  config: QualityBudgetConfig,
  simulationId: string | null | undefined,
): number | null {
  if (!simulationId) return null;
  const v = config.sim_lab_budget_ms?.[simulationId];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}
