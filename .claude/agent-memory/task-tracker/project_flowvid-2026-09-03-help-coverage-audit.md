---
name: flowvid-2026-09-03-help-coverage-audit
description: Audit gaps in §5 "the ? help" (PR #168, feat/help-coverage) — false "deleted"/"compile error" claims in the commit and ledger, and four still-uncovered features
metadata:
  type: project
---

Night-run §5 ("the '?' help", `.claude/review/NIGHT-RUN-2026-09-03.md` §5) shipped as PR #168,
merged to `origin/main` via `1ff0eee`. Audited 2026-09-03 against the merged tip. Two of the
commit's own claims are false, and the Acceptance criterion's "coverage table" item is only
partly met — none of this was caught before merge.

**1. "HowItWorksDialog deleted" is false.** Commit `1e3fdb5` and `.claude/review/DECISIONS.md:85`
both say it was deleted. `podcast-saas/client-web/components/HowItWorksDialog.tsx` is still in the
tree on `origin/main` right now — unreferenced (dead, as it already was pre-PR) but never removed.
No commit in `main..feat/help-coverage` touches that path at all.

**2. "a step at nothing is a compile error" / "cannot rot silently again" overstates what shipped.**
The Design section promised "a render test mounts the editor and asserts every anchor is in the
DOM — the silent-skip rot becomes a red test." That test does not exist.
`podcast-saas/client-web/__tests__/tours.test.ts` only checks the pure data tables (every step's
anchor is a key of `TOUR_ANCHORS`, and every `TOUR_ANCHORS` key is used by some step) — it never
renders a component or queries the DOM. Proven by mutation: deleting
`{...tourAnchor('library')}` from `VideoEditor.tsx` (so the anchor renders nowhere) leaves
`tsc --noEmit` clean and all 115 client-web test files / 1911 tests green. The only signal left is
`GuidedTour.tsx`'s `console.warn` in non-production — invisible in CI, exactly the failure mode
the feature was built to close. TypeScript only catches a *typo'd* anchor name at a `tourAnchor()`
call site, not a call site being deleted entirely.

**3. Four features named in §5's own gap list still have no tour step anywhere:** "Raise your
hand", courses, playlists, branching (checked against `lib/tours/steps.ts` — none of the four
strings appear). Import gallery, markers/flags, music/SFX, dubbing, the Minimal-UI control picker,
the three share addresses + Create podcast, export, and keyboard shortcuts ARE covered.

**How to apply:** when auditing a "this cannot rot / regress silently" claim, don't trust the
commit message — mutate the guarded thing (delete the anchor/element/call site) and run the actual
suite. A pure-data test that only checks two tables agree with each other is not the same as a
test that checks the tables agree with the rendered DOM. See also
[[destructive-git-needs-a-census]] pattern of "the blocking list is not the damage list" — here,
"the anchor registry is not the DOM."
