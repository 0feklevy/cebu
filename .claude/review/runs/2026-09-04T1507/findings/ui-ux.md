# UI/UX & Accessibility Findings — feat/library-minimal-ui

Scope: `git diff main...HEAD` for the Library-panel minimal UI, upload autoFiles routing, export
warning collapse, settings/collaborators layout, and the SectionEditor Advanced disclosure.
Read-only review; all locations are `file:line` from the repo root.

---

### [P2] Deleting the last image or last audio file collapses the whole section, dropping focus and removing the recovery affordance from where it was
- id: ui-ux-001
- location: podcast-saas/client-web/components/VideoEditor.tsx:1633 (Images gate), podcast-saas/client-web/components/VideoEditor.tsx:1743 (Sound gate)
- category: a11y
- confidence: high
- status: confirmed
- what: The diff wraps the Images and Sound sections in `{(images.length > 0 || pendingCropImage || imgUploading) && (...)}` and `{(audioFiles.length > 0 || audioUploading) && (...)}`. Before this branch, the outer section (heading + "add" button) was always mounted; only the inner list-vs-placeholder ternary changed. Now, deleting the last image/audio item unmounts the entire section — heading, the violet/emerald "add" button, everything — in the same render that removes the just-clicked delete button.
- why: A keyboard user whose focus was on the delete button (`VideoEditor.tsx:1732` image delete, `:1801` audio delete) loses focus to `document.body` when that node is removed — that already happened before this diff. What's new is that the section's own heading and its "add" button, which previously stayed put right where the deleted item was and gave an obvious next stop, now vanish in the same frame. A screen-reader user navigating by heading ("Images") or tabbing forward loses the landmark entirely and lands somewhere unrelated (the next section, or the Sound heading if that's also empty), with no live-region announcement that the section collapsed. This is worse than ordinary post-delete focus loss because the whole recovery path — "click the add button that was right there" — disappears with it.
- evidence: Read VideoEditor.tsx:1631-1740 (Images) and :1742-1809 (Sound); confirmed via `git diff main...HEAD` that the wrapping `{...&&(...)}` gate is new in this branch and the inner ternary (`images.length === 0 ? <placeholder> : list`) is unchanged, i.e. the regression is specifically the new outer unmount, not the existing per-item focus loss.
- fix: Keep the section header + "add" button always mounted (matching the still-visible Simulations section pattern just below, VideoEditor.tsx:1509, which never hides its header even at zero items); only gate the placeholder-vs-list body. Optionally move focus to the section's "add" button after a delete completes so keyboard users land somewhere useful instead of at `document.body`.
- verify: Manually (or via RTL) delete the only image while the delete button has focus; assert the "Images" heading and its add button are still present in the DOM and receive focus, rather than being removed from the tree.
- cross: @frontend-reviewer (focus management is state/behavior, flagging in case it overlaps hook logic)
- effort: S

---

### [P3] Delete-video button dropped its `aria-label` while the adjacent Replace button in the same diff hunk gained one
- id: ui-ux-002
- location: podcast-saas/client-web/components/VideoEditor.tsx:1493-1504
- category: a11y
- confidence: medium
- status: confirmed
- what: In this diff, the Replace button (VideoEditor.tsx:1489) was given `aria-label="Replace video"` in addition to its existing `title`. The Delete button three lines below it (`:1493-1504`) was repositioned in the same hunk (`bottom-2` → `top-2`) but kept only `title="Delete video"` with no `aria-label`.
- why: `title` does function as a fallback accessible name per the accname spec (and is picked up by testing-library / most screen readers), so this is not a broken control — but it is an inconsistent pattern introduced within the same commit that just added explicit `aria-label`s to two other icon-only buttons (Replace, and the "Extended library" button at :1420). A reader of this diff has no way to tell whether the omission on Delete is deliberate.
- fix: Add `aria-label="Delete video"` alongside the existing `title` for consistency with the sibling Replace button touched in the same change.
- verify: `pnpm -C podcast-saas --filter client-web typecheck` (no behavior change); visually confirm the accessible name via testing-library `getByRole('button', { name: 'Delete video' })`.
- effort: S

---

### [P3] "Added N video(s) to the library" fires before any video has actually finished uploading
- id: ui-ux-003
- location: podcast-saas/client-web/components/VideoEditor.tsx:978-986
- category: ux
- confidence: medium
- status: confirmed
- what: On a Library-panel drop containing video files, `vids.length > 0` opens the VideoUploader panel with `autoFiles` and, in the same tick, the toast at line 986 says "Added N video(s) … to the library." The video upload itself has not started rendering progress yet (it starts async inside VideoUploader's effect, VideoUploader.tsx:389-397), and for a large file it can take a while before it's actually "in the library."
- why: This reuses the same `parts`/`Added …` wording that images and audio use (where `uploadImageFile`/`uploadAudioFile` are genuinely fired synchronously on drop), but for videos and simulations "Added" describes something that is still in-flight — the upload panel that just opened is where the user needs to look, and calling it "added" undersells that there's a multi-step upload still ahead, or worse, could be read as job-done when it is not.
- fix: For the vids/sims branches, use language that matches what actually happened — e.g. "N video(s) queued for upload" — or move the toast to fire from VideoUploader's own completion callback instead of the drop handler.
- verify: Drop a large video file on the Library panel and confirm the toast wording no longer implies completion before HLS/transcode status shows anything.
- cross: @frontend-reviewer (this shares code with the pre-existing simulation "Added" wording, which is out of this PR's diff but has the identical defect)
- effort: S

---

### [P3] Advanced disclosure has `aria-expanded` but no `aria-controls`
- id: ui-ux-004
- location: podcast-saas/client-web/components/SectionEditor.tsx:2773-2789
- category: a11y
- confidence: medium
- status: confirmed
- what: The new "Advanced" toggle button correctly sets `aria-expanded={advancedOpen}`, but the three regions it reveals/hides (the controls picker at :2342, "Reuse this setup" at :2798, and Guided Simulation at :2893) have no `id`, so there is no `aria-controls` link from the button to what it toggles.
- why: Without `aria-controls`, a screen-reader user gets "expanded/collapsed" state but no programmatic association to the content that appeared — they have to discover it by linear navigation. Low severity because `aria-expanded` alone is a reasonable minimum and the content immediately follows the button in DOM order.
- fix: Give the disclosure body a stable `id` (e.g. `sim-advanced-panel-${section.id}`) and add `aria-controls` on the button referencing it.
- verify: Run an axe/accessibility-tree check on the expanded and collapsed states of the SectionEditor sim panel.
- effort: S

---

## Not filed (checked and clean)
- **Tour anchors for the Advanced disclosure** (`podcast-saas/client-web/lib/tours/anchors.ts`, `steps.ts`): the old `sec-sim-presets`/`sec-sim-controls` anchors, which would have pointed inside a now-collapsed-by-default disclosure, were removed and merged into a single `sec-sim-advanced` step that targets the always-visible toggle button. No silently-skipped tour step.
- **Low-confidence warning card** (SectionEditor.tsx:2653-2659): correctly pulled outside the `advancedOpen` gate so a keyboard/regular user still sees "check the script before recording" even with Advanced collapsed — the critical signal isn't hidden behind the new disclosure.
- **Images/Sound sections appear immediately on upload start**, not only on completion (`imgUploading`/`audioUploading` flags are set synchronously before the async upload call, VideoEditor.tsx:838-839), so the "hidden while empty" change does not create an unreachable empty-state — the section reveals itself the instant a drop/pick begins.
- **CollaboratorsSection invite row** (`flexWrap` + `minWidth: 160`): a legitimate overflow fix for narrow settings columns; no regression.
- **ProjectSettingsPanel grid→flex-column change**: visual reflow only, verified the Smart Crop conditional (`projectOrientation(videos) !== 'portrait'`) still renders correctly in the new column, no orphaned/clipped card.
- **ExportProgressPanel routine-warning collapse**: `<li role="list">`/`aria-label="Export warnings"` region unchanged, "Copy all" still hands over the complete original warning text (verified against the new test `presetDialogsVisible`/`exportPanelViewport` assertions), so the collapse is compression of what's *shown*, not loss of what's *available*.
