// Presentation gate for a SAME-DOCUMENT section switch — pure, unit-tested.
//
// A pooled simulation document serves many sections. `painted` only certifies that the document
// once drew SOMETHING (possibly the PREVIOUS section's frozen frame), so revealing on `painted`
// alone can present the wrong sub-simulation. The v2.1 bridge acknowledges each applied section
// with SCRIPT_APPLIED; this decides when the player is allowed to wait for that acknowledgement.
//
// THE RULE, and why it is safe for both bridge generations:
//   A modern bridge emits SCRIPT_APPLIED on the package's FIRST activation — which always happens
//   before any section SWITCH on that document. So by the time a switch occurs, `ackCapable` is
//   already known (true for modern, still null for a stored pre-ack bridge). Therefore:
//     • ackCapable === true  → PROVEN modern → hold the swap until the matching ack. Never
//       force-reveal on a timer: a slow body (the generation prompt tells bodies to poll for
//       async-built controls with ~200ms intervals) must not cause a wrong-section frame.
//     • anything else        → legacy / unknown → reveal immediately, exactly as before. Waiting
//       on a bridge that can never answer would delay every legacy switch and, if the wait were
//       unbounded, make legacy simulations undisplayable.
//
// The player additionally arms an honest stall affordance while awaiting (it never reveals an
// unacknowledged frame), and SCRIPT_MISSING / SCRIPT_ERROR release the wait immediately.

export type ApplyGateDecision = 'reveal-now' | 'await-ack';

export interface ApplyGateMeta {
  /** v2 dynamic-dispatch capability; null until SIM_READY classifies the document. */
  dynamic: boolean | null;
  /** true once this document has emitted at least one SCRIPT_APPLIED. */
  ackCapable: boolean | null;
  /** The script this document last applied (or was last sent). */
  lastScript: string | null;
  /**
   * True once a deferred `stopScript` tore the last section down. Such a document is NOT a fresh
   * one: its cleanup ran and restored whatever the section had hidden (full UI back), while the
   * canvas still holds that section's frozen frame. Tracked separately because `lastScript: null`
   * means "nothing applied yet" — a genuine first activation, which reveals immediately.
   */
  stopped?: boolean;
}

export function applyGateFor(meta: ApplyGateMeta, nextScript: string): ApplyGateDecision {
  if (meta.dynamic !== true) return 'reveal-now';        // legacy dispatch: navigates, never switches in place
  if (meta.ackCapable !== true) return 'reveal-now';     // never proven to ack — do not wait on silence
  // A torn-down document shows the previous section's frozen frame with its full UI restored.
  // Revealing that before the new body applies is the exact defect this gate exists to prevent,
  // so it must be checked BEFORE the first-activation shortcut below (audited).
  if (meta.stopped) return 'await-ack';
  if (meta.lastScript === null) return 'reveal-now';     // first activation on this document
  if (meta.lastScript === nextScript) return 'reveal-now'; // re-entering the SAME section: already applied
  return 'await-ack';
}
