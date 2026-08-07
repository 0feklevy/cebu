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
  isFadingOut: (key: string) => boolean,
): string[] {
  return specs
    .filter((s) => s.key !== activeKey && !isFadingOut(s.key))
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
  isFadingOut: (key: string) => boolean,
): string | null {
  if (specs.length + 1 <= cap) return null;
  const evictable = specs.filter((s) => s.key !== incomingKey && !isFadingOut(s.key));
  const victim =
    evictable.find((s) => s.key !== activeKey && s.key !== warmingKey)
    ?? evictable.find((s) => s.key !== activeKey);
  return victim ? victim.key : null;
}
