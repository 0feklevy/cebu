/**
 * Transition timing (Priority 8.1 / 8.9) — what a section transition actually costs.
 *
 * WHY THIS EXISTS
 * Nothing in this pipeline has ever measured a transition. `SimRuntimeClient` reads no clock at
 * all, and the child's own measurements — `applyMs`, `framesSubmitted`, `canvas`, resource `counts`
 * — are computed, put on the wire, and thrown away by the parent. Every existing bound is a
 * wall-clock DEADLINE on a protocol step (fail if slower than X), never a measurement of cost. So
 * questions the rest of Priority 8 depends on are currently unanswerable:
 *
 *   • how much lead time does preparing a section actually need?  (a lead time guessed as a
 *     constant is the thing this module exists to avoid)
 *   • is same-package switching slow enough to be worth new protocol machinery?
 *   • did a change make transitions faster, or did it just feel faster?
 *
 * THIS MODULE IS PURE AND HAS NO CLOCK OF ITS OWN
 * Callers pass timestamps in. That keeps it testable without fake timers, keeps it usable from the
 * backend (which has a different clock origin), and means a test can construct a pathological
 * ordering directly rather than trying to provoke one.
 *
 * DURATIONS ARE NULL WHEN UNKNOWN, NEVER ZERO
 * A missing stage is not a fast stage. Zero is a real, achievable measurement, so using it as the
 * absent value makes "we never saw this" indistinguishable from "this was instantaneous" — and the
 * second is exactly what a broken measurement looks like.
 */

/** The stages of one activation, in the order the protocol produces them. */
export type TransitionStage =
  /** Parent decided this section should become live. The clock starts here, not at PREPARE. */
  | 'requested'
  /** PREPARE_SECTION posted to the child. */
  | 'prepare-sent'
  /** SECTION_APPLIED received — the child ran the section body. */
  | 'applied'
  /** PRESENT_SECTION posted. */
  | 'present-sent'
  /** SECTION_PRESENTED received with framesSubmitted >= 1. */
  | 'presented'
  /** The frame was actually revealed to the viewer. The only stage a human perceives. */
  | 'revealed';

export const TRANSITION_STAGES: readonly TransitionStage[] = [
  'requested', 'prepare-sent', 'applied', 'present-sent', 'presented', 'revealed',
];

export interface TransitionMarks {
  /** Monotonic timestamps in ms, one per observed stage. Absent stages are simply missing. */
  marks: Partial<Record<TransitionStage, number>>;
  /** The child's OWN measurement of how long the section body took. It is not our clock. */
  applyMs?: number | null;
  framesSubmitted?: number | null;
  canvas?: { width: number; height: number } | null;
}

export interface TransitionDurations {
  /** requested → prepare-sent. Parent-side scheduling overhead. */
  dispatchMs: number | null;
  /** prepare-sent → applied. Round trip plus the child running the body. */
  prepareMs: number | null;
  /** applied → present-sent. Parent turnaround. */
  turnaroundMs: number | null;
  /** present-sent → presented. Round trip plus the child rendering a frame. */
  presentMs: number | null;
  /** presented → revealed. Reveal-invariant check plus compositing. */
  revealMs: number | null;
  /**
   * requested → revealed. THE number that matters: everything a viewer waits through.
   * Null unless both ends were observed — a partial transition has no total.
   */
  totalMs: number | null;
  /**
   * The child's self-reported body cost, passed through unchanged. Kept separate from `prepareMs`
   * deliberately: `prepareMs` includes two postMessage hops that `applyMs` does not, and averaging
   * them together would hide whether a slow prepare is the package's fault or the transport's.
   */
  applyMs: number | null;
}

const diff = (
  m: Partial<Record<TransitionStage, number>>,
  a: TransitionStage,
  b: TransitionStage,
): number | null => {
  const x = m[a]; const y = m[b];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Negative durations are dropped rather than clamped to zero. A stage that appears to precede the
  // one before it means the marks were recorded out of order — a real bug — and clamping would
  // launder it into a plausible-looking 0 ms that no percentile could ever flag.
  const d = y - x;
  return d >= 0 ? d : null;
};

export function computeDurations(t: TransitionMarks): TransitionDurations {
  const m = t.marks;
  return {
    dispatchMs: diff(m, 'requested', 'prepare-sent'),
    prepareMs: diff(m, 'prepare-sent', 'applied'),
    turnaroundMs: diff(m, 'applied', 'present-sent'),
    presentMs: diff(m, 'present-sent', 'presented'),
    revealMs: diff(m, 'presented', 'revealed'),
    totalMs: diff(m, 'requested', 'revealed'),
    applyMs: typeof t.applyMs === 'number' && Number.isFinite(t.applyMs) && t.applyMs >= 0
      ? t.applyMs
      : null,
  };
}

