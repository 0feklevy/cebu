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

## 🟢 Acting on the verification sweep, 2026-08-22 — 10 findings closed across PRs #58–#60

The sweep returned 93 confirmed findings with 22 marked `fix-now`. These are the ones now fixed,
each re-verified against the code before being touched rather than trusted from the report.

**PR #58 — the two P1s.** `test-quality-015` (RumService `fieldAggregates` bound a raw `Date` into
raw SQL) and `job-queue-011` (rollback re-pointed `APP_VERSION` without moving the tree, so an old
image got a queue name it did not know and crash-looped while `wait_healthy` omitted `worker`).
The first turned out to share its exact mechanism with the live dubbing outage — see D-23.

**PR #59 — cross-tenant writes, a credential leak, and containment.**
- `security-009` — a knowledge-document DELETE never proved the document belonged to the project,
  and the default deployment sends every tenant's request under ONE shared vendor key.
- `security-008` — `findManageableVisual` matched `OR project_id IS NULL`, making every global
  avatar visual writable by any project owner. The only thing making it non-trivial was that the
  LIST endpoints hide global ids — obscurity, not a boundary.
- `security-011` — Firebase ID tokens were accepted in `?token=` on EVERY route using the shared
  middleware, and nginx logged the query string. Both halves fixed.
- `backend-011` — a throw inside a fire-and-forget failure handler terminates the process on
  Node 22. Both catch bodies hardened, error text sanitised, and a process-level net added.
- `config-003` — nothing on the host had a memory limit. Ceilings sized from MEASURED idle usage
  (665 MiB total across five containers) to 6016 MiB of 7815 MiB, swap disabled, `cpus: 1.5` on the
  worker only.

**PR #60 — resource cost.**
- `security-007` — six multipart routes buffered whole files; two "checked" the size only after
  the allocation, which is the cost being defended against.
- `database-005` — the hottest read path fetched every scene's transcript and word-level alignment
  to use four scalars, usually for nothing.
- `performance-009` — katex and chart.js sat in the initial JS of every public viewer route.
  Measured before/after: **−474 KB** on `/[slug]`, **−475 KB** on `/v/[shareToken]`.

**🔵 BLOCKED ON YOU — cluster C1, the largest remaining security item.** The media authorization
gate knows exactly three key prefixes (`videos/`, `exports/`, `hls/`), so `simulations/` and
`podcasts/` are served with no project lookup at all. Six findings collapse into one fix — but the
fix needs a ruling first, and the sweep explicitly warns that whoever implements one of these
without the ruling "will produce something that looks done and is not":
1. **`/sim-public/*` policy** (`simulation-007`, `security-005`): should a simulation package be
   reachable by a token scoped to it, or by a live project-visibility lookup? Today unsharing a
   project does not revoke access to its simulation.
2. **`podcasts/` prefix** (`security-016`): it is modelled as public because it was chosen for
   immutable studio clips, and user SOURCE DOCUMENTS were later added to it. Move the documents off
   the public prefix, or make the prefix private and re-mint its URLs?
3. **`security-001`** — steps 3 and 4 of the storage migration (mint `/hls-proxy/t/{token}/` URLs,
   then make the bucket private). This changes URLs people already hold, so it is a scheduling
   decision as much as a technical one.
Also `needs-owner`: `security-012` (the gate returns true on a DB error — ratify or reverse that
availability-over-confidentiality trade).

---

## 🔴→🟢 2026-08-22 — the dubbing feature was COMPLETELY DEAD in production (D-23, PR #58)

The owner reported "the translation doesn't work at all", and they were right in the strongest
sense: **no production dub has ever run.** Diagnosed live on the VM (read-only — container ps,
logs, SELECTs on `pgboss.job`): every attempt died in `acquireDubbingSlot` with
`TypeError: … Received an instance of Date` — a raw `Date` bound into `db.execute(sql…)`,
which postgres-js `unsafe()` does not serialise. Thrown before any log line and before the vendor
was ever reached; pg-boss retried on backoff and failed the job permanently; the row sat `queued`
forever.

