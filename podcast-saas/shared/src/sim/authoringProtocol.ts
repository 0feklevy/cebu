/**
 * The authoring channel — parent editor ⇄ the simulation document it is picking controls in.
 *
 * WHAT THIS IS FOR. The Minimal-UI picker needs three things the viewer path never needs: an exact
 * list of the controls in a LIVE document, green/red badges drawn on those controls, and a way for
 * a click on a badge to reach the editor. None of that may exist for a viewer, so the capability is
 * dormant until the editor explicitly connects.
 *
 * ── TRANSPORT: MessageChannel, per the ADR's §8.6 ─────────────────────────────────────────────
 *
 * `CONNECT` is the ONLY window-level message. It is posted by the parent to an exact targetOrigin
 * and carries a transferred `MessagePort`; the child accepts it only when the sender is its real
 * parent AND the sender's origin is in an allowlist embedded at serve time. Everything after that
 * rides the port.
 *
 * The port is not a nicety. It is capability-based, so post-handshake traffic has no targetOrigin
 * to get wrong; and a transferred port DIES WITH ITS DOCUMENT, which makes staleness structural
 * rather than something a comparison has to catch. That matters here specifically: `e.source ===
 * iframe.contentWindow` is NOT a staleness guard, because a WindowProxy is the same object across
 * navigations of one browsing context — a message from the PREVIOUS document passes that check.
 *
 * `sid` rides on top for the bookkeeping a port cannot express: which CONNECT a reply belongs to
 * when the editor reconnects to the same live document. `requestId` does the same for overlapping
 * scans. Both exist because the failure they prevent is silent: an older answer overwriting a
 * newer one looks exactly like a correct answer.
 *
 * ── SCOPE: this is the MVP subset of the ADR's authoring protocol ─────────────────────────────
 *
 * `ActionRecordingV1`, the seq/ACK envelope, CAPABILITIES negotiation and the recording message
 * set are Phase 2 and are deliberately absent. What is here is what the picker needs, named so the
 * full version REPLACES these types rather than growing a second vocabulary beside them.
 *
 * ── AMENDMENT A1 (2026-08-26, owner-approved) ─────────────────────────────────────────────────
 *
 * The ADR's D10 specifies a four-mode toolbar (Interact / Keep / Hide / Clear) and a tri-state
 * mark. For the PRE-RECORDING picker the owner chose binary Keep/Hide with badges shown the whole
 * time the panel is open, over a separate pick mode. Tri-state returns with Phase-2 recording,
 * where `Auto` (derive from what the recording touched) is a state that means something; before
 * recording exists there is nothing for it to derive from.
 *
 * D10's hard floor is unchanged and NOT negotiable here: icon+text never colour alone, single
 * click never double, the checkbox list stays a first-class accessible fallback (and is the only
 * path to a control the simulation itself keeps hidden), and "hide everything untouched" is never
 * applied without an explicit action.
 */

/** Namespace on every message, window-level and port-level alike. */
export const SIM_AUTHORING_NS = 'flowvid.sim-authoring';

/** Bumped when a message shape changes incompatibly. The child refuses anything else. */
export const SIM_AUTHORING_VERSION = 1;

/** Path the serve-time hook loads the active script from. Root-relative to the sim's own origin. */
export const SIM_AUTHORING_SCRIPT_PATH = '/sim-authoring.js';

/** Marks the overlay's own subtree so the scanner never reports its badges as sim controls. */
export const SIM_AUTHORING_OVERLAY_ATTR = 'data-sim-authoring-overlay';

// ── Message types ─────────────────────────────────────────────────────────────

/** Window-level. The only message not on the port; carries the port in `event.ports[0]`. */
export const SIM_AUTHORING_CONNECT = 'CONNECT';

export const SIM_AUTHORING_PORT_TYPES = {
  /** Child → parent, first message on the port. Echoes the sid so a stale reply is detectable. */
  CONNECTED: 'CONNECTED',
  /** Parent → child. */
  SCAN_CONTROLS: 'SCAN_CONTROLS',
  /** Child → parent. ALWAYS sent, empty list included — see ScanResult below. */
  CONTROLS_LIST: 'CONTROLS_LIST',
  /** Parent → child: the full current mark set. Idempotent; the child renders from it wholesale. */
  SET_MARKS: 'SET_MARKS',
  /** Child → parent: the author clicked a badge. */
  MARK_TOGGLED: 'MARK_TOGGLED',
  /** Parent → child: begin/end watching for script-driven control changes. */
  OBSERVE_START: 'OBSERVE_START',
  OBSERVE_STOP: 'OBSERVE_STOP',
  /** Child → parent: controls a script appears to have driven. HEURISTIC — see the payload. */
  SCRIPT_TOUCHED: 'SCRIPT_TOUCHED',
  /** Child → parent: Escape was pressed inside the frame; the parent closes the panel. */
  ESCAPE_REQUESTED: 'ESCAPE_REQUESTED',
  /** Parent → child: remove the overlay and stop observing. The script stays resident. */
  DISARM: 'DISARM',
} as const;

export type SimAuthoringPortType =
  typeof SIM_AUTHORING_PORT_TYPES[keyof typeof SIM_AUTHORING_PORT_TYPES];

// ── Payloads ──────────────────────────────────────────────────────────────────

/** One control, as the shared scanner reports it. Mirrors SimUiControl. */
export interface AuthoringControl {
  selector: string;
  kind: string;
  label: string;
  /** Not laid out and not position:fixed — the simulation itself is hiding it. */
  hidden?: boolean;
}

/**
 * The answer to a scan — and the reason this is a record rather than a bare array.
 *
 * "The scanner replied with nothing" and "the scanner could not be reached" are different facts
 * with opposite consequences, and the picker used to collapse both to `null`. That is what made it
 * show "Not scanned yet" and "No controls detected" at the same time. A reply always carries
 * `scanned: true`; absence of a reply is the only unreachable signal.
 */
export interface AuthoringScanResult {
  scanned: true;
  requestId: string;
  sid: string;
  controls: AuthoringControl[];
  /**
   * The scan hit a cap and this list is INCOMPLETE.
   *
   * It travels because a caller that acts on the list — "hide everything not used by the script" —
   * would otherwise hide controls it never saw. The ADR requires that suggestion to fall back to
   * off on a truncated scan, and it cannot without this flag.
   */
  truncated: boolean;
}

/** A control the author has decided about. Absent from the set ⇒ keep (the default). */
export interface AuthoringMark {
  selector: string;
  mark: 'keep' | 'hide';
}

/**
 * Controls a script appears to have driven — a HEURISTIC, and labelled one everywhere it is shown.
 *
 * It is derived from events whose `isTrusted` is false, which per the DOM Standard means they were
 * dispatched by script rather than by a user. That inference is sound in one direction only:
 *
 *   - a simulation's own initialisation or framework code also dispatches untrusted events, so a
 *     control can appear here without the Auto Script having anything to do with it — which is why
 *     observation is armed only for the automation's lifetime, not for the document's;
 *   - and a script that assigns `element.value` directly, or drives an internal API, produces NO
 *     event at all and is therefore invisible here.
 *
 * So this narrows the author's search. It is never applied on its own.
 */
export interface AuthoringScriptTouched {
  selectors: string[];
  heuristic: true;
}
