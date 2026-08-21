# Decision response for Claude — 2026-08-21

Rulings for the open decisions of the 2026-08-21 feature round, written against
`integration/night-run` @ `bda28d6` (= `origin/main` `6c7f9bb` + three feature merges:
`8434f05` library-share, `06c6252` dubbing, `bda28d6` crop). `pnpm release:verify` passed on
exactly this tree. The implementing session executes these rulings in the order of §Way of
working at the bottom; it does not re-litigate them. Where a ruling depends on a fact, the fact
was verified in this session and the evidence is named.

**Approval semantics.** The owner handing this codex to an implementing session constitutes
approval of exactly what each ruling names — including the R-06 deletion block. Anything beyond
the named scope still needs its own yes. Nothing here authorises touching production (the VM,
Supabase, live API keys); those remain owner-gated in Phase B/D.

---

## R-01 — Ship as ONE PR, from the integration branch

**Ruling:** push `integration/night-run` and open a single PR to `main`. Do not unbundle back
into the three feature branches.

**Why.** The strongest argument wins: *the tree that was verified is the tree that ships.*
`release:verify` (all 9 steps, bundle scan included) passed on the integration tree; the three
branches sequenced onto `main` one-by-one were never verified in that shape, and each would
present a stale migration array to its reviewer (the 065/066/067 reservation only reconciles at
the integration merge). Per-feature revert survives: each feature is one `--no-ff` merge commit,
so `git revert -m 1 <sha>` removes one feature cleanly.

**Mechanics for the implementing session:**
- Review unit = the three implementation reports in `podcast-saas/md-files/`
  (`LIBRARY-SHARE-IMPLEMENTATION-REPORT.md`, `DUBBING-IMPLEMENTATION-REPORT.md`,
  `CROP-V2-IMPLEMENTATION-REPORT.md`) plus `git diff origin/main...<feature-branch>` per branch.
- The PR body lists the three merge commits and states the migration-number reservation
  (065 library_shares / 066 crop_algo_version / 067 video_dubs) so a reviewer diffing a single
  branch is not misled.
- Delete the three feature branches and their worktrees only after the PR merges.
- `feat/library-share-minisite` (the planning checkout, zero unique commits) is retired after
  merge as well.

## R-02 — ElevenLabs watermark: confirm, probe, then flip

**Ruling:** `ELEVENLABS_DUBBING_WATERMARKED` stays `true` until BOTH steps below have happened,
in order. The default-blocks design is correct and is not to be weakened.

1. **Owner confirms the plan tier** on the ElevenLabs subscription page (watermarking is a
   property of the plan; the v2 API exposes no watermark field on any response — verified against
   the live OpenAPI document).
2. **One paid probe dub** on a short (≤60s) internal clip, run by the owner or with the owner
   watching: listen to the output for a watermark, and use the same run to close the top of the
   live-API unverified list in `DUBBING-IMPLEMENTATION-REPORT.md` §7 — above all whether the
   multipart create accepts `reference` (if the field is silently dropped rather than rejected,
   the crash-recovery defence goes quiet without erroring; that must be *known*, not assumed).

Only then set `ELEVENLABS_DUBBING_WATERMARKED=false` in the deploy environment and document the
probe date in `.env.example`. Cost of the probe: ≤ ~$2.20.

## R-03 — Per-user dubbing budget gate: REQUIRED before non-owner access

**Ruling:** dubbing stays owner-only until a budget ceiling exists. This is the one genuinely
missing safety piece: cost is metered and shown pre-run, but nothing stops a user from running it
a hundred times.

**Design (S effort, backend-only):**
- Env: `DUBBING_MONTHLY_BUDGET_CENTS` (default conservative, e.g. 5000 = $50/user/month) and
  `DUBBING_BUDGET_EXEMPT_USER_IDS` for the owner.
- At the dub-create endpoint, before any vendor call: sum `video_dubs.cost_cents` for the
  requesting user's projects in the current calendar month, add the run's estimate
  (`estimateProjectDubCost`), refuse with a clear 409 + remaining-budget message when over.
- The refusal message is creator-facing copy, not a raw number dump.
- Test: a user at the ceiling is refused; an exempt user is not; the refusal happens BEFORE any
  billable call (assert the provider mock was never invoked).

## R-04 — Playback position across a language switch: approved

