# Open decisions

**State as of 2026-08-22.** Production runs **v0.1.38**, healthy. Merged to `main` and NOT yet
released: **#57** (dubbing panel — source-language detection, real progress, search/sort),
**#58** (the D-23 production dubbing outage + both sweep P1s), **#59** (cross-tenant writes, the
token leak, container ceilings), and **#60** (bounded uploads, scenes over-fetch, −474 KB viewer
JS — merged 2026-08-22). **The dubbing feature is dead in the deployed build and fixed only in
`main` — nothing dubbing-related can be tested until the next release ships.**

The 2026-08-21→22 closed round — v0.1.36→38, the fleet audit, the CSP defects, D-13, D-01b,
D-20…D-23, and the ten sweep findings fixed in #58–#60 — is archived with per-item verification
notes in `DECISIONS-ARCHIVE.md` (bottom section). The verification sweep itself is
`LEDGER-VERIFICATION-2026-08-22.md`: 164 verdicts, 93 confirmed, of which 10 are now fixed;
**the remaining confirmed findings are the work queue below.**

Last updated: **2026-08-22**, during the post-sweep fix round.

---

## 🔴 Next release — the one action everything dubbing waits on

**Do:** dispatch a release, approve the deploy. (#60 is merged; main is ready as it stands.)

**Then, the probe dub (~$2.20), which is now the LAST unverified step:** the watermark flag is
verified `false` in both containers (checked 2026-08-22, process env read directly), the vendor
client's five endpoint shapes are verified against the current API reference, and the Date-bind
crash that killed every prior attempt is fixed in #58. Open the dubbing panel on a short video,
pick one language, run it. What the probe proves that nothing else can: the billable create
against the LIVE vendor, the watermark's absence by ear, and the new stage-by-stage progress bar
against a real run. If it stalls again, the worker now logs every handler failure —
`docker logs podcast-saas-worker-1 | grep dub` will say why, which it could not before.

## 🔵 Blocked on your ruling — C1, the largest remaining security item (6 findings, one fix)

The media gate (`canServeMediaKey`) knows exactly three key prefixes — `videos/`, `exports/`,
`hls/`. Everything else is served by handlers that invented weaker checks: `/sim-public/*` checks
only that the key starts with `simulations/`, and `podcasts/` is modelled as fully public.
One prefix-complete gate closes `security-005`, `security-016`, `simulation-007`, `security-006`,
and (with the bucket migration) `security-001`. The sweep's own warning: implementing this without
the ruling "produces something that looks done and is not." Three decisions, with my
recommendation on each:

1. **`/sim-public/*` policy — token or live lookup?** *Recommendation: scoped tokens, the same
   `t/{token}/` shape HLS already uses.* A sim package is many files fetched by relative URL from
   an iframe, which is exactly the case the path-segment token was designed for; a per-request
   project lookup would put a DB query on every asset of every sim. Cost: revoking a share keeps
   already-minted tokens alive until expiry (≤8 days) — same trade already accepted for HLS.
2. **`podcasts/` holds user SOURCE DOCUMENTS on a public prefix.** *Recommendation: move the
   documents to a private prefix (`podcast-sources/`), keep the immutable studio clips public.*
   The prefix was chosen for clips; documents were added later without revisiting it. Moving new
   writes is one key-builder change; existing objects get a small backfill move.
3. **`security-001` / STEP 3+4 — when to cut the public bucket over to proxied URLs.**
   *Recommendation: schedule it as its own round, after the C1 gate lands.* It changes URLs people
   already hold (the four ordered landings are documented in
   `supabasePublicMedia.guard.test.ts`); a naive cutover is an outage. The ⚪ "revoked shares keep
   working" acceptance stays accepted until this ships.
4. **`security-012` — the gate returns TRUE on a DB error (availability over confidentiality).**
   *Recommendation: ratify it, but bound it* — fail open only for keys whose project was public at
   last successful check (a tiny TTL cache), fail closed for never-seen keys. Full fail-closed
   turns every Supabase blip into a sitewide media outage; full fail-open is what stands today.

Say "approve C1 as recommended" (or amend any of the four) and the next session implements it as
one gate.

## 🔵 Blocked on you — materials and approvals (unchanged, restated once)

- **Crop P0.3 footage:** 20–50 real catalogue clips + ~2h labelling with the shipped annotation
  tool (`scripts/crop-eval/annotate.html`, PR #54). Until then crop P2 does not start, and all
  quoted crop gains remain synthetic-fixture numbers. YuNet model: `..._2026may.onnx` (R-08).
- **Route renames (P3-A)** — `/admin`, `/edit-podcasts`, and the audio landing you already chose
  as **option א: `/{slug}/audio`**. Full design in `CODEX-DECISION-RESPONSE-2026-08-21.md` Part
  III; needs your "go" to implement, and should land together with —
- **Interactive podcast phase 2 (P3-B)** — Raise Your Hand / Hands-Busy Mode / Call It, built
  from the existing video + captions, exported as audio, with the locked-phone playback answer
  (Media Session + background audio) in the same design doc. Architecture first, code on approval.

## 🟠 Standing constraints (do not change without a ruling)

- `AVATAR_CAPABILITY_MODE` / `AVATAR_BUDGET_MODE` stay `shadow` — flipping capability enforce
  early 401s every viewer; the five-step enforce ordering is in `.env.example` and the archive.
  Budget-shadow traffic is NOT valid calibration data until the async observer is rebuilt (D-14).
- `QUEUE_CROP_CONCURRENCY` stays 1 — measured ruling (six videos, no queue); revisit on a real
  backlog, not a calendar.
- Language switching is a full document load; the `?t=` resume goes through the extracted scrub
  path only. Do not add a second seek.
- Captions for a dubbed language come from that dub's own segments, never an independent
  translation. Groq Whisper stays allowed only for captions-only languages with no dub.
- Migration numbers are reserved by hand across branches; BOTH hardcoded registries
  (`db/migrate.ts`, `scripts/check-db.ts`) must carry every file. Latest reserved: **070**.
- The classifier boundaries stand: merges yes, `--admin` no; push yes, force-push no; release
  dispatch and deploy approval are yours alone.

## 🟡 Work queue — the sweep's remaining confirmed findings, in cluster order

**The remaining `fix-now` findings** — the 13 below are every one not closed by #58–#60. First steps are the sweep's own,
re-checked against the code before anything lands:

1. **C4 — viewer and export disagree on overlapping clips** (`broll-player-002` +
   `broll-data-008`): move `resolvePlan`'s winner rule into `shared/`, call it at both
   `useProjectPlayer` sites; add an `overlap` violation code + writer-side rejection.
2. **`simulation-009`** — an aborted section's error is stamped with the live section's identity:
   capture `var activation = current` at call time, re-check identity before posting.
3. **`simulation-008`** — republication leaks the previous revision's posters forever: call
   `invalidate()` from the two real activation sites; fold poster GC into the storage census.
4. **`media-003`** — the capture sanity gate discards canvas-free sims' frames: full-viewport
   screenshot hash when `cs.length === 0`; "no canvas" is not-applicable, not failed.
5. **C10 — `job-queue-013`**: extend `NEVER_INLINE` to every CPU-bound job kind (the export
   precedent already exists); move corpus ingest onto pg-boss (`backend-008`/`job-queue-015`
   ride along).
6. **`job-queue-014`** — test files are not type-checked: `tsc --noEmit -p tsconfig.test.json`
   in CI, fix the four current errors.
7. **LLM trio** — `llm-pipeline-007` (wire the prompt-caching fields that already exist),
   `llm-pipeline-011` (hoist quota block + reasoning payload into a shared preamble),
   `llm-pipeline-016` (ratio floor before the compile hash, fall back to draft below it).
8. **Ship-conductor trio** — `scripts-ship-005` (read the review decision, never infer approval
   from a disappearance), `scripts-ship-010` (one shared arg parser that rejects non-finite
   numbers — a NaN currently disarms the destructive-backfill ceiling), `scripts-ship-013`
   (`assertLocalDatabase` beside `assertLocalStorageOnly` in every wipe/seed script).

**Then the 69 `schedule` findings** — report §2, grouped; biggest clusters after C1: C2's
remaining resource items (`media-009` tmpfs arithmetic, `performance-005` zip double-buffer),
observability's silent-failure paths, and the a11y group.

**Standing backlog, unchanged:** production storage census (`storage-census.sql`, read-only —
unblocks retention/rollup/TOAST work and simulation-008's poster GC) · **D-14** avatar spend
(atomic function → async observer → client wiring, in that order) · **D-16** crop hardening ·
**D-17** knowledge/retrieval gates · D-01b follow-ups (absolute `timeline_markers.at_sec` and
manual avatar ranges share the drift class; standing review panel in the editor) · WebKit
`__CHILD` re-key + the stale `ci.yml` comment (baseline measured, in the archive).

## ⚪ Known and accepted

- Public-bucket HLS: revoked shares keep working until C1's STEP 3+4 cutover ships (see the
  ruling block above — this is now the same item).
- The WebKit e2e lane is non-blocking and flaky by measurement; scenario 11 is the one consistent
  failure, lead documented (the opacity product over 5 elements).
- 71 sweep ids are unadjudicated aliases — never bulk-close by alias; four documented cases where
  the canonical's verdict does not carry (`dependency-008`, `security-012`, `media-011`,
  `simulation-004`).
- Sweep caveat: code, tests and local probes only; §5 names the seven determinations resting on
  inference and the one cheap observation that settles each.
