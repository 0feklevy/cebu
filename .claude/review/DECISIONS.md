# Open decisions

**A feature round is open (2026-08-21).** Three features were built overnight on three branches and
merged into `integration/night-run` over `origin/main` @ `6c7f9bb`: the Library Share mini-site
(Phase 1), ElevenLabs Dubbing v2 with a viewer language switcher, and crop v2 (P0 harness + all of
P1). Then the R-01…R-10 rulings were executed on top. Plans and per-feature reports are in
`podcast-saas/md-files/`.

**Status: SHIPPED. `v0.1.36` is live in production** — published 2026-08-21T11:07Z from run
32473689948, digest-pinned, `HEALTHY -> BROWSER_VERIFIED`, `api.flowvidco.com/health` answering 200.

R-13 played out exactly as ruled: one dispatch carried the **entire** backlog — PRs #36 through #47,
twelve of them — rather than adding a ninth undeployed tag. That closes the deploy drought that had
left v0.1.32–v0.1.35 stacked as drafts while production ran a pre-#32 build. The VM checkout pin,
which killed the v0.1.28 attempt 32 seconds in, passed this time because the owner cleared the tree
by census first (`git status --porcelain=v2` empty) rather than by `reset --hard`.

Now live that was not before: the storage-leak fixes (#37), four avatar corrections (#39–#42), the
dedicated GPU export host (#44), and the three features of this round — Library Share, Dubbing v2
with the viewer language switcher, and crop v2's measurement harness plus its P1 fixes.

The prior 2026-08 remediation round is closed and archived — PRs #31–#37 merged, v0.1.30 tagged and
built; its full record is in `DECISIONS-ARCHIVE.md` (bottom section, dated 2026-08-19). Its items
below are still live and unchanged.

Last updated: **2026-08-21**, after v0.1.36 shipped (PRs #45, #46, #47 merged; #48 carries this update).
**Every item in this ledger now has a written answer in `CODEX-DECISION-RESPONSE-2026-08-21.md`:**
Part I (R-01…R-11, executed), Part II (R-12…R-19 — the 🔴 items: release order, ElevenLabs,
crop footage, VM runbook, Supabase), and **Part III (P3-A…P3-F — everything else)**: the two 🔵
parked features as approvable solution designs (route renames incl. the `/{slug}/audio`
recommendation; podcast phase 2 incl. the locked-phone answer), the 🟠 constraints' unblock paths,
each 🟡 backlog item's plan, the ⚪ risks' dispositions — including one STALE fact corrected:
PR #44's dedicated GPU export host supersedes the "sim-capture 10× too slow" acceptance, pending
one post-deploy measurement — and a four-round map (P3-F) sequencing all of it.

---

## 🔴 Still open — post-release (2026-08-21, after v0.1.36)

1. **The dubbing watermark flag is still `true` in production.** The tier question is ANSWERED —
   the workspace is on the paid Creator plan ($22/mo), so output is not watermarked — but the
   deployed environment still carries the safe default, which means every dub would be produced,
   **billed**, and then withheld. Set `ELEVENLABS_DUBBING_WATERMARKED=false` on the VM, then run
   the ≤60s probe dub (~$2.20) BEFORE any customer-facing use: it confirms the absence of a
   watermark by ear and closes the top of `DUBBING-IMPLEMENTATION-REPORT.md` §7 — above all whether
   the billable multipart create accepts `reference` or silently drops it. Until the probe runs,
   nothing in the dubbing pipeline has ever met the live vendor API.
2. ~~**The 0-byte root `.env.local`.**~~ **CLOSED 2026-08-21** — the owner removed it by hand and
   confirmed `OK: removed`. Worth recording that this is owner-attested rather than agent-verified:
   the repo's secrets floor blocks any command that so much as names an env file, including a
   read-only existence check, and the file is gitignored, so its absence from `git status` proves
   nothing either way. That guard is correct and was not worked around at any point.
3. **Crop P2 needs real footage.** The face-detector step change is blocked on measurement, not on
   feasibility: YuNet scores **zero detections** against the synthetic eval fixtures, so nothing about
   it can be scored until P0.3 exists (20–50 labelled catalogue clips). The dependency and model were
   removed rather than landing ~1,000 unverifiable lines. Supplying clips is the unblock, and R-08
   describes the annotation tool and the model file to use (`..._2026may.onnx`, not the plan's
   `..._2023mar.onnx`, which is fixed-640×640 and ~10× over budget).

## ✅ Resolved in the 2026-08-21 round (rulings R-01…R-10, executed)

- **Ships as ONE PR** from `integration/night-run` (R-01) — the tree that was verified is the tree
  that ships; per-feature revert survives as three `--no-ff` merge commits.
- **Share dialog names the video** (R-05): the title rides on the share state the button already
  fetches, since `VideoEditor` has only a `projectId` in scope. The prop is gone.
- **Playback position survives a language switch** (R-04): `?t=` out, consumed once on first play
  through the scrub path — extracted, not reimplemented, so the in-flight-swap rule guards it too.
- **A per-user monthly dubbing ceiling** (R-03), checked BEFORE the vendor is called; the route test
  asserts the vendor was never reached on a refusal. All four dubbing settings are now documented.
- **The capture harness is versioned** at `scripts/dev/local-capture/` (R-07), paths derived rather
  than hardcoded; the dead `podcast-saas/.gitignore` entry is gone. `localCaptureProvider.ts` stays
  out — it is source belonging to the open export bug-chain.
- **Four of five cleanup deletions executed** (R-06) after re-verifying each guard; the surviving
  agent-memory content was untouched, and the superseded root copies are in `_archive/`.
- **Contract drift checked, not assumed** (R-09): `client-v1.ts` was diff-read against the server —
  `LibraryShareInfo` ≡ `shareState()`, `ProjectDub` ≡ `toView()`, `DubCostEstimate` and
  `ProjectDubsResponse` field-for-field. No drift shipped.

## 🟢 CI evidence from PR #45 — the WebKit lane is flaky, and now measured

PR #45 (`integration/night-run` → `main`) ran green on every blocking check: Release verification
gate, Static audits, Redundancy guard, and the chromium and firefox e2e lanes. WebKit failed, and
because that lane is `continue-on-error` by design it does not veto the merge — but it was worth
proving the failure was not ours, so it was measured rather than waved through:

| run | WebKit result |
|---|---|
| `feat/gpu-capture-grant` (before this round) | 1 failed — scenario 11 |
| `fix/deploy-blocked-by-untracked` (before this round) | 2 failed — scenarios 9 **and** 11 |
| PR #45, first run | 3 failed — 9, 11, **32** |
| PR #45, **re-run of the same commit** | **1 failed — scenario 11.** 37 passed |

The same commit produced three different failure sets across runs, and the re-run landed exactly on
the documented baseline. So scenarios 9 and 32 are **flaky on Linux WebKit, not regressions** —
which also updates what `ci.yml` records: the comment there describes a single reproducible failure,
when in fact the lane's failure count varies run to run. Worth folding into that comment when the
`__CHILD` Window-identity assumption is finally fixed.

## 🟠 Rulings made during the 2026-08-21 round (do not silently reverse)

- **Captions for a dubbed language come from that dub's own segments — never from an independent
  Whisper translation.** Two independent translations diverge and the viewer reads different wording
  than they hear. The Groq Whisper path stays allowed only for captions-only languages with no dub.
- **Migration numbers are reserved by hand across concurrent branches** (065/066/067 here). Two
  hardcoded registries must both be updated — `db/migrate.ts` **and** `scripts/check-db.ts`. This is
  guarded: removing an entry from either fails three tests in the standard suite (verified empirically
  on 2026-08-21), though the `db:check` tool itself is still not wired into CI.
- **The active-speaker correlator performs below chance** (17–46% correct when it fires, against 50%
  for guessing; an 80-point threshold sweep found no configuration that beats it). The gender→region
  gap-fill was not merely deleted — deleting it alone regressed the end-to-end test — it was replaced
  with shot-level speech-correlated motion. Treat any future work here as fixing a signal that carries
  no information, not as tuning a threshold.
- **Language switching is a full document load, not a soft navigation.** The player holds live hls.js
  instances on two `<video>` elements; a soft nav leaves them attached and the picture changes while
  the audio does not. This constraint stands. What changed in R-04 is only how the position survives
  it: the offset now rides out on `?t=` and is consumed once, on the first play, through the scrub
  path — which was **extracted, not reimplemented**, so the in-flight-swap rule whose comment records
  wedging the player permanently guards the resume too. Do not "simplify" that by writing a second
  seek.

## 🟡 Known gaps that ship with this round

- Crop P0.1 (fleet-audit script), P0.2 (annotation tool) and P0.3 (real labelled set) are absent; all
  reported crop gains are measured on **synthetic fixtures**, and must not be quoted as field results.
  P2 (the detector itself) is not in this release at all — `CROP_ALGO` has no v2 to select yet.
- Nothing in the dubbing pipeline has been exercised against the live ElevenLabs API — no key, no
  network in the build environment. The ranked list of call shapes that remain unverified is in
  `md-files/DUBBING-IMPLEMENTATION-REPORT.md` §7; the riskiest is the billable multipart create,
  where a silently-dropped `reference` field would quiet the crash-recovery defence without erroring.
- `db:check` is a manual operator tool and is still not wired into CI. It does not need to be: the
  registry-drift invariant it would enforce is already covered by tests that run on every branch.

## 🔵 Requested 2026-08-21, deliberately NOT started — plan only after the release, then on approval

Both were asked for while the release round was in flight, and both were parked on purpose: the
owner's instruction is that everything else finishes first, that planning starts only afterwards,
and that no implementation begins without an explicit go-ahead.

1. **Interactive podcast, phase 2 — the three named surfaces.** *Raise Your Hand*, *Hands-Busy
   Mode*, *Call It* (see `md-files/INTERACTIVE-PODCAST-PLAN.md`, whose phase 1 is the episode +
   share page). The framing the owner gave, which changes the architecture from what that plan
   assumed: **start from the video that already exists.** Take the existing project — captions
   included — and export it as audio, either as a download for the creator or as a new section at
   `flowvidco/audio/…`, which then becomes its own public-or-private link and the home of the
   interactive-podcast surfaces. The hard requirement is the listening context: driving, walking,
   eyes-and-hands busy. That includes a technical answer for **playback surviving a locked or
   screen-off phone**, which is a real constraint (background audio, Media Session, a service
   worker or a native shell — it is a design question, not a detail). Deliverable when it starts:
   a considered architecture first, not code.
2. **Public route renaming.** `/admin` becomes the control surface — the management dashboard with
   all the data already exists on its own server, and that page moves in under this path.
   `/podcasts` becomes `/edit-podcasts` (the creator-facing editor), which frees the podcast
   *landing* surface for a new route: `/project/audio`, presented as a sub-project of the video —
   the interactive-audio edition. Note before planning: renaming a live public route is a redirect
   and SEO question as much as a routing one (`permalinkService.ts` `RESERVED_SLUGS`,
   `LegacyRedirectResolver`, sitemaps, and any already-shared `/podcasts/...` link), and it
   overlaps item 1's `/project/audio` target — they should be planned together, not separately.

---

## 🔴 Blocked on you — carried over from the 2026-08-19 round (two items, both small)

1. ~~**The production deploy fails on the VM, not in this repo.**~~ **CLOSED 2026-08-21.** The
   v0.1.28 attempt died 32 seconds in at *"Pin VM checkout"* because the working tree at
   `/home/ubuntu/cebu` was dirty. The owner cleared it the prescribed way — a read-only
   `git status --porcelain=v2` census first, never `reset --hard` — and it came back completely
   empty. v0.1.36 then deployed through that same pin without incident. Keep the procedure: the
   pin refuses a dirty tree on purpose, and the census is what makes the refusal cheap to resolve
   instead of destructive.
2. ~~**One-time Supabase dashboard action:** bucket lifecycle rule "abort incomplete multipart
   uploads after 7 days."~~ **CLOSED 2026-08-21, no action needed.** Checked against the live
   dashboard: Supabase exposes no per-bucket lifecycle UI, and aborts incomplete multipart uploads
   automatically after **24 hours** — stricter than the 7-day rule we were going to configure. The
   underlying risk (abandoned parts are billed but invisible to LIST, so no code path can reach
   them) is therefore handled by the platform. Nothing to build, nothing to remember.

## 🟠 Standing constraints (do not change without a ruling)

- `AVATAR_CAPABILITY_MODE` / `AVATAR_BUDGET_MODE` stay `shadow` — the five-step enforce ordering
  is in `.env.example` and the archive. Flipping capability enforce early 401s every viewer.
- Budget-shadow traffic is **not** valid calibration data until the async observer is rebuilt.
- `QUEUE_CROP_CONCURRENCY` stays 1 until measured on the 2-vCPU host (now also the code default).

## 🟡 The next work, when picked up

- **Production storage census** — run `deploy/scripts/storage-census.sql` (read-only, aggregates
  only, no PII) and bring the output. It unblocks: `branch_path_events` retention (needs a rollup
  design, not a bare TTL), failed-duplication reaping, `token_usage` rollup, TOAST-column review.
- **D-13 viewer config freshness** — ruled, specified in the archive, not yet built.
- **D-14 avatar spend enforcement** — atomic Postgres function + async observer + client
  capability wiring, in that order.
- **D-16 crop hardening** — discontinuity markers, detector fallbacks, confidence gate before
  auto-publish is trusted.
- **D-17 knowledge/retrieval** — KnowledgeSnapshot first; three feature gates before any public
  Avatar rollout (multi-segment scoping, `chart` off without provenance, moderation wired on the
  visual/image routes).
- ~~**Billing scope** — 24 findings parked as `OUT_OF_SCOPE_BILLING`, including two P1s.~~
  **DESCOPED by the owner, 2026-08-21: the billing feature is not currently relevant**, so the
  parked findings stay parked deliberately rather than by neglect, and the planned billing review
  round is cancelled. Two things to carry forward if that changes: "parked is not fixed" still
  holds — the two P1s are real and unaddressed — and the money path that IS live today is dubbing,
  which is guarded instead by the per-user monthly ceiling shipped in this round (R-03).
- **A P1 with no implementation:** `broll-data-001` (b-roll offsets anchored to
  `video_files.duration_sec`) — decided, no schema or code yet.

## ⚪ Known and accepted

- Public-bucket HLS: revoked shares keep working until the signed-URL cutover (four ordered
  landings; a naive cutover is an outage).
- Sim-capture export ~10× too slow on the 2-vCPU host. **This premise is now stale and awaits one
  measurement to close.** PR #44 shipped a dedicated GPU export host
  (`deploy/docker-compose.gpu-worker.yml`) that is the sole consumer of `project_export` — the
  production worker's queue list excludes it — and that host went live with v0.1.36. The 2-vCPU
  ceiling no longer describes where exports run. To close: run one real export and record
  seconds-per-frame on the GPU host. If it meets budget, this item is resolved outright and the
  Creator-Side Render Farm idea in Volume 2 demotes from "the fix" to a contingency.
- The e2e WebKit lane is non-blocking by design (`__CHILD` keyed on Window identity). Its failure
  is **flaky, not a fixed single test** — measured across four runs this round, including one on a
  docs-only PR that touched no code: the same commit produced 1, 2, and 3 failures on different
  runs. The `ci.yml` comment still describes one reproducible failure and should be corrected when
  `__CHILD` is re-keyed onto something the child sends.
- 235 ledger findings remain open and unverified (P2/P3-labelled, tail never adversarially read).
