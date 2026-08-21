---
name: flowvid-editor-admin-hardening
description: FlowVid's editor giants (SectionEditor/TimelinePanel/VideoEditor) and admin-web are heavily pre-reviewed — where new bugs still hide
metadata:
  type: project
---

As of run `2026-08-15T2109` (supplementary editor/admin pass), `podcast-saas/client-web/components/{SectionEditor,TimelinePanel,VideoEditor}.tsx`
and `podcast-saas/admin-web/**` have already been through multiple review cycles. Nearly every
`useEffect` with a timer/listener/EventSource in those three giant files carries an inline comment
citing a prior fix id (`frontend-001`, `frontend-006`, `frontend-101`, `frontend-102`,
`frontend-201`, `ui-ux-005`, etc.) and correctly tears down what it opens — interval/RAF cleanup,
`AbortController`s, `interRef`-based drag handlers instead of stale closures, `cancelled`/`active`
guards on list-loading effects. Grepping for `JSON.parse`, `setInterval/setTimeout`,
`addEventListener`, `createObjectURL`, `.play()/.load()` and reading each hit found almost nothing
new in that surface on this pass.

**Why this matters:** don't spend the review budget re-verifying lifecycle/cleanup hygiene in
those three files — it's very likely already correct. The genuine remaining gaps in this pass were
all in **optimistic-update / save-error paths that had less scrutiny than the media lifecycle
code**: an optimistic rename (`VideoEditor.tsx` `commitRenameSim`) whose catch comment claimed a
revert mechanism that doesn't exist, a dialog save handler (`PlaylistEditorDialog.tsx handleSave`)
with no error state at all despite every sibling handler in the same file having one, and an
admin delete handler (`avatar/page.tsx del`) with no try/catch at its only call site. See
[[frontend-reviewer-scope-notes]] for the exact ownership split with the sibling viewer-surface
reviewer.

**How to apply:** on a future supplementary pass over this same scope, prioritize: (1) any
`setXxx(prev => ...)` optimistic update, checking whether its catch block actually reverts or just
comments that it will; (2) every Save/Delete button's error path — grep for the component's error
state name and confirm every mutating handler in the file routes through it, not just some; (3)
admin-web pages that call a `lib/*Api.ts` helper directly from an `onClick` without an intermediate
`void x().catch(...)` wrapper.
