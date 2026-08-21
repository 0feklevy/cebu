---
name: reference-patterns
description: Where FlowVid's client-web/admin-web already do async-state and modal a11y correctly — use these as the fix template and to avoid false positives
metadata:
  type: project
---

As of the 2026-08-15T2109 whole-codebase review (commit 2d187e3), a few components are the
*correct*, deliberate implementations of patterns that are inconsistently applied elsewhere in the
same codebase. When filing a finding about a missing state/a11y pattern, check whether the fix
already exists in one of these and cite it as the fix template — the team has clearly already
solved the problem once, they just haven't propagated it:

- **Bounded polling with a "lost contact" give-up state**: `podcast-saas/client-web/lib/useProjectExport.ts`
  (`MAX_CONSECUTIVE_POLL_FAILURES`, a distinct "lost contact" message that does NOT claim failure).
  Several other poll loops in the app (viewer "processing" state in `ViewerPage.tsx`/
  `SharedViewerPage.tsx`, podcast mix generation in `AudioStudio.tsx`) reimplement `setInterval`
  with no cap — this is the recurring "stuck spinner forever" bug class in this repo. See
  [[async-state-gaps]].
- **Viewport-clamped floating panels**: `podcast-saas/client-web/components/ExportProgressPanel.tsx`
  uses `w-[min(360px,calc(100vw-24px))]` deliberately (its own docblock rule 7 references a past
  production incident where an unclamped popover pushed its action row off-screen). Other
  fixed-`right`+fixed-`width` popovers (`A2AudioModal.tsx`, `TimelinePanel.tsx`'s audio-section
  popover) don't have this and can overflow on narrow viewports.
- **Modal focus trap + initial focus**: `podcast-saas/client-web/components/ProjectSettingsPanel.tsx:70-88`
  hand-rolls a correct trap (focus on mount + Tab-cycling keydown handler). `ConfirmDialog.tsx` —
  the component used for essentially every destructive-action confirmation app-wide — has
  `role="dialog" aria-modal="true"` but neither the trap nor initial focus.
- **Radix-based dialogs already get a11y for free** — `CreateProjectDialog`, `UserSettingsDialog`,
  `HowItWorksDialog`, `PlaylistEditorDialog` all use `@radix-ui/react-dialog` (`Dialog.Root` /
  `Dialog.Overlay` / `Dialog.Content`), which supplies focus trap, `role="dialog"`, `aria-modal`,
  and Escape-to-close automatically. **Do not flag these for missing dialog semantics** just
  because `grep` for `role="dialog"`/`Escape` comes up empty in the file — the semantics come from
  the library, not inline markup. This was a near-miss false positive in the 2026-08-15 run; always
  check for `Dialog.Root`/similar library wrapper before filing a missing-a11y-semantics finding.
- **Icon-only accessible-name done right**: `ExportProgressPanel.tsx:120-127` pairs `aria-hidden`
  on the icon with a `<span className="sr-only">Close export panel</span>` plus `title="Close"`.
  Several other icon-only close buttons in the same codebase (`BrollPanel.tsx`, `VersionsDrawer.tsx`,
  `avatar/ExtendedLibraryModal.tsx`) skip this entirely.

See [[async-state-gaps]] for the specific finding list from that run.
