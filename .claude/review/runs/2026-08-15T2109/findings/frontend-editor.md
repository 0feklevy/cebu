# Frontend review — editor + admin surfaces (supplementary pass)

Scope: `podcast-saas/client-web/components/{SectionEditor,TimelinePanel,VideoEditor,ProjectSettingsPanel}.tsx`
and every other non-viewer component in `client-web/components/`, `client-web/app/**`,
`client-web/lib/**` (excluding `lib/sim/**`), and all of `podcast-saas/admin-web/**`.

**Method:** traced project open → editor load → timeline edit → save (VideoEditor/TimelinePanel/
SectionEditor), the admin auth gate (AdminGate/firebase.ts) and every admin page's data-fetch/save
path, and swept the remaining editor-adjacent components (BrollPanel, A2AudioModal,
PlaylistEditorDialog, ImageCropEditor, CollaboratorsSection, ProjectHeader, HomeSidebar,
UserSettingsDialog). `pnpm -C podcast-saas --filter admin-web typecheck` reran clean
(`tsc --noEmit`, no output). Verified Next 15 async `params`/`searchParams` handling across every
dynamic route under `client-web/app/**` — all correctly `await params`.

**General note:** SectionEditor.tsx, TimelinePanel.tsx and VideoEditor.tsx carry an unusually deep
history of prior review passes — nearly every `useEffect` with a timer/listener/EventSource cites
an inline fix comment (`frontend-001`, `frontend-006`, `frontend-101`, `frontend-102`,
`frontend-201`, `ui-ux-005`, `sim-persistence fix`, etc.) and correctly tears down what it opens
(interval/RAF cleanup, `AbortController`, `interRef`-based drag handlers instead of stale
closures, `cancelled`/`active` guards on every list-loading effect). The three findings below are
gaps that survived that hardening, concentrated in save/optimistic-update paths that had less
scrutiny than the media/lifecycle code.

---

### [P2] Admin avatar-gallery delete is an unhandled rejection with no error surfaced and no rollback
- id: frontend-editor-001
- location: podcast-saas/admin-web/app/avatar/page.tsx:48-52 (`del`), called from :152
  (`onDelete={() => del(item.id)}`)
- category: bug
- confidence: high
- status: confirmed
- what: `del(id)` is `async () => { if (!confirm(...)) return; await deleteAvatarVisual(id); setItems(...) }`,
  invoked from `onClick`/`onDelete` as a bare `() => del(item.id)` with no `.catch` and no
  try/catch inside `del` itself. `deleteAvatarVisual` (`admin-web/lib/avatarAdminApi.ts:82`, via
  `authedFetch`) throws whenever the DELETE returns non-2xx or the network call fails.
- why: On any delete failure (permission error, the visual already deleted by another admin,
  network hiccup) the rejection is never caught: it becomes an unhandled promise rejection, the
  page's `error` state is never set (there is no error banner for this action at all — the only
  `setError` calls in this file are in the two top-level `useEffect`/`loadGallery` loads), and
  `setItems` is never reached, so the card silently stays in the grid with no indication the
  delete failed. The operator has no way to tell whether the click did anything.
