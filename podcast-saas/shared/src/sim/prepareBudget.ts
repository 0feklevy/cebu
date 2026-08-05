/**
 * The preparation budget for a package (Priority 8.7).
 *
 * WHERE A LEAD TIME COMES FROM
 * Preparation has to begin some distance ahead of a section boundary. Compiling that distance in as
 * a constant is wrong in both directions at once: too small on a slow phone, so the work is wasted
 * AND the sim is still late; too large on a fast desktop, so a heavy document is held resident far
 * longer than it needs to be against a hard residency cap.
 *
 * There are two sources of a real number, and they are used in this order:
 *
 *   1. What THIS session measured. Best, because it reflects this device on this network — but only
 *      after enough transitions have completed to be worth trusting.
 *   2. The package's own publish-time canary. Already recorded per step, for exactly these bytes,
 *      on a machine we controlled. A lab number for the right package beats a constant for every
 *      package, and it is available on the very first view, which is when nothing has been measured
 *      yet and the guess would otherwise be worst.
 *
 * The floor exists because the canary runs on CI hardware, which is not a phone. It is a floor and
 * not a multiplier: scaling a lab number by a guessed factor would just be a constant wearing a
 * measurement's clothes.
 */

/** The canary already records `ms` per step; these are the steps that make up a preparation. */
export const BUDGET_STEPS = ['load', 'handshake', 'prepare', 'section-applied'] as const;
export type BudgetStep = (typeof BUDGET_STEPS)[number];

/** No package prepares faster than this in the field, whatever a CI machine managed. */
export const MIN_BUDGET_MS = 250;
/** Nothing waits longer than this for a preparation; beyond it, a poster is the better answer. */
export const MAX_BUDGET_MS = 10_000;

export interface CanaryStepLike {
  step: string;
  ms?: number | null;
  status?: string;
}

/**
 * Sum the preparation-relevant canary steps.
 *
 * Steps are summed rather than maximised because they are SEQUENTIAL — the document loads, then
 * handshakes, then prepares, then applies — so the cost of getting to a usable section is their
 * total. Taking the maximum would describe the slowest single hop and systematically under-budget
 * every package with several moderate steps.
 *
 * Returns null when nothing usable is present, so a caller can tell "no lab data" from "fast".
 */
export function canaryPrepareMs(steps: readonly CanaryStepLike[] | null | undefined): number | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const wanted = new Set<string>(BUDGET_STEPS);
  let total = 0;
  let seen = 0;
  for (const s of steps) {
    if (!s || typeof s.step !== 'string' || !wanted.has(s.step)) continue;
    // A FAILED step's duration describes how long the failure took, not how long the work takes.
    // Including it would budget for a path this package does not have.
    if (s.status !== undefined && s.status !== 'pass') continue;
    if (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms < 0) continue;
    total += s.ms;
    seen += 1;
  }
  return seen > 0 ? Math.round(total) : null;
}

export interface BudgetInput {
  /** p90 of completed transitions measured in THIS session, or null before there are enough. */
  measuredP90Ms: number | null;
  /** Sum of the package's publish-time canary preparation steps, or null when never canaried. */
  canaryMs: number | null;
  /** Multiplier applied to a measured p90 so the budget covers more than exactly nine in ten. */
  safetyFactor?: number;
}

export interface Budget {
  ms: number;
  /** Which source produced it. A caller must never be unable to tell a measurement from a guess. */
  source: 'measured' | 'canary' | 'floor';
}

/**
 * Resolve the budget from the best available source.
 *
 * `source` is part of the return value, not a log line: a closed-loop controller that cannot
 * distinguish a measured budget from a default would eventually treat its own fallback as evidence
 * and adapt to it.
 */
export function resolveBudget(input: BudgetInput): Budget {
  const clamp = (n: number): number =>
    Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(n)));

  if (typeof input.measuredP90Ms === 'number' && Number.isFinite(input.measuredP90Ms)
      && input.measuredP90Ms > 0) {
    return { ms: clamp(input.measuredP90Ms * (input.safetyFactor ?? 1.25)), source: 'measured' };
  }
  if (typeof input.canaryMs === 'number' && Number.isFinite(input.canaryMs) && input.canaryMs > 0) {
    // No safety factor on the lab number. The floor already covers the CI-hardware gap, and
    // multiplying a lab measurement by a guess would produce a constant pretending to be data.
    return { ms: clamp(input.canaryMs), source: 'canary' };
  }
  return { ms: MIN_BUDGET_MS, source: 'floor' };
}

/**
 * Should preparation for a section start yet?
 *
 * Pure, and takes the clock as an argument, so the scheduler that calls it stays testable without
 * fake timers and a pathological ordering can be constructed directly.
 *
 * A section already past its start is NOT due for preparation — it is late, and the caller's job is
 * then to activate it immediately rather than to schedule work for it.
 */
export function isDueForPrepare(opts: {
  nowSec: number;
  sectionStartSec: number;
  budgetMs: number;
}): boolean {
  // No explicit non-finite guard: the comparison below already rejects every such input. NaN makes
  // `until` NaN and `NaN > 0` is false; an infinite start makes `until` infinite and
  // `Infinity <= leadSec` is false. A guard here was unkillable by any mutation for exactly that
  // reason, and an unfalsifiable check invites a later reader to weaken the comparison believing it
  // is still covered.
  const leadSec = Math.max(0, opts.budgetMs) / 1000;
  const until = opts.sectionStartSec - opts.nowSec;
  return until > 0 && until <= leadSec;
}
