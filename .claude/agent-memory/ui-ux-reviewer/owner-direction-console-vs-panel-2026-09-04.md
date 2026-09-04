---
name: owner-direction-console-vs-panel-2026-09-04
description: Owner ruling (2026-09-04) that routine/operator-only diagnostics go to console.warn, not the UI panel, across FlowVid's editor and export surfaces — read this before flagging "missing" info as a UX gap.
metadata:
  type: project
---

On 2026-09-04 the owner directed a repo-wide UX simplification pattern, applied in the same PR to
two different surfaces:

1. `podcast-saas/client-web/components/ExportProgressPanel.tsx` — routine per-section
   "no poster still exists for this exact configuration" warnings collapse into one summary
   `<li>` in the panel and go to `console.warn` verbatim (still recoverable for a bug report).
2. `podcast-saas/client-web/components/SectionEditor.tsx` — the simulation "last generation"
   diagnostics (confidence %, provider/model, bridge warnings) moved behind a collapsed-by-default
   "Advanced" disclosure and also log to `console.warn` via a small `SimMetaConsoleLog` helper.
   The one exception kept always-visible outside the disclosure: a low-confidence (<45%) warning,
   because that one is actionable by a regular user, not just an operator.

**Why:** the owner's stated reasoning is that this class of information is "operator chatter to a
regular user" — correct and worth keeping recoverable, but not worth cluttering the default view
with. `"Copy all"` on the export panel still hands over the *complete* original warning text, so
nothing is actually lost, only what's shown by default is trimmed.

**How to apply:** when reviewing a *new* instance of "info moved to console instead of the panel"
in this codebase, don't reflexively file it as a "silent failure" or "error only in console"
finding — check first whether it's operator-diagnostic info with a UI-visible summary/count (the
pattern above), versus an actual failure/error state with no UI signal at all. The latter is still
a real finding; the former is an established, owner-approved pattern. See [[tour-anchor-collapse-behind-disclosure]] for the companion pattern this created in the tour system.
