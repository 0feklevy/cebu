/**
 * Operating the editor timeline without a mouse (ui-ux-006).
 *
 * ── WHAT WAS MISSING ──────────────────────────────────────────────────────────────────────────
 * Every timeline section is moved and trimmed by `onMouseDown` on a plain `<div>`. No `tabIndex`,
 * no `role`, no key handler — so a section could not be reached by keyboard at all, let alone
 * moved. This was the one item of the a11y group left open, deliberately, because a half-built
 * keyboard path is worse than none: it looks operable and then strands you.
 *
 * ── WHY SLIDER SEMANTICS, NOT A MODIFIER SCHEME ───────────────────────────────────────────────
 * The obvious design is Alt+Arrow to trim and Shift+Arrow to move faster. Two problems: Alt+Arrow
 * is browser back/forward on Windows and Linux, and a modifier scheme has to be MEMORISED — which
 * for a screen-reader user means it has to be documented somewhere they will find, and it usually
 * is not.
 *
 * The timeline already draws three affordances per section: the body, and two trim handles. Making
 * each one a focusable `role="slider"` mirrors the visual UI exactly, needs no modifier at all, and
 * describes itself: a screen reader announces "slider, 12.4 seconds, minimum 0, maximum 40", and
 * every user already knows arrow keys adjust a slider. Tab walks body → start → end, in the order
 * the eye reads them.
 *
 * ── THE GEOMETRY IS NOT HERE, ON PURPOSE ──────────────────────────────────────────────────────
 * This module answers only "what did the user ask for, and how far" — a delta in seconds. WHERE
 * the section may legally land is `clampMove`/`clampTrim` in TimelinePanel, the same two functions
 * the drag path uses, and the keyboard path calls them with the same arguments. A second copy of
 * the collision rules is how the mouse and the keyboard end up disagreeing about where a section
 * can go, and the one that gets tested is never the one that drifts.
 */

/** One arrow press. Fine enough to place a cut on a syllable at ordinary zoom. */
export const TIMELINE_STEP_SEC = 0.1;

/**
 * Shift, PageUp/PageDown. Ten steps rather than a round second, so the two are the same gesture at
 * different scales and a user does not have to learn a second number.
 */
export const TIMELINE_COARSE_STEP_SEC = TIMELINE_STEP_SEC * 10;

export type TimelineKeyAction =
  | { kind: 'nudge'; deltaSec: number }
  | { kind: 'jump'; to: 'min' | 'max' }
  | null;

interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * What a keypress on a timeline handle means, or null when it means nothing to us.
 *
 * Returning null is as important as the rest: an unhandled key must fall through to the browser
 * rather than be swallowed. Ctrl and Meta are reserved without exception — Cmd+Left is
 * "beginning of line" on macOS and Ctrl+Left is word-jump elsewhere, and a component that eats
 * them breaks the surrounding page for everyone, not just the person using the timeline.
 *
 * Alt is reserved for the same reason in the other direction: Alt+Left is browser BACK on Windows
 * and Linux, so binding a trim to it means a mistimed press loses the editor.
 */
export function timelineKeyAction(e: KeyLike): TimelineKeyAction {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  const step = e.shiftKey ? TIMELINE_COARSE_STEP_SEC : TIMELINE_STEP_SEC;

  switch (e.key) {
    // Both axes, because a slider takes both and a user reaching for Down should not find nothing.
    case 'ArrowLeft':
    case 'ArrowDown':
      return { kind: 'nudge', deltaSec: -step };
    case 'ArrowRight':
    case 'ArrowUp':
      return { kind: 'nudge', deltaSec: step };
    // Page keys are always coarse regardless of Shift — that is what they mean on every slider.
    case 'PageDown':
      return { kind: 'nudge', deltaSec: -TIMELINE_COARSE_STEP_SEC };
    case 'PageUp':
      return { kind: 'nudge', deltaSec: TIMELINE_COARSE_STEP_SEC };
    case 'Home':
      return { kind: 'jump', to: 'min' };
    case 'End':
      return { kind: 'jump', to: 'max' };
    default:
      return null;
  }
}

/**
 * A time a screen reader can read aloud without turning it into a number nobody pictures.
 *
 * `aria-valuenow` carries the raw seconds for anything that computes; this is `aria-valuetext`,
 * which is what is actually spoken. "1:23.4" is how the rest of the editor writes a timecode, and
 * a listener tracking a cut needs the tenth — that is the resolution one arrow press moves.
 */
export function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const total = Math.round(sec * 10) / 10;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * What a section's handle announces itself as.
 *
 * The label leads with the ROLE of this particular handle, because all three sit on the same
 * section and "Introduction" three times in a row tells a listener nothing about which one they
 * have landed on.
 */
export function handleLabel(
  handle: 'move' | 'trim-start' | 'trim-end',
  sectionLabel: string,
  startSec: number,
  endSec: number,
): string {
  const span = `${formatTimecode(startSec)} to ${formatTimecode(endSec)}`;
  switch (handle) {
    case 'move':
      return `Move ${sectionLabel}, ${span}`;
    case 'trim-start':
      return `Trim start of ${sectionLabel}, currently ${formatTimecode(startSec)}`;
    case 'trim-end':
      return `Trim end of ${sectionLabel}, currently ${formatTimecode(endSec)}`;
  }
}
