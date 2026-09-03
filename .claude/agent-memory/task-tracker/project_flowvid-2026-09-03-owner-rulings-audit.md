---
name: flowvid-2026-09-03-owner-rulings-audit
description: audit of 7 owner rulings (banners/import-panel/questions-removal/tap-to-ask-interactive on main PRs #180-181; script-panel/refresh-banner/portable-setup on PR #183) — 6 clean, 1 real unwired bug found in the portable-setup flagship scenario
metadata:
  type: project
---

Audited 2026-09-03 against `origin/main` (`0608c1c`, PRs #180 banners/inbox/import-panel + #181
tap-to-ask-interactive, both MERGED) and `feat/portable-setup` (PR #183, OPEN at `43f5ae3`, carries
PR #182's commit `2beba76` — script-panel redesign — since #182's branch was deleted pre-merge and
its commit rides inside #183 instead, which is why `gh pr view 182` shows CLOSED not MERGED).

**Items 1/2/3/6 — clean, no gaps.** Banners button removed from `VideoEditor.tsx` but
`useBannerSweep`'s auto-run `useEffect` (`useBannerSweep.ts:151-155`) still fires unconditionally;
`ImportSimulationDialog` is a genuine overlay+panel split (`.import-sim__overlay` fixed/inset:0 as
backdrop, `.import-sim` bounded to `min(1400px,92vw) × min(920px,90vh)`, full-screen only
`@media(max-width:640px)`), backdrop click guarded by `!importing`; the listener-question creator
inbox (routes, `ListenerInboxDialog`, the 4 named client-v1 methods) is fully gone client+server
while migration 083 and its 4 columns are deliberately KEPT (still in `migrate.ts`'s array and
`check-db.ts`, applied on production) — confirmed by commit `a514f1b`; "Refresh banner" button is
gone from `SectionEditor.tsx` but `usePosterCapture`'s own automatic capture effect
(`usePosterCapture.ts:74-80`, fires 1.5s after preview loads) survives untouched.

**Item 4 (Tap to ask interactive) — the deepest verification, fully holds under adversarial
reading.** `sentenceStream.ts`'s boundary logic (waits at end-of-buffer, skips abbreviations via
regex, skips digit-decimals, skips lowercase continuations) is exactly as tested.
`answerVoiceQuestionStream` (`VoiceQuestionService.ts`) genuinely starts TTS synthesis on sentence 1
via a promise chain BEFORE `await deps.ask(...)` (the model call) resolves — proven by a real
ordering test (`voiceQuestionStream.test.ts` "the first sentence is synthesised before the model
has finished", asserting `order.indexOf('tts:First') < order.indexOf('model-done')`, which WOULD
fail on the unfixed one-shot design). Abort propagation is real end-to-end, not just a passed-but-
ignored param: SSE route's `request.raw.on('close', () => controller.abort())` →
`answerVoiceQuestionStream(..., signal)` → `askListenerQuestion({abortSignal})` →
`LLMService.sendText` → each of `ClaudeProvider.ts:128`, `OpenAIProvider.ts:53`,
`GeminiProvider.ts:58` forwards `{signal: opts.abortSignal}` into the actual HTTP/SDK call. Client
`voiceLoop.ts`'s `END_CAPTURE` effect is a literal no-op (comment explains why); `RELEASE_MIC` is
mutation-pinned by `voiceLoop.test.ts:121` (`expect(effects.filter(e=>e==='RELEASE_MIC')).
toHaveLength(1)` across a full off→...→off exchange). All specified test commands pass (backend
125/125 across 9 files, client 35/35 across 3 files). **One minor gap:** `lib/tours/steps.ts:54`
(the creator-facing in-app tour's "share" step) still reads "...or press ✋ Raise your hand to ask
in text" — stale copy describing the typed-question UI that items 3+4 removed; the player itself
(`AudioEditionPlayer.tsx`) has no typed sheet (`useState<'closed'|'chapters'>`, no third state) but
that absence is not pinned by any negative test.

**Item 5 (script panel redesign) — core complaint fixed, two concrete residual issues found by
diffing commit `2beba76`'s hunks against the merged tree.** The outer card containers, title
("This moment"), and the numbered 2-step picker with "N of M kept" (label frozen, chevron/aria-
expanded carry state) are correctly tokenized and tested (`scriptPanelIntent.test.tsx`, covering
2 of the 3 outcome-line/button states — "controls only" [prompt empty, picker touched] is
implemented (`canGenerate = !!simPrompt.trim() || hasGenSelection`) but has zero test coverage).
**Found:** the "Simple UI"/"Auto Script" toggle-switch grid sitting directly below the fixed
picker, INSIDE the same card, was never touched by `2beba76` (confirmed: its hunks jump from old-
line 2257 to old-line 2588, skipping the toggle grid entirely) and still uses hardcoded
`#fffbeb`/`#f59e0b` (amber-50 wash / amber-500 border) for the "on" state — the literal "light-only
amber island" pattern the commit's own message says was eliminated. In dark mode this one sub-
control will look exactly like the pre-fix bug. Also `pickerLinkStyle`'s `color:'#b45309'` (Undo/
Keep all/Hide all buttons) is hardcoded, contradicting the PR body's "every string is a token
colour."

**Item 7 (portable setup / save-load-across-projects) — PARTIAL, one real unwired bug in the
flagship scenario.** Migration 084 (additive, rollback, registered in both `migrate.ts` and
`check-db.ts`), `SimulationImportService`'s `imported_from_simulation_id` recording, the pure
decision module `portableSetup.ts` (`resolveSetupTarget`/`describeSetupTarget`, all 7 branches
unit-tested including the never-swap rule), and the `/fit` + `/apply` routes (bring-block instead
of 400, import→attach→apply in one request, 409 still carries `brought`, second load reuses the
earlier copy via the migration-084 column) are all genuinely implemented AND covered by real
HTTP-level tests (`portableSetupApply.test.ts`) that assert exact call counts/payloads per branch —
all specified backend+client test commands pass (16 backend, 11 client). "Without wasting storage"
traces true: `SimulationImportService.ts` claims each file as a content-hashed blob (uploads only
unseen bytes), and `saved_bridges.main_body` is a plain Postgres `text` column, not a file copy.
**The bug:** `VideoEditor.tsx:1861` — `onSimulationUpdate={sim => setSimulations(prev =>
prev.map(s => s.id === sim.id ? sim : s))}` — is REPLACE-ONLY; `.map()` cannot append an id that
isn't already in the array. This works for the `source`/`existing-import` resolutions (the sim was
already in the project) but silently fails for the `import` resolution — the primary "a project
sees this package for the very first time" case the whole ruling ("like duplicate but across
projects") is about. Compare the CORRECT pattern used two call sites away for the import gallery:
`VideoEditor.tsx:1532` (`setSimulations(prev => [...prev, ...sims])`) and `:1544`
(`setSimulations(prev => [...prev, sim])`). Net effect: after "Bring X and load" into a brand-new
project, the section itself IS correctly pointed at the new simulation (works, because the preview
resolves via `section.simulation_url` set directly from the apply response) but the Simulation
`<select>` dropdown and any other UI reading the `simulations` array won't show it until a full
reload. **None of the three specified/existing client test files exercise this path** — a grep for
`bring`/`presetFit`/"and load" across all of `client-web/__tests__` returns zero hits outside the
files this memory names — confirming the gap is invisible to the existing suite, not just present
in the ledger.

