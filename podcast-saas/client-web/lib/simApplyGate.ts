// Presentation gate for a same-document activation — pure, unit-tested.
//
// A pooled simulation document serves many sections. `painted` only certifies that the document
// once drew SOMETHING (its boot scene, its default sub-simulation, the previous section's frozen
// frame, or whatever a warm pass ran), so revealing on `painted` alone can present the wrong
// sub-simulation. The v2.1 bridge acknowledges each applied section with SCRIPT_APPLIED; this
// decides when the player is allowed to wait for that acknowledgement.
//
// ── WHAT CHANGED, AND WHY (audit P0.5: the first-activation identity hole) ───────────────────
// This gate used to reason from ONE capability signal: `ackCapable`, which is learned IN-SESSION
// from the first SCRIPT_APPLIED this document happens to emit. Before that first ack there was no
// evidence either way, so the gate took a shortcut — `lastScript === null` meant "first activation,
// nothing to switch away from, reveal" — and that shortcut was false for exactly the documents the
// pool exists to create. A resident frame boots, paints, and freezes long before its first
// REQUESTED activation; when the request finally arrives, `lastScript` is null and the canvas is
// already full of pixels belonging to something else. The viewer showed them.
//
// The fix is not a better guess. Capability is now KNOWN before the first activation, because the
// publication that assembled the bridge recorded whether it posts SCRIPT_APPLIED
// (shared/src/sim/bridgeCapability.ts → sim_revisions.metadata → simulations.bridge_ack_capable →
// PlayerConfig `bridge_ack_capable` → `packageAckCapable` below). So the gate now reasons from
// THREE capability states instead of two:
//
//   KNOWN-CAPABLE   (in-session ack observed, or the package record says so)
//       → wait for the matching ack, including on a first activation. Never force-revealed on a
//         timer: a slow body (the generation prompt tells bodies to poll for async-built controls
//         at ~200ms intervals) must not be able to cause a wrong-section frame.
//   KNOWN-INCAPABLE (the package record says the bridge posts no ack)
//       → reveal. Waiting on a bridge that provably cannot answer is waiting on silence, and an
//         unbounded wait would make such packages undisplayable.
//   UNKNOWN         (published before the record existed, or unclassified)
//       → 'await-ack-bounded': hold, but BOUNDED. Hold the valid outgoing content, and at the
//         deadline select a COVER — never a reveal (audit §21 rule 7). The deadline is reported so
//         the population that reaches it is a measurement rather than a belief.
//
// The `stopped` case keeps its priority over the first-activation and same-section shortcuts: a
// torn-down document shows the previous section's frozen frame with its full UI restored, which is
// the exact defect this gate exists to prevent, and it is NOT a fresh document.

export type ApplyGateDecision =
  /** Safe to present immediately: no pixels currently on this document can be the wrong ones. */
  | 'reveal-now'
  /** Hold until the matching SCRIPT_APPLIED. No deadline may substitute for it. */
  | 'await-ack'
  /** Hold, bounded. At the deadline the player selects a cover and reports — it never reveals. */
  | 'await-ack-bounded';

