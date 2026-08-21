# Open decisions

**A feature round is open (2026-08-21).** Three features were built overnight on three branches and
merged into `integration/night-run` (20 commits over `origin/main` @ `6c7f9bb`): the Library Share
mini-site (Phase 1), ElevenLabs Dubbing v2 with a viewer language switcher, and crop v2 (P0 harness +
all of P1). `pnpm release:verify` passes on the integrated branch. **Nothing is pushed, no PR is open,
`main` is untouched.** Plans and per-feature reports are in `podcast-saas/md-files/`.

The prior 2026-08 remediation round is closed and archived — PRs #31–#37 merged, v0.1.30 tagged and
built; its full record is in `DECISIONS-ARCHIVE.md` (bottom section, dated 2026-08-19). Its items
below are still live and unchanged.

Last updated: **2026-08-21**, after the overnight feature run.
**Proposed resolutions + execution plan: `CODEX-DECISION-RESPONSE-2026-08-21.md`** — rulings
R-01…R-11 and a phased way of working for the implementing session.

---

## 🔴 Still blocked on you — from the 2026-08-21 feature round (three items)

1. **ElevenLabs plan tier.** `ELEVENLABS_DUBBING_WATERMARKED` defaults to `true` and withholds every
   dub from viewers. The vendor exposes no watermark field on any v2 response — it is a property of
   the plan the API key belongs to — so this is a declared config fact, deliberately defaulting to
   the inconvenient-but-safe value. Until you confirm a non-watermarking plan and set it to `false`,
   dubs are produced, **billed**, and never published. Confirm the tier before anyone runs a real
   dub, then run one ≤60s probe (R-02) before customer-facing use.
2. **The 0-byte root `.env.local`.** The only cleanup deletion NOT executed, and deliberately so:
   the repo's own secrets floor refuses any command that names an env file, so it could not even be
   re-verified, let alone removed. That guard is correct and was not worked around. Delete it by
   hand if you still want it gone.
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
  the audio does not. Playback position is therefore not preserved; the `?t=` + `initialSeekSec`
  follow-up is specified in `DUBBING-IMPLEMENTATION-REPORT.md` (~a day).

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

1. **The production deploy fails on the VM, not in this repo.** The approved v0.1.28 deploy
   failed 32 seconds in at *"Pin VM checkout"* — the working tree at `/home/ubuntu/cebu` holds
   uncommitted changes, so the pin refuses. Containers were never touched; production still runs
   the older version, and **every fix since PR #32 is merged, tagged, built — and not live.**
   Do NOT clean the VM with `git reset --hard`: first a read-only census of
   `git status --porcelain=v2` there, review what those files are, then preserve/commit/move
   aside, then re-dispatch the release workflow with `deploy=true`. Needs SSH, which no session
   here has.
2. **One-time Supabase dashboard action:** bucket lifecycle rule *"abort incomplete multipart
   uploads after 7 days."* Abandoned upload parts are billed but invisible to LIST, and no code
   path can reach them. Documented in `.env.example`.

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
- **Billing scope** — 24 findings parked as `OUT_OF_SCOPE_BILLING` in the ledger, including two
  P1s. Parked is not fixed.
- **A P1 with no implementation:** `broll-data-001` (b-roll offsets anchored to
  `video_files.duration_sec`) — decided, no schema or code yet.

## ⚪ Known and accepted

- Public-bucket HLS: revoked shares keep working until the signed-URL cutover (four ordered
  landings; a naive cutover is an outage).
- Sim-capture export ~10× too slow on the 2-vCPU host; obvious levers spent.
- The e2e WebKit lane is non-blocking by design (`__CHILD` keyed on Window identity); its one
  failing test is documented in `ci.yml`.
- 235 ledger findings remain open and unverified (P2/P3-labelled, tail never adversarially read).
