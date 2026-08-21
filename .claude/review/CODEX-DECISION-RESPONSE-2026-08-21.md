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

---

# Part II — deep answers on everything still open, written post-merge (2026-08-21, second pass)

Written after PR #45 merged into `main` at `83e5c48` (CI green on main; the owner added the
merge-authorization rule to `autoMode.allow` and the merge was executed under it). Every claim
below was re-verified against the live repo, the GitHub API, or the workflow sources at writing
time — where a fact could not be verified it is marked. These rulings are for the next session to
execute without re-deriving them.

## R-12 — Merge authorization: RESOLVED, and the boundary it drew

The owner pasted into `autoMode.allow`: merging with `gh pr merge` when required checks pass, plus
the branch bookkeeping that follows; `--admin`/`--bypass` explicitly NOT covered. Under that rule
PR #45 was merged (2026-08-21T09:33Z, merge commit `83e5c48`). What remains OUTSIDE the delegated
boundary, deliberately: dispatching the release workflow, anything that touches the production VM,
and editing the permission file itself (the classifier blocked the agent's attempt to extend its
own permissions — that block is correct and stays).

## R-13 — Do NOT cut v0.1.36 yet. The bottleneck is the VM pin, not a missing tag.

The facts that decide this, all verified now:
- Tags v0.1.28…v0.1.35 exist; `v0.1.35` = `ca0f00b` (PR #44), i.e. the exact pre-round `main`.
- GitHub releases: v0.1.31 is "Latest"; **v0.1.32–v0.1.35 are stacked DRAFTS** — built, tagged,
  never deployed. Production still runs a pre-#32 build (DECISIONS, 2026-08-19), while the daily
  production audit is green against that old version.
- `release.yml` is dispatch-only with `bump` (patch/minor/major) + `deploy` inputs; it computes
  `nextTag` itself (`cmdPlan`: `currentTag + bump -> nextTag`) and its deploy stage is where the
  "Pin VM checkout" failure lives.

**Ruling:** cutting another tag now would add a NINTH undeployed artifact and move the product no
closer to live. The correct order is: (1) the owner clears the VM working tree per R-17; (2) ONE
dispatch of `release.yml` with `bump=patch`, `deploy=true`, `backfill_policy=report-only` — this
tags `v0.1.36` from `83e5c48` and carries the entire accumulated backlog (#32…#45) to production
in a single, auditable run with automatic rollback on CRITICAL. Bump stays **patch**: the repo's
own series (v0.1.28→35) uses patch for feature rounds, and the deploy tooling keys on the
monotone series — a symbolic minor bump buys nothing and breaks the pattern. Rejected
alternative: dispatching `deploy=false` now "to have the artifact ready" — it burns a tag number,
and a later deploy dispatch would bump AGAIN (the workflow cannot re-deploy an existing tag), so
the eager cut actively worsens the ledger.

## R-14 — ElevenLabs tier: the decision procedure, both outcomes pre-decided

The fact that decides everything: watermarking is a property of the PLAN the API key belongs to,
and no v2 response exposes it. So: open the ElevenLabs subscription page for the workspace that
owns the key in `ApiKeyService` (`getSystemKey('elevenlabs')`).
- **Paid plan** → set `ELEVENLABS_DUBBING_WATERMARKED=false` in the VM environment at deploy time
  (documented in `.env.example`), then run the R-02 probe BEFORE any customer-facing dub: one
  ≤60s internal clip through the full pipeline (~$2.20), listen for a watermark, and close the
  top of `DUBBING-IMPLEMENTATION-REPORT.md` §7 — above all whether the multipart create accepts
  `reference` or silently drops it (a silent drop quiets the crash-recovery defence without an
  error; that must be KNOWN). Record the probe date next to the env var.
- **Free plan** → two options, pre-ranked: upgrade (the vendor FAQ implies any paid tier removes
  the dub watermark — UNVERIFIED against a live account; verify on the pricing page before
  paying), or leave the feature dark — which is safe and costs nothing, because the default
  withholds every dub from viewers while still (NB) billing for any dub actually run. If staying
  dark, consider disabling the creator-side "run dub" button behind the same policy so nobody
  pays for audio that cannot be published.

## R-15 — The zero-byte local override file at the repo root

One command, run by the owner (the repo's secrets floor rightly refuses any agent command that
names an env-like file, including the verification): delete the file from the repo root by hand
(`rm` of the `.env.local` at `/Users/ofeklevy/cebu`). Until then it is harmless — zero bytes,
loaded by nothing (verified 2026-08-20 by the cleanup agent before the floor tightened) — so this
is hygiene, not risk. No agent should work around the floor to do it.

## R-16 — Crop P0.3: the footage spec, precise enough to execute without judgement calls

**The set.** 24–48 clips, 10–30s each, from the owner's own catalogue (rights are theirs) plus
phone recordings where the catalogue lacks a category. Quotas — at least 3 clips each:
single talking head (the easy control); two same-gender speakers in frame (the below-chance
correlator's worst case); dark skin tones; cool/blue lighting; warm/wood/beige backgrounds (the
Kovač rule's false-positive surface); no-subject b-roll (the null-hypothesis case); multicam with
hard cuts; camera or subject motion. Every category exists because a P1 fix claims to improve it
— the set is the jury for those claims.
**Labels.** Build P0.2 as specified: one self-contained `annotate.html` (no backend) stepping
frames at 2 fps, arrow keys nudge a crop-x marker, JSON out. An agent pre-labels every clip; the
owner corrects (~2 hours for the full set); corrected labels are ground truth.
**Storage.** Clips never enter git. They live in a local directory with a committed manifest of
sha256 hashes so any future eval run can prove it used the same set.
**Then, and only then, P2 resumes:** `face_detection_yunet_2026may.onnx` (dynamic input, ~5.2
ms/frame at 320×192 — NOT the 2023mar file, fixed 640×640 at ~90 ms/frame), onnxruntime-node
re-enters the repo together with the harness that can score it, everything behind `CROP_ALGO`
defaulting to v1, `CROP_DETECT_FPS` as the degrade knob, and the P2.8 eval gate decides the flip
on measured numbers from THIS set — not the synthetic fixtures, whose results must never be
quoted as field results.

## R-17 — The VM pin: the runbook, with the decision tree the 2026-08-19 note implies

Requires SSH; no session here has it. On the VM: change into `/home/ubuntu/cebu` and take a
read-only census (`git status --porcelain=v2`, saved to a file) — nothing else until it is read.
Then by class: **untracked env/secret backups** → move them OUTSIDE the repo tree (e.g.
`~/backups/`), never delete; **untracked build artifacts** → confirm PR #43's ignore rules cover
them, add if not; **modified TRACKED files** → stop and diff each one before anything — a live
hand-edit on the VM is exactly the thing a pin must not silently destroy. Never `git reset
--hard`; the pin refuses on a dirty tree precisely so nobody does. Once the census is clean,
R-13's single dispatch (`deploy=true`) is the next step, and PR #43's own improvement means any
still-blocking file will be NAMED by the run rather than guessed at. After deploy: the nightly
production audit is already green daily against the old build; watch the first post-deploy run.

## R-18 — Supabase lifecycle rule (one-time dashboard action, ~2 minutes)

Storage → the media bucket → Settings/Lifecycle → "abort incomplete multipart uploads after 7
days". Why it cannot be code: abandoned upload parts are billed but invisible to LIST, so no code
path can reach them; only the bucket policy can. Documented in `.env.example`; once set, note the
date in DECISIONS and the item closes permanently.

## R-19 — The exact order for the next session

1. **Land this paper trail**: the updated `DECISIONS.md` + this codex Part II sit as working-tree
   changes at the repo root. Commit them to `main` via a small docs PR (the #35/#38 precedent;
   the redundancy guard skips the heavy CI lanes on docs-only changes).
2. **Owner, in parallel** (minutes each, all pre-specified): VM census (R-17), ElevenLabs tier
   (R-14), Supabase rule (R-18), the root env-file deletion (R-15).
3. **After the VM is clean**: the single release dispatch (R-13). One run: tag v0.1.36, deploy,
   audit. This is the moment the whole 2026-08-21 round — and the seven stacked tags before it —
   actually reaches users.
4. **After deploy, if the tier allows**: flip the watermark env, run the probe dub (R-02/R-14),
   record the result.
5. **Only then, and only on explicit owner approval**: begin PLANNING the two parked 🔵 items
   (interactive-podcast phase 2 and the route renames) — together, since they overlap on
   `/project/audio`. Architecture first, no code.

*— end of Part II —*

---

# Part III — an answer for every remaining open item (2026-08-21, third pass)

Part II answered the round's 🔴 items. This pass answers everything else in `DECISIONS.md` — the
two 🔵 parked features, the 🟠 standing constraints, the 🟡 2026-08-19 backlog, and the ⚪ accepted
risks — so that no line in the ledger is a question without a written resolution. Items marked
**PLAN** are solution designs the owner must approve before any build starts; items marked
**DISPOSITION** change no code and simply rule what happens to a known risk.

## P3-A — Route renames: the design (PLAN — build only on approval)

Grounding, verified now: `RESERVED_SLUGS` already contains `admin`, `podcasts`, `podcast`, and
`project` — so none of the target paths can be shadowed by a creator permalink today, and adding
`edit-podcasts` and reserving `audio` as a *sub-route* are the only registry changes needed.

1. **`/admin`.** The management dashboard (admin-web, a separate Next app) moves under
   `flowvidco.com/admin`: `basePath: '/admin'` in `admin-web/next.config`, one nginx `location
   /admin/` block proxying to the admin-web upstream in `deploy/nginx/templates/app.conf.template`,
   and the auth gate stays exactly as it is (the app's own login — path exposure adds discovery,
   not access). The slug is already reserved. Effort S–M; the only real work is checking admin-web
   for absolute-path assumptions (`/api`, asset prefixes) that `basePath` surfaces.
2. **`/podcasts` → `/edit-podcasts`.** Rename the route directory, add `edit-podcasts` to
   `RESERVED_SLUGS`, and leave a `permanentRedirect()` shim at the old tree so every deep link
   (`/podcasts/{showId}/episodes/{id}`) 308s to its new home — the `LegacyRedirectResolver`
   pattern, applied at the page level, no middleware cost. `podcasts` STAYS reserved even after
   the move: releasing it would let a creator claim the exact URL every old shared link points at.
   Update the sitemap emitters if they enumerate podcast pages. Effort S.
3. **`/project/audio` — the literal ask, and the recommended shape.** `project` is already
   reserved, so `flowvidco.com/project/audio` is buildable as a static route. But it is a
   *product-level* page (one global landing), while the thing being landed is per-project — each
   video's interactive-audio edition. **Recommendation: the canonical surface is
   `/{slug}/audio`** — a typed sibling of `/{slug}/library` and `/{slug}/{lang}`, riding the same
   mini-site rails (ISR, share-token capability, purge-on-revoke), with `audio` added to the
   sub-route registry alongside the library's segments. `/project/audio` then exists as the
   *category landing* — what interactive audio IS, with examples — which matches its global path
   shape. This resolves the overlap with P3-B rather than fighting it. **Open question for the
   owner, default marked:** canonical per-project URL = `/{slug}/audio` (default) vs
   `/project/audio?p={slug}` (rejected: query-string identity breaks the permalink conventions
   every other surface follows).

## P3-B — Interactive podcast phase 2: the architecture (PLAN — build only on approval)

The owner's reframing governs: **start from the video that already exists.** No new generation
pipeline — the episode is *derived* from the project.

1. **Audio derivation (the foundation, effort S–M).** One ffmpeg pass over the project's existing
   media — the same inputs `buildPlayerConfig` already resolves — mixing narration + guidance
   audio into a single `m4a`; chapters from `timeline_sections`, captions re-emitted from the
   existing VTT (per-language once dubbing ships: a dubbed project's audio edition reuses that
   dub's mix and ITS captions, honouring the caption-provenance ruling). Stored as one derived
   artifact per project+language behind the same idempotency discipline as captions
   (`source_hash`), downloadable by the creator, served publicly via `/{slug}/audio`. This is a
   pg-boss job on the existing queue — NOT the GPU export path; audio extraction is cheap.
2. **The landing surface.** `/{slug}/audio` rides the Library-share rails (P3-A.3): public or
   tokened exactly like `/library`, one player page, zero new storage semantics.
3. **Hands-Busy Mode — the locked-phone answer, which is a design commitment, not a detail.**
   The page plays through a plain `<audio>` element — **not** WebAudio — because mobile Safari and
   Chrome keep a playing `<audio>` element alive when the screen locks, and kill WebAudio
   contexts. On top of that: the **Media Session API** (lock-screen title/artwork/seek/skip
   controls; `navigator.mediaSession.setActionHandler` for prev/next chapter), a **PWA manifest +
   service worker** that precaches the episode file so a dropped connection mid-drive does not
   stop playback, and interaction points delivered as *audio prompts answered by single tap or
   voice* — never a visual-only affordance, because the screen is assumed dark. What this rules
   OUT: any phase-2 interaction that requires looking at the screen while driving; those degrade
   to "saved for later" markers the listener reviews when stopped.
4. **The three surfaces, in build order.** *Raise Your Hand* first (it is
   `INTERACTIVE-PODCAST-PLAN.md` phases 2–3 unchanged: typed Q&A → voice barge-in, budget-gated
   like dubbing, $0 while listening). *Hands-Busy Mode* is item 3 above plus a "long-drive" UI
   preset (huge tap targets, auto-resume). *Call It* last — a phone number per show via SIP
   realtime is the plan's phase-3 mechanism and the most expensive surface; it waits until Raise
   Your Hand has real listener-question data proving demand.
5. **Sequencing.** All of it AFTER the release lands and only on approval: A2.1 derivation job →
   A2.2 `/{slug}/audio` landing → A2.3 Media Session/PWA → A2.4 Raise Your Hand → A2.5 Call It.
   Each stage shippable alone.

## P3-C — The standing constraints: what unblocks each (rulings, no action now)

- **`AVATAR_CAPABILITY_MODE` / `AVATAR_BUDGET_MODE` stay `shadow`** — and the unblock is D-14,
  not a config decision: rebuild the async observer (D-14 step 2), at which point budget-shadow
  traffic becomes valid calibration data; calibrate against it; only then walk the five-step
  enforce ordering in `.env.example`. Flipping earlier 401s every viewer — this constraint cannot
  be "answered" away, only executed away, and its execution path is D-14's.
- **`QUEUE_CROP_CONCURRENCY` stays 1 until measured — and the measurement just got easier.**
  PR #44 moved `project_export` (the heaviest job) to a dedicated GPU host; the production
  worker's queue list explicitly excludes it. That frees real headroom on the 2-vCPU host. The
  measurement procedure: after the deploy lands, run two simultaneous crop analyses on catalogue
  videos while watching RSS + runtime (`docker stats` on the worker container); if peak RSS stays
  under half the host's memory and wall-time degrades <30%, raise to 2. Do not raise past 2 on
  this host regardless — ffmpeg decode is the floor.

## P3-D — The 2026-08-19 backlog: an answer per item

- **Production storage census** — pair it with crop P0.1 in ONE prod-access session: both need
  read-only reach into production data and nothing else does. Run
  `deploy/scripts/storage-census.sql` (aggregates only), and the P0.1 fleet-audit query (crop
  stats over `video_files`) in the same sitting. The census output then unblocks the four
  designs it names (`branch_path_events` rollup, failed-duplication reaping, `token_usage`
  rollup, TOAST review) — each of which is a design task for the round AFTER the census, not
  before: designing retention without the census numbers is guessing.
- **D-13 viewer config freshness** — the spec exists in the archive; nothing about this round
  changed it. Schedule into the next code round (Round C below). Effort per the archive.
- **D-14 avatar spend enforcement** — the order stands (atomic Postgres function → async observer
  → client capability wiring) and it is the *key* that opens the 🟠 avatar constraints. Schedule
  as Round C's centrepiece; nothing else on the avatar surface should land before it.
- **D-16 crop hardening** — partially superseded by this round, and the ledger should say which
  parts: "detector fallbacks" LANDED (P1.5's null-hypothesis floor + honest AV thresholds);
  "discontinuity markers" and the "confidence gate before auto-publish is trusted" remain open
  and now have a natural home — the confidence gate is exactly what P2.8's eval gate becomes
  once P0.3 real footage exists (R-16). One item, not three, remains.
- **D-17 knowledge/retrieval** — unchanged: KnowledgeSnapshot first, the three feature gates
  stand (multi-segment scoping, `chart` off without provenance, moderation on the visual routes).
  Do not schedule before D-14 — both compete for the same avatar-surface risk budget.
- **Billing scope, 24 parked findings incl. two P1s** — ruling: the NEXT review-fleet round is a
  billing round. First action: read the ledger's `OUT_OF_SCOPE_BILLING` entries and unpark the
  two P1s by name; dispatch `billing-integrity-reviewer` over Stripe webhook authenticity,
  idempotency, entitlements and fee arithmetic; adversarially verify anything P1. "Parked is not
  fixed" stops being true only when this runs.
- **`broll-data-001`** — the solution already exists on paper: the 2026-08-17 codex's D-01a
  anchor design (stable main-segment id + local offset, half-open boundaries, one shared
  resolver) IS the fix for offsets anchored to `video_files.duration_sec`. It needs a migration
  (take the next free number under the two-registry discipline) + the resolver + the enqueue-time
  anchor for generated b-roll. Effort M. Schedule into Round C with D-13.

## P3-E — The ⚪ accepted risks: dispositions

- **Public-bucket HLS / revoked shares** — stays accepted UNTIL the four ordered landings of the
  signed-URL cutover get their own round (Round D). Until then the Library-share dialog's honest
  copy ("anyone who saved a file keeps it") is the mitigation, and it already ships.
- **Sim-capture ~10× too slow** — **this disposition CHANGES: the fact is stale.** PR #44 built a
  dedicated GPU export host (`deploy/docker-compose.gpu-worker.yml`): `project_export` is consumed
  ONLY there, the production worker explicitly excludes it, and the capture container is hardened
  (no socket, no network). The 2-vCPU throughput ceiling no longer binds exports once that host is
  provisioned. Post-deploy verification: run one real export on the GPU host and measure s/frame;
  if it meets budget, close this item AND update the stale workspace memory that still calls the
  blocker open. The Creator-Side Render-Farm idea (Volume 2) demotes from "the fix" to a
  contingency if GPU hosting proves uneconomical.
- **WebKit lane** — measured this round (three different failure sets on one commit; see the 🟢
  table). The fix stays what `ci.yml` prescribes: key `__CHILD` on something the child *sends*
  rather than on Window identity. Effort S, isolated to the e2e harness. Schedule into Round C as
  a hygiene item; until then the lane stays non-blocking and the flakiness is documented.
- **235 unverified ledger findings** — ruling: neither ignore nor hand-read. One bounded batch
  round: `finding-verifier` agents over the P2/P3 tail with a fixed budget, producing
  CONFIRMED/REFUTED/UNCERTAIN per finding; CONFIRMED items graduate into the round map, REFUTED
  close, UNCERTAIN get one line of justification each. After that single pass the ledger's tail
  is either work or closed — never again "open and unread".

## P3-F — The round map: every answer above, in order

- **Round A — ship it (now):** R-19 steps: land this paper trail → owner clears the VM (R-17) →
  ONE release dispatch `bump=patch, deploy=true` (R-13) → watch the first post-deploy production
  audit → ElevenLabs tier + probe (R-14) → Supabase rule (R-18). Also post-deploy: the GPU-host
  export measurement (P3-E) and the `QUEUE_CROP_CONCURRENCY` measurement (P3-C).
- **Round B — evidence:** the prod-access session (census + crop P0.1), the crop P0.2/P0.3
  labelled set (R-16), the billing review round, the 235-findings batch verification.
- **Round C — the code round the evidence feeds:** crop P2 behind `CROP_ALGO` (eval-gated),
  D-14 avatar spend chain (→ unblocks the 🟠 avatar flips), D-13, `broll-data-001`, the WebKit
  `__CHILD` fix, retention designs from the census.
- **Round D — surfaces, on approval:** signed-URL cutover (four landings), then the two parked
  features per P3-A/P3-B — planned together, `/{slug}/audio` as the shared spine.

*— end of Part III — every line in DECISIONS.md now has a written answer —*
