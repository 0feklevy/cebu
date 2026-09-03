---
name: flowvid-2026-09-03-layout-regression-and-panel-followups-audit
description: audit of the v0.3.0 layout-regression hotfix (#172), share-library banners (#173), and PR #185's own eight UX-review claims — all confirmed, two narrow residual color/test gaps found
metadata:
  type: project
---

Audited 2026-09-03 (evening) against `origin/main` (`51d5f96`, carries #172-#184 merged) plus open
PR #185 `fix/script-panel-ux-followups` (`7fea175`, based on main-with-#184). Ran real `vitest`
(client-web + backend-api, existing `node_modules`, no install) and real `tsc --noEmit` / `eslint`
in both workspaces — all clean — rather than trusting the PR bodies' own claims of the same.

**v0.3.0 layout regression (#172) — clean.** `tailwind.config.ts`'s `theme.extend.screens` (the
`landscape: { raw: ... }` entry #167 added) is gone entirely; `tailwindResponsiveVariants.test.ts`
compiles a probe through the REAL config via `postcss`+`tailwindcss` (not a string match) and passes
3/3 — proving arbitrary `min-[…]:`/`max-[…]:` variants emit CSS again. `ProjectHeader.tsx:211,233`
and `PlaylistEditorDialog.tsx:251` still carry the exact `hidden min-[390px]:inline` classes for
Export/Preview labels. `ImportSimulationDialog.tsx` genuinely `createPortal`s to `document.body`
(own stacking context, confirmed item 2). One doc-staleness note: the file's own top-of-file
docstring still describes the OLD full-screen-gallery design ("the whole screen, stills first") from
PR #169 — contradicted by the current CSS (`importSimulation.css:9`, bounded to
`min(1400px,92vw)×min(920px,90vh)`, full-screen only under 640px) and by #180's actual "gallery
becomes a panel" change. Cosmetic (comment only), but would mislead the next reader/agent.

**Share library (#173) — clean.** `loadSimBannerUrls` (`buildLibraryView.ts:144`) prefers the served
revision's poster, falls back to the newest RETIRED revision's poster, and never uses a
never-activated candidate — all 4 branches unit-tested (`simBanners.test.ts`, 4/4 pass) including a
DB-failure-degrades-gracefully case. `useBannerSweep.ts` auto-runs via
`useEffect(() => { if (!enabled) return; run(false); }, [enabled, simulations])`, `enabled` defaults
true and `VideoEditor.tsx:1222` never overrides it. First paint: `usePaintedSignal.ts` resolves on a
real `SIM_PAINTED`/`SIM_PAINTED_FALLBACK` postMessage from the iframe FIRST, the 1200 ms `setTimeout`
is only the last-resort fallback (down from the old 2.5 s) — `paintedSignal.test.tsx` (4/4) and the
server-side `simBootSnippet.painted.test.ts` (4/4, runs the injected snippet for real in a `vm`
sandbox) both pass.

**PR #185 (open, UX-review follow-ups on the script panel) — all 5 claimed fixes hold, with two
narrow residual gaps found by reading render logic rather than the diff alone:**
- Escape-closes-topmost + focus-restore: the Escape handler correctly checks `presetSaveOpen`/
  `loadOpen` before falling through to `onClose()` (`SectionEditor.tsx` handler, tested — Escape
  once closes the dialog, `onClose` not called; twice closes the editor). The focus-restore ref
  (`setupDialogReturnFocus`) is real and wired into both dialogs' Cancel/backdrop/Escape paths, but
  **has zero test coverage** — no test asserts `document.activeElement` actually returns to the
  trigger button. Implemented-but-untested, not a false claim, just unverified by the suite itself.
- Step 3 relabeled "3 · How it behaves" (was "3 · Apply them") — confirmed in code and
  `scriptPanelIntent.test.tsx`.
- "Minimal UI" replaced with "Simple UI" in the toggle note and the Reuse-card description — BUT one
  more instance survives inside the SAME card: `SectionEditor.tsx:2420`,
  `'This simulation has no buttons or sliders for Minimal UI to hide.'`, rendered only when
  `uiScan.phase === 'empty'` AND the picker panel is open. The new test
  (`scriptPanelIntent.test.tsx` "the two switches announce their state...") asserts
  `queryByText(/Minimal UI/i)).toBeNull()` but only under the DEFAULT mount state, where
  `uiScan.phase` never reaches `'empty'` — so the claim "Minimal UI appears nowhere in that card" is
  not quite true; it is untested for the one phase where it is false. A real, narrow, "false green"
  in the making of the exact kind this role exists to catch.
- `role="switch"`/`aria-checked` on both toggles — confirmed in the `.map()` over the 2-item array
  (both switches get it identically); test explicitly exercises only "Simple UI", not "Auto Script",
  but the shared component code makes that low-risk.
- `--success`/`--warning` added to `globals.css` with dark-theme values, `--destructive` gained a
  dark value it previously lacked — confirmed via `git diff`. Used at: keep/hide badges, the error
  box, the confidence badge, the low-confidence warning, "Last generation" label. **One surface named
  in the PR body is NOT actually on the new tokens**: the "regenerate offer" box
  (`SectionEditor.tsx:2803`) still hardcodes `border: '1.5px solid #f59e0b'` and
  `background: 'rgba(245,158,11,0.12)'` rather than `hsl(var(--warning))` — only its TEXT color moved
  to `hsl(var(--foreground))` (from `#92400e`, fixing the dark-ink-on-dark-wash illegibility). Net
  effect is dark-mode-safe in practice (translucent wash reads fine on both grounds) but the literal
  "uses --warning" claim is false for this one box.

**Corroboration beyond the PR's own claims.** Ran `tsc --noEmit` directly in both `client-web` and
`backend-api` (clean, 0 errors, existing `node_modules`, no install) and `eslint` on the 3 changed
files (0 errors, 2 pre-existing warnings unrelated to this diff) — matching but independently
verifying the PR body's "tsc/eslint clean" claim rather than trusting it. `gh pr checks 185`: 8/9
green (Redundancy guard, Static audits, 3 self-contained browser suites, all 3 viewer e2e browsers);
"Release verification gate" (the one that runs the full client suite + tsc + eslint together, ~15-16
min per [[reverify-live-state-before-flagging-stale]]) was still IN_PROGRESS at report time —
reported as pending, not assumed green, per that same memory's rule against snapshotting a pending
check as a verdict.

**Confirms the same-day self-correction noted in
[[flowvid-2026-09-03-owner-rulings-audit]]**: commit `18509e5` (before this audit even started)
already fixed that memory's REPLACE-vs-upsert bug, the gated Load button, the hardcoded-amber toggle
grid, and the stale tour copy — all re-verified clean here via `broughtSimulationReachesTheList.
test.tsx` (5/5, mounts `SectionEditor` on a section with `simulation_id: null` and asserts the Load
button renders enabled, not just that its `disabled` prop is false) and `tourAnchors.editor.test.tsx`
(clean).