/** Did this transition run to completion, or was it abandoned part-way? */
export function isComplete(t: TransitionMarks): boolean {
  return typeof t.marks.requested === 'number' && typeof t.marks.revealed === 'number';
}

/**
 * The furthest stage reached. Answers "where do transitions die" without needing a total.
 *
 * An abandoned transition is data, not noise: a package that always dies at `applied` is failing
 * differently from one that dies at `prepare-sent`, and a summary that only counted completed
 * transitions would report both as simply absent.
 */
export function furthestStage(t: TransitionMarks): TransitionStage | null {
  let last: TransitionStage | null = null;
  for (const s of TRANSITION_STAGES) {
    if (typeof t.marks[s] === 'number') last = s;
  }
  return last;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────────────────────────

export interface TransitionSummary {
  samples: number;
  completed: number;
  /** Where incomplete transitions stopped, counted per stage. */
  abandonedAt: Partial<Record<TransitionStage, number>>;
  p50TotalMs: number | null;
  p90TotalMs: number | null;
  maxTotalMs: number | null;
  p50PrepareMs: number | null;
  p90PrepareMs: number | null;
  p50ApplyMs: number | null;
}

/**
 * The percentile of a sorted sample, by nearest-rank.
 *
 * Nearest-rank rather than interpolation, deliberately: every value it returns is a measurement
 * that actually occurred. An interpolated p90 is a number no transition ever took, which is a poor
 * basis for a budget someone will later be paged about.
 */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 1) return sortedAsc[sortedAsc.length - 1]!;
  const rank = Math.ceil(p * sortedAsc.length);
  return sortedAsc[Math.min(rank, sortedAsc.length) - 1]!;
}

const sortedFinite = (xs: readonly (number | null)[]): number[] =>
  xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);

export function summarize(transitions: readonly TransitionMarks[]): TransitionSummary {
  const durations = transitions.map(computeDurations);
  const totals = sortedFinite(durations.map((d) => d.totalMs));
  const prepares = sortedFinite(durations.map((d) => d.prepareMs));
  const applies = sortedFinite(durations.map((d) => d.applyMs));

  const abandonedAt: Partial<Record<TransitionStage, number>> = {};
  let completed = 0;
  for (const t of transitions) {
    if (isComplete(t)) { completed += 1; continue; }
    const s = furthestStage(t);
    if (s) abandonedAt[s] = (abandonedAt[s] ?? 0) + 1;
  }

  return {
    samples: transitions.length,
    completed,
    abandonedAt,
    p50TotalMs: percentile(totals, 0.5),
    p90TotalMs: percentile(totals, 0.9),
    maxTotalMs: totals.length ? totals[totals.length - 1]! : null,
    p50PrepareMs: percentile(prepares, 0.5),
    p90PrepareMs: percentile(prepares, 0.9),
    p50ApplyMs: percentile(applies, 0.5),
  };
}

// ─── Derived lead time ───────────────────────────────────────────────────────────────────────────

/**
 * How far ahead of a section boundary preparation must begin.
 *
 * DERIVED FROM MEASUREMENT, NEVER GUESSED. A constant lead time is wrong in both directions at
 * once: too small on a slow phone (the sim is late anyway, and the work was wasted) and too large
 * on a fast desktop (a document is held resident far longer than it needs to be, against a hard
 * residency cap). The p90 is used rather than the median because a lead time that is right half the
 * time is not a lead time.
 *
 * `fallbackMs` is what to use before enough samples exist. It should come from the package's own
 * publish-time canary, which already records per-step `ms` — a lab number for these exact bytes is
 * a far better prior than any constant compiled into the client.
 */
export function deriveLeadMs(opts: {
  summary: TransitionSummary;
  fallbackMs: number;
  minSamples?: number;
  safetyFactor?: number;
  maxMs?: number;
}): { leadMs: number; source: 'measured' | 'fallback'; } {
  const minSamples = opts.minSamples ?? 5;
  const safety = opts.safetyFactor ?? 1.25;
  const cap = opts.maxMs ?? 10_000;

  const clamp = (n: number): number => Math.min(cap, Math.max(0, Math.round(n)));

  // Below `minSamples` the p90 of a handful of transitions is mostly noise, and adopting it would
  // let one slow first load pin the lead time high for the rest of the session.
  if (opts.summary.completed < minSamples || opts.summary.p90TotalMs === null) {
    return { leadMs: clamp(opts.fallbackMs), source: 'fallback' };
  }
  return { leadMs: clamp(opts.summary.p90TotalMs * safety), source: 'measured' };
}
