/**
 * Which pooled frames a residency pass may evict — the ONE place the fade guard lives.
 *
 * WHY THIS IS A MODULE AND NOT AN `if` AT EACH CALL SITE
 * The player had five eviction sites. Three checked `isFadingOut`, two did not, and the two that
 * did not were the ones that actually ran:
 *
 *   - `ensurePooledSpec`'s single-mode loop DID spare a fading frame, and its comment promised the
 *     frame "is evicted on the next tick, once the fade is done" — but the per-tick residency loop
 *     had no fade check at all, so the tick that followed evicted it mid-fade regardless. Both
 *     single-mode guards were defeated within the same tick.
 *   - the hard-cap eviction picked its victim by active/warming only, so on a strong device with
 *     more packages than the cap it could drop the frame currently fading out.
 *
 * Unmounting mid-fade removes the element being animated: the simulation CUTS to video instead of
 * fading, and the deferred stopScript fires into a dead frame. 'single' is the mode an operator
 * selects during an incident, which is the worst possible moment to add a visible glitch.
 *
 * Centralising the rule means a future eviction path cannot be written without it, and one unit
 * test covers every tier.
 */

export interface ResidentSpecLike {
  key: string;
}

/**
 * Frames a pass must leave alone, for two different reasons that both end in "not this pass".
 *
 * `isFadingOut` — an exit fade still owes this frame work. Unmounting it removes the element being
 * animated, so the simulation CUTS to video and the deferred stopScript fires into a dead frame.
 *
 * `isEvicting` — a two-phase eviction is already under way on this frame: it has been marked, muted
 * and frozen, its section released, and the parent is waiting for the child's DISPOSED before
 * removing the element. Selecting it AGAIN would start a second teardown of one document — a second
 * RELEASE_SECTION and DISPOSE_DOCUMENT into a port that is mid-handshake — and, worse, would report
 * one eviction twice, so the clean-vs-forced record the handshake exists to produce would count
 * frames that were never separately evicted. It is already leaving; a pass that "evicts" it again
 * achieves nothing and corrupts the measurement.
 *
 * Optional so every existing call site keeps compiling and keeps its exact behaviour: with no
 * predicate, nothing is evicting, which is what was true before two-phase eviction existed.
 */
export interface ResidencyGuards {
  isFadingOut: (key: string) => boolean;
  isEvicting?: (key: string) => boolean;
}

/** One place that answers "may this pass touch this frame at all?", for both guards. */
const sparedBy = (g: ResidencyGuards, key: string): boolean =>
  g.isFadingOut(key) || g.isEvicting?.(key) === true;

/**
 * Single-tier residency: keep ONLY the active package, and never evict a frame still fading out.
 *
 * A fading frame is spared for THIS pass and collected by a later pass once `isFadingOut` goes
 * false, which is what makes the "at most one resident document in steady state" promise true
 * without cutting a transition. The promise was always about steady state, never about the
 * ~200ms of an exit fade.
 */
export function singleModeEvictions(
  specs: readonly ResidentSpecLike[],
  activeKey: string | null,
  guards: ResidencyGuards | ((key: string) => boolean),
): string[] {
  // Accepts the bare `isFadingOut` predicate it has always taken, or the guard record. Two shapes
  // rather than a migration of every call site in one commit: an eviction rule is the last place to
  // want a mechanical edit across five sites, four of which this change does not otherwise touch.
  const g: ResidencyGuards = typeof guards === 'function' ? { isFadingOut: guards } : guards;
  return specs
    .filter((s) => s.key !== activeKey && !sparedBy(g, s.key))
    .map((s) => s.key);
}

/**
 * Hard-cap residency: the single victim to evict before admitting `incomingKey`, or null when the
 * pool is under the cap or every candidate must be spared.
 *
 * Preference order among evictable frames is unchanged (neither active nor warming first, then
 * merely not-active), with fading frames removed from BOTH tiers rather than used as a fallback.
 * If that leaves nothing, the pass admits without evicting and the pool sits one frame over the
 * cap until the fade resolves — a bounded, self-clearing overshoot, because a deferred stop always
 * completes on its timer. Cutting a live transition to hold an internal cap exactly is the worse
 * trade.
 */
export function hardCapEviction(
  specs: readonly ResidentSpecLike[],
  incomingKey: string,
  activeKey: string | null,
  warmingKey: string | null,
  cap: number,
  guards: ResidencyGuards | ((key: string) => boolean),
): string | null {
  const g: ResidencyGuards = typeof guards === 'function' ? { isFadingOut: guards } : guards;
  // An EVICTING frame still counts toward the cap and is deliberately not subtracted here: its
  // element is still in the DOM and its WebGL context is still allocated until the child answers,
  // so pretending the slot is already free is how the pool ends up over the browser's context
  // budget for the length of a disposal handshake. It is only excluded from being CHOSEN below.
  if (specs.length + 1 <= cap) return null;
  return pickVictim(specs, incomingKey, activeKey, warmingKey, g);
}

/** Preference order among frames a pass may take: neither active nor warming first, then merely not-active. */
function pickVictim(
  specs: readonly ResidentSpecLike[],
  excludeKey: string | null,
  activeKey: string | null,
  warmingKey: string | null,
  g: ResidencyGuards,
): string | null {
  const evictable = specs.filter((s) => s.key !== excludeKey && !sparedBy(g, s.key));
  const victim =
    evictable.find((s) => s.key !== activeKey && s.key !== warmingKey)
    ?? evictable.find((s) => s.key !== activeKey);
  return victim ? victim.key : null;
}

/**
 * Bring a pool that is ALREADY over the hard cap back down to it — the collection pass that makes
 * `hardCapEviction`'s overshoot the "bounded, self-clearing" thing its comment claims.
 *
 * It was not self-clearing. `hardCapEviction` returns null whenever every candidate must be
 * spared, and the caller then admits anyway, over the cap — which is the right trade against
 * cutting a live exit fade. But the hard cap was enforced at ADMISSION ONLY: no later pass ever
 * looked at it again, so once the fade or the disposal handshake that forced the overshoot
 * resolved, nothing came back for the extra frame. The pool simply stayed over the browser's
 * live-WebGL-context budget until some unrelated tier rule happened to evict something, which at
 * the 'all' tier is never.
 *
 * Victims are chosen in `hardCapEviction`'s exact preference order and obey the same guards, so a
 * frame mid-fade or mid-eviction is spared here too and collected by a later pass. The result is
 * bounded by construction: it never returns more keys than the overshoot, and it stops as soon as
 * nothing may be taken, so a pool of nothing but spared frames yields an empty list rather than a
 * pass that cannot terminate.
 */
export function overCapEvictions(
  specs: readonly ResidentSpecLike[],
  activeKey: string | null,
  warmingKey: string | null,
  cap: number,
  guards: ResidencyGuards | ((key: string) => boolean),
): string[] {
  const g: ResidencyGuards = typeof guards === 'function' ? { isFadingOut: guards } : guards;
  const victims: string[] = [];
  let remaining = [...specs];
  while (remaining.length > cap) {
    const victim = pickVictim(remaining, null, activeKey, warmingKey, g);
    if (victim === null) break;   // everything left must be spared — a later pass collects it
    victims.push(victim);
    remaining = remaining.filter((s) => s.key !== victim);
  }
  return victims;
}