- evidence: Read `admin-web/app/avatar/page.tsx` in full; `del` (lines 48-52) has no try/catch and
  its only caller (`GalleryCard`'s `onDelete`, line 152) does not wrap the call either. Compared
  against `loadGallery`/`getAvatarConfig`/`getAvatarStats` in the same file, which all route
  failures through `setError((e as Error).message)`.
- fix: Wrap the body of `del` in try/catch, route the caught error through the existing `error`
  state (`setError((e as Error).message)`), and keep `setItems` gated on success only (it already
  is, once the throw is caught instead of propagating).
- effort: S

---

### [P2] Optimistic simulation rename in the editor is never reconciled or rolled back on failure
- id: frontend-editor-002
- location: podcast-saas/client-web/components/VideoEditor.tsx:647-657 (`commitRenameSim`)
- category: bug
- confidence: high
- status: confirmed
- what: `commitRenameSim` optimistically sets the simulation's name in local state
  (`setSimulations(prev => prev.map(s => s.id === id ? { ...s, name } : s))`) before the PATCH,
  then on `api.updateSimulation` rejecting, the catch block is `{ /* revert on next list refresh */ }`
  — a comment describing a mechanism that does not exist. `simulations` is only reloaded by
  `loadData()` (called once on mount/auth-change and after a b-roll job completes) or by the
  `pendingSimKey` poll, which only runs while some simulation has `status === 'processing'` —
  renaming does not set that status, so neither path fires after a plain rename failure.
- why: If the PATCH fails (name validation, network blip, auth expiry mid-session — all realistic
  on a long editor session), the sidebar keeps showing the new, unsaved name indefinitely with no
  error message and no automatic correction. The user has no signal that the rename did not
  persist; a page reload is the only way to discover the real server-side name.
- evidence: Read `VideoEditor.tsx:646-657` and traced every caller of `setSimulations` triggered by
  a refetch: `loadData()` (line 350, called at :412-414 and from `handleBrollJobUpdate` on
  `status === 'ready'`, line 562) and the `pendingSimKey` poll (lines 456-470), which is gated on
  `simulations.filter(s => s.status === 'processing')` — renaming never produces that status, so
  the poll's dependency (`pendingSimKey`) stays empty and the effect never runs after a rename.
- fix: On catch, either revert the optimistic entry to its pre-rename name (keep the pre-update
  snapshot in a local variable before the optimistic `setSimulations` call) or surface an error and
  trigger an explicit refetch (`api.listSimulations(projectId).then(setSimulations)`), matching the
  pattern `confirmDeleteSim`/`confirmDeleteVideo` already use of not mutating local state until the
  await settles.
- effort: S

---

### [P2] Playlist editor's Save silently swallows failures, leaving title/items partially applied with no feedback
- id: frontend-editor-003
- location: podcast-saas/client-web/components/PlaylistEditorDialog.tsx:119-135 (`handleSave`)
- category: bug
- confidence: high
- status: confirmed
- what: `handleSave` does `await api.updatePlaylist(...)` then `await api.setPlaylistItems(...)`
  then `onChanged(); onClose();`, all inside `try { ... } catch { /* ignore */ } finally { setSaving(false) }`.
  There is no `saveError` (or any error) state in this component — grepping the file shows no
  `saveError` identifier at all — and no toast/banner mechanism is wired to the Save button.
- why: Two separate defects compound here. First, any failure (validation, network, auth expiry)
  is completely invisible: `saving` flips back to `false`, the dialog stays open, and the user has
  no way to tell whether their edits were saved. Second, because the two writes are sequential and
  independently awaited, a failure of the second call (`setPlaylistItems`) after the first
  (`updatePlaylist`) succeeds leaves the server with the new title/description/flags but the OLD
  item list — a real partial-write with zero indication to the user that their reordered/added
  items were dropped.
- evidence: Read `PlaylistEditorDialog.tsx:119-183`; `grep -n "saveError" components/PlaylistEditorDialog.tsx`
  returns nothing, confirming no error path exists for this handler (contrast with
  `handleBannerUpload`/`handleBannerGenerate` in the same file, which both route failures through
  `setBannerError`).
- fix: Add a `saveError` state, set it in the catch block, render it next to the Save button, and
  don't call `onClose()` on failure (currently unreachable inside the catch, but make it explicit)
  so the user can retry without losing their in-dialog edits.
- effort: S

---

## Scope notes / clean areas

- Admin-web dashboard/users/billing/llm-config/feature-flags/api-keys pages: all data fetches are
  guarded correctly (e.g. `UsersPage`'s `active` flag on the page-fetch effect at
  `admin-web/app/users/page.tsx:19-42` correctly discards out-of-order responses from rapid
  pagination clicks), and every save path routes failures through a visible `error` state. No
  findings.
- `AdminGate`/`AdminFirebaseAuthProvider` (admin-web/components/AdminGate.tsx,
  admin-web/lib/firebase.ts): the dev-only bypass fails closed in production
  (`process.env.NODE_ENV !== 'production' && NEXT_PUBLIC_ADMIN_BYPASS !== 'false'`), and `isAdmin`
  is decided server-side per session (a real authenticated GET against
  `/api/admin/v1/settings`), not by a client-only flag. No findings.
- `AdminSimSurface.tsx`: sandbox/inert/aria-hidden rules match `client-web`'s `SimSurface` by
  design (kept in sync by a cross-app DOM-equivalence test per its header comment); the duplication
  is deliberate and documented, not drift.
- `client-web/app/**`: every dynamic route (`[id]`, `[slug]`, `[shareToken]`, `[courseSlug]`,
  `[lessonSlug]`, `[showId]`, `[episodeId]`) correctly types `params` as a `Promise` and awaits it —
  Next 15 App Router convention is followed everywhere in scope.
- `TimelinePanel.tsx` drag/resize/duplicate/marker-drag gesture handlers: read in full; every
  `mousemove`/`mouseup` pair is torn down on unmount (`markerDragCleanupRef`), and in-flight drag
  state is read from a ref (`interRef.current`) rather than a closed-over `inter`, so there is no
  stale-closure risk despite the handlers being registered once per gesture. No findings.
- `SectionEditor.tsx` SSE/EventSource paths (bridge-script generation stream, guidance stream): all
  correctly close/abort on unmount and on re-invocation; the `JSON.parse` calls without try/catch
  in the guidance stream were already filed as `frontend-002` by the first-pass reviewer and are
  not re-reported here.
- `BrollPanel.tsx`, `ImageCropEditor.tsx`, `CollaboratorsSection.tsx`, `A2AudioModal.tsx`,
  `HomeSidebar.tsx`: read in full; polling/drag effects clean up correctly, and every
  fetch/mutation in `CollaboratorsSection.tsx` and `HomeSidebar.tsx` in particular routes failures
  through a visible error state or a `cancelled` guard — used as the positive reference pattern
  the three findings above are missing.
