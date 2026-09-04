/**
 * Every place a walkthrough can point at, named ONCE (night run 2026-09-03 §5).
 *
 * A component marks itself with `{...tourAnchor('library')}` and a tour step names the same
 * anchor; TypeScript refuses an anchor neither side has heard of. Before this, six components
 * each carried a hard-coded `data-tour="…"` string and six step arrays carried the matching
 * selector, `GuidedTour` silently skipped any step whose target had gone, and the help copy
 * rotted with no signal — a dubbing card carried an anchor for a step that never existed.
 */
export const TOUR_ANCHORS = {
  // ── the editor ──
  library: 'library',
  simulations: 'simulations',
  timeline: 'timeline',
  preview: 'preview',
  export: 'export',
  share: 'share',
  branching: 'branching',
  // ── project settings ──
  'settings-thumbnail': 'settings-thumbnail',
  'settings-details': 'settings-details',
  'settings-crop': 'settings-crop',
  'settings-access': 'settings-access',
  'settings-avatar': 'settings-avatar',
  'settings-collab': 'settings-collab',
  'settings-dubbing': 'settings-dubbing',
  // ── the section editor ──
  'sec-broll-info': 'sec-broll-info',
  'sec-sim-select': 'sec-sim-select',
  'sec-sim-prompt': 'sec-sim-prompt',
  'sec-sim-generate': 'sec-sim-generate',
  // One anchor for the Advanced disclosure that now holds the control picker, saved setups
  // and guided voice (2026-09-04). The old 'sec-sim-presets'/'sec-sim-controls' anchors died
  // with the always-visible layout — a step pointing INSIDE a collapsed disclosure is skipped
  // silently, which is exactly the rot this ledger exists to prevent.
  'sec-sim-advanced': 'sec-sim-advanced',
  'sec-camera': 'sec-camera',
  'sec-video': 'sec-video',
  'sec-video-prompt': 'sec-video-prompt',
  'sec-video-generate': 'sec-video-generate',
  'sec-video-options': 'sec-video-options',
  // ── the avatar persona ──
  'persona-basics': 'persona-basics',
  'persona-knowledge': 'persona-knowledge',
  'persona-advanced': 'persona-advanced',
  'persona-avatar': 'persona-avatar',
  'persona-voice': 'persona-voice',
  // ── the extended library ──
  'lib-generate': 'lib-generate',
  'lib-panel': 'lib-panel',
  'lib-gallery': 'lib-gallery',
  // ── the home page ──
  'home-projects': 'home-projects',
  'home-playlists': 'home-playlists',
} as const;

export type TourAnchor = keyof typeof TOUR_ANCHORS;

/** The attribute a component spreads onto its element: `<div {...tourAnchor('library')}>`. */
export function tourAnchor(name: TourAnchor): { 'data-tour': TourAnchor } {
  return { 'data-tour': name };
}

/** The selector a tour uses to find that element. */
export function tourSelector(name: TourAnchor): string {
  return `[data-tour="${name}"]`;
}

export function isTourAnchor(value: string): value is TourAnchor {
  return Object.prototype.hasOwnProperty.call(TOUR_ANCHORS, value);
}
