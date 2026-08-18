'use client';

/**
 * Geometry for the editor's fixed-position floating panels.
 *
 * `ExportProgressPanel` learned this the hard way and documents it in its own rule 7: a panel
 * anchored with `right: N` and a FIXED pixel width runs off the left edge of any viewport narrower
 * than `width + 2N`, and the controls inside it become unreachable. Every popover that repeated the
 * `right: 24; width: 380` shape repeated the bug, because the clamp lived as a copied string rather
 * than a rule. It lives here now.
 */

/** Breathing room kept on BOTH sides of a floating panel. Also the panel's `right` offset. */
export const PANEL_EDGE_GAP_PX = 24;

/**
 * A width that prefers `preferredPx` but can never push the panel off-screen.
 *
 * With the panel anchored at `right: gapPx`, its left edge sits at
 * `100vw - gapPx - min(preferredPx, 100vw - 2*gapPx)`, which is `>= gapPx` for every viewport —
 * so the panel is fully visible at any width, down to a phone.
 */
export function clampedPanelWidth(preferredPx: number, gapPx: number = PANEL_EDGE_GAP_PX): string {
  return `min(${preferredPx}px, calc(100vw - ${gapPx * 2}px))`;
}