Three compounding silences, each now fixed:
1. the slot acquire sits outside `run()`'s try/catch → the `[dubbing] failed` log never fired;
2. `registerWorkers` re-threw without logging → the worker emitted ZERO lines across a 30-minute
   window holding four failed attempts (the error existed only in `pgboss.job.output`);
3. every test was green — PGlite serialises Dates itself. **The identical mechanism the sweep
   confirmed as P1 the same night (`test-quality-015`, RumService.fieldAggregates).** Both sites
   fixed in one pass; the invariant is pinned at the parameter layer in both suites.

Also ruled out while diagnosing, worth keeping: **the vendor client is verified correct** against
the current API reference — `POST /v1/dubbing/project` (multipart, `reference` accepted),
language targets, target transcript, status enums. §7's riskiest unknown is now answered; the
probe (~$2.20) remains the last unverified step. Beware the docs redirect: the current surface's
`create` URL 404s to the LEGACY `POST /v1/dubbing` page, which briefly misled this diagnosis.

**`job-queue-011` (P1) fixed in the same PR**: rollback.sh now checks out the target tree, waits
on `worker`, and `resolveWorkerQueues` skips unknown names (throws only when nothing survives).

Production state verified clean after diagnosis: no pending dub jobs, no orphan rows. **The fix
is dead code until a release ships it** — the owner runs the dub again afterwards, which doubles
as the long-owed vendor probe.

---

## 🟢 Requested and delivered 2026-08-22 — the dubbing panel, three defects from the running product

The owner opened the shipped panel and found three things wrong with it. All three are the same
kind of failure: the round that added 94 languages, a source-language column and a progress bar
shipped the *mechanism* for each and never checked what the creator actually sees.

- **D-20 — the source language is never detected, so English is offered for an English video.**
  Migration 068 added `projects.source_language` and the server refuses a same-language dub, but
  **nothing ever writes that column**. It is null for every real project, so `is_source` is false
  for all 94 rows and the exclusion never fires. Reported twice, which is the measure of how
  badly the first fix missed: shipping the *refusal* without shipping the *detection* left the
  defect exactly where it was. Fix: detect from the source captions this product already stores
  (offline, no vendor call, no tokens), persist what the vendor auto-detects on the first real
  dub, keep a creator override above both, and record WHICH of the three a value came from so a
  guess never masquerades as a declaration.
- **D-21 — the progress bar measures the wrong thing.** It renders `done/total videos`, so a
  single-video project — which is nearly all of them — sits at `0/1` for the entire run and then
  jumps to `1/1`. That is a boolean drawn as a bar. The information the creator wants is *where
  in the pipeline this dub is*: waiting for a slot, transcribing, translating, captioning,
  mixing, packaging. Every one of those stages is a distinct step in `DubbingService` and none of
  them is persisted. Fix: persist the stage, report a real percentage, and say in words what is
  happening right now.
- **D-22 — 94 languages, no search and no order.** The list is alphabetical by English name, so
  Spanish is 76 rows below Afrikaans. Fix: a search box matching name, endonym and code, plus a
  sort control (popular / A–Z / status), with the source language and anything already requested
  pinned above the rest.

**Why these three together:** they are one screen and one round. Splitting them would ship a
searchable list that still lies about progress.