**Ruling:** implement the follow-up specified in `DUBBING-IMPLEMENTATION-REPORT.md`: the switch
keeps its full-document-load design (correct, for the live-hls.js reason recorded in
`DECISIONS.md`), and carries `?t={currentTime}` on the navigation; `HLSPlayerShell` gains an
`initialSeekSec` applied once on `loadedmetadata`, clamped to `[0, duration]`. ~1 day including
tests. Test: switch at t=90s lands within a second of 90s in the new language; t beyond the new
duration clamps to 0 or duration-ε, never NaN.

## R-05 — Share-dialog title: approved, via the API

**Ruling:** the `title={null}` state is correct as written (VideoEditor has only `projectId` in
scope — verified), and the fix goes through the API, not through threading props: add `title`
(the project's title, string | null) to `shareState()` in
`backend-api/src/controllers/v1/library-share.controller.ts`, to `LibraryShareState` in
`shared/src/types/library-view.ts`, and to `LibraryShareInfo` in
`shared/src/generated/client-v1.ts`; `LibraryShareButton` then feeds the dialog from the GET it
already makes on mount, and the `title` prop is deleted. One field, four files, and the dialog's
"…in this project" sentence becomes the video's real title. Not a leak vector: the owner routes
are authenticated and the title is the owner's own.

## R-06 — Cleanup deletions: APPROVED, exactly this block

**Ruling:** the five delete candidates from `REPO-CLEANUP-2026-08-20.md` are approved. Execute
exactly:

```bash
rm /Users/ofeklevy/cebu/.claim-demo-watch-long.sh     # byte-identical dup of claim-demo-watch.sh (re-diffed 2026-08-21)
rm /Users/ofeklevy/cebu/.env.local                    # 0 bytes since Aug 6, nothing loads it
rmdir /Users/ofeklevy/cebu/podcast-saas/.claude/agent-memory/performance-reviewer \
      /Users/ofeklevy/cebu/podcast-saas/.claude/agent-memory/frontend-reviewer \
      /Users/ofeklevy/cebu/podcast-saas/backend-api/.claude/agent-memory/test-quality-reviewer
```

Guard rails: re-verify the dup is still byte-identical and the dirs still empty immediately
before deleting (`diff`/`ls -A`); if any check fails, stop and report instead of deleting.
The agent-memory dirs with REAL content (three locations, e.g. `backend-reviewer/`,
`fiji-advisor/`) are NOT in this ruling — consolidation stays open because the destination is a
protected path; leave them untouched.

## R-07 — Capture harness: version it under `scripts/dev/`, stop the untracked bleed

**Ruling:** the harness becomes tracked code; gitignoring working tools was the wrong instinct.
PR #43 exists precisely because untracked files block deploys, and the harness supports the
still-open export-throughput blocker — losing it to a dead laptop would be self-inflicted.

- `git mv` `claim-demo.sh`, `claim-demo-watch.sh`, `run-local-capture.sh`,
  `LOCAL-CAPTURE-README.md` → `scripts/dev/local-capture/` (repo root). Parameterise any
  machine-specific absolute path via env with the current value as default. Update the README's
  "not for the repo" line — that claim predates the deploy-blocking lesson.
- `podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts` is SOURCE, not
  harness. It stays where it is and gets committed **with the export bug-chain branch when that
  work resumes** — not in this round, whose scope it is outside. Record it as belonging to the
  open static-frames blocker.
- Remove the dead `.claude/review/runs/` line from `podcast-saas/.gitignore` (anchored where no
  such directory exists; the root-level runs dirs are deliberately tracked).

## R-08 — Crop P2 unblock: the owner's footage, a tiny annotation tool, the 2026may model

**Ruling:** P2 stays parked until P0.3 exists, and P0.3 is built like this:

1. **Footage:** the owner's own catalogue videos (rights are theirs). 20–50 clips of 10–30s,
   deliberately covering the adversarial categories the synthetic set mimics (dark skin, cool
   light, two same-gender speakers, no-subject, multicam, wood/beige backgrounds).
2. **P0.2 annotation tool:** a single local HTML file (no backend) that steps a video at 2fps and
   records a crop-x label per frame to JSON — the plan's `annotate.html`, kept that small.
   An agent pre-labels; the owner corrects; corrected labels are the ground truth.
3. **Model:** when P2 resumes, use `face_detection_yunet_2026may.onnx` (dynamic input, 5.20
   ms/frame at 320×192) — NOT the 2023mar file the plan named (fixed 640×640, 89.9 ms/frame,
   ~10× over budget). Same directory, same MIT licence. onnxruntime-node is ~258 MB unpacked;
   it re-enters the repo only together with the harness that can score it.
4. Labelled clips do not enter git; they live outside the repo with a manifest of hashes so the
   eval is reproducible without committing footage.

Standing warning re-affirmed: the AV correlator is below chance (17–46% vs 50%); any future
active-speaker work replaces the signal, it does not tune thresholds.

## R-09 — Contract drift: VERIFIED CLOSED; no new CI wiring needed

**Ruling:** two audit follow-ups are closed with evidence, and no busywork is to be created:

- `shared/src/generated/client-v1.ts` was diff-read against the server this session:
  `LibraryShareInfo` ≡ `shareState()` (six fields, exact); `ProjectDub` ≡ `toView()`;
  `DubCostEstimate` ≡ the server interface field-for-field; `ProjectDubsResponse` ≡ the
  `/projects/:id/dubs` reply. No drift ships in this round.
- The two-registry migration pattern (`db/migrate.ts` + `scripts/check-db.ts`) is already
  guarded: removing an entry from either fails three tests in the standard suite (proven
  empirically 2026-08-21 by desyncing and running). Do NOT add `db:check` to CI — the guard
  exists where it runs on every branch; wiring the manual operator tool into CI adds a second
  enforcement of the same invariant.
- Any NEW migration in the implementing session takes **068** and registers in both files.

## R-10 — The round's paper trail ships with the round

**Ruling:** commit `DECISIONS.md` (the 2026-08-21 round header and rulings) and this codex as a
`docs(decisions): open the 2026-08-21 round` commit **on the integration branch**, so the single
PR carries its own decision record — same convention as the #35/#38 docs commits. The
`_archive/2026-08-20/` snapshots stay untracked (gitignored) as intended.

## R-11 — Carried-over 2026-08-19 items: unchanged, owner-gated

The VM deploy pin (read-only census first, never `reset --hard`, needs SSH) and the Supabase
"abort incomplete multipart uploads after 7 days" lifecycle rule stay exactly as written in
`DECISIONS.md`. They belong to Phase B/D below. The standing constraints (`AVATAR_*` shadow
modes, `QUEUE_CROP_CONCURRENCY=1`) are untouched by this round and remain in force.

---

# Way of working for the implementing session

Rules first, phases second.

**Rules.**
1. Work on `integration/night-run` in its worktree (`.claude/worktrees/integration-night`).
   `main` is not touched until the PR merges. Nothing is pushed before Phase C.
2. Every phase ends green: `pnpm -C podcast-saas -r typecheck && pnpm -C podcast-saas -r test`
   after each ruling lands; full `release:verify` at the end of Phase A and again before push.
3. Stray-comment discipline: the added-lines sweep (console.log/debugger/TODO/markers/.only)
   must be clean per commit, as it was for all three feature branches.
4. Verify the committed tree, not the worktree, before declaring anything done.
5. The four 🟠 rulings in `DECISIONS.md` (caption provenance, two-registry migrations,
   below-chance correlator, full-load language switch) are constraints, not suggestions.
6. Small focused commits; per-ruling. `Co-Authored-By` per repo convention.

**Phase A — code, no owner input needed (~2 days):**
R-05 (title via API) → R-04 (`?t=` seek) → R-03 (budget gate) → R-07 (harness move + dead
gitignore line) → R-06 (deletion block, with its guard rails) → R-10 (docs commit).
Then full `release:verify`; fix or revert anything that regresses.

**Phase B — owner-gated config (minutes of owner time, no code):**
R-02 step 1 (plan tier); Supabase lifecycle rule (R-11). Neither blocks Phase A or C.

**Phase C — ship (R-01):**
push `integration/night-run` → single PR with the body from R-01 → CI → merge → release per the
ship flow. The VM pin issue (R-11) may still block the *deploy* step; the census procedure in
`DECISIONS.md` governs there. Branch/worktree cleanup after merge.

**Phase D — next round seeds (do not start inside this one):**
R-02 step 2 (probe dub + §7 live-API verification) before any customer-facing dub;
R-08 (crop P0.1–P0.3, then P2 behind `CROP_ALGO` with the 2026may model);
dubbing GA review (budget gate observed in practice, then non-owner access);
the export static-frames blocker + `localCaptureProvider.ts` commit;
agent-memory consolidation (still owner-gated).

*— end of codex —*
