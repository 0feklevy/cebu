---
name: tour-anchor-collapse-behind-disclosure
description: How this repo handles guided-tour anchors when the elements they point to move behind a collapsed-by-default disclosure — check lib/tours/anchors.ts + steps.ts together before flagging a tour step as broken.
metadata:
  type: project
---

`podcast-saas/client-web/lib/tours/` implements a first-run guided tour keyed by string anchors
(`TOUR_ANCHORS` in `anchors.ts`, consumed by `tourAnchor()` and referenced from `Step[]` arrays in
`steps.ts`). When a PR moves a UI control behind a disclosure/accordion that is collapsed by
default, an anchor pointing INSIDE that disclosure is a real bug — the tour step is skipped
silently because the DOM node doesn't exist until the user opens the disclosure themselves.

On 2026-09-04 (`feat/library-minimal-ui`), `SectionEditor.tsx`'s Minimal-UI controls picker and
"Reuse this setup" moved behind a new collapsed-by-default "Advanced" disclosure. The PR's own
comment names this exact failure mode and fixes it correctly: the old `sec-sim-presets` /
`sec-sim-controls` anchors were deleted and replaced with one `sec-sim-advanced` anchor on the
always-visible disclosure TOGGLE button itself (not on the content inside it), with the step copy
rewritten to say "Open Advanced for the power tools…". `anchors.ts:29-35`, `steps.ts:128-131`.

**How to apply:** when a review finds a UI element moving behind a new disclosure/accordion, always
grep `lib/tours/anchors.ts` and `steps.ts` for that element's old anchor name before filing a
"broken tour step" finding — check whether the anchor was already relocated to the toggle in the
same diff, as it correctly was here. Only file it if the anchor still targets content that is
unreachable until user interaction.
