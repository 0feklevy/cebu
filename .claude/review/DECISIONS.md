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

## 🟡 CROP v2 — the recompute trap is DEFUSED in code; only the delete-vs-implement ruling remains

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

**UPDATE 2026-08-23 (verified in code on main):** the dangerous half is closed. `algo.ts` now
carries `V2_IMPLEMENTED = false`; `cropAlgo()` CLAMPS a requested-but-unimplemented v2 to v1 (so
the version stamp, and with it every `crop_source_hash`, cannot change), and
`cropAlgoMisconfigured()` is wired into `server.ts` startup to say loudly that the variable is
being ignored and why. Tested in `crop/__tests__/algoV2Guard.test.ts`. What remains is ONLY the
owner ruling this entry always ended on: delete the flag/type/VERSIONS entry, or implement v2 —
and the implementing commit must flip `V2_IMPLEMENTED` in the same change.

## 🟡 OWNER ACTION (⅓ done 2026-08-23) — smoke variables: PUBLIC set, two remain

Found 2026-08-22 while checking whether the production audit shared the hole closed in the release
path. It does.

`SMOKE_PUBLIC_PATH`, `SMOKE_PLAYLIST_PATH` and `SMOKE_ADMIN_PREVIEW_PATH` are **not set** as
repository variables. Every fixture-dependent production check is written
`test.skip(!process.env.SMOKE_PUBLIC_PATH, …)`, so the daily **Production audit** has been running
green while skipping project pages, playlists and admin preview entirely. Three consecutive green
runs verified far less than they appear to.

**What to set (Settings → Secrets and variables → Actions → Variables):**
- `SMOKE_PUBLIC_PATH` — the path of a PUBLIC project with media, e.g. `/some-lesson-slug`
- `SMOKE_PLAYLIST_PATH` — a public playlist page path
- `SMOKE_ADMIN_PREVIEW_PATH` — an admin preview path

**There is currently no public project at all** — both sitemaps are empty — so this needs a
project made public before the first variable has a value to hold.

**UPDATE 2026-08-23:** `SMOKE_PUBLIC_PATH` is now SET — `/projects/d8e7557a-…/view`, the owner's
public project verified viewable anonymously during the avatar incident. The four
fixture-dependent production flows run again from the next audit. Two remain, both needing a value
only the owner has: `SMOKE_PLAYLIST_PATH` (playlists are share-token pages — need a token) and
`SMOKE_ADMIN_PREVIEW_PATH`. ALSO STALE BELOW: "releases will refuse to deploy" described #81's
behaviour; the release now computes `require_tests` from which fixtures EXIST (v0.1.39 deployed
with none set), so missing fixtures shrink coverage rather than block. The paragraph is kept for
the near-miss reasoning:

