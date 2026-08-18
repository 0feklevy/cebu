# UI/UX & Accessibility Findings — ui-ux-reviewer

Scope covered: all client-web App Router routes and their driving components (editor, viewer,
share/permalink viewers, podcast studio, playlists, upload/corpus flows) and all admin-web routes.
`_archive/**`, `.next/**`, `node_modules/**`, `e2e/**` fixtures skipped per instructions.

---

### [P2] Viewer's "processing" poll has no timeout — a stuck transcode spins the loading state forever
- id: ui-ux-001
- location: podcast-saas/client-web/components/viewer/ViewerPage.tsx:33-81 (duplicated at podcast-saas/client-web/components/viewer/SharedViewerPage.tsx:32-88)
- category: ux
- confidence: high
- status: confirmed
- what: The `check()` poll only stops on a thrown fetch error, a 404 (share page only), `locked`,
  empty segments, or `allFailed` (every segment's `hls_status === 'failed'`). If the backend leaves
  a segment in a non-terminal state indefinitely (stuck worker, crash that never flips
  `hls_status` to `failed`), the `setInterval(check, 5000)` loop runs forever and the component
  never leaves the `!config` branch (client-web/components/viewer/ViewerPage.tsx:105-114): a
  spinner plus "Video is processing — this may take a few minutes…" with no cap, no retry button,
  no way to bail out.
- why: This is exactly the "long media operation spinner that never resolves" failure mode this
  review was asked to prioritize, and it sits on the two highest-traffic surfaces in the app: the
  owner viewer and the public share/permalink viewer. A visitor who hits a broken transcode job has
  no way to tell "still working" from "will never finish" and no affordance to leave the wait state.
- evidence: Read both files end to end. Compare with `podcast-saas/client-web/lib/useProjectExport.ts:59-61,262-265`,
  which has exactly this problem solved via `MAX_CONSECUTIVE_POLL_FAILURES` and a "lost contact"
  message — the pattern exists in this codebase, it just wasn't applied to the viewer poll.
- fix: Cap the poll (e.g. stop after N intervals of `processing`, or after a wall-clock budget) and
  render a distinct "taking longer than expected" state with a manual "check again" action, mirroring
  the give-up pattern already used in `useProjectExport.ts`.
- effort: M

### [P2] Podcast studio "Building the studio audio…" poll has no timeout or escape
- id: ui-ux-002
- location: podcast-saas/client-web/components/podcast/studio/AudioStudio.tsx:117-131
- category: ux
- confidence: high
- status: confirmed
- what: `generating` polls `getPodcastStudio` every 2.5s for as long as `data.mix?.status ===
  'generating'`. There is no attempt counter and no timeout. The render for this state
  (AudioStudio.tsx:255-258, the "Building the studio audio…" spinner) has no cancel/dismiss control
  either — the user is stuck on that screen until the backend transitions the mix out of
  `generating`.
- why: Same failure mode as ui-ux-001 in the studio's audio-build pipeline: if the LLM/TTS batch
  job that builds clips wedges or crashes without writing `status: 'failed'`, the operator is left
  looking at an unbounded spinner with no explanation and no way out, mid-editing-session.
- evidence: Read AudioStudio.tsx:100-270 in full; no `MAX_` constant, no attempt counter, no
  timeout anywhere in this effect, unlike the export poll two effects below it which at least
  terminates on `render.status === 'failed'` (AudioStudio.tsx:199-201) — the generation poll has no
  equivalent failed-path from the server at all as far as the client is concerned.
- fix: Add a poll-attempt cap (mirror `useProjectExport.ts`'s `MAX_CONSECUTIVE_POLL_FAILURES`
  pattern) and surface a "still building — you can wait or come back later" state with a manual
  refresh action after the cap is hit.
- effort: S

### [P2] Several icon-only close buttons have no accessible name
- id: ui-ux-003
- location: podcast-saas/client-web/components/BrollPanel.tsx:154-159
- category: a11y
- confidence: high
- status: confirmed
- what: `<button onClick={onClose}><X size={15} strokeWidth={1.9} aria-hidden /></button>` — the
  icon is `aria-hidden`, and the button has no `aria-label`, `title`, or visually-hidden text. Same
  pattern at `podcast-saas/client-web/components/podcast/studio/VersionsDrawer.tsx:38` and
  `podcast-saas/client-web/components/avatar/ExtendedLibraryModal.tsx:378`.
- why: A screen-reader user tabbing to these "close panel" buttons hears only "button" with no
  indication of what it does, in three different close/dismiss controls across the B-roll panel,
  podcast versions drawer, and the avatar library's fullscreen preview.
- evidence: Read all three files at the cited lines; confirmed no `aria-label`/`title`/`sr-only`
  text present on any of the three. Contrast with `podcast-saas/client-web/components/ExportProgressPanel.tsx:120-127`
  which does the same close action correctly (`<span className="sr-only">Close export panel</span>`
  plus `title="Close"`) — the accessible pattern already exists in this codebase.
- fix: Add `aria-label="Close"` (or a more specific label per surface, e.g. "Close b-roll panel")
  to each of the three buttons.
- effort: S

### [P2] ConfirmDialog — the app-wide destructive-action modal — has no focus trap or initial focus
- id: ui-ux-004
- location: podcast-saas/client-web/components/ConfirmDialog.tsx:53-67
- category: a11y
- confidence: high
- status: confirmed
- what: `ConfirmDialog` renders `role="dialog" aria-modal="true"` but never moves focus into the
  dialog on open and has no Tab-trap, so keyboard focus stays wherever it was before the dialog
  opened (typically the trigger button) and `Tab` can walk into content behind the (unstyled,
  non-focus-blocking) backdrop rather than staying inside the dialog. It is used for every
  "Delete project?" / "Duplicate project?" confirmation in `HomeSidebar.tsx` and for several
  deletes/discards in `VideoEditor.tsx`, `SectionEditor.tsx`, and the podcast show/script pages.
- why: `aria-modal="true"` is a promise to assistive tech that focus is contained; here it isn't,
  so a screen-reader or keyboard-only user confirming a permanent delete can tab past the
  Confirm/Cancel buttons into background page content without realizing they've left the dialog.
- evidence: Read ConfirmDialog.tsx in full — no `useEffect` moving focus, no keydown Tab handler,
  no `inert`/`aria-hidden` applied to the rest of the page. Contrast with
  `podcast-saas/client-web/components/ProjectSettingsPanel.tsx:70-88`, which implements exactly
  this (initial `.focus()` + a Tab-cycling keydown handler) for its own modal — the working pattern
  already exists one file away in the same component tree.
- fix: Port the focus-trap effect from `ProjectSettingsPanel.tsx:70-88` into `ConfirmDialog`:
  focus the dialog (or the Cancel button) on mount, and cycle Tab/Shift+Tab between the two buttons.
- effort: S

### [P2] Upload dropzones are not reachable by keyboard
- id: ui-ux-005
- location: podcast-saas/client-web/components/VideoUploader.tsx:380-388
- category: a11y
- confidence: high
- status: confirmed
- what: The drop target is a plain `<div onDragOver onDragLeave onDrop onClick>` with no `role`,
  no `tabIndex`, and no `onKeyDown`. It is not in the Tab order, so a keyboard-only user cannot
  reach it at all — there is no way to invoke `inputRef.current?.click()` without a pointer. The
  identical pattern (div + onClick + hidden `<input type=file>`, no tabIndex/role/keydown) is at
  `podcast-saas/client-web/components/CorpusUploader.tsx:48-53`.
- why: Uploading a video or corpus source is a primary, often first, action in both the editor and
  the corpus-builder flow. A keyboard-only user has no way to open the file picker on either
  surface.
- evidence: Read both files; neither dropzone `div` has `tabIndex`, `role="button"`, or a keydown
  handler for Enter/Space.
- fix: Add `role="button" tabIndex={0}` and an `onKeyDown` that triggers `inputRef.current?.click()`
  on Enter/Space (or replace the wrapping `div` with a `<button type="button">` styled the same way
  and drop the `onClick` off the div).
- effort: S

### [P2] Editor timeline is entirely pointer-driven — no keyboard alternative to seek, select, trim, or place clips
- id: ui-ux-006
- location: podcast-saas/client-web/components/TimelinePanel.tsx:2011-2014 (video track), 1834-1844 (b-roll track)
- category: a11y
- confidence: medium
- status: confirmed
- what: The video and b-roll tracks are `<div onMouseDown={...} onClick={handleTrackClick}>` with
  no `tabIndex`/`role`, and clip creation/move/trim throughout the file is driven by
  `onPointerDown`/`onMouseDown` gesture handlers (e.g. `handleCirclesPointerDown` at line 1149,
  the marker-drag handlers around line 1090). The only keyboard support in the whole 2292-line file
  is Escape (to close a popover/exit a mode) and Delete/Backspace to remove an already-selected
  item (lines 1120-1133, 1214-1231) — both of which require the selection to have been made with a
  mouse first. There is no keyboard path to move the playhead, select a clip, or create/trim a
  section.
- why: A keyboard-only editor cannot operate the timeline at all beyond deleting whatever happens
  to already be selected — every other timeline action (seek, select a clip, trim, place a marker,
  create a b-roll/circle range) requires a pointer.
- evidence: `grep -n "onKeyDown|keydown|ArrowLeft|ArrowRight|tabIndex" TimelinePanel.tsx` returns
  only the two Escape/Delete effects noted above; no `tabIndex` on any track/clip element.
- fix: At minimum, make the focused track/clip elements reachable (`tabIndex=0`) and add
  arrow-key seeking of the playhead plus Enter/Space to select a clip under an on-screen cursor —
  full parity is a larger project, but "reachable and seekable" is the realistic first step.
- effort: L

### [P2] Admin Toggle switch has no accessible name — including the "Maintenance Mode" kill switch
- id: ui-ux-007
- location: podcast-saas/admin-web/app/feature-flags/page.tsx:315-341
- category: a11y
- confidence: high
- status: confirmed
- what: `Toggle` renders `<button type="button" role="switch" aria-checked={checked} onClick=...>`
  with no `aria-label` or `aria-labelledby`; the visible title text ("Maintenance Mode", "Adaptive
  quality", etc.) lives in a sibling `<div>` inside `FlagCard` (feature-flags/page.tsx:300-307) with
  no `id`/`htmlFor` relationship to the switch. `ChoiceCard`'s `<select>` two components below it
  does this correctly (`aria-label={title}` at line 265) — `Toggle` is the one control in this file
  that doesn't.
- why: Every toggle on this page announces to a screen reader only as "switch, on/off" with no
  indication of which control it is — including Maintenance Mode, which this file's own comment
  calls out as "the safe setting if simulations are leaking memory or crashing tabs" and one of "the
  kill switches an incident actually needs" (feature-flags/page.tsx:15-23). This is the control an
  on-call admin under time pressure is most likely to need to operate correctly and unambiguously.
- evidence: Read Toggle (315-341) and FlagCard (279-313) in full; no aria-label/aria-labelledby
  anywhere in either. Compared against ChoiceCard (242-277), which passes `aria-label={title}` to
  its own control.
- fix: Add a `label` prop to `Toggle` and pass `title` through from `FlagCard`, rendering
  `aria-label={label}` on the switch button (same fix `ChoiceCard` already applies to its `<select>`).
- effort: S

### [P3] Admin API-key inputs have no associated `<label>`
- id: ui-ux-008
- location: podcast-saas/admin-web/app/api-keys/page.tsx:143-150
- category: a11y
- confidence: medium
- status: confirmed
- what: Each provider's key `<input type="password">` relies on a `placeholder` and a nearby
  (visually adjacent, not programmatically linked) heading `{label}` (e.g. "Anthropic (Claude)")
  for its name — there is no `<label htmlFor>`/`aria-label`/`aria-labelledby` tying the two
  together.
- why: A screen-reader user tabbing through the four key fields hears an unlabeled password field
  (placeholders are not reliably announced as the accessible name), with no way to tell which
  provider's key they are about to overwrite before typing.
- evidence: Read api-keys/page.tsx:105-150; the input has `placeholder`, `autoComplete="off"`, no
  labelling attribute of any kind.
- fix: Add `aria-labelledby` pointing at the existing `label`/heading `div`'s `id`, or wrap in an
  actual `<label>`.
- effort: S

### [P3] Bare "✕" glyph buttons with no accessible name
- id: ui-ux-009
- location: podcast-saas/client-web/components/CorpusUploader.tsx:96,105
- category: a11y
- confidence: medium
- status: confirmed
- what: `<button onClick={() => removeFile(i)} ...>✕</button>` and the matching URL-remove button
  use a bare Unicode "✕" character as their only content, with no `aria-label`.
- why: Screen readers vary in how (or whether) they announce the multiplication-sign glyph; it is
  not a reliable substitute for a real accessible name like "Remove file" / "Remove URL".
- evidence: Read CorpusUploader.tsx:88-110 in full; confirmed no aria-label on either button.
- fix: Add `aria-label={`Remove ${f.name}`}` / `aria-label="Remove URL"` respectively.
- effort: S

### [P2] Fixed-width popovers are not viewport-clamped and can overflow off narrow screens
- id: ui-ux-010
- location: podcast-saas/client-web/components/A2AudioModal.tsx:188-196
- category: ux
- confidence: medium
- status: confirmed
- what: The audio-section popover is positioned `right: 24, bottom: 164, width: 380` with no
  viewport-width clamp. On any viewport narrower than ~430px (`24 + 380 + 24` margin), the panel's
  left edge runs off-screen. The same fixed-width-with-no-clamp pattern recurs at
  `podcast-saas/client-web/components/TimelinePanel.tsx:471-488` (`width: 320, right: 24`).
- why: The editor is used responsively elsewhere in the same codebase (e.g.
  `VideoUploader.tsx:385` uses `sm:px-6 sm:py-8` breakpoints, and `ExportProgressPanel.tsx:116`
  explicitly clamps with `w-[min(360px,calc(100vw-24px))]` specifically to avoid this). These two
  popovers open from the same timeline/editor surface but were not given the same treatment, so a
  user on a small tablet or a narrow browser window editing a project sees the audio-settings and
  audio-section popovers clipped or partially off-screen.
- evidence: Read both files at the cited lines; neither uses `calc(100vw-...)`/`min(...)` the way
  `ExportProgressPanel.tsx:116` does for the equivalent case.
- fix: Apply the same `min(WIDTHpx, calc(100vw - 24px))` clamp used in `ExportProgressPanel.tsx:116`
  to both popovers' width (and consider left-edge repositioning on narrow viewports rather than a
  fixed `right: 24`).
- effort: S

### [P2] Playlist delete and share-revoke failures are silently swallowed
- id: ui-ux-011
- location: podcast-saas/client-web/components/PlaylistEditorDialog.tsx:179-183
- category: ux
- confidence: high
- status: confirmed
- what: `handleDelete`'s catch block is `catch { /* ignore */ }` — if `api.deletePlaylist` rejects
  (network error, 403, 409, etc.), nothing happens: no `onChanged()`, no `onClose()`, no error
  state set anywhere in the component. The user pressed "Delete" (past the native `window.confirm`
  gate at line 181), the dialog stays open, and the playlist visually looks unchanged with zero
  indication of what went wrong. `handleRevokeShare` two lines above (172-177) has the identical
  silent-catch pattern for revoking a share link.
- why: A destructive action that fails must tell the user it failed — otherwise they either retry
  blindly, assume it worked and navigate away leaving the playlist un-deleted, or conclude the
  button is broken.
- evidence: Read PlaylistEditorDialog.tsx:170-183; confirmed no error state, toast, or `console`
  call of any kind in either catch block, and no `error`/`err` state variable is even declared for
  this component (grepped the file for `useState.*error` — none found for these two actions; the
  file's other async handlers, e.g. `handleSave`, do set an error state on failure).
- fix: Set the same error/toast surface `handleSave` already uses on failure, and keep the dialog
  open with a visible "Couldn't delete this playlist — try again" message.
- effort: S

### [P3] Podcast studio overlays skip Escape-to-close, inconsistent with the rest of the app
- id: ui-ux-012
- location: podcast-saas/client-web/components/podcast/studio/ExportDialog.tsx:17-23
- category: ux
- confidence: medium
- status: confirmed
- what: `ExportDialog`, `VersionsDrawer.tsx:14-39`, and `ClipPopover.tsx` are hand-rolled overlays
  (backdrop `div` + `createPortal`) with click-outside-to-close but no `keydown` handler for
  Escape, and no `role="dialog"`/`aria-modal`.
- why: Escape-to-close and modal semantics are the established pattern elsewhere in this app —
  `ConfirmDialog.tsx:32-36`, `ProjectSettingsPanel.tsx` (via its own effect), and the Radix-based
  dialogs (`CreateProjectDialog`, `UserSettingsDialog`, `HowItWorksDialog`, `PlaylistEditorDialog`,
  which get this for free from `@radix-ui/react-dialog`) all support it. These three podcast-studio
  overlays are the outliers.
- evidence: `grep -n "role=\"dialog\"|aria-modal|Escape" ExportDialog.tsx VersionsDrawer.tsx
  ClipPopover.tsx` returns nothing in any of the three files.
- fix: Add the same `window.addEventListener('keydown', ...)` Escape handler `ConfirmDialog.tsx:32-36`
  uses, and `role="dialog" aria-modal="true"` on each panel's outer element.
- effort: S

---

## Architecture notes

- **Two competing modal idioms coexist with no shared component.** Some dialogs get Radix
  (`@radix-ui/react-dialog` — free focus trap, Escape, `role="dialog"`) and some are hand-rolled
  `createPortal` + backdrop `div` pairs that each reimplement (or omit) focus trapping and Escape
  independently (`ConfirmDialog`, `ProjectSettingsPanel`, `A2AudioModal`, `SectionEditor`'s popover,
  `ExportDialog`, `VersionsDrawer`). The quality is inconsistent precisely because the plumbing is
  copy-pasted rather than shared — a single `useModalA11y(ref, onClose)` hook (trap + Escape +
  initial focus) used by every hand-rolled overlay would close most of the a11y findings in this
  report at once (ui-ux-004, ui-ux-012) instead of one-at-a-time.
- **The polling-with-timeout pattern is proven but only lives in `useProjectExport.ts`.** That hook
  is the one place in the codebase that correctly handles "the server may never answer" for a
  long-running media job (`MAX_CONSECUTIVE_POLL_FAILURES`, a distinct "lost contact" message). Every
  other poll loop in the app (viewer processing, podcast mix generation, HLS status, simulation
  status) reimplements its own ad hoc `setInterval` with no shared give-up policy. Given that "stuck
  spinner on a failed media job" is called out as this review's top priority, promoting that hook's
  logic into a shared `usePolledStatus` utility would prevent this class of bug from recurring as
  new async surfaces get added.
- **Fixed-pixel-width floating panels anchored with `right: N`** (A2AudioModal, TimelinePanel's
  audio popover, several others) are a recurring pattern that only sometimes gets the
  `min(Wpx, calc(100vw - Npx))` viewport clamp that `ExportProgressPanel` documents as a deliberate,
  previously-incident-causing fix (its own rule 7 comment). Since that rule was learned the hard way
  once already, it's worth lifting into a small shared `FloatingPanel` wrapper so the clamp is
  applied by construction rather than by remembering to copy it into every new popover.
