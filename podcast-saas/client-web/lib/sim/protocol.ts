/**
 * The parent↔simulation message protocol, in ONE place.
 *
 * Every surface that hosts a simulation iframe speaks this protocol. Before this module the
 * message names, their payload shapes and the rules for interpreting them were re-typed (and
 * re-derived) in each component, which is exactly how the surfaces drifted apart: three separate
 * audits each found a defect that existed only because one surface implemented a rule the others
 * did not.
 *
 * SCOPE: this is the CURRENT wire protocol, unchanged. The activation-scoped redesign
 * (MessageChannel transport, documentId/packageRevision/configHash, PREPARE_SECTION /
 * SECTION_PRESENTED) is deliberately NOT started here — this module exists to remove duplication
 * of what already ships, not to introduce a second protocol alongside it.
 */

// ── child → parent ────────────────────────────────────────────────────────────────────────

/** The bridge booted and can accept startScript. Says NOTHING about what has been drawn. */
export const SIM_READY = 'SIM_READY' as const;
/**
 * A real animation frame executed while un-paused — the only honest "safe to reveal" signal.
 * Emitted by the injected rAF gate, never by bridge bookkeeping (which uses the system clock so
 * it can not counterfeit a paint).
 */
export const SIM_PAINTED = 'SIM_PAINTED' as const;
/** The named section's body ran to completion. Carries the activation token it was started with. */
export const SCRIPT_APPLIED = 'SCRIPT_APPLIED' as const;
/** The named section does not exist in this document — the bridge deliberately ran NOTHING. */
export const SCRIPT_MISSING = 'SCRIPT_MISSING' as const;
/** The body (or a cleanup) threw. The document stays usable. */
export const SCRIPT_ERROR = 'SCRIPT_ERROR' as const;
/** Automation was stopped in response to pauseScript. */
export const AUTO_PAUSED = 'AUTO_PAUSED' as const;
/** The user touched a control inside the simulation. */
export const USER_INTERACTION = 'userInteraction' as const;

// ── parent → child ────────────────────────────────────────────────────────────────────────

export const START_SCRIPT = 'startScript' as const;
export const STOP_SCRIPT = 'stopScript' as const;
export const PAUSE_SCRIPT = 'pauseScript' as const;
export const SIM_PAUSE = 'simPause' as const;
export const SIM_RESUME = 'simResume' as const;
export const SIM_MUTE = 'simMute' as const;
export const SIM_UNMUTE = 'simUnmute' as const;
export const SIM_RELAYOUT = 'simRelayout' as const;
export const CLEAR_BOOT_HIDE = 'clearBootHide' as const;
export const GUIDANCE_GATE = 'guidanceGate' as const;
export const PING_SIM_READY = 'PING_SIM_READY' as const;
export const PING_SIM_PAINTED = 'PING_SIM_PAINTED' as const;

/** Section parameters the bridge applies on startScript. Mirrors the generated body contract. */
export interface SimStartParams {
  simpleUi?: boolean;
  autoScript?: boolean;
  hideSelectors?: string[];
}

export interface SimInboundMessage {
  type: string;
  /**
   * SIM_READY capability advertisement. The SHIPPING v2 bridge sends `dispatch: 'dynamic'` plus
   * the section id list; its absence means an old load-time-locked bridge that needs a per-section
   * URL. Feature-detect on this — never on a version number, which no bridge sends.
   */
  dispatch?: string;
  sections?: string[];
  script?: string;
  /** Echoed activation token — present only on acks from a v2.1+ bridge. */
  token?: number;
  message?: string;
  phase?: string;
  v?: number;
}

/** Narrow an untrusted MessageEvent payload to the inbound shape. */
export function asInbound(data: unknown): SimInboundMessage | null {
  if (!data || typeof data !== 'object') return null;
  const t = (data as { type?: unknown }).type;
  return typeof t === 'string' ? (data as SimInboundMessage) : null;
}

/**
 * Timings. These are PRODUCT behaviour, not tuning knobs — they are duplicated in the CSS
 * (`.sim-overlay` transition) and in the e2e harness, and all three must agree.
 */
export const SIM_FADE_MS = 200;
/** Deferred stopScript delay. MUST exceed SIM_FADE_MS: a teardown restores whatever the section
 *  hid, so running it while the frame is still visible is a guaranteed full-UI flash. */
export const SIM_EXIT_STOP_MS = 280;
/** Terminal bound on waiting for SCRIPT_APPLIED. Never a reveal-on-timer for a healthy bridge —
 *  only the escape hatch that keeps a wedged document from holding the screen forever. */
export const SIM_APPLY_STALL_MS = 3_000;
/** Reveal ceiling for pre-gate packages that can never emit SIM_PAINTED. */
export const SIM_LEGACY_REVEAL_MS = 800;
