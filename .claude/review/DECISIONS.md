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

## 🔴 Blocked on you — from the 2026-08-21 feature round (five items)

1. **ElevenLabs plan tier.** `ELEVENLABS_DUBBING_WATERMARKED` defaults to `true` and withholds every
   dub from viewers. The vendor exposes no watermark field on any v2 response — it is a property of
   the plan the API key belongs to — so this is a declared config fact, deliberately defaulting to
   the inconvenient-but-safe value. Until you confirm a non-watermarking plan and set it to `false`,
   dubs are produced, **billed**, and never published. Confirm the tier before anyone runs a real dub.
2. **How this ships: one PR or three?** `integration/night-run` is a local merge of
   `feat/library-share-impl` (migration 065), `feat/crop-v2` (066) and `feat/dubbing-multilang` (067).
   Reviewing any single feature branch against `main` in isolation shows a stale migration array —
   the numbers were reserved by hand, and only the integration branch has them reconciled. Decide
   whether the integration branch ships as one PR or is unbundled back into three.
3. **Five cleanup deletions, still untouched** (from `REPO-CLEANUP-2026-08-20.md`): the byte-identical
   duplicate `.claim-demo-watch-long.sh`, the 0-byte root `.env.local`, and three empty
   `agent-memory` leaf dirs. A ready-to-paste `rm` block is in that report. Nothing was deleted.
4. **The local capture harness: `.gitignore` or `scripts/dev/`?** `claim-demo*.sh`,
   `run-local-capture.sh` and `LOCAL-CAPTURE-README.md` support the still-open export-throughput
   work; their own README says they are not for the repo, but PR #43 exists because untracked files
   block deploys. Only the unambiguous `_archive/` line was added to `.gitignore`; this question was
   left for you. The dead `.claude/review/runs/` entry in `podcast-saas/.gitignore` is also still there.
5. **Crop P2 needs real footage.** The face-detector step change is blocked on measurement, not on
   feasibility: YuNet scores **zero detections** against the synthetic eval fixtures, so nothing about
   it can be scored until P0.3 exists (20–50 labelled catalogue clips). The dependency and model were
   removed rather than landing ~1,000 unverifiable lines. Supplying clips is the unblock.

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

## 🟡 Known small gaps from the 2026-08-21 round

- `VideoEditor.tsx:1375` passes `title={null}` to `LibraryShareButton` — correct, since the component
  receives only `{ projectId }` and has no project object in scope. Consequence: one sentence in the
  share dialog reads "…in this project" instead of the video's title. Fixing it properly means adding
  the title to the library-share API response; not done, deliberately.
- `shared/src/generated/client-v1.ts` is hand-maintained and was edited by two branches. Typecheck
  proves internal consistency only, never that the client type matches what the server actually
  returns. Worth a diff-read before merge.
- Crop P0.1 (fleet-audit script), P0.2 (annotation tool) and P0.3 (real labelled set) are absent; all
  reported crop gains are measured on **synthetic fixtures**, and should not be quoted as field results.

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
