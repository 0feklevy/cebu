/**
 * Which mounted surface renders which tour anchor — the ledger the mount tests assert against.
 *
 * `tours.test.ts` proves every STEP names a registered anchor; that is the registry ↔ steps half.
 * The other half — that some COMPONENT still renders each anchor — was silent: deleting
 * `{...tourAnchor('library')}` from the editor left `tsc` clean and every test green, and the
 * walkthrough just skipped the step (audit of PR #168). Each `tourAnchors.*.test.tsx` mounts one
 * surface and asserts its list here is in the DOM; `tourSurfaces.test.ts` asserts the lists
 * together cover the whole registry, so a new anchor must be claimed by a mount test.
 */
import type { TourAnchor } from '@/lib/tours/anchors';

export const SURFACE_ANCHORS = {
  /** `VideoEditor` — the left rail and the timeline. */
  editor: ['library', 'simulations', 'timeline', 'branching'],
  /** `ProjectHeader` — the row above the editor. */
  header: ['preview', 'share', 'export'],
  /** `ProjectSettingsPanel` for a landscape project (the crop card is landscape-only). */
  settings: [
    'settings-thumbnail', 'settings-details', 'settings-crop', 'settings-access',
    'settings-avatar', 'settings-collab', 'settings-dubbing',
  ],
  /** `SectionEditor`, across the section kinds it switches on. */
  section: [
    'sec-broll-info',
    'sec-sim-select', 'sec-sim-prompt', 'sec-sim-generate', 'sec-sim-advanced',
    'sec-camera', 'sec-video', 'sec-video-prompt', 'sec-video-generate', 'sec-video-options',
  ],
  /** `AvatarSettingsModal`. */
  persona: ['persona-basics', 'persona-knowledge', 'persona-advanced', 'persona-avatar', 'persona-voice'],
  /** `ExtendedLibraryModal`. */
  library: ['lib-generate', 'lib-panel', 'lib-gallery'],
  /** `HomeHero` (with `PlaylistsPanel` inside it). */
  home: ['home-projects', 'home-playlists'],
} as const satisfies Record<string, readonly TourAnchor[]>;

export type TourSurface = keyof typeof SURFACE_ANCHORS;

/** The selector for one anchor — the same string `tourSelector` builds, spelled out so a test reads plainly. */
export function anchorSelector(anchor: TourAnchor): string {
  return `[data-tour="${anchor}"]`;
}
