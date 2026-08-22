# Open decisions

**State as of 2026-08-22.** Production runs **v0.1.38**, healthy. Merged to `main` and NOT yet
released: **#57** (dubbing panel — source-language detection, real progress, search/sort),
**#58** (the D-23 production dubbing outage + both sweep P1s), **#59** (cross-tenant writes, the
token leak, container ceilings), and **#60** (bounded uploads, scenes over-fetch, −474 KB viewer
JS — merged 2026-08-22). **The dubbing feature is dead in the deployed build and fixed only in
`main` — nothing dubbing-related can be tested until the next release ships.**

The 2026-08-21→22 closed round — v0.1.36→38, the fleet audit, the CSP defects, D-13, D-01b,
D-20…D-23, and the sweep's entire fix-now queue — is CLOSED, its per-item verification record
living in git history (the ledger's own commits across PRs #48–#69), which is where
closed rounds belong rather than in an ever-growing archive file. The verification sweep itself is
`LEDGER-VERIFICATION-2026-08-22.md`: 164 verdicts, 93 confirmed, of which 10 are now fixed;
**the remaining confirmed findings are the work queue below.**

Last updated: **2026-08-22**, during the post-sweep fix round.

---

## ✅ RESOLVED (2026-08-22) — EVERY DUBBED LANGUAGE HAD AN AMERICAN ACCENT

**The report, verbatim:** ElevenLabs dubbing "puts an American accent on all the other languages and
it does not sound natural at all (Spanish, Hebrew — there is an English `r`, not their languages')."

**What we actually send**, verified in `ElevenLabsDubbingClient.ts:252-259`: `file`/`source_url`,
`reference`, `model_id`, `source_language`, `target_language`, `keyterms`. **Nothing about voice.**

**The mechanism this most likely is, and why it matters which:** ElevenLabs Dubbing CLONES the
original speaker's voice and has the clone speak the target language. A cloned English speaker
speaking Hebrew carries that speaker's articulation — an English `r` is exactly what voice-cloning
transfer sounds like. If that is what is happening, this is not a bug in our integration at all; it
is the default behaviour of the product we chose, and the fix is a **product decision with a real
trade-off**: the creator's own voice with a foreign accent, or a native-sounding voice that is not
theirs. Those are different products and the owner should choose, not us.

**Do NOT assume it is that.** The alternative — that a parameter we are not sending would fix it
outright — is equally consistent with the evidence, and we would be shipping a preference where a
one-line fix belonged.

**The research must settle, with citations to the vendor's current API:**
1. Does Dubbing v2 expose per-target-language VOICE selection, or a way to disable cloning and use
   a stock native voice? If so, is it per project, per language, or Dubbing-Studio-only?
2. Is there a quality or accent control we are not sending (`num_speakers`, voice settings,
   `dubbing_studio`) that changes phonetics rather than just fidelity?
3. Does `keyterms` — which we already send — affect pronunciation, and are we using it?
4. Is `model_id` (`dubbing_v2`) the right model for accent quality, or is there a newer one?
5. If cloning is unavoidable, what do comparable products do, and what does the owner lose either
   way? A recommendation, with the trade-off stated in one sentence each.

**Evidence to collect before recommending anything:** one short clip dubbed to Hebrew AND Spanish,
under the current settings and under each candidate setting, so the difference is heard rather than
argued. Dubbing is billed per source-minute, so use the shortest usable clip.

**Blast radius:** dubbing is the most expensive job kind in the product ($2.20/min was the figure
used when the budget guard was written), so any experiment needs a stated cost before it runs.

### THE ANSWER (researched and shipped, 2026-08-22)

It was cloning, and it is one parameter. ElevenLabs' `disable_voice_cloning`: *"Instead of using a
voice clone in dubbing, use a similar voice from the ElevenLabs Voice Library."* **Similar** is the
operative word — gender and character are preserved, the phonetics are the library voice's own.

**The owner ruled:** a different voice is fine, an accent is not — "if a man/woman is speaking, a
different man's/woman's voice is fine, but no accent; they should sound native in that language."
Shipped on by default, with `DUBBING_NATIVE_VOICE=0` to restore cloning without a deploy.

`target_accent` (experimental) also exists and picks between natives — Castilian vs Latin American
Spanish. Left UNSET: a wrong dialect is a worse answer than no preference.

**THE COST, WHICH THE VENDOR STATES PLAINLY:** *"Voices used from the library will contribute
towards a workspace's custom voices limit, and if there aren't enough available slots the dub will
fail."* Every language dubbed takes a slot, and it needs the `add_voice_from_voice_library`
permission on the workspace.

That failure is now named (`voiceLimitReached`) and made NON-retryable — a dub gets eight attempts,
and spending them on a condition only a human can clear delays the error the operator needs to see
while making it look transient. **Owner action if it ever fires:** free a custom-voice slot in the
ElevenLabs workspace; no code change will help.

## 🔴 CROP v2 IS A LABEL WITH NO ALGORITHM BEHIND IT — and flipping it costs a full recompute

Found on the first real run of the field eval, 2026-08-22.

`algo.ts` documents `CROP_ALGO=v2` as a shipped-dark rollout lever: *"v2 carries a new dependency
and a new failure mode, so it ships dark and is turned on per-environment, and rolling back is an
env flip rather than a deploy."* The flag, the type and the version stamp all exist.

**Nothing branches on it.** `cropAlgo()` has no consumers anywhere outside `algo.ts` — grep the
whole of `backend-api/src` and the only readers are the version stamper and the two eval scripts.
v1 and v2 are one code path wearing two labels, which the field eval demonstrated by scoring both
at mIoU 0.5089 — identical to four decimal places, on 390 real frames.

**The trap.** `sourceHash(..., algo = algoVersion())` folds the version into the crop idempotency
hash — deliberately, so a genuine algorithm fix reaches videos that already have a crop. So
setting `CROP_ALGO=v2` in production would:
  - change every `crop_source_hash`,
  - make every `ready` crop row stale,
  - recompute the ENTIRE catalogue,
  - and produce byte-identical output.

An env flip documented as a cheap rollback lever is in fact a full-catalogue reprocess for zero
change. Nothing warns about it and nothing fails.

**Also:** any past comparison of "v1 vs v2" from `run-eval.ts` compared a thing to itself. Its
`withAlgo()` helper pins the env var around each run, which reads as a working A/B and is not one.

**Not fixed here, because the right fix depends on an answer only the owner has:** was v2 removed
deliberately (then delete the flag, the type and the VERSIONS entry, and say so), or is it still
intended (then the flag stays and needs a guard so it cannot be set until an implementation
exists)? Shipping either without knowing would be guessing at a plan. The dangerous half — that a
flip silently costs a catalogue recompute — is what needed writing down today.

## 🎯 WORK WAVES — the order everything is done in (owner-ranked 2026-08-22)

The owner's ranking: **podcast is the most critical area, crop second — but a critical BUG comes
before either.** That rule does real work here, because the podcast area turns out to CONTAIN one.

Each wave is finishable and leaves the product in a coherent state. Do not start wave N+1 while a
wave-N item is open, unless it is blocked on the owner — in which case say so and drop down.

### ✅ PRIORITY 1 (owner, 2026-08-22) — APPROVAL CLICK REPLACED BY REAL GATES  ·  PR #76 MERGED
The owner's account of the manual production approval: *"in practice I only click 'Approve and
deploy' without performing an additional review, so it is not providing meaningful protection."*
Shipped as one coherent extension of the existing release system, not a parallel one.

- **`candidate-smoke`** — a job between `release-plan` and `deploy` that boots the exact
  digest-pinned images about to be deployed and exercises them over HTTP. Every other check in the
  pipeline tests the SOURCE. Pins from `manifest.json` (the same file `remote-deploy` pins from),
  refuses any non-`@sha256:` reference, runs against a real Postgres.
- **Conditional approval** — `release-cli release-risk` classifies each release in `plan` from
  evidence already produced (migration-audit findings, `backfill_policy`, `approve_high`, the
  changed-path surface for auth/secrets/media-tokens/deploy config). Risky → `production-approval`
  environment with a required reviewer. Routine → automatic. Unreadable evidence ⇒ ask a human.
- **`production-flows.spec.ts`** — the flows the owner named: opening an existing project, the
  legacy-URL → token-minting → resource-loads round trip, an untokenised private key being refused,
  playback buffering a real frame, the export entry point (stopping short of submitting).
- **A hole this found in the EXISTING post-deploy gate:** every fixture-dependent production audit
  is `test.skip(!process.env.SMOKE_*)`, so an unset repository variable silently removed the check —
  spec skipped, summary counted it, no finding, gate passed, release deployed. Closed by
  `playwright-summary --require-tests`, which scores skipped and missing as the same CRITICAL.
- **Tests for the gates themselves:** `workflow-graph.ts` parses the job graph structurally. Eleven
  un-gating mutations applied, eleven caught. Two pre-existing tests rewritten from magic constants
  (`checkouts===7`, a literal `testMatch`) to the properties they were protecting.

- **Five boot guards the candidate stack could not have passed**, each found by reading what the
  code does with a value rather than what the value looks like, and each of which would have failed
  `--wait` and blocked EVERY release while reporting it as a broken image: local-disk storage is
  refused under production; `assertPublicOriginsForProd` rejects loopback origins; `getFirebaseAdmin`
  parses a PEM at boot; `next.config.ts` applies the same origin rules at `next start`; and
  migrations do not run at boot at all. Mapped in the `production-mode-boot-guards` memory.
- **Two of my own tests asserted things that cannot be true** — Next.js bakes its public env at
  BUILD time, so the candidate client-web calls production regardless. One of them would have failed
  on every correct release, which is the failure mode that gets a gate deleted rather than fixed.

**Owner-side, already done by me:** `production-approval` created with the owner as required
reviewer; `production` already had none. **Done when:** #76 merges and the first release after it
exercises `candidate-smoke` against live images for the first time — that run is the real test, and
it fails closed, so the risk is a blocked release rather than a bad deploy.

### 🔴 WAVE 0 — FIVE MERGED PRs ARE NOT IN PRODUCTION  ·  blocks everything user-facing
**Verified 2026-08-22 against the running containers**, because the previous version of this entry
was stale in both directions — it said v0.1.38 and "dubbing is dead", and production had been on
v0.1.39 with dubbing working since the owner fixed the API key.

Production runs **v0.1.39**. Merged to `main` and NOT deployed:
- **#74 — `security-016`, a live data exposure.** A user's uploaded podcast brief is readable by
  anyone who obtains the URL, with no credential. Fixed in `main`, still exposed in production.
  This is why the wave is red rather than amber.
- **#75** — the media gate understands simulations and no longer fails open blindly.
- **#76** — the release gates that replace the approval click.
- **#77** — the writers'-room golden suite and the podcast pipeline's own health metrics.
- **#78** — A2.1, audio editions.

**The first release after #76 exercises `candidate-smoke` against live images for the first time.**
It fails closed, so the risk is a blocked release rather than a bad deploy — which makes this the
right release to find out on, not the wrong one.
**Done when:** a release is published and deployed, and production reports the new version.

### ✅ WAVE 1 — CLOSED (2026-08-22), verified in `main` rather than assumed
Both of the findings that made this wave outrank podcast features are fixed and merged:
- **`security-016`** — `podcast.controller.ts` now writes user source documents under the private
  `podcast-sources/` prefix (PR #74). Verified present in `origin/main`.
- **`simulation-007`** — `sim-public.controller.ts` gates on `isRevisionStatusPublic` before the
  storage read, so a draft/uploading/failed revision 404s rather than serving its bytes (PR #75).
  Verified present in `origin/main`.

Still open from C1 and deliberately NOT closed here: **`security-001`, the bucket cutover.** It
changes URLs people already hold, so it is scheduled separately — see the ruling block below.
**Owner action outstanding:** delete and re-upload the one podcast document that was exposed. The
code fix stops new exposure; it cannot un-expose a URL that was already shared.

### ✅ WAVE 2 — DONE (2026-08-22, PR #77 merged)
Both items shipped. `llm-pipeline-017`: a golden suite drives the REAL ScriptRoom over a fixed
corpus and pins everything the room does after the model speaks — the proportional floor, the
splitter, the overlap demotion, the blank-turn drop, the hook guarantee, pass order, telemetry, and
what the content hash must distinguish. The fake parses every fixture through the pass's own Zod
schema, which immediately caught the judge's verdict enum being `approve|needs_fixes` rather than
`pass|needs_fixes` — a value `.catch()` silently coerced, so the "clean" corpus had been quietly
taking the rewrite path. `observability-006`: four aggregates plus the dashboard, reporting a
failure RATE over SETTLED renders (queued work in the denominator would make the rate improve as the
pipeline backs up) and `null` rather than `0` when nothing has settled, preserved all the way to
the screen. 33 mutations, all caught; five of them only after a test was fixed.

### 🔵 WAVE 3 — IN PROGRESS  ·  A2.1 shipped (PR #78), A2.2–A2.4 next
`PARKED-DESIGNS.md` P3-B, in its stated build order. **A2.1 (audio derivation) is complete**:
migration 071, the pure rules, the ffmpeg pass, the service, the durable job and the API. An edition
is exactly as public as its project — re-derived per request from `requireProjectAccess`, never read
off the edition row — with the artifact under a PRIVATE `editions/` prefix, because `podcasts/` being
public is what made a customer's brief world-readable (security-016). 31 mutations, all caught.
**Remaining:** A2.2 `/{slug}/audio` landing → A2.3 Media Session + PWA (the locked-phone answer) →
A2.4 Raise Your Hand. **A2.5 "Call It" is deferred by its own design** until A2.4 produces real
listener-question data proving demand — that is a decision already recorded, not an omission.

### WAVE 4 — CROP  ·  owner: footage  ·  blocked at the first step
P0.3 is 20–50 real catalogue clips + ~2h labelling in the shipped tool
(`scripts/crop-eval/annotate.html`). Until it exists, P2's detector cannot be scored — YuNet gets
ZERO detections on the synthetic fixtures — and every crop number in this repo remains a
synthetic-fixture figure that must not be quoted as a field result. Then D-16 hardening
(discontinuity markers, detector fallbacks, a confidence gate before auto-publish is trusted).

### WAVE 5 — THE TAIL  ·  not blocked  ·  take from it, do not try to finish it
~65 remaining `schedule` findings (report §2) plus the standing backlog: storage census, D-14
avatar spend, D-17 knowledge gates, D-01b follow-ups, the WebKit `__CHILD` re-key. Mostly P3 with
bounded blast radius. **This wave has no finish line and is not meant to have one** — pull from it
when a related area is already open, rather than working down the list.

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
the ruling "produces something that looks done and is not." Four decisions, with my
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
  as **option א: `/{slug}/audio`**. Full design in `PARKED-DESIGNS.md`;
  needs your "go" to implement, and should land together with —
- **Interactive podcast phase 2 (P3-B)** — Raise Your Hand / Hands-Busy Mode / Call It, built
  from the existing video + captions, exported as audio, with the locked-phone playback answer
  (Media Session + background audio) in `PARKED-DESIGNS.md`. Architecture first, code on approval.

## 🟠 Standing constraints (do not change without a ruling)

- `AVATAR_CAPABILITY_MODE` / `AVATAR_BUDGET_MODE` stay `shadow` — flipping capability enforce
  early 401s every viewer; the five-step enforce ordering is in `.env.example`.
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

## 🟢 The sweep's fix-now queue is DONE — 8 landed, 1 corrected by measurement (2026-08-22)

**Landed** (PRs #62–#68, each mutation-checked): C4 viewer/export overlap parity · `simulation-009`
superseded-activation identity · `job-queue-013` no encodes in the API container ·
`job-queue-014` exhaustive job maps · `media-003` canvas-free capture · the ship-conductor trio
(`-005` rejected-deploy-as-approved, `-010` NaN ceiling, `-013` seeder DB guard) · the LLM trio
(`-011` thinking-off + un-metered, `-016` gutted script marked ready, `-007` unreachable prompt
caching).

**`simulation-008` — CORRECTED, and deliberately NOT implemented.** The finding's facts hold:
`posterService.invalidate()` has no caller on the production activation path, and
`cleanupOrphans()` has no caller at all. But its SCENARIO — "every republication leaks the previous
revision's posters, forever" — is not currently reachable, and the prescribed fix would have added a
destructive call to a path that creates nothing:

- the production activation path does not GENERATE posters either. The only capture path is the
  operator script `sim-canary-publish.ts`, which already calls `invalidate()` after the new verdict
  is durable (line 322) — the one writer is also the one invalidator;
- the other writer, `ProjectDuplicationService`, copies posters onto a NEW simulation id, so nothing
  is superseded;
- **production evidence, read-only: `sim_posters` holds 0 rows across 0 simulations.** There is no
  accumulated backlog, which is what the sweep's "fold it into the storage census rather than
  deleting in isolation" caution was protecting.

Wiring `invalidate()` into the activation path today would delete nothing and add a real hazard:
the function deletes every poster row whose `package_revision` differs from the one passed, and its
own comment warns that a wrong value matches rows it was meant to keep.

**The condition under which this becomes real:** a production path that CAPTURES posters. If poster
generation ever moves out of the operator script and into publication, the capture and the
invalidation must land together — that pairing is the actual invariant, and it is currently
maintained only because both live in one script.

---

## 🟡 Work queue — the sweep's remaining confirmed findings, in cluster order

~~**The remaining `fix-now` findings** — the 13 below.~~ **ALL CLOSED 2026-08-22** — see the
section above. Kept as the record of what each was and how it was approached:

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
`__CHILD` re-key + the stale `ci.yml` comment (baseline measured — PR #45's four-run table, in git history).

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
