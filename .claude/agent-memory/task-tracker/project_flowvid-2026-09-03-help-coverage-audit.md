---
name: flowvid-2026-09-03-help-coverage-audit
description: CLOSED — all 3 gaps in §5 "the ? help" (PR #168) were fixed by PR #171 (commit 4c93336, fix/audit-followups), re-verified by mutation on 2026-09-03
metadata:
  type: project
---

**CLOSED 2026-09-03, re-audited on `fix/audit-followups` (PR #171, HEAD `4c93336`).** All three
gaps below (originally found against PR #168 / `1ff0eee`) are fixed. Re-verification used a
detached worktree at `4c93336` (not the working tree — see [[verify-committed-tree]]) with
`node_modules` symlinked from the primary checkout (safe only because the two commits share an
identical `pnpm-lock.yaml`, checked with `diff` first).

**1. HowItWorksDialog is now actually deleted.** `git ls-tree -r 4c93336 --name-only | grep
HowItWorks` is empty; `git grep HowItWorksDialog 4c93336` finds only two prose mentions (a
reference-patterns memory doc and a comment), no imports.

**2. The DOM-mount gap is closed, confirmed by mutation, twice.** `tourAnchors.{editor,header,
settings,section,persona,library,home}.test.tsx` (9 files, 51 tests) each render the real
surface component and assert every claimed anchor is in the DOM; `tourSurfaces.test.ts` +
`__tests__/helpers/tourSurfaces.ts` force every `TOUR_ANCHORS` key to be claimed by exactly one
mounted surface. Verified by re-running the ORIGINAL mutation from this memory's first version:
- Deleting `{...tourAnchor('library')}` from `VideoEditor.tsx` (client-web/components/
  VideoEditor.tsx:1367) now turns `tourAnchors.editor.test.tsx` red (`tourSurfaces.test.ts` and
  `tours.test.ts` stay green, as expected — they're pure-data checks, not DOM checks).
- Deleting the `branching: 'branching'` entry from `TOUR_ANCHORS` in `lib/tours/anchors.ts` turns
  BOTH `tourSurfaces.test.ts` and `tours.test.ts` red at runtime, AND `tsc --noEmit` reports 4
  type errors (`steps.ts:42`, `VideoEditor.tsx:1808`, `tourAnchors.editor.test.tsx:56`,
  `__tests__/helpers/tourSurfaces.ts:15`) — the "a step at nothing is a compile error" claim is
  now true for a registry-level deletion, not just a typo.

**3. The four uncovered features now have tour coverage.** `branching` anchor + EDITOR_STEPS step
(`lib/tours/steps.ts:39-45`), raise-your-hand and playlists named in the `share` step body
(`steps.ts:53`), `HOME_STEPS` with `home-projects` (`HomeHero.tsx`, `tourAnchor('home-projects')`)
and `home-playlists` (`PlaylistsPanel.tsx:89`) anchors, `TourButton` + `GuidedTour` wired into
`HomeHero.tsx`. Courses genuinely has no creator UI (`client-web` only calls the public GET
course/lesson routes, never the `courses.controller.ts` POST create routes) — the `.claude/review/
DECISIONS.md` 🟡 "Courses have no creator UI" line is accurate, recorded as an owner decision
rather than built.

**Also closed in the same commit (from a separate §6/PR #169 audit not previously memorialized):**
a Fastify-inject route test (`simulations.posterRoutes.test.ts`, 7 tests) now covers `GET /api/v1/
simulations/importable` and `POST /api/v1/projects/:id/sections/:sid/poster` through the real
`registerSimulationsRoutes`, asserting the stored key matches `posterKeyForSection(...)` and a
store-before-invalidate call order (`simulations.controller.ts:232-233` calls `storePoster` then
`invalidate`, matching the test). The ten dead-import lint warnings across `buildPlayerConfig.ts`,
`exportPlan.ts`, `simulations.controller.ts`, `sim-public.controller.ts` are gone (`eslint` exit 0
on all four). The 4 MB cap / 10-minute cache / session-scoped throttle deviations from the
original design are recorded (not changed) in `NIGHT-RUN-2026-09-03.md` §11's "What the audits
corrected" paragraph, along with the "C captions, F fullscreen" viewer-overlay design text being
explicitly marked aspirational-and-not-built.

**How to apply (still holds, now demonstrated twice):** when auditing a "this cannot rot / regress
silently" claim, don't trust the commit message — mutate the guarded thing (delete the anchor/
element/call site, or delete the registry entry) and run the actual suite, not just the named test
file. A pure-data test that only checks two tables agree with each other is not the same as a test
that checks the tables agree with the rendered DOM — but a registry-level deletion (as opposed to a
component-level one) IS caught by both the type system and the pure-data test, so the right
mutation to run depends on which layer you're trying to prove is guarded. See also
[[destructive-git-needs-a-census]] pattern of "the blocking list is not the damage list."
