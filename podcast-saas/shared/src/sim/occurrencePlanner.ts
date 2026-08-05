/**
 * Occurrence planning and predictive admission (Priority 8.2 / 8.3 / 8.4 / 8.5).
 *
 * WHAT AN OCCURRENCE IS
 * A section that will need a simulation document, at a known time. The planner's job is to answer
 * two questions the player currently answers by accident:
 *
 *   • which package should be resident RIGHT NOW, given a hard residency cap; and
 *   • which one should start preparing, given how long preparation actually costs.
 *
 * PURE, AND THE CLOCK IS AN ARGUMENT
 * Everything here is a function of (occurrences, nowSec, budgets, capacity). No timers, no DOM, no
 * hidden state. That makes a pathological timeline directly constructible in a test instead of
 * something to be provoked, and it is why the eviction and admission rules can be mutation-tested
 * at all.
 *
 * PACKAGES ARE THE UNIT OF RESIDENCY, SECTIONS ARE THE UNIT OF PLANNING
 * Several sections commonly share one package — the pool holds one document per package, and each
 * section is a variant within it. Planning per section but admitting per package is what keeps the
 * residency cap meaningful; treating them as the same thing is how a pool silently holds the same
 * document three times.
 */

export interface SimOccurrence {
  /** Section id — what the player dispatches on. */
  sectionId: string;
  /** The package this section lives in. Several sections may share one. */
  packageKey: string;
  startSec: number;
  endSec: number;
}

export interface PlanInput {
  occurrences: readonly SimOccurrence[];
  nowSec: number;
  /** How many documents may be resident at once. */
  capacity: number;
  /** Per-package preparation budget in ms. Absent means "unknown", never "free". */
  budgetMsFor: (packageKey: string) => number;
  /**
   * How far ahead the video is buffered, in seconds. Speculative work is admitted only when the
   * viewer can actually reach the section — preparing a document the network cannot yet deliver
   * competes with the segment fetches that would make it reachable.
   */
  bufferedAheadSec?: number;
}

export type AdmitReason =
  /** The section playing right now. Always admitted, whatever else is competing. */
  | 'active'
  /** Inside its preparation lead window. */
  | 'due'
  /** Neither, but there is spare capacity and it is the next thing coming. */
  | 'speculative';

export interface PlannedEntry {
  packageKey: string;
  /** Earliest upcoming start among this package's occurrences. The eviction ordering key. */
  dueAtSec: number;
  reason: AdmitReason;
}

export interface Plan {
  /** Packages that should be resident, most urgent first. Never longer than `capacity`. */
  admit: PlannedEntry[];
  /** Packages that should begin preparing now. Always a subset of `admit`. */
  prepare: string[];
  /** Packages that should be dropped if currently resident. */
  evict: string[];
}

/** The occurrence covering `nowSec`, if any. Half-open [start, end) so a boundary is unambiguous. */
export function activeOccurrence(
  occurrences: readonly SimOccurrence[],
  nowSec: number,
): SimOccurrence | null {
  let best: SimOccurrence | null = null;
  for (const o of occurrences) {
    if (nowSec >= o.startSec && nowSec < o.endSec) {
      // Overlaps are resolved by the LATEST start rather than by array position, so a plan does not
      // depend on how the timeline happened to be ordered in the database.
      if (!best || o.startSec > best.startSec) best = o;
    }
  }
  return best;
}

/**
 * The soonest upcoming start for each package.
 *
 * A package whose only occurrences are in the past has no due time and is therefore never admitted
 * speculatively — but it may still be the ACTIVE one, which is why activity is decided separately.
 */
export function dueTimes(
  occurrences: readonly SimOccurrence[],
  nowSec: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of occurrences) {
    if (o.startSec < nowSec) continue;
    const prev = out.get(o.packageKey);
    if (prev === undefined || o.startSec < prev) out.set(o.packageKey, o.startSec);
  }
  return out;
}

/**
 * Decide what should be resident and what should be preparing.
 *
 * The ordering rule is "soonest needed wins", and the ACTIVE package outranks everything — including
 * a package due sooner in wall-clock terms, which cannot happen for a well-formed timeline but can
 * for an overlapping one. Evicting what is on screen to make room for what is coming is the one
 * mistake a residency planner must never make.
 */
export function planResidency(input: PlanInput): Plan {
  const { occurrences, nowSec, capacity } = input;
  const cap = Math.max(0, Math.floor(capacity));

  const active = activeOccurrence(occurrences, nowSec);
  const due = dueTimes(occurrences, nowSec);

  const candidates: PlannedEntry[] = [];
  const seen = new Set<string>();

  if (active) {
    candidates.push({ packageKey: active.packageKey, dueAtSec: nowSec, reason: 'active' });
    seen.add(active.packageKey);
  }

  const upcoming = [...due.entries()]
    .filter(([k]) => !seen.has(k))
    .sort((a, b) => a[1] - b[1]);

  for (const [packageKey, dueAtSec] of upcoming) {
    const budgetMs = input.budgetMsFor(packageKey);
    const isDue = withinLead(nowSec, dueAtSec, budgetMs);
    candidates.push({ packageKey, dueAtSec, reason: isDue ? 'due' : 'speculative' });
    seen.add(packageKey);
  }

  // `due` before `speculative`, then soonest first. A package inside its lead window is work that
  // must happen; a speculative one is work that merely might pay off, and it must never displace it.
  const rank = (e: PlannedEntry): number => (e.reason === 'active' ? 0 : e.reason === 'due' ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b) || a.dueAtSec - b.dueAtSec);

  // `seen` above is the single authority on de-duplication: every package appears in `candidates`
  // exactly once, so the overflow slice cannot contain an admitted key. A defensive filter here was
  // unkillable by any mutation for that reason, and an unfalsifiable guard invites a later reader to
  // weaken the de-duplication believing this still covers it.
  const admit = candidates.slice(0, cap);
  const evict = candidates.slice(cap).map((e) => e.packageKey);

  // Preparation is admitted only for entries inside their lead window AND reachable in the buffer.
  // Speculative residency is cheap (an idle document); speculative PREPARATION is not, because it
  // runs the section body.
  const prepare = admit
    .filter((e) => e.reason === 'due')
    .filter((e) => reachable(input, e.dueAtSec, nowSec))
    .map((e) => e.packageKey);

  return { admit, prepare, evict };
}

/** Inside the lead window: strictly ahead, and no further than the budget allows. */
function withinLead(nowSec: number, startSec: number, budgetMs: number): boolean {
  const leadSec = Math.max(0, budgetMs) / 1000;
  const until = startSec - nowSec;
  return until > 0 && until <= leadSec;
}

/**
 * Can the viewer actually reach this section with what is buffered?
 *
 * An unknown buffer is treated as reachable. Refusing to prepare because we cannot measure the
 * buffer would disable predictive preparation entirely on any browser that does not report it —
 * turning a missing signal into a permanent regression.
 */
function reachable(input: PlanInput, startSec: number, nowSec: number): boolean {
  const buf = input.bufferedAheadSec;
  if (typeof buf !== 'number' || !Number.isFinite(buf)) return true;
  return nowSec + buf >= startSec;
}
