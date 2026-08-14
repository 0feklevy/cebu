# UI/UX & Accessibility Findings

Scope: JSX/TSX and styling under `podcast-saas/client-web/**` and `podcast-saas/admin-web/**`.
`_archive/**`, `.next/**`, `e2e/**`, `node_modules/**` excluded.

---

### [P1] Five separate polling loops for long-running jobs never give up — if the poll itself starts failing, the UI spins forever with no message and no way to dismiss or retry
- id: ui-ux-001
- location: podcast-saas/client-web/components/podcast/studio/AudioStudio.tsx:117-131
- category: ux
- confidence: high
- status: confirmed
- what: `AudioStudio`'s mix-generation poll (117-131) renders a full-panel blocking spinner ("Building the studio audio…", lines 251-259) whenever `data.mix?.status === 'generating'`, with no other UI reachable from inside the component. The poll's catch block is `catch { /* keep polling */ }` — a persistently failing fetch (expired token, network blip that doesn't clear, backend restart) never terminates the interval and never surfaces anything to the user; the spinner is the only thing rendered, forever. The same file's export-render poll (184-206) has the identical shape: while `exportJob.status === 'rendering'` the toolbar's Export button is disabled (line 351) and the only visible state is a spinner banner with no dismiss/cancel button (303-307) — if polling itself never resolves, both the button and the banner are stuck permanently. The same unbounded `catch { /* ignore */ }` polling pattern, with no failure counter and no give-up message, also appears in `podcast-saas/client-web/components/SectionEditor.tsx:467-479` (B-roll generation job poll), `podcast-saas/client-web/components/BrollPanel.tsx:84-99` (B-roll generation job poll), and `podcast-saas/client-web/components/podcast/PodcastEpisodePage.tsx:91-101` (source-ingestion poll).
- why: This is the exact failure mode the export flow was already patched for (see `podcast-saas/client-web/lib/useProjectExport.ts:59,254-269`, which bounds consecutive poll failures at 5 and then sets a `EXPORT_POLL_LOST_CONTACT_MESSAGE` — "Lost contact with the export — it may still be running. Refresh to check."). None of these five sibling polls (podcast mix generation, podcast export render, B-roll generation ×2, corpus source ingestion) inherited that fix. A user whose network blips for 15+ seconds during a podcast render, or whose auth token expires mid-poll, is left staring at an un-interactive spinner with zero indication anything is wrong; the only way out is leaving the page (back button / reload), which is not hinted at anywhere in the UI.
- evidence: Read AudioStudio.tsx:117-131 (`catch { /* keep polling */ }`, no counter), :184-206 (identical shape), :251-259 (the only render path while `generating`, no error/dismiss affordance), :303-307 and :351 (export banner/button with no cancel while `rendering`). Read useProjectExport.ts:59 (`MAX_CONSECUTIVE_POLL_FAILURES = 5`) and :254-269 (the give-up branch) as the sibling implementation that already solved this. Grepped `setInterval` usage across client-web and read SectionEditor.tsx:467-479, BrollPanel.tsx:84-99, PodcastEpisodePage.tsx:91-101 — all share the same `catch { /* ignore */ }`-with-no-counter shape.
- fix: Port the `useProjectExport` pattern (consecutive-failure counter + a "lost contact, refresh to check" terminal state) into the five poll loops listed above, or extract it into one shared `usePollingJob` hook so future poll loops get it by construction. At minimum, `AudioStudio`'s two loops need it most since they render the only UI for their surface with no escape hatch.
- verify: Add a jsdom test that makes the polled endpoint reject N times in a row and asserts the UI transitions to a "lost contact" message instead of spinning past the bound; `pnpm -C podcast-saas --filter client-web test`.
- cross: @frontend-reviewer (hook/polling correctness is your column — this is the user-visible consequence)
- effort: M

---

### [P2] Video/simulation/image/audio delete in the editor swallow errors silently — a failed delete gives the user zero feedback
- id: ui-ux-002
- location: podcast-saas/client-web/components/VideoEditor.tsx:677-687
- category: ux
- confidence: high
- status: confirmed
- what: `confirmDeleteVideo` (677-687) calls `api.deleteVideo` inside `try { … } catch { /* ignore */ } finally { setDeletingId(null); }` — no error state is set, no toast, nothing rendered. The identical pattern repeats for `confirmDeleteSim` (659-668), `handleDeleteImage` (854-861), and `handleDeleteAudio` (951-958). On failure the item correctly stays in the list (no false-positive removal), but the user sees the per-item spinner stop and nothing else — no message telling them the delete failed or why.
- why: Delete is the one destructive action in this surface; "is the result actually surfaced?" fails here on the unhappy path. A user who clicks delete, sees the spinner, and then sees the item just... sit there with no explanation, will reasonably retry, assume it's broken, or assume it silently worked when it didn't.
- evidence: Read all four handlers; each catch block is `catch { /* ignore */ }` with no `setError`/toast call. Contrast with `podcast-saas/client-web/components/podcast/PodcastShowsPage.tsx:49-51` and `podcast-saas/client-web/components/podcast/PodcastShowPage.tsx:66-68`, which catch the same class of failure and call `window.alert('Could not delete the show/episode — please try again.')` — the rest of the codebase's own convention for this exact action already surfaces the failure; VideoEditor's four handlers are the outlier.
- fix: Set a visible error (reuse the pattern already in this file, e.g. the `libraryFeedback` toast state used elsewhere) in each catch block instead of discarding the error.
- verify: Mock `api.deleteVideo` (and the sim/image/audio equivalents) to reject, click delete, assert an error message renders. `pnpm -C podcast-saas --filter client-web test`.
- effort: S

---

### [P2] The shared delete-confirmation dialog and the export/consent panel don't trap or restore focus, unlike two sibling modals that already do it correctly
- id: ui-ux-003
- location: podcast-saas/client-web/components/ConfirmDialog.tsx:16-131
- category: a11y
- confidence: high
- status: confirmed
- what: `ConfirmDialog` (the shared destructive-action confirmation used at 8+ call sites — `HomeHero.tsx`, `VideoEditor.tsx` ×4, `HomeSidebar.tsx`, `SectionEditor.tsx`, `PodcastShowsPage.tsx`, `PodcastShowPage.tsx`, `PodcastScriptEditor.tsx`) opens with `role="dialog" aria-modal="true"` but never moves focus into itself, never traps Tab, and never restores focus to the triggering element on close. `podcast-saas/client-web/components/ExportProgressPanel.tsx:110-117` (the consent/export panel this review's brief specifically calls out) has the same gap — Escape closes it (`ProjectHeader.tsx:114-116`) and outside-click closes it, but nothing sets initial focus or restores it.
- why: A keyboard/screen-reader user who opens either dialog is not moved into it — Tab continues to walk the page behind the (visually blocking) dialog, and on close, focus is not returned to the button that opened it. For `ConfirmDialog` this is the confirmation gate in front of every delete action in the product; for `ExportProgressPanel` it's the "Export anyway" consent gate the brief flags as priority.
- evidence: Read ConfirmDialog.tsx in full — no `useRef`/`.focus()`/keydown-Tab-trap anywhere. Read ExportProgressPanel.tsx in full — same gap; only Escape is wired (in the parent, ProjectHeader.tsx:114-116). Confirmed the pattern exists correctly elsewhere in this same codebase: `podcast-saas/client-web/components/ProjectSettingsPanel.tsx:73-83` (focuses the panel on open, traps Shift+Tab/Tab between first/last focusable) and `podcast-saas/client-web/components/avatar/AvatarPopup.tsx:80-90` (identical pattern) — 2 of the 12 `role="dialog"` components in client-web implement this; the rest, including the two highest-traffic ones, do not.
- fix: Extract the trap/restore logic already written in `ProjectSettingsPanel.tsx:73-83` into a small shared hook (`useFocusTrap` or similar) and apply it to `ConfirmDialog` and `ExportProgressPanel` at minimum.
- verify: jsdom test — open the dialog, assert `document.activeElement` is inside it; Tab from the last focusable element and assert it wraps to the first; close and assert focus returns to the trigger.
- effort: M

---

### [P2] Video and corpus-source dropzones are click-only — not reachable or operable by keyboard, unlike the sibling simulation uploader
- id: ui-ux-004
- location: podcast-saas/client-web/components/VideoUploader.tsx:380-388
- category: a11y
- confidence: high
- status: confirmed
- what: The video-upload dropzone (`VideoUploader.tsx:380-388`) is a `<div onClick={() => inputRef.current?.click()}>` with a `focus-ring` CSS class but no `tabIndex`, no `role="button"`, and no `onKeyDown` — so it is never in the Tab order and Enter/Space do nothing on it even if a user managed to focus it another way. There is no fallback "Browse" button either. `podcast-saas/client-web/components/CorpusUploader.tsx:48-55` (used on the project-creation / corpus-upload flow) has the identical shape.
- why: A keyboard-only user cannot upload a video (the main content-entry point of the editor) or a corpus source through these controls at all.
- evidence: Read both files' dropzone markup — neither has `tabIndex`/`role`/`onKeyDown`. Confirmed the correct pattern exists in the same codebase at `podcast-saas/client-web/components/SimulationUploader.tsx:310-324`, which has `role="button"`, `tabIndex={uploading ? -1 : 0}`, `aria-label`, an `onKeyDown` handler for Enter/Space, and — belt-and-suspenders — an explicit "Choose ZIP" `<button>` alongside the drop area.
- fix: Apply SimulationUploader's exact pattern (role/tabIndex/aria-label/onKeyDown, or a visible fallback `<button>`) to VideoUploader and CorpusUploader.
- verify: `pnpm -C podcast-saas --filter client-web test` after adding a test that Tabs to the dropzone and presses Enter, asserting the file input is triggered (mirroring any existing SimulationUploader keyboard test if one exists).
- effort: S

---

### [P2] The editor's timeline (clip blocks + trim handles) and the per-section clip-in/out trimmer are 100% mouse-driven — no keyboard path exists to select, move, or trim a section
- id: ui-ux-005
- location: podcast-saas/client-web/components/TimelinePanel.tsx:1392-1458
- category: a11y
- confidence: high
- status: confirmed
- what: Each timeline section block is a plain `<div onMouseDown=… onClick=…>` (1392-1417) with no `role`, `tabIndex`, or `onKeyDown` — it cannot be reached by Tab at all. Its trim-start/trim-end handles (1428-1438, 1448-1458) are likewise bare `<div onMouseDown>`s with no keyboard equivalent — there is no arrow-key nudge, no numeric fallback on the block itself. The per-section clip in/out trimmer in `podcast-saas/client-web/components/SectionEditor.tsx:2644-2673` (the scrubber track and the selection window that sets `clipInSec`/`clipOutSec`) is the same: `onMouseDown={handleScrubMouseDown}` / `onMouseDown={handleWindowMouseDown}` on unfocusable divs, with the numeric in/out values only ever set via drag (or the `i` hotkey which itself requires the video element to already be focused/playing, per line ~496-500) — there is no text input for start/end seconds.
- why: This is the primary content-editing surface of the entire product. A keyboard-only user cannot select a section, cannot trim it, and cannot set a clip's in/out points — the core editing task of the app is entirely unavailable without a mouse.
- evidence: Grepped `onMouseDown|role=|tabIndex|onKeyDown` in both files and read the surrounding JSX; confirmed no `role`, `tabIndex`, or keyboard handler exists on any of the block/handle/scrubber elements cited.
- fix: At minimum, make the section block focusable (`tabIndex={0}`, `role="button"`, `aria-label` describing the section) and wire arrow-key nudge / Delete for trim-start/trim-end while a block is focused; add numeric start/end (or in/out) inputs to `SectionEditor.tsx` as a keyboard-operable alternative to the scrubber drag.
- verify: A Playwright test that Tabs into the timeline, selects a block via keyboard, and confirms an equivalent action (e.g. delete, or a numeric trim change) is possible without a pointer event.
- effort: L

---

### [P2] `A2AudioModal`'s fixed-width floating panel has no viewport guard and clips off-screen on narrow phones, unlike its sibling floating panels
- id: ui-ux-006
- location: podcast-saas/client-web/components/A2AudioModal.tsx:188-196
- category: ux
- confidence: high
- status: confirmed
- what: The panel is positioned `right: 24, bottom: 164, width: 380` with no responsive/viewport-relative cap. Its left edge sits at `viewportWidth - 24 - 380`, which goes negative below a ~428px-wide viewport — meaning on any phone narrower than that (most phones, including a 375px iPhone SE/mini-class viewport) the panel's left portion is pushed off the left edge of the screen with no horizontal scroll offered (the ancestor is `fixed`), clipping content and controls.
- why: This is the "Add Music / Sound Effect" editor panel — on the affected viewport widths, part of its content and controls become unreachable.
- evidence: Read A2AudioModal.tsx:188-196 — `width: 380` and `right: 24` are both fixed pixel values with only a `maxHeight: 'calc(100vh - 200px)'` guard (vertical only, no horizontal one). Confirmed the sibling floating panels in the same codebase already guard against this: `podcast-saas/client-web/components/ExportProgressPanel.tsx:116` uses `w-[min(360px,calc(100vw-24px))]`, and `podcast-saas/client-web/components/GuidedTour.tsx:146` uses `w-[320px] max-w-[calc(100vw-24px)]`.
- fix: Cap the width the same way: e.g. `width: 'min(380px, calc(100vw - 48px))'` (or the Tailwind equivalent used by ExportProgressPanel), and consider anchoring via `left`/`right` clamped similarly.
- verify: Render at a 375px viewport and assert the panel's bounding rect has no negative left offset (visual/Playwright check).
- effort: S

---

### [P2] Several icon-only close buttons have no accessible name at all
- id: ui-ux-007
- location: podcast-saas/client-web/components/podcast/studio/VersionsDrawer.tsx:38
- category: a11y
- confidence: high
- status: confirmed
- what: `<button onClick={onClose} className="…"><X size={17} aria-hidden /></button>` — no `aria-label`, no `title`, and the icon is `aria-hidden`, so the accessible name is empty (a screen reader announces just "button"). The identical shape appears at `podcast-saas/client-web/components/podcast/studio/ExportDialog.tsx:23` and `podcast-saas/client-web/components/BrollPanel.tsx:154-159`. `podcast-saas/client-web/components/avatar/ExtendedLibraryModal.tsx:378` has the same problem via a different route — `<button className="avatar-gfs__close" onClick={onClose}><X size={18} /></button>`, no `aria-label`/`title` and the icon isn't `aria-hidden` either, but a bare lucide `<svg>` has no default accessible text so it is effectively unlabeled too. (Note: the same file's *other* close button, line 192, does it correctly with `aria-label="Close"` — so this is an inconsistency within one file, not a systemic miss.)
- why: A screen-reader user tabbing through these panels (mix export dialog, versions drawer, B-roll panel, avatar gallery fullscreen viewer) hits an unlabeled "button" with no way to know it closes the panel.
- evidence: Read all four call sites directly; none has `aria-label`/`title`/visible text. Compared against `podcast-saas/client-web/components/branching/BranchingModal.tsx:222-224` and `podcast-saas/client-web/components/podcast/PodcastVoicePicker.tsx:78`, which correctly set `aria-label="Close"` on the same kind of button — confirming this is an easy, already-known-good fix pattern in this codebase, just inconsistently applied.
- fix: Add `aria-label="Close"` (or a more specific label, e.g. "Close versions" / "Close export dialog") to each of the four buttons cited.
- verify: axe/jest-axe pass on each modal, or a quick manual VoiceOver/NVDA check confirming the button now announces a name.
- effort: S