**Delivered on `feat/dubbing-language-ux`** — migration **070** (`video_dubs.stage`,
`video_dubs.stage_entered_at`, `projects.source_language_origin`, and a
`(video_file_id, status)` index for the panel's poll), registered in **both** hardcoded registries.

- **D-20** — `detectLanguage.ts` identifies the language offline from the WebVTT this product
  already stores: script ranges decide the non-Latin cases outright, stopword rates decide the
  Latin ones. No dependency, no model, no vendor call, no tokens. `sourceLanguage.ts` resolves
  three sources in a fixed order of authority — a creator's declaration, then what the vendor heard
  during a real dub, then our own detection — caches the answer, and records WHICH it was. **A
  guess below the confidence floor is returned as a suggestion and acted on by nothing**, because a
  language silently removed from someone's list is a worse failure than the one being fixed. A new
  `PUT /api/v1/projects/:id/source-language` is how a person overrules all of it.
- **D-21** — `stages.ts` is the pipeline as data: seven steps, each with where the bar stands when
  it begins and roughly how long it runs. `DubbingService` writes the stage as it crosses each
  one. Inside a step the bar creeps asymptotically on elapsed time toward one point short of the
  next step and can only cross when the step actually finishes — optimistic about timing, never
  about progress. The panel shows the percentage and the sentence ("Translating and matching the
  voices"), and polls at 5s because the poll interval is now the frame rate.
- **D-22** — search across English name, endonym and code, accent-folded, with **graded relevance**
  (exact code → prefix → substring) so "fr" answers French rather than Afrikaans. Three sorts —
  Most used / A–Z / In progress first — with the rank served from `languages.ts` so one table
  orders the list. The source language is pinned first when not searching, and relevance wins when
  searching.

Tests: 26 new (detector, stages, ordering, rollup, the popular-list invariants), and the whole
suite green — backend 3891, client-web 1699, 0 lint errors. The pure logic was pulled OUT of the
component into `languageList.ts` first: a rule tested through a rendered tree is tested through
everything else the tree does, which this repo has already paid for once.

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

## 🟢 Production fleet audit, 2026-08-21 — read-only, and it answered two questions at once

Ran against production (read-only queries through the backend container; nothing written). This is
crop **P0.1**, delivered — and it settled the `QUEUE_CROP_CONCURRENCY` question without needing the
load test that was queued for the owner.

**The fleet is six videos.** Four crop-ready, two failed. The most recent crop analysis ran on
2026-07-30 — three weeks before this audit.

**RULING — `QUEUE_CROP_CONCURRENCY` stays 1, and the reason is not caution about CPU.** There is no
queue to parallelise. Concurrency 2 would optimise contention that has never occurred; the planned
two-job RSS/runtime measurement would have been measuring a non-problem. Revisit only if the fleet
grows enough that crop jobs actually wait on each other — the trigger is a real backlog, not a
calendar reminder. (Capacity context, since it was previously unmeasured: the host is 2 vCPU with
**7.6 GB RAM, 5.6 GB free**, and the worker idles at 63 MB. Memory was never the constraint.)

**Both crop failures are `download failed: 404` — storage, not the algorithm.** The `video_files`
row exists and its `storage_key` is well-formed (`videos/<uuid>.mp4`), but the object is not there.
Neither size nor age explains it: a 541 MB video from 51 days ago works while a 79 MB one from 60
days ago does not.

Two of the six are **public projects**, and they fail differently:

| video | project | state | what a visitor sees |
|---|---|---|---|
| `9ee102e7` | "Niceville - test" (public) | `hls_status=failed` **and** crop failed; 726 MB source, 82 days old | **A broken player.** Nothing to play — this one is fully dead. |
| `292ea47d` | "How Did Proteins Evolve…" (public) | `hls_status=ready`, crop failed; 79 MB source, 60 days old | Plays fine. The raw source is gone, so crop can never run and any future re-processing fails. |

The 726 MB one, whose HLS also failed, has the fingerprint of an **abandoned multipart upload** —
the row was created optimistically and the object never assembled. That is precisely the billed-but-
invisible case Supabase's 24-hour auto-abort now covers, so new occurrences should stop; this row
predates it by 82 days. The 79 MB one is different and more concerning: it survived long enough to
transcode, then disappeared — a deletion after the fact, which is the writers-vs-deleters asymmetry
PR #37 was chasing.

**Every video has `crop_algo_version = NULL`.** Not one has been analysed by the versioned algorithm,
so this round's P1 improvements have never touched production data. Because `ALGO_VERSION` is in the
idempotency hash, a re-run WOULD re-analyse all four ready videos under v1.1 — the dark-skin mIoU
0.272→0.508 improvement is available to them the moment anyone asks for it.

**All three follow-ups are now closed** (2026-08-21, same day):

- **The missing 79 MB object was a known path.** The owner confirms deleting source files by hand.
  The storage-leak file does NOT reopen — this was housekeeping, not an unaccounted deleter.
- **The four healthy videos were re-cropped onto v1.1**, enqueued through the app's own
  `enqueueJob('crop')` rather than by touching rows. All four now carry `crop_algo_version = v1.1`;
  the two failures stayed failed, correctly, because their source objects genuinely are not there.
  This is the first time this round's P1 work has touched production data — including the dark-skin
  mIoU 0.272→0.508 improvement.
- **The dead public project is to be deleted by the owner from the app**, not by SQL. It holds two
  simulations and two `avatar_visuals`, and the delete handler's own comment explains why the path
  matters: avatar-visual bytes live under `simulations/avatar/{uuid}/`, outside any project-scoped
  prefix, so once the row is gone they are unreachable by every sweep that will ever exist. The
  handler collects them before deleting; a hand-rolled delete would orphan them permanently.

**A measurement fell out of the re-crop for free** — the thing the queued load test was supposed to
produce. Four analyses ran back-to-back on production; the gaps between their `crop_updated_at`
stamps give real durations: 5 s of video ≈ instant, 239 s ≈ 81 s, 432 s ≈ 167 s, 432 s ≈ 179 s.
**Crop runs at roughly 0.4× realtime** — a 7-minute video is analysed in about 3 minutes. That is
comfortable, and it independently confirms the concurrency ruling: the job is not slow, and there is
no queue behind it.

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

- Crop **P0.2 (annotation tool) and P0.3 (real labelled set) are absent**; all reported crop gains are
  measured on **synthetic fixtures** and must not be quoted as field results. P2 (the detector itself) is
  not in this release at all — `CROP_ALGO` has no v2 to select yet. *(P0.1 was listed here as absent too;
  it is not — it ran against production on 2026-08-21, see the fleet-audit section above. An audit caught
  this line contradicting one 60 lines higher in the same file.)*
- Nothing in the dubbing pipeline has been exercised against the live ElevenLabs API — no key, no
  network in the build environment. The ranked list of call shapes that remain unverified is in
  `md-files/DUBBING-IMPLEMENTATION-REPORT.md` §7; the riskiest is the billable multipart create,
  where a silently-dropped `reference` field would quiet the crash-recovery defence without erroring.
- `db:check` is a manual operator tool and is still not wired into CI. It does not need to be: the
  registry-drift invariant it would enforce is already covered by tests that run on every branch.

## 🔴 Live production defects, found in the owner's own browser console (2026-08-21)

Both are real, user-visible, and — until this entry — **recorded nowhere**: not here, not in either codex,
not among the 334 audit-ledger findings. An adversarial completeness audit caught that, which is the whole
reason for running one.

1. **Avatar-circle images are served from `http://localhost:8080` in production.** The editor requests
   `http://localhost:8080/local-storage/avatar-circles/{projectId}/{uuid}.png`; the browser blocks it twice
   over, as mixed content and against `img-src 'self' data: blob: https:`. `getStorageAdapter.ts` has a
   guard that THROWS rather than fall back to local disk in production, so the live request path should not
   be able to construct this — which points at absolute URLs persisted during a local run and never
   rewritten. The bug CLASS is a documented past incident (`backend-api/src/config/publicOrigins.ts:5-6`:
   a missing public-origin var emitting a loopback URL to real browsers), so this may be a recurrence
   rather than a new fault.
2. **Simulation iframes are served from `pub-*.r2.dev` and blocked by `frame-src`.** This was PREDICTED —
   `md-files/LIBRARY-SHARE-MINISITE-PLAN.md` (the R2 guard) says `R2StorageAdapter.getSimPublicUrl` returns
   an origin that `rebaseSimPublicOrigin` will not rebase and `frame-src` will refuse, giving a blank
   iframe. A prediction in a planning document is not an open item, which is exactly how it reached
   production unnoticed. Note the plan's premise — "R2 is not the production writer today" — needs
   re-checking against what is actually being served now.

Both are under investigation on `fix/production-console-errors`. **The fix must not simply widen
`browserOrigins()`/`frame-src`**: that would widen who may frame EVERY simulation in the product, which is
a security decision rather than a config tweak. Routing sims through the API origin is preferred.

## 🟡 Delivered but previously untracked (recorded 2026-08-21 after a completeness audit)

The ledger is the index of what exists; work absent from it is work the next session cannot find.

- **PR #51 — 94 dubbing languages, a progress bar, and source-language exclusion.** Open and CI-green at
  the time of writing. The language table went from three codes to the vendor's full verified set;
  `PERMALINK_LANGUAGE_SUFFIXES` is now DERIVED from it rather than hand-maintained as a second copy (the
  same drift class as the two migration registries); migration **068** puts a source language on the
  project so the language the video is already in stops being offered as a paid target — a same-language
  dub is a full billable run returning a degraded copy. Belongs to Round A.
- **The two ideas volumes exist and were never recorded as delivered**: `md-files/FLOWVID-NEXT-STEP-IDEAS.md`
  (1,334 lines, product ideas) and `md-files/FLOWVID-EXPANSION-AND-GTM-IDEAS.md` (743 lines, GTM, strategy
  and niche expansion). They are reference material, not scheduled work — but a reader of this ledger alone
  would not have known they exist, which made them effectively invisible.
- **`localCaptureProvider.ts` is now tracked on `main`, and it arrived by accident.** R-07 ruled it stays
  out of this round because it belonged to the open export bug chain; it was swept into commit `f9414e6`
  by an over-broad `git add -A`. The ruling is amended rather than reverted: the export work it supported
  has since shipped (#44's GPU host, confirmed working in production), so the reason to withhold it is
  stale and removing it now would be churn. Recorded because a file that enters the repo by accident and
  is then silently kept is indistinguishable from one nobody noticed.

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
- `QUEUE_CROP_CONCURRENCY` stays 1. **Now measured and settled** — see the fleet audit above: six videos, no queue, so there is nothing to parallelise. Not a capacity limit.

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
- ~~**A P1 with no implementation:** `broll-data-001` (b-roll offsets anchored to
  `video_files.duration_sec`) — decided, no schema or code yet.~~ **Two corrections, 2026-08-21.**
  (1) The premise was already stale when it was written: migration **063** shipped D-01a's anchor
  (`anchor_video_file_id` + `anchor_offset_sec` + `placement_mode`), the one shared resolver
  (`shared/src/timeline/placement.ts`) behind the editor, viewer, export and prewarm, and the
  enqueue-time anchor for generated b-roll. (2) What was genuinely missing was **D-01b** — the
  three cases a media change can be — and that is on branch `fix/broll-anchor` (not yet a PR):
  migration **069** (`placement_impact_reviews` + the anchor FK moved SET NULL → NO ACTION), the
  cut-to-fit clamp in the transcode job **removed** (it silently rewrote authored `start_sec`/
  `end_sec` on every duration change), a replace now raising a review instead of clamping, and a
  video delete that refuses until the author chooses (never re-anchoring to "the next" clip).
  Follow-ups it does NOT close, from D-01a's own text: absolute `timeline_markers.at_sec` and
  manual avatar ranges keep the same drift class, and the review queue has API + delete-time UI but
  no standing panel in the editor.

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
- ~~235 ledger findings remain open and unverified (P2/P3-labelled, tail never adversarially read).~~
  **SWEPT 2026-08-22** — `.claude/review/LEDGER-VERIFICATION-2026-08-22.md` (823 lines). 164
  verdicts against the tail (71 ids are unadjudicated aliases and must NOT be bulk-closed by
  alias — four documented cases where the canonical's verdict does not carry). Split:
  **93 CONFIRMED · 65 ALREADY_FIXED · 6 REFUTED** — 40% of the tail was already dead, most of it
  closed by commits that name the finding id in a comment. Severity moved DOWN, not up: 2 P1,
  41 P2, 50 P3, with only two escalations. Actions: 22 fix-now, 69 schedule, 7 needs-owner,
  66 close. The two P1s are `job-queue-011` (rollback re-points `APP_VERSION` without checking
  out the matching tree, so the old image gets a queue name it does not know, exits 1, and
  crash-loops — while `wait_healthy` omits `worker` and calls the rollback healthy) and
  `test-quality-015` (`RumService.fieldAggregates` binds a raw `Date` into raw SQL; real
  Postgres rejects the string and a bare catch hides it, so field refinement is dead in production
  and six tests pass because PGlite serialises Dates itself). The largest single cluster is C1 —
  the media authorization gate knows exactly three key prefixes — six findings closed by one
  prefix-complete gate. **Caveat carried from the report:** code, tests and local probes only; no
  production was exercised, and §5 names the seven determinations resting on inference.