**Until they are set, releases will refuse to deploy.** That is deliberate and is the safe half of
a near miss: `--require-tests` makes a skipped release-blocking flow CRITICAL, and the post-deploy
gate turns CRITICAL into an automatic rollback — so without the early refusal, the first release
would have rolled back a perfectly healthy deploy over a missing configuration value. `plan` now
refuses BEFORE anything is deployed and names the variables (PR #81).

## 🔴🔴 OWNER-RANKED TOP PRIORITY — every API token and every dollar, visible in admin

Asked for directly on 2026-08-23, and ranked ABOVE routine debugging: *"מעקב צמוד על כל ה-API
tokens וההוצאות שיש בכל המערכת ב-admin mode"*.

It came out of a real incident. Four ElevenLabs Auto Top-Up invoices fired on 22 August — $10 at
14:43, $10 at 14:57, $10 at 16:14, $22 at 18:06, and a fifth $10 left Open at 00:27 on the 23rd.
The owner first read them as ₪31.81 usage charges; they are $10 top-ups at a 3.181 shekel rate,
which is why three of them look identical. **The spend itself was invisible in the product**, and
that is the finding: the money left the account and nothing in FlowVid could say what bought it.

### The gap, measured rather than assumed

`token_usage` is written from 14 modules and covers the LLM providers, dubbing, avatar and video
generation. It does NOT cover the paths below — every one of them calls a vendor that charges, and
none of them records a row:

| path | what it spends on |
|---|---|
| `podcast/audio/PodcastRenderer.ts` → `ElevenLabsDialogue` | **the whole episode's speech synthesis** — almost certainly the largest untracked line |
| `podcast/audio/previewTurn.ts` | one synthesis per preview click, unlimited and unmetered |
| `podcast/audio/revoiceTurn.ts` | one synthesis per re-voice click |
| `simulation/GuidanceService.ts` → `GuidanceTTSService` | guidance narration |
| `controllers/v1/audio.controller.ts` | on-demand TTS straight from a route |
| `podcast/PodcastVoiceService.ts` callers | voice operations on the render and preview paths |

The preview and re-voice paths matter beyond the accounting: a creator auditioning voices spends
real money per click, with no counter anywhere and no ceiling. That is the shape of the 22 August
burn — the owner was testing dubbing voices that afternoon, which is when the top-ups fired.

### What "close tracking" has to mean here

1. **No vendor call without a usage row.** A CONTRACT TEST that enumerates every module reaching a
   paid vendor host and fails when one of them records nothing — with today's gaps as an explicit,
   shrinking allow-list. Same shape as the env-var contract (#86/#94) and the typecheck ratchet
   (#90), and for the same reason: a gate that demands perfection on day one gets skipped.
2. **Characters and credits, not just tokens.** `token_usage` is shaped for LLM tokens. TTS bills
   per CHARACTER and dubbing per source-MINUTE, and forcing them into `input_tokens` would make the
   dashboard arithmetic wrong in a way nobody could see. The unit belongs in the row.
3. **An admin surface that answers "where did the money go".** By provider, by day, by user, by
   project — and it must reconcile against the vendor invoice, which is the only external check
   that the tracking is complete.
4. **A ceiling that covers every path.** `DUBBING_MONTHLY_BUDGET_CENTS` ($50 default, checked
   BEFORE the vendor call) protects dubbing alone. TTS has no equivalent, which is why an
   audition loop can spend without limit.
5. **The vendor's own view, for reconciliation.** `backend-api/scripts/dubbing-audit.ts` (read-only)
   lists every dubbing project in the workspace grouped by our `reference`, so duplicates are
   visible. The equivalent for TTS is the character-usage endpoint, not yet wired.

### Owner action, worth doing tonight

Put a ceiling on ElevenLabs **Auto Top-Up**, or turn it off. Auto Top-Up is the amplifier: any
runaway path spends without a natural stop, and the product-side ceiling only covers dubbing.

## ✅ CLOSED (#101) — the schema-failure log leaked the customer's value THREE ways

Found by the end-of-day verification pass on 2026-08-22, not by a report. The audit named one leak
on that line. There were three, and the second is the one worth remembering.

`LLMService.ts` logged `rawPreview: raw.slice(0, 300)` at WARN on every schema-validation failure —
the same defect as the ERROR-level site #91 closed, 300 characters instead of 800. But
`result.error.errors` is not structural either: for an enum or literal mismatch **Zod puts the
actual value in `received` AND interpolates it into `message`**. And that array was interpolated
into the thrown `AppError`'s message, which travels further than a log line — it is the 422 the
caller sees.

`describeSchemaIssues` keeps the half that is ours: which field, what the schema wanted, how many
options existed. `received`, `message` and `keys` are dropped, because the model authored all
three.

**Why #91's tests could not have caught it:** they drive never-valid-JSON fixtures, so they exercise
`logger.error` and are structurally blind to JSON that PARSES and fails the schema. The new test
uses valid JSON with a wrong enum value — precisely the shape that makes Zod echo the value back —
and asserts on `logger.warn` and separately on the THROWN error, because no log assertion would
have caught the third leak.
* ~~**The a11y group**~~ **COMPLETE (#102).** Five shipped on 2026-08-19; `ui-ux-006` — the editor
  timeline had no keyboard path at all — landed overnight. Each section now exposes three focusable
  sliders (move, trim-start, trim-end) driven by plain arrow keys, with NO modifier scheme: Alt+Arrow
  is browser back on Windows and Linux, so binding a trim there would lose the editor on a mistimed
  press. The keyboard calls `clampMove`/`clampTrim` — the drag path's own collision rules — because
  a second copy is how the two inputs start disagreeing about where a section may go.

* ~~**`observability-009`**~~ **CLOSED (#91 + #101).** The error-level site went first. The audit
  then found a WARN-level sibling, and that turned out to be THREE leaks: `raw.slice(0, 300)`, the
  Zod issue array (which carries the offending value in `received` and again inside `message`), and
  the same array interpolated into the thrown AppError — the 422 the caller sees. All closed; the
  describer keeps shape and drops every field the model authored.
## ✅ DIAGNOSED AND FIXED — a project that OPENS on a simulation showed nothing

Three rounds read this as a harness problem. It was two product bugs stacked on each other, and
both are now fixed with the evidence attached.

**Correction to the record, first.** The failure screenshot shows the VIEWER's chrome — FlowVid's
own avatar button and its "Ask!" button — over an empty frame. It is not the simulation's UI. The
earlier reading ("the simulation's OWN UI chrome — its buttons are drawn") is what sent two rounds
at the harness. And the scenario does NOT pass locally either: macOS WebKit fails it in ~2.5 s on
`realErrors()`, because the Firebase auth emulator is not running on that machine — a separate
environmental failure that had been masking the fact that the CI one was never reproducible there.

**Bug 1 — the section was never applied (#89).** `updateSimOverlay` is the only function that
applies a section and reveals the overlay, and every path to it required the timeline to have
MOVED: the `timeupdate` tick, a segment swap, or a seek. A viewer that requested playback and got
no frames had reached none of them. An instrumented boot logs no call to it at all. Fixed by
ticking in the `play` handler — `play` fires when playback is REQUESTED, so it fires even when the
media then fails to advance, which is precisely the case that had no recovery. Scenario 11b
reproduces it deterministically (play, then pause in the same synchronous block, so no `timeupdate`
can fire) and **passes on Linux WebKit in CI where it failed before**.

**Bug 2 — a negative playhead matched no section (#92).** #89 did not turn the job green, and the
enriched dump said why in one number: `currentTime: -0.04`, `played: []`, `readyState: 4`,
`buffered: [[0, 32.4]]`. An HLS stream demuxed from MPEG-TS carries the packager's presentation
timestamps, and they need not begin at 0, so the element reports a slightly negative time before
the first frame. `-0.04 >= 0` is false, so a section starting at 0 contained nothing. Fixed by
clamping in `playheadFromMediaTime`, beside `sectionAtPlayhead` in `lib/sectionInterval.ts`.

**What made the difference:** #87 put the video's `played`, `currentTime` and `error`, and the
iframe's ancestor chain, into the failure dump. Every previous round was inference from one
screenshot. `buffered` full with `played` empty is the whole diagnosis, and it took one red run to
produce once the dump could say it.

**User-visible reach beyond CI:** both bugs are engine-independent in principle. Any browser where
the first `timeupdate` is late shows a flash of the video's first frame before the simulation
appears, and any stream whose timeline starts before zero misses a section at 0 until the clock
crosses it.

## 📌 WHERE THINGS STAND — end of 2026-08-22

**Merged to `main` today:** #74 podcast source privacy · #75 media gate · #76 release gates ·
#77 wave 2 (writers'-room golden suite + podcast health metrics) · #78 A2.1 audio editions ·
#79 A2.2 listening surface + A2.4 Raise Your Hand · #80 A2.3 save-for-the-drive ·
#81 candidate-gate artifact path.

**Open:** #82 (webkit disproof + failure instrumentation) · #83 (a missing fixture must not block
a release) · #84 (crop v2 guard).

**Production is still on v0.1.39.** Two release attempts, both stopped before deploying:
1. `candidate-smoke` could not find the manifest — a relative path in a job that runs one
   directory down. The gate refused rather than guessing, deploy skipped, containers untouched.
   Fixed in #81, with a string check for the whole class.
2. `plan` refused because the SMOKE_* fixture variables are unset — a check I had added an hour
   earlier, which was the wrong half of a real trade-off. Fixed in #83: the gap is now warned
   about loudly and the flows with no fixture are excluded from the post-deploy requirement, so
   nothing blocks and nothing rolls back.

Nothing has been deployed and nothing is broken. The gate has done exactly what it exists to do,
twice, on its own first outings.

**The three things waiting on the owner**, in order of cost of delay:
1. **Delete and re-upload the exposed podcast document.** The code fix is merged; a URL that was
   already shared stays valid regardless.
2. **Set `SMOKE_PUBLIC_PATH`, `SMOKE_PLAYLIST_PATH`, `SMOKE_ADMIN_PREVIEW_PATH`.** Needs a public
   project to exist first — both sitemaps are empty. Until then every release deploys without
   verifying project pages, playlists or admin preview, and says so in its run summary.
3. **Check the ElevenLabs custom-voice quota** before the dubbing accent fix reaches production.
   Each language now takes a voice slot; running out makes dubs FAIL rather than degrade.

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

### THE GATE'S FIRST LIVE RUN, 2026-08-22 — it blocked the deploy, and it was right to

Release run 32580801013: `candidate-smoke` FAILED → **deploy SKIPPED, publish SKIPPED, production
containers untouched on v0.1.39.** Fail-closed demonstrated in production rather than argued for.

The cause was a bug in the gate itself, not in the images. The workflow sets
`defaults.run.working-directory: podcast-saas`, so every `run:` step starts one directory down,
while `actions/download-artifact` writes relative to the workspace ROOT — a relative
`artifacts/manifest.json` looked in `podcast-saas/artifacts/` and found nothing. The job then did
exactly what it promises when it cannot identify the candidate: refused.

Fixed in PR #81, which also adds a string check for the whole class — the trap waits for every
future step added to that job and costs a full image build to discover. Verified: `candidate-smoke`
was the ONLY job with the problem; every other one already reads through the absolute `$ART`.

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
avatar spend, D-17 knowledge gates, D-01b follow-ups, ~~the WebKit `__CHILD` re-key~~. Mostly P3 with
bounded blast radius. **This wave has no finish line and is not meant to have one** — pull from it
when a related area is already open, rather than working down the list.

* **WebKit "STALE evidence" flake — root-caused and fixed same day (#130).** Three hits on
  2026-08-23 (twice on #126, once on #129 — the release-blocking one), all on diffs that never
  touched the viewer. The freshness check judged child reports against a fixed 120ms; on CI WebKit
  under software GL the PARENT samples every 150–300ms, so every report aged past the bound between
  samples — environment starvation misread as a blocking sim body. The bound now scales with the
  sampler's own observed cadence (max(120ms, 4× median inter-sample gap)); a blocking body on a
  healthy runner is still caught, and the failure message names the bound and the median gap.
* **WebKit `__CHILD` re-key — CLOSED as already-done, 2026-08-23.** The re-key is implemented in
  `viewer-e2e.spec.ts`: the map stores BOTH keys (`el.src` resolved at message arrival, plus the
  posting `Window`), and `waitForSection` reads src-first with the Window lookup kept as fallback
  (lines ~434 and ~543). Evidence it worked: the WebKit viewer e2e job passed on every CI run today
  (e.g. 7m41s green on #121's and #122's runs) — the same job whose scenario-11 timeout, twice
  reproduced at 20s AND 45s, motivated the re-key. Closure kind: verified in code + green CI, not
  owner-attested.

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

## 🟡 Work queue — re-audited 2026-08-22, and the ledger was wrong in BOTH directions

The previous version of this section said the 13 `fix-now` findings were "ALL CLOSED". A file-by-file
audit against the actual tree says: eleven of them are closed and verifiable, **one closure was
reported for work that was never done**, and **one gate was reported closed while nothing in CI has
ever invoked it**. Separately, two clusters listed here as outstanding were quietly finished days
ago, so the queue also under-reported progress.

A ledger that is stale in the optimistic direction is how a hole stays open. Both directions are
recorded below, because the corrections that make the list look better are the ones that buy the
credibility for the corrections that make it look worse.

### ✅ Verified closed — evidence, not commit messages

| item | closed by |
|---|---|
| C4 `broll-player-002` / `broll-data-008` | `shared/src/timeline/overlayStack.ts` `stacksAbove`, called from both `resolvePlan.ts` and `useProjectPlayer.ts`; `overlayParity.test.ts` green |
| `simulation-009` | `simRuntimeChild.ts` captures the activation identity at call time; `simRuntimeActivationIdentity.test.ts` green |
| `simulation-008` | `posterService.invalidate()` — deliberately reachable from the publish path only; the GC hazard was correctly not added |
| `media-003` | `beginFrameBackend.ts` reports `canvasRegion`; `sanityGate.ts` suspends the animation check for canvas-free sims |
| `job-queue-013` (the NEVER_INLINE half) | `pgBossDriver.ts` `CPU_BOUND_JOBS`, asserted equal to the `QUEUE_CONCURRENCY === 1` set |
| LLM trio `-007` / `-011` / `-016` | `ClaudeProvider.ts` cache-control, `LLMService.ts` shared preamble, `ScriptRoom.ts` ratio floor |
| Ship trio `-005` / `-010` / `-013` | `conductor.ts` reads the review decision, `argGuards.ts` rejects non-finite numbers, `assertLocalDatabase` beside `assertLocalStorageOnly` |
| `performance-005` | `simulations.controller.ts` refuses before the heap fills, citing the finding by name |

### 🔴 `job-queue-014` — reported closed; the gate was never wired, and 140 errors accumulated

`tsconfig.test.json` exists. `typecheck:test` exists in `backend-api/package.json`. **Nothing has
ever run either** — not `ci.yml`, not `release-verify.sh`; grep both and the result is empty. So the
finding was marked closed on the strength of a config file that no build executes.

Meanwhile the drift the finding exists to stop carried on: **140 type errors across 51 test files**,
in a repo whose production sources type-check clean. Vitest executes TypeScript without checking it,
so every one of those files still passes.

**Now gated, as a ratchet rather than a clean assertion** (`deploy/scripts/typecheck-tests-ratchet.sh`,
wired into the static-audits job). Nothing may get worse: a clean test file may not acquire an error,
a dirty one may not acquire more, and the per-file baseline in `backend-api/.typecheck-test-baseline`
is expected only to shrink. Demanding zero today would mean 140 judgement calls in one pass and a red
build people learn to skip.

**Still open:** 81 as of end-of-day (140 at freeze, minus #98's fixtures and #99's typed
captures). What remains is the judgement-call set — `TS2339` property access on `unknown` and
`TS2352` casts, each needing a decision on whether the cast hides a real defect. (Original text,
for the record: dominated by `TS2493` (indexing a mock's
empty-tuple capture), `TS2352` (a cast through `undefined`), `TS2339` — so they are tractable, but
each needs a judgement about whether the cast is hiding a real defect.

### ✅ `job-queue-015` / `backend-008` — CLOSED for real this time (#96)

Corpus ingest is on pg-boss. Registered across all nine coupled points — JOB_NAMES, JobPayloads,
the handler registry, PGBOSS_JOB_NAMES, QUEUE_OPTIONS, QUEUE_CONCURRENCY, singletonKeyFor,
compose's WORKER_QUEUES and the two test sample-payload maps. The queue suite caught four of them
before I did.

**`retryLimit: 1`, because the retry budget here is set by a vendor bill.** An ingest of an audio
corpus runs a paid speech-to-text pass. One retry buys the case the queue exists for — a deploy or
a crash mid-ingest — without turning a permanently broken source into a small recurring bill.

**And a retry is nearly free**, because `ingest` now returns immediately when the row is already
`ready` WITH content. A durable queue re-delivers a job whose completion it never saw, which a
deploy makes routine, and without that short-circuit a lost acknowledgement is a second invoice for
bytes already in the row. The condition asks for the status AND the content: a row marked `ready`
with empty `extracted_md` is a partial write, not finished work.

The two dead Trigger.dev files that made this look done are deleted (#95).

### 🟢 Corrections in the other direction — two clusters were finished and never recorded

* ~~**The a11y group**~~ **COMPLETE (#102).** Five shipped on 2026-08-19; `ui-ux-006` — the editor
  timeline had no keyboard path at all — landed overnight. Each section now exposes three focusable
  sliders (move, trim-start, trim-end) driven by plain arrow keys, with NO modifier scheme: Alt+Arrow
  is browser back on Windows and Linux, so binding a trim there would lose the editor on a mistimed
  press. The keyboard calls `clampMove`/`clampTrim` — the drag path's own collision rules — because
  a second copy is how the two inputs start disagreeing about where a section may go.

* **D-16 crop is not "blocked at the first step".** Thirteen hand-labelled clips exist under
  `backend-api/scripts/crop-eval/labels/`, a field eval has run, and its result is marked quotable —
  it is what surfaced the `CROP_ALGO=v2` no-op recorded above. Below the 20–50 clip target, but the
  measurement loop exists and works. The P2 detector work has not started.

### Still open, unchanged

* ~~**`media-009`**~~ **CLOSED (#94).** The capture container was capped on CPU, memory, pids,
  tmpfs scratch and wall clock — every dimension except the one it fills. Ten minutes at 1080p30 is
  18,000 JPEGs and nothing compared that to the disk. It refuses before starting now, against both
  a per-capture ceiling and the free space, and an UNMEASURABLE filesystem does not refuse — the
  ceiling still applies, so an absurd request is refused either way.
* ~~**`observability-005`**~~ **CLOSED (#95).** Thirteen call sites, including the failure line.
  The file had ALREADY imported pino, at line 18, and used it elsewhere — the console calls were an
  inconsistency inside a file that otherwise logs properly, which is how they survived. The two in
  `R2StorageAdapter` went with them. `isolation/main.ts` keeps its console calls deliberately: it
  runs INSIDE the capture container, where there is no pino and stdout is the transport.
* ~~**`observability-009`**~~ **CLOSED (#91 + #101).** The error-level site went first. The audit
  then found a WARN-level sibling, and that turned out to be THREE leaks: `raw.slice(0, 300)`, the
  Zod issue array (which carries the offending value in `received` and again inside `message`), and
  the same array interpolated into the thrown AppError — the 422 the caller sees. All closed; the
  describer keeps shape and drops every field the model authored.

* **`observability-010`** — **verified, and deliberately NOT deleted.** `initSSE` is reached only
  from `_archive/v1-podcast-pipeline`, and `SSEEmitter` survives as a type on
  `CorpusBuilder.ingest`'s optional third parameter, which no live caller passes. Deleting it would
  break the archive's imports, and the archive exists to be readable. The accurate statement is
  that this system has no live SSE surface — worth knowing before anyone builds one on top of it.
* **D-14 avatar spend** — **two of three parts are BUILT**, and the ledger said "No code". Measured
  2026-08-23:
  * ✅ **atomic reserve** — `reserveAvatarSpend` in `usage/AvatarBudgetService.ts`, a single
    `INSERT … ON CONFLICT … DO UPDATE … WHERE` so Postgres holds the row while it decides. Wired
    into `avatar.controller.ts`, and it denies with a status, a `Retry-After` and a `deniedBy`.
  * ✅ **async observer** — `sweepAvatarMeter`, run by `scheduleSweep` after the response and
    throttled once per process per interval, so housekeeping never sits in a request's latency.
  * ✅ **client wiring** — **PR #121** (2026-08-23). `shared/src/avatar/denial.ts` owns the wire
    shape both ways: three coarse public reasons (busy/limited/unavailable — the limiter DIMENSION
    stays in the operator log, asserted off the wire), copy generated from the enum, and
    `parseAvatarDenial` REGENERATING it on read so a valid `reason` is never a licence to render
    the server's string (ui-ux-205 kept by construction). `explain` is opt-in per call site — the
    quiet degradations (`NONE`, `NO_IMAGE`, `{ok:false}`) keep their success shapes. The popup
    disables Try-again for exactly the server-named wait, then gives it back. Found and fixed on
    the way: **the kill switch reused the capability body** — an operator pulling the stop
    produced a 503 explained as "Avatar capability required". All claims mutation-checked; the
    one untested line is flagged in-code (reconnect denial copy — no harness makes a live
    connection-lost event). **D-14 is now complete end to end; enforce is no longer blocked on
    the client.**

  `AVATAR_BUDGET_MODE` stays `shadow` deliberately — the same posture as the new account-wide
  `SPEND_CEILING_MODE`, and for the same reason: a limit that refuses on a number nobody has
  watched is a limit that takes something down.

* **D-01b follow-ups** — ~~`timeline_markers.at_sec` absolute-only~~ **CLOSED (#118)**: markers now
  carry the same segment anchor 063 gave b-roll, resolved through the same function rather than a
  second copy of the rules. The standing review panel still does not exist.
* ~~**D-17 knowledge/retrieval gates**~~ **CLOSED as empty, 2026-08-23.** The ledger never recorded
  which findings this covered, which is the whole reason it lingered — an entry that names no work
  cannot be finished, only re-read. Both plausible members are fixed and verified in code:
  `security-009` (a knowledge document could be deleted across groups) now refuses with
  `avatar.controller.ts` logging "refused a knowledge-document delete for a document outside this
  project group", and `performance-002` (unbounded corpus upload) is bounded by a declared-size
  check plus a spooled read against `UPLOAD_MAX_BYTES.corpusSource`.

  Removed rather than left open. **An item whose scope was never written down is not a backlog
  entry, it is a worry** — and a list that keeps them teaches the reader to skim, which is how the
  real entries around it stop being read.

* **Production storage census** (`deploy/scripts/storage-census.sql`, read-only) — **owner action**.
  It unblocks retention, rollup and poster GC, and no result exists anywhere in the repo.

* ✅ (same day) #127-review cross-signal CLOSED in #132: ALL SEVEN `avatar_config` writers now
  funnel through the sanitizer — including the main PUT rebuild (which reflects VENDOR fields via
  `enrichAvatarConfigFromAnam`'s `||` and could store the exact poison the read seams survive),
  the knowledge-upload merge, project duplication (a copy never inherits poison) and the
  tag-circle-voices script. A jsonb CHECK constraint remains optional belt-and-braces; the typed
  chokepoint exists without a migration.
* 🔴 **PROD INCIDENT (open): /avatar/start returns 500 — owner-reported 2026-08-23** — full debrief draft: `INCIDENT-2026-08-23-avatar.md` — **MECHANISM CRACKED + reproduced: wrong-typed avatar_config field → statusless TypeError → bare 500 pre-vendor; fix = #127 (sanitize at both seams); v0.1.42 (diagnostic+admin key) deploying, v0.1.43 (the fix) right behind**

  * v0.1.42 did NOT deploy: candidate smoke failed one step past #103's cd fix —
    `${BACKEND_IMAGE}` is a compose REQUIRED variable and its per-step env block existed only on
    the stack-start step, so the migrate step died on interpolation and the deploy was skipped
    (run 32640689308). Fixed in **#129** ($GITHUB_ENV export from the resolve step; contract
    suites 84/84). Escape hatch if smoke blocks again: images are pushed BEFORE the smoke, and
    rollback.yml deploys by tag — a "rollback" TO the new tag bypasses the smoke path entirely.
  * The reconnect-denial line in #121 got its harness (avatarReconnectDenial.test.tsx) — the
    in-code "no harness produces a live connection-lost event" note is now false and removed. from their own
  browser console (`api.flowvidco.com/api/v1/avatar/start` → 500, body `Avatar session failed`,
  twice). Diagnosis so far, all from outside the VM:
  * `/health` and `/health/ready` are green (DB 2ms, queue empty) — the server itself is fine.
  * Anam's API answers from here (401 fast, unauthenticated) — the vendor is not down outright.
  * The 500 text `Avatar session failed` is produced ONLY by the start handler's catch for
    `status >= 500`, and the mint passes the VENDOR's status through verbatim
    (`anamService.ts` — `err.status = minted.status`). Network error → 502, timeout → 504, so a
    plain 500 means **Anam itself answered 500 to the mint POST**, or a statusless throw — and the
    statusless candidates are nearly all swallowed (`getPersona` → null, `resolveDefaultLlmId`
    caught), leaving `res.json()` on a 200 as the only thin one.
  * The deciding evidence exists in two places we cannot reach from a dev machine: the VM log line
    `[Anam] session-token request failed {status, code}`, and the owner's Anam dashboard
    (credits/plan banner). Owner is running `anam-probe.sh` (repo root) — auth check + minimal
    mint with their key, statuses only.
  * NOTE: prod runs the OLD build (release blocked at the VM pin), so nothing recently merged is a
    suspect; equally, no code fix can reach prod until that pin is resolved.
  * CORRECTION (later same day): prod is NOT on an old build — release v0.1.39 deployed
    successfully 2026-08-22 10:57Z; the VM-pin memory was stale. v0.1.40/41 failed only the
    candidate-smoke `cd` bug (#103 fixed it). Further probes with the owner's key ruled the vendor
    OUT: every real persona (6/6), 26KB prompts, dead references — all mint 200 from outside; prod's
    pre-mint path answers 400/404 correctly. The 500 is inside the mint block, server-side only.
    Owner asked for the VM log line + failing project URL; owner placed the working key at the
    repo root (now gitignored) for remediation — INCIDENT-AVATAR-500.md has both scenarios.
  * Fallout shipped: #122 (main was RED — #115 merged on a cancelled CI run, no-useless-assignment;
    same class as #102), #123 (vendor-5xx ephemeral retry + the start catch now logs a bounded
    shape-only diagnostic — during the incident a statusless throw left no log line at all).
  * NOT a finding after all: the "leaked" CANDIDATE_FIREBASE_CREDENTIAL in the release logs is a
    per-run synthetic key that authenticates nothing, and main already masks it line-by-line.
  * ROOT DESIGN GAP FOUND (owner suspected it first): `getSystemKey`'s provider union never
    included 'anam' — the admin key screen managed four vendors and the avatar read only the
    container env, so rotating the key in the screen built for that changed nothing. **PR #125**
    fixes it end to end (migration 075 widens the enum in both registries, resolution order
    BYOK → admin key → env, project-less path included, admin-web row, admin-v1 widened).
  * INTERIM BROWSER-ONLY FIX handed to owner (works on deployed v0.1.39): enable BYOK in
    admin → paste the working key in user settings (AnamKeyField) → owner's videos mint with
    the owner's key. A monitor watches /avatar/start for recovery.
  * Still open pending the VM log line: WHY the env key draws a 500 (not 401) from Anam —
    revoked-key-of-live-account vs deleted-account are the candidates; garbage keys give 401.
  * CI fallout fixed in the same wave: #122 also carried a test that silently required a live
    local Postgres (guidanceSpendMetering — resolveGuidanceVoice reads admin_settings through
    the real db client; green with `docker ps`, red in CI). Mocked at the module seam, proven
    with an unroutable DATABASE_URL.

## ⚪ Known and accepted

- Public-bucket HLS: revoked shares keep working until C1's STEP 3+4 cutover ships (see the
  ruling block above — this is now the same item).
- ~~The WebKit e2e lane is non-blocking and flaky by measurement; scenario 11 is the one
  consistent failure~~ — **no longer true as of 2026-08-22**: scenario 11 was two stacked product
  bugs, fixed in #89/#92, and the lane ran 39/39 green on main's own CI the same day. Kept struck
  through rather than deleted so the contradiction with the ✅ section above cannot recur silently.
- 71 sweep ids are unadjudicated aliases — never bulk-close by alias; four documented cases where
  the canonical's verdict does not carry (`dependency-008`, `security-012`, `media-011`,
  `simulation-004`).
- Sweep caveat: code, tests and local probes only; §5 names the seven determinations resting on
  inference and the one cheap observation that settles each.