export interface ApplyGateMeta {
  /** v2 dynamic-dispatch capability; null until SIM_READY classifies the document. */
  dynamic: boolean | null;
  /**
   * IN-SESSION evidence: true once THIS document has emitted at least one SCRIPT_APPLIED. Null
   * before that, and null is not "no" — it is "no evidence yet", which is why it can no longer be
   * the only capability input.
   */
  ackCapable: boolean | null;
  /**
   * PUBLICATION-TIME record for the package: does its bridge post SCRIPT_APPLIED at all?
   * `null`/absent means never recorded (UNKNOWN). Evidence outranks the record — a document that
   * has actually acknowledged is capable whatever a stale row says — but the record is what makes
   * the FIRST activation a lookup instead of a guess.
   */
  packageAckCapable?: boolean | null;
  /**
   * Has this DOCUMENT drawn anything at all yet?
   *
   * The hazard is never "a first activation"; it is "pixels on the canvas that belong to something
   * other than the section being requested". A document that has painted NOTHING has no such
   * pixels — its boot scene has not drawn, there is no default sub-simulation on screen, no warm
   * pass left a frame — so holding it would delay every cold entry to protect against a frame that
   * does not exist, and for a legacy package that can never acknowledge it would delay it forever.
   * A document that HAS painted before its first requested activation is precisely the pooled,
   * pre-warmed case the audit found.
   *
   * Optional, and absent reads as "not painted": the only callers that omit it are tests of the
   * cold path, where that is also the truth.
   */
  painted?: boolean;
  /** The script this document last applied (or was last sent). */
  lastScript: string | null;
  /**
   * True once a deferred `stopScript` tore the last section down. Such a document is NOT a fresh
   * one: its cleanup ran and restored whatever the section had hidden (full UI back), while the
   * canvas still holds that section's frozen frame. Tracked separately because `lastScript: null`
   * means "nothing applied yet", which used to read as a genuine first activation.
   */
  stopped?: boolean;
}

/** The three capability states, resolved once so every branch below reads the same answer. */
export type ApplyGateCapability = 'capable' | 'incapable' | 'unknown';

export function capabilityOf(meta: ApplyGateMeta): ApplyGateCapability {
  // EVIDENCE FIRST. A document that has acknowledged is capable no matter what was recorded about
  // the package — the record can be stale (a republished package viewed from a cached config), the
  // observation cannot.
  if (meta.ackCapable === true) return 'capable';
  if (meta.packageAckCapable === true) return 'capable';
  // Only an explicit `false` proves incapability. `null`/`undefined` is the absence of a record and
  // must never be read as one, which is the whole reason this is not a boolean.
  if (meta.ackCapable === false || meta.packageAckCapable === false) return 'incapable';
  return 'unknown';
}

/**
 * The hold a document with unverifiable pixels deserves, given what is known about the package.
 *
 * Factored out because THREE branches need the same mapping (a torn-down document, a first
 * activation, a genuine section switch) and writing it three times is how they drift apart.
 */
const holdFor = (cap: ApplyGateCapability): ApplyGateDecision =>
  cap === 'capable' ? 'await-ack'
    : cap === 'incapable' ? 'reveal-now'
      : 'await-ack-bounded';

export function applyGateFor(meta: ApplyGateMeta, nextScript: string): ApplyGateDecision {
  // A load-time-locked bridge NAVIGATES to a per-section URL rather than switching in place, so the
  // document the player is about to show is a brand-new one with nothing on it. There is no wrong
  // frame to protect against and no in-place ack to wait for.
  if (meta.dynamic !== true) return 'reveal-now';

  const cap = capabilityOf(meta);

  // A torn-down document shows the previous section's frozen frame with its full UI restored.
  // Checked BEFORE the two shortcuts below because it is precisely the state that LOOKS like a
  // fresh document (`lastScript` is null) and is not one (audited).
  if (meta.stopped) return holdFor(cap);

  // FIRST ACTIVATION. This was the hole: it returned 'reveal-now' unconditionally, on the reasoning
  // that there is "nothing to switch away from". That is true only of a document that has drawn
  // nothing — and the resident pool exists to make sure that is NOT the usual case. A pooled frame
  // boots, paints its scene and freezes long before the section it was mounted for is entered, so
  // by the time the first activation is requested the canvas is full of pixels belonging to the
  // package's boot scene, its default sub-simulation, or whatever a warm pass ran. Those are the
  // wrong sub-simulation, and they were revealed on sight, once per package per session.
  //
  // The distinction is `painted`, not the activation count.
  if (meta.lastScript === null) return meta.painted === true ? holdFor(cap) : 'reveal-now';

  // RE-ENTERING THE SAME SECTION on a document that was not torn down: the body is still installed
  // and the pixels on screen are already this section's. Nothing to verify, and holding here would
  // add a flicker to every re-entry.
  if (meta.lastScript === nextScript) return 'reveal-now';

  // A genuine switch between two different sections on one document.
  return holdFor(cap);
}