**Method note:** items 1-4 read via `git show origin/main:<path>` (no worktree needed, pure reads);
items 5-7 needed real `vitest run`s, so used two detached worktrees at pinned SHAs
(`scratchpad/wt-main` @ `0608c1c`, `scratchpad/wt-rulings` @ `43f5ae3`) per [[verify-committed-tree]]
— NOT the primary checkout, whose branch had already silently changed once before this audit even
started (initial `gitStatus` said `docs/m3-ttl-and-ops-note`, first `git branch --show-current` in
this session already showed `feat/portable-setup`), consistent with
[[reverify-live-state-before-flagging-stale]]. Used isolated `pnpm install --frozen-lockfile`
per worktree rather than symlinking `node_modules` from the primary checkout — a first attempt at
symlinking triggered pnpm to "Recreate" the PRIMARY repo's real `node_modules` directory (relinking,
not a real reinstall — `pnpm-lock.yaml` was byte-identical across both refs — but risky enough in a
shared, concurrently-used checkout to avoid deliberately next time). Both worktrees removed at the
end (`git worktree remove --force`). Re-verified at the very end: `origin/main` and PR #183's
`headRefOid` both unchanged from the SHAs audited; PR #183's `mergeStateStatus: UNSTABLE` is just
"Release verification gate" still `pending` at report time (all other checks green), not a
conflict — `mergeable: MERGEABLE`.

**UPDATE, same day, later session.** The bug this memory found (`VideoEditor.tsx`'s
`onSimulationUpdate` REPLACE) and the two staleness gaps (hardcoded amber toggle grid, stale tour
copy) were all fixed by commit `18509e5` ("fix(setup): a brought simulation reached the section but
never the picker") before this memory was even read back — the rule moved to
`client-web/lib/simulationList.ts`'s `upsertById`, with a NEW mount-level test
(`broughtSimulationReachesTheList.test.tsx`) that renders `SectionEditor` on a section with
`simulation_id: null` and asserts the Load button is enabled and rendered — closing exactly the
"a disabled prop cannot see an enclosing gate" hole this memory itself named. See
[[flowvid-2026-09-03-layout-regression-and-panel-followups-audit]] for the full re-verification and
what is still actually open (two narrower residual gaps, different from the ones this memory found).
