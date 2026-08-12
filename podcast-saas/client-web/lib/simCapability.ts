// Whether it's worth WARMING a sim iframe unpaused (letting it run frames while hidden so
// it paints before the boundary). The warm is always *safe* — if a device throttles hidden
// iframes it simply never acks SIM_PAINTED and the player falls back to a bounded hold — but
// on low-end / data-saving devices the extra GPU work isn't worth it, so we skip it and park
// the sim cold at SIM_READY instead. Unknown = conservative (skip). SSR-safe.

interface NavigatorLike extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

export function canWarmUnpaused(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorLike;
  if (nav.connection?.saveData) return false;                 // respect Data Saver
  const mem   = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  if (mem !== null && mem <= 4) return false;
  // The ≤4-core threshold deliberately matches the `lowend=1` hint shared/src/sim/simUrl.ts
  // stamps into every sim URL (hardwareConcurrency <= 4). Before this check, a 4-core device
  // with unknown memory and a fine pointer was told it is low-end inside its own sim URL while
  // this classifier handed it pool tier 'all' (CLASSIFY) — the two must agree.
  if (cores !== null && cores <= 4) return false;
  // Neither memory nor cores reported at all: unknown = conservative (skip), exactly as the
  // header documents. (Firefox/Safari expose neither `deviceMemory` nor, in some privacy
  // configurations, a truthful `hardwareConcurrency`.)
  if (mem === null && cores === null) return false;
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return false; // touch/mobile
  } catch { /* matchMedia unavailable — fall through */ }
  return true;
}

// ── paint-ack capability ─────────────────────────────────────────────────────────────────────
/**
 * Evidence that a PACKAGE's document can emit SIM_PAINTED at all — i.e. that the injected rAF
 * gate is the v4 one, which drives a real animation frame and answers PING_SIM_PAINTED.
 *
 * This is a capability of the paint channel, and it is deliberately NOT a restatement of anything
 * SimRuntimeClient classifies. The runtime owns two other, genuinely different capabilities:
 *   • `dynamic`    — can this document switch sections IN PLACE (SIM_READY's dispatch field)?
 *   • `ackCapable` — has this document ever emitted SCRIPT_APPLIED?
 * Neither answers "will a paint ack ever arrive", and both legitimately disagree with it:
 *   • ackCapable === true while canEmitPaint === false — a DOM / setInterval-canvas package
 *     acknowledges every startScript but never drives requestAnimationFrame.
 *   • dynamic === false while canEmitPaint === true — a load-time-locked package rebuilt with the
 *     v4 gate paints honestly but still needs a per-section URL to change section.
 * It also differs from the runtime's `painted`, which is a per-DOCUMENT fact that every reload
 * resets. Capability is a per-PACKAGE fact: a package that has once proven it paints does not
 * stop being able to, so this is monotonic across navigations of the same pooled package.
 */
export interface PaintCapabilityEvidence {
  /** The document emitted a real SIM_PAINTED (proof — the rAF gate ran). */
  painted?: boolean;
  /**
   * The RUNTIME's own `dynamic` classification. Read from SimRuntimeClient state, never
   * re-derived from the wire: dispatch capability is classified in exactly one place, and this
   * only draws an implication from it (the dynamic bridge ships with the v4 gate).
   */
  dynamic?: boolean | null;
}

/** Fold new evidence into a package's paint-ack capability. Monotonic: capability is never lost. */
export function learnCanEmitPaint(prev: boolean, ev: PaintCapabilityEvidence): boolean {
  if (prev) return true;               // per-PACKAGE and sticky — a reload cannot un-prove it
  if (ev.painted) return true;         // proof: the rAF gate ran and acked
  return ev.dynamic === true;          // implication: the dynamic bridge is the rebuilt package
}
