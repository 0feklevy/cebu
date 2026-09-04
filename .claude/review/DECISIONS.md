# Open decisions

**State as of 2026-09-03 (night).** Production runs **v0.5.1**, deployed 21:04Z
(`refs/deployed/production` = `fe0139c`) — every PR through #187: the night run, the next phase,
the v0.3.0 layout fix, the Questions removal, Tap to ask interactive, the portable-setup panel, its
own UX follow-ups, and the CORS hotfix below. Release dispatch changed hands the same evening —
see the standing constraints below. This was the first release dispatched under that change, and
it taught a second lesson the same night: dispatch and deploy **approval** are different
authorities, and a risk-gated file (`publicOrigins.ts`) correctly stopped the hotfix for a human
click even though I was the one who dispatched it.

Within minutes of v0.5.0 going live the owner reported Tap to ask broken in production with a
browser console CORS error — root-caused, fixed in #187, and **confirmed live against production**
the same night (see the ✅ CLOSED incident entry below for the exact verification method).

The two plans of record are `NIGHT-RUN-2026-09-03.md` (outcome in its §11) and `NEXT-PHASE-2026-09-03.md`
(outcome in its §8); both are indexed below.

**The previous version of this header said v0.2.11 "was dispatched on 2026-08-26 and never
deployed".** True when written (a GitHub Actions outage cancelled that run) and false four days
later: it was re-dispatched on 08-30 and deployed. The header is corrected here, and the rule it
keeps re-teaching stands — a state sentence names the moment it describes, and a release updates it.

An earlier version of this paragraph said "nothing sits merged-and-unshipped", written minutes
before #158 and #159 merged. It was true when typed and false within the hour, which is the same
mistake as the four-day-old header it replaced, at a smaller scale: a state sentence is only as
good as the moment it describes, so it now names the version in flight rather than claiming the
queue is empty.

v0.2.10 carried thirteen PRs (#142–#154) after production had sat on **v0.2.7 for four days** — not
because anything was wrong with the code, but because the release pipeline could not deploy. Two
separate bugs pointed the same way and each made the other harder to see:

- **The human-approval job crashed before it could ask** (fixed, #152). It reported as an
  unanswered approval, which is indistinguishable from a refused one unless you open the job log.
- **`release-risk` measured from the last TAG, not the last DEPLOY** (fixed, #143). `v0.2.8` and
  `v0.2.9` are tagged and were never deployed, so a tag-based diff compared against code that had
  never shipped.

`refs/deployed/production` now exists and points at the deployed commit, so the next release
measures its risk window against what is actually running.

**The previous version of this paragraph said production ran v0.1.38 and listed #57–#60 as
unreleased.** It had been wrong for four days, and it is the first thing any reader of this file
sees. That is the same failure the entries below keep recording in other forms: work whose status
was written once and never revisited. The state header is now part of what a release updates.

The 2026-08-21→22 closed round — v0.1.36→38, the fleet audit, the CSP defects, D-13, D-01b,
D-20…D-23, and the sweep's entire fix-now queue — is CLOSED, its per-item verification record
living in git history (the ledger's own commits across PRs #48–#69), which is where
closed rounds belong rather than in an ever-growing archive file. The verification sweep itself is
`LEDGER-VERIFICATION-2026-08-22.md`: 164 verdicts, 93 confirmed, of which 10 are now fixed.

Last updated: **2026-08-26**, after v0.2.10 deployed and the post-release audit closed its findings.

---

## 📋 2026-09-04 — Heavy-sim day: kinesin/dynein integration proven, no-loading reveal shipped, Library/section-editor minimalism, sim-subsystem review findings

**Branch `feat/library-minimal-ui`** (one PR, all of the below; opened for release the same day).

**1. Kinesin/Dynein 3D sim (external, 35MB, 29.7MB single GLB) integrated and battle-tested against the sim subsystem — zero backend gaps found in the happy path.** Upload (30MB zip, 202/287ms) → static ui-controls scan (7/7) → mechanical minimal-UI bridge (187ms, no LLM) → real opus bridge generation (26s, confidence 0.94, ~9.5k tokens of context out of 726K chars of package — selectSources' minified-excerpt budgeting worked exactly as designed) → edit iteration with conversationHistory → replace flow (SimBridgeContract compat gate passed) → revision activate/retire ×5. Full v2+v3 wire battery ALL PASS; 6 concurrent WebGL docs @60fps; same-frame poster capture verified. Durable record: `~/Desktop/Kinesin and Dynin/flowvid-integration-kit/README.md` (includes the CGTrader browser-delivery **licensing gate — still open, blocks public deploy of the kinesin GLB only** — and the dynein RCSB attribution that must return before public dynein delivery).

**2. Owner-critical invariant implemented: a sim section can NEVER reveal into a video while its 3D models are still loading.** Two halves: (a) packages may export `window.__flowvidReadyForPresent` (thenable factory); the child runtime's wrapped-legacy `present` now awaits it (bounded 4.2s, under `SIM_PRESENT_TIMEOUT_MS`) before acking `SECTION_PRESENTED`, so the player's poster covers any remaining download — absent hook = old behavior byte-for-byte (`simRuntimeChild.ts`, backward compatible, all three hermetic suites re-fixtured and green on all engines). (b) The kinesin package's `sim.js` exports the hook + a managed prepare that loads the full motor. Verified live under cold-cache 40Mbps: `SECTION_PRESENTED` arrived only with the complete assembly (screenshot at ack: no chip, no overlay).

**3. Owner UI/UX batch (all seven items).** Library shows only Videos+Simulations until Images/Sound have content; whole-panel drop now also routes video files (autoFiles added to VideoUploader); Extended is icon-only; Videos card trash/re-upload no longer overlap; export's routine per-section "no poster still exists" warnings collapse to one summary line + console.warn (consent Copy-all still hands over the full text; `exportPanelViewport.test` updated + new collapse suite); Settings right panel regridded to packed flex columns (Smart Crop no longer stretched, Collaborators invite no longer overflows); section editor's "This moment" reduced to prompt + two toggles with controls-picker/Reuse/Guided/Last-generation behind a new Advanced disclosure (diagnostics also go to console.warn; low-confidence alert stays visible; tour steps merged into one `sec-sim-advanced` step). 10 test files updated to the new UX — intent preserved, full client-web suite 131 files / 1,980 tests green.

**4. Cross-browser/device sweep (owner ask):** 42/42 combinations (chromium/firefox/webkit × phone-portrait/landscape/tablet×2/laptop×2 × home/public-viewer, + authenticated editor) — zero horizontal overflow, zero page errors. Sim renders on firefox (32fps headless-software GL, no errors) and webkit (61fps); weak-device emulation (6× CPU, DPR3, `lowend=1`) 60fps with the heavy background auto-shed by the new sim.js device-hint handling.

**5. 🔴 OPEN — sim-subsystem review findings (simulation-reviewer, run `.claude/review/runs/2026-09-04T1507/`), NOT fixed in this branch:** (P0) `R2StorageAdapter.getSimPublicUrl` bypasses `/sim-public` entirely — on the R2 backend, serve-time CSP/boot-snippet/publication-gate are all skipped and draft revision bytes are world-readable; the `.glb` redirect also lands on `/hls-proxy` which 403s `simulations/` keys. (P1) `SIM_PREPARE_TIMEOUT_MS=5000` has no per-package override and `sim_revisions.metadata.weight` feeds no residency/budget decision. (P2) `db/jsonb.ts` double-encoding breaks `ProjectDuplicationService.ts:2170` and the `049_sim_posters` CHECK; `runtimeValidated` is written and never set true/read. Owner decision needed on scheduling the P0.

## ✅ CLOSED (verified live 2026-09-03 21:14 UTC) — Tap to ask was CORS-blocked in production, v0.5.0; fixed in #187, deployed as v0.5.1

**Reported by the owner from their own browser**, minutes after v0.5.0 deployed: a full console
dump showing VAD working, speech detected, then
```
Access to fetch at '.../voice-question/stream' from origin 'https://flowvidco.com' has been
blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```
Tap to ask — the flagship feature of today's release — does not work at all for any listener.

**Root cause.** `POST /api/v1/public/audio/:slug/voice-question/stream` (added in #181) is the
only route in the entire backend that calls `reply.hijack()`. `@fastify/cors` sets
`Access-Control-Allow-Origin` via `reply.header()` in an `onRequest` hook — Fastify's own
abstraction, which only ever reaches the wire through Fastify's own send pipeline. `hijack()`
exists specifically to skip that pipeline, so the header the plugin computed was never silently
wrong — it was computed correctly and then never sent. Every other SSE route in the app
(`src/lib/sse.ts`'s `initSSE`, used by the script-generation and guidance streams) writes its own
`Access-Control-Allow-Origin` directly because it never routes through `reply.header()` either; this
route did neither — it set the SSE headers on `reply.raw` by hand but never added the CORS one.

**Why nothing caught it before shipping.** `audioEdition.voiceStream.test.ts` (written same day as
#181) exercises the route with a hand-built `reply` object whose `raw.setHeader` just records
whatever the handler calls — it could not have caught a header the handler never calls, because it
never modeled `@fastify/cors` at all. Seven Playwright/vitest suites and a release gate all passed,
because none of them run a real browser against a real cross-origin request; the loopback e2e
suite's "real app" is same-origin.

**Fix (#187).** `hijackedReplyCorsHeaders(origin)` in `config/publicOrigins.ts`, beside
`browserOrigins()` (the single source of truth `@fastify/cors` itself reads): reflects the request
Origin when it's in `browserOrigins()`, adds `Vary: Origin`, set on `reply.raw` before `hijack()`.
Verified three ways, because a mocked test agreeing with itself is exactly the failure mode that
shipped this bug: a real-Fastify-plus-real-`@fastify/cors` integration test
(`hijackedReplyCors.realFastify.test.ts`) reproduces the incident with the fix removed and confirms
it resolves with the fix present; a controller-level test drives the actual route handler through
four origin scenarios; a unit test pins the helper against the plugin's own allow/deny logic. Also
removed two imports (`askListenerQuestion`, `listener_questions`) this file no longer needed since
#184 — dead since that PR, not since this one.

**Closure kind: verified live, not owner-attested and not "tests pass."** #187 merged, the owner
approved the risk-gated deploy (this file touches `publicOrigins.ts`, and the automated risk plan
flagged `requiresHuman: true` — see the standing constraints section on why dispatch and approval
are different authorities), and v0.5.1 deployed at 21:04 UTC. At 21:14 UTC I sent the EXACT request
from the owner's bug report — a `POST` to
`https://api.flowvidco.com/api/v1/public/audio/unlocking-the-secrets-of-effective-communication/voice-question/stream`
with `Origin: https://flowvidco.com`, the same multipart shape the real client sends (`audio` +
`position_ms` + `language` fields, confirmed by reading `audioEditionApi.ts`) — against the live
server, not a test double. The response:

```
HTTP/2 200
content-type: text/event-stream
access-control-allow-origin: https://flowvidco.com
vary: Origin
```

followed by a clean `event: done` frame (`status: "nothing_heard"` — correct: the probe was 0.3s of
silence, so it cost a fraction of a cent of STT and nothing else, no LLM or TTS call). A browser
making this exact request now receives a response it is allowed to read. The incident is closed on
this evidence, not on the deploy succeeding — a deploy succeeding only means the container started,
a claim this project has been burned by conflating with "the feature works" before ([[merged-is-not-shipped]]).

**Report to confirmed-fixed-in-production: under two hours**, and almost none of it was
investigation — the root cause, the fix and its three layers of verification were written before
the first release run had even reached the human-approval gate. What took the time was the
pipeline's own deterministic gates (a 14-minute verification job, twice) and the wait for the
owner's approval click.

## 📋 NIGHT RUN 2026-09-03 — plan of record, rulings, and PR index

**The plan:** `.claude/review/NIGHT-RUN-2026-09-03.md` — seven owner-ordered items (branch
hygiene, open rulings, vertical video, podcast car mode, the "?" help, import gallery + posters +
library speed, the storage/scale decision), each with design, files, acceptance and tests, ending in
release v0.3.0. Read it before touching any of those areas; this entry is only the index.

**Housekeeping (done, verified against GitHub):** #163 squash-merged, #164 merged after taking
`main` into it; every other remote branch proven fully in `main` by `git merge-tree` against the
merged state; `backup/audio-landing-orig` and `recovery/P7-stash-2026-08-04` archived as
`archive/*` tags and deleted (their content re-landed via #78/#79/#139 and migration 081
respectively); merged branches deleted; four stale worktrees pruned. Also recorded here because it
was missing: **PR #161** (2026-08-30, `794064a`) gave the public library page sim-poster banners,
keyword search and a full-width responsive grid — its reasoning lived only in the squash message.

**Rulings by delegated authority (owner instruction 2026-09-03: "answer the open decisions").**
Each takes the recommendation already recorded unless a measurement contradicted it:

| # | Item | Ruling |
|---|---|---|
| D1 | Crop v2 — delete or implement | **Keep, guarded; closed.** It is the lever the YuNet plan (P2.8) flips; `V2_IMPLEMENTED=false` + clamp + warning + test make it inert. |
| D2 | C1 #1 `/sim-public/*` policy | **Scoped tokens (`t/{token}/`), as recommended — its own round after this run**, together with the sim-asset cache work, or it is done twice. |
| D3 | C1 #3 bucket cutover to proxied URLs | **Superseded.** Never proxy bytes through the VM; the plan's §7 answers the same security goal with signed URLs on a CDN-fronted zero-egress bucket. |
| D4 | A2.3 option (1), SW kill-switch narrowing | **Not now.** Car mode keeps plain `<audio>` + Media Session; "Save for the drive" remains the explicit offline path. |
| D5/D6 | Video dedup; revision dedup (FIX C) | Unchanged — owner-deferred / owner-declined. |
| D7 | "Publish release job reported skipped" | **Closed by evidence:** v0.2.10 and v0.2.11 are published, not drafts. |
| D8 | P3-A item 1, `/admin` under the app domain | Open, owner-approved, not in this run — recorded so it is not lost. |
| D9 | Podcast plan §7 (provider, mic UX) | **Chained STT→LLM→TTS with on-device Silero VAD; realtime vendor deferred** — plan §4. |
| D10 | `prepare` on the transaction pooler | **`prepare: false`** (Supabase docs require it for postgres-js in transaction mode). |

**Policy:** only commercially-usable open source may enter the product — the allow/deny list is
`.claude/reference/stack.md` §8, mirrored in `PROTOCOL.md` rule 8, `review-fixer` rule 9,
`dependency-auditor` item 7 and `CLAUDE.md` §8.

**PR index (appended as each opens):**
- #165 docs — this plan, the rulings above, the licence policy, the ledger header (`docs/night-2026-09-03-plan`).
- §3 vertical video — migration 082 (`video_files.width/height`, displayed geometry), one derived `orientation`, portrait HLS ladder, portrait export grid, crop skipped for portrait sources, editor preview + filmstrip cell + settings + lesson page follow the frame, library/playlist tiles contain a portrait banner, portrait poster identity, b-roll/thumbnail/sim-prompt follow orientation, backfill script; real-ffmpeg portrait cases in both real-encode suites (#166, `feat/vertical-video`).
- §4 podcast car mode — `/{slug}/audio` rebuilt as a full-viewport dark player (artwork, title, bar, three transport buttons, ASK, STOP; chapters/typed question/save in a sheet); hands-free loop on an on-device Silero VAD (ISC/MIT, served from /vad/): speech pauses the episode, the question is transcribed (Groq), answered through the SAME typed path and cap, spoken (ElevenLabs, device voice as fallback), and the episode resumes after 3 s of silence; barge-in and follow-ups; ASK = push-to-talk / stop / hold to toggle; `POST /public/audio/:slug/voice-question` (bounded, rate-limited, `nothing_heard` never touches the cap); the listener contract moved to `shared/src/audio/listener.ts`; `editions/` known to media access so local dev can play an edition (#167, `feat/podcast-car-mode`).
- §5 the “?” — every walkthrough moved to `lib/tours/steps.ts` typed on one anchor registry (`lib/tours/anchors.ts`; components spread `tourAnchor()`, so a step at nothing is a compile error and an anchor nobody points at is a red test); the editor tour reordered by importance and covering the import gallery, flags, the music track, the three share addresses + podcast, export and vertical video; Settings gains Dubbing (its anchor had no step for weeks); the section tour gains the Minimal-UI control picker; the viewer gains a `?` shortcuts overlay; the “Guided Tutorial” preference now actually gates the auto-run; `GuidedTour` warns in development when a step’s target is missing; the dead `HowItWorksDialog` deleted (#168, `feat/help-coverage`).
- §6 import gallery + posters + library speed — posters are captured in the CREATOR’S BROWSER (a `SNAPSHOT` message on the authoring channel: the sim hands over its canvas, the editor letterboxes it into the poster sizes, `POST /projects/:id/sections/:sid/poster` files it under the identity the player looks up — one function, `sectionPosterKey.ts`, now shared by player, export and capture; store + invalidate land together, the pairing simulation-008 named); the import gallery is a full-screen surface of stills from ONE request (`GET /simulations/importable`), live only on Play/expand, imports 3 at a time; library tiles get the compact rendition with declared sizes, the overlay shows the poster at once and clears on `SIM_PAINTED`, tiles prefetch the entry on pointerdown; poster objects are served straight from the bucket (`immutable`, no 302); a served REVISION’s text assets are read/hashed/injected once per process (`simTextCache`), legacy keys never cached (#169, `feat/import-fullscreen-posters`).
- §7 scale, phase 1 — the DECISION (plan §7): keep Supabase Postgres (28 fixed connections, every hot path indexed; a migration moves the database and leaves a 2-vCPU box doing the same work), move public bytes to a zero-egress CDN-fronted store in a phase 2 runbook that needs the owner’s account, take the app tier off the byte path. CODE tonight: `prepare: false` on the app pool (D10); LISTEN/NOTIFY refused on a transaction-pooler URL; the two uncached admin_settings reads on player-config cached 10 s with invalidation on the admin write; `users.last_seen_at` written at most once per 5 min per user instead of per request; every `/api/` response without a Cache-Control gets `no-store` (the discipline a CDN in front of the API needs); a per-IP ceiling (120/min) on the anonymous viewer reads that had none; the playlist play-config fan-out bounded to 4; `GET /projects` capped at 500; `branch_path_events` gets a 90-day retention sweep; the orphan-blob sweep repeats every 6 h instead of running once at boot (#170, `perf/scale-phase-1`). C1 #3 (bucket cutover to proxied URLs) is superseded by this entry.
- #171 fix — the task-tracker audits of §5 and §6, answered: a mount test per anchored surface (`tourAnchors.*.test.tsx`, with `tourSurfaces.test.ts` forcing every registered anchor to be claimed by one) — the dropped-anchor rot that stayed green under mutation is red now; `HowItWorksDialog.tsx` deleted for real (the #168 line above said it was, and it was not); tour steps for branching (new `branching` anchor on the editor button), raise-your-hand and playlists, and a home-page walkthrough (`HOME_STEPS`, `home-projects`/`home-playlists`, a "?" beside New project); Fastify-inject tests for `GET /simulations/importable` and `POST …/sections/:sid/poster` asserting the identity `sectionPosterKey` predicts and the store→invalidate order; the ten dead imports the poster refactor left; and, from the §4 audit's correction, a route-level suite for `POST /public/audio/:slug/voice-question` (per-IP key and limit, public-only, no-file 400, the multipart fields into the service, the response shape, a real 413 through the bounded temp file, the 502 that leaves playback alone) and the info route's `artwork_url`. §7's audit found every item DONE at the merged tip. Recorded, not changed: the 4 MB per-rendition cap, the 10-minute text cache, the session-scoped capture throttle (plan §11).
- #172 hotfix — **v0.3.0 shipped with every `min-[…]:` / `max-[…]:` variant disabled.** Owner-reported in production the morning after: the editor rail "messed up", Export / Preview labels gone, the import gallery neither full-screen nor above the editor. Root cause, verified by compiling a probe through both configs: #167's `theme.extend.screens.landscape` with a `raw` media query makes Tailwind refuse the arbitrary min/max variants (it can no longer order the screens), so 22 classes across ProjectHeader, VideoEditor, BrollPanel, BranchingModal, PlaylistEditorDialog and PlaylistViewer produced no CSS — and `landscape:` itself fell back to the built-in orientation variant, so the podcast page took the phone-sideways layout on every desktop. Fix: the screen removed, the car-mode player on an arbitrary `[@media(orientation:landscape)_and_(max-height:560px)]:` variant, and the import gallery portaled to `<body>` so no ancestor stacking context can trap it (that part was a second, independent defect). Guard: `tailwindResponsiveVariants.test.ts` compiles the real config and goes red if a variant stops emitting or a screen carries `raw`. Why the gates missed it: no test compiles the stylesheet, and the release smoke has no fixtures (§9 item 3) so no page was looked at after the deploy. Dispatched by delegated authority — the owner's instruction in the report ("restore the layout and release").
- #173 fix — the share library's banners and first paint (the ✅ CLOSED entry above; plan `NEXT-PHASE-2026-09-03.md` §0b). Also carries the owner's post-deploy report and rulings (the 📋 OWNER REPORT section) and the next-phase plan itself.
- ✅ CLOSED in #173 (was 🔴, owner-reported on v0.3.0) — **Share library: simulation tiles show no captured poster, and the overlay loads slowly.** Mapped with file:line evidence (plan `NEXT-PHASE-2026-09-03.md` §0b): the only capture was the section editor's, 1.5 s after a section's preview loaded, so a simulation never re-opened since v0.3.0 — or never placed in a section — could not have a picture, and every failure was swallowed; the prefetch named a URL the frame never requested (no `?dpr=`); pre-gate packages waited the full 2.5 s painted-signal timer; legacy packages were excluded from the text cache. Fix: a simulation-level poster route (identity = the simulation's default presentation; the library looks up by package revision), an editor banner sweep (`useBannerSweep.ts`: one offscreen frame at a time for every ready simulation without a banner, 12 per session, failures counted and shown, a "Banners" button forces all), `poster_url` on the listings, a fallback to a RETIRED revision's poster (served once, never a candidate — the 2026-08-30 ruling stands), the prefetch resolved like the frame, a serve-time SIM_PAINTED fallback in the boot snippet two frames after load when the gate is absent (client timer 2.5 s → 1.2 s), and a 30 s legacy text cache evicted by prefix on every in-place writer (Replace, upload, guidance). Tests: route (simulation identity, listing poster_url), retired-revision fallback, the snippet run in a sandbox, legacy cache + eviction, the sweep hook, the prefetch href.
- #174 ops — **release retention + disk guard** (owner priority 2; plan `NEXT-PHASE-2026-09-03.md` §2). `retain_app_images` in `_lib.sh`: after every healthy deploy keep the release just deployed and the one before it, remove every older `podcast-saas/{backend,client-web,admin-web}:<tag>` (never `-f`; an in-use image refuses; nginx/certbot/volumes/env untouched); `retain-images.sh` for the by-hand case; `require_free_disk_gb` refuses a deploy under 8 GB free on `/var/lib/docker` before any pull (`DEPLOY_MIN_FREE_GB`, `DEPLOY_ALLOW_LOW_DISK=1`), in both `deploy-images.sh` and `deploy.sh` (the latter used to warn only); the post-deploy audit's `vm.disk-low` is HIGH under 3 GB, WARNING under 8. NOT in the git-only sync script — its tested contract is docker-free. Guard: `deploy/scripts/__tests__/lib.test.sh` (a docker/df shim on PATH; 18 checks), run by CI's static audits. Closes the 🔴 ops item in the OWNER REPORT section.
- #175 feat — **the listener-question creator inbox** (owner priority 3; plan §3). Migration 083 (additive: `source`, `creator_reply`, `creator_replied_at`, `seen_at`, a partial index for the public read); the spoken path stores `source: 'voice'`; routes: the creator list with a status filter, a cursor, and the chapter the listener was in; a summary for the badge; PATCH reply (empty clears; 2000 chars); POST seen; and `GET /public/audio/:slug/replies` — only rows WITH a reply, public projects, per-IP limited, a minute cacheable — so an anonymous listener gets the reply where they asked. Client: `ListenerInboxDialog` (unanswered/all, the moment, the chapter, typed/spoken, the language, the model's answer folded, one reply box), a "Questions" button with the unanswered count in the project header (a failed summary read never breaks the header), and in the car-mode player a marker per reply on the progress bar plus a "Replies" sheet. Tests: 13 route cases, the dialog, the player's replies, the contract check. Closes plan §11's "creator-facing list of listener questions" deferral.
- #176 ops — **storage reconciliation (dry-run), the abandoned-multipart sweep, the delete-GC gaps** (owner priority 4; plan §4). `StorageService.listMultipartUploads` on both S3 adapters + `lastModified` on heads; `services/storage/reconcile.ts` (pure classification, a rule per family, never-delete list); `pnpm storage:reconcile` dry-run by default, deletes only with `--apply --delete --older-than=` through the chokepoint; `multipartSweeper` daily, a week's grace; project delete sweeps `dubs/{videoId}` and `editions/{projectId}`. Owner: run `--family=multipart` then `--family=all --json` on the VM before any apply.
- #177 feat — **R2 readiness** (owner priority 5; plan §5; stacked on #176). `pnpm storage:probe -- --backend=r2|supabase` (the capability matrix of a NAMED provider); `MigratingStorageAdapter` (`STORAGE_BACKEND=migrating`, primary/secondary, refuses a half window); `R2_PUBLIC_BASE_URL`; `pnpm storage:rewrite-urls` (dry-run; only where the object exists at the destination). Owner: the R2 token with write/list/multipart, run the probe, paste the matrix; then the §5 runbook.
- #183 feat — **a saved setup travels between projects** (owner: save the whole minimal-UI / auto-script / bridge configuration under a name, and on load take the original simulation and attach its files too — "like duplicate but between projects"). The pieces existed and the path did not: Load setup was DISABLED on a section with no simulation, `/fit` answered 400 there, and the "Bring the simulation too" button lived inside a dialog that section could never open — so a fresh project needed the import gallery, by name, first. Now: `/fit` answers for a section with no simulation and says whether the package can come along and what that would do; `/apply` takes `bring_simulation` and imports → attaches → applies in ONE request; the 409 (script does not fit) still leaves the package attached and says so, so the recipe path regenerates against it. Migration 084 records `simulations.imported_from_simulation_id`, so a second load reuses the first copy instead of minting another row — and the bytes were already deduplicated by the blob store (migration 080), which is what makes "nothing is stored twice" a fact. A section that already has a simulation is NEVER swapped. Decision logic is a pure module (`portableSetup.ts`) with its own tests; the routes have theirs.
- #182 fix — **the section script panel, redesigned** (owner: it is unclear and messy). The card was a light-only amber island in a themed editor, its title was jargon ("AI Script Generation · Extended Thinking"), the Minimal-UI picker hid behind a grey 11px "Advanced" link, and ONE button meant two different things — write a script with AI, or mechanically hide controls — decided silently by whether the prompt was empty. Now: theme tokens throughout (both cards, via one `cardStyle`), a title that says what the card is for, two NUMBERED optional steps (describe it · choose the controls) with the picker promoted to a full-width row carrying "N of M kept" and a label that does not rename itself on click, and a line above the button that states the outcome before it is pressed, with the button words matching. The reuse row is named "Reuse this setup" and its buttons and dialogs read Save setup… / Load setup…. **Refresh banner is gone** (owner ruling): the capture still happens from the preview, silently.
- #181 feat — **Tap to ask, interactive** (owner ruling: like NotebookLM's interrupt). The answer is STREAMED: the model writes plain text, a sentence splitter cuts it at real boundaries (never inside "e.g.", a decimal, or before a lowercase continuation), each finished sentence is synthesised and sent as its own SSE `audio` event, and the client plays them back to back — the listener hears the first sentence while the model is still writing the third. The microphone now stays OPEN through thinking, the answer and the silence window (`RELEASE_MIC` fires only on the way back to OFF), so speaking over the answer interrupts it and a follow-up needs no second tap. Same guards and the same ledger as the one-shot path: per-IP limit, public-only, the 30 s and 2 MB ceilings, record-before-answer, the daily cap, the ElevenLabs ceiling asked once, one TTS spend for the whole answer. A closed socket aborts the model call. Text-only (a ceiling refusal or a vendor outage) still speaks, through the device voice.
- #180 chore — **UI cleanups by the owner's rulings**: the creator inbox (#175) reverted wholesale — routes, client methods, dialog, header button, car-mode replies — with migration 083 and its four columns kept (applied on production; unused, nullable); the Banners button and status removed (the sweep runs silently); the import gallery a ~92vw × 90vh panel with a dimmed backdrop, full-screen only on phones.
- #178 feat — **playlist → publish as course** (owner priority 6; plan §6). `PlaylistCourseService` on the dormant schema and API: created once, linked by `courses.legacy_playlist_id` (now the live link), lessons follow the playlist's items in order, the existing readiness-gated publish; routes on the playlists controller; `PlaylistCourseSection` in the playlist editor. Closes the 🟡 below.
- ✅ CLOSED in #178 (was 🟡) — **Courses have no creator UI.** `courses.controller.ts` (create, slug, lessons) and the public `/c/[courseSlug]/[lessonSlug]` pages exist; nothing in `client-web` calls the create routes. A walkthrough cannot point at what is not there. Either build the creator side (playlist → "publish as course") or retire the routes; owner's call (plan §9).

## 📋 OWNER REPORT 2026-09-03 (after the v0.3.0 deploy) — production state, closures, and the rulings for the next phase

Everything in this section is **owner-attested** (the owner ran it on production and reported the numbers);
nothing here was re-derived from code, per the owner's instruction not to reopen completed diagnostics.
The plan built from it is `NEXT-PHASE-2026-09-03.md` (indexed at the end of this section).

### Closed by the owner, on production

- ✅ **Video-dimension backfill (§9 item 8) — done.** Dry run found 5 legacy videos without geometry; apply wrote 4
  (1916×1080, 1280×720, 1920×1080, 1920×1080 — all landscape, 0 portrait). One remains unresolved because
  `ffprobe` reports no geometry for the file: video `292ea47d-8df5-47b5-8661-04f63c40b68c`
  ("vidssave.com But how did proteins evolve to be so complex_ 720P.mp4"). **Ruling: do not invent dimensions for
  it**; investigate separately only if needed. The script exits 1 while any probe fails — that exit is not a
  rollback of the four writes (the writes are per-row and committed). 🟡 small follow-up: make the exit code say
  "N written, M unresolved" instead of failing the whole run for one unreadable file.
- ✅ **Production disk emergency — resolved.** The VM was at ~94% (`/` 3.6 GB free): Docker/containerd retained
  every historical release image. The owner deleted the older FlowVid/Cebu image IDs and their GHCR digest refs,
  keeping v0.3.0 (backend, client-web, admin-web), v0.2.11 as the rollback set, every image backing a running
  container, nginx and certbot. After: 58 GB total, 16 GB used, 42 GB free (28%); 8 images, ~7.2 GB; 6/6
  containers healthy. ~2.9 GB shows as "reclaimable" and is the retained rollback — **do not prune it blindly.**
  → 🔴 ops item below: retention must be a policy in the deploy, not a manual rescue.
- ✅ **Read-only DB census — done.** Database total ≈ 27 MB. No database-size problem; some tiny tables have
  high dead-row percentages, not a capacity concern. Cleanup CANDIDATES the census enumerated (candidates for a
  dry-run reconciliation tool, **not** permission to delete): 18 terminal exports with no `output_key`; 7 ready
  exports whose `sections/` may be redundant; 3 failed duplications with a surviving plan (orphans enumerable);
  4 videos with both inline captions and a captions storage key; avatar references that can leak on project
  deletion (2 project rows with sim prefixes, 6 with image keys).
- ✅ **Full bucket census (LIST + HEAD against the live Supabase S3 bucket) — done.** 3,200 objects,
  10,799,246,594 bytes (~10.30 GiB), 0 objects of unknown size. By prefix: `dubs/` ~3.21 GiB / 878 objects;
  `exports/` ~3.12 GiB / 7; `hls/` ~1.93 GiB / 1,513; `videos/` ~1.73 GiB / 4; `podcasts/` ~183 MiB;
  `images/` ~45.7 MiB; `simulations/` ~41.8 MiB; `avatar-circles/` ~17 MiB; the rest small. **Reading:**
  storage volume is modest; an R2 move is about delivery/egress architecture, not a 10 GB crisis.
- 🟡 **4 unfinished multipart uploads, 81 stored parts, reported part bytes 0.** Not aborted. Ruling: inspect keys
  and initiation timestamps first (the zero may be an API reporting limit, not proof nothing is billable); if
  clearly abandoned, add a safe **age-based multipart-abort sweep** rather than a one-off manual clean.

### Owner report, afternoon 2026-09-03

- ✅ **Anam key rotated** (owner-attested). The 🔴 HIGH item below is closed.
- ✅ **v0.4.1 deployed**; `storage-reconcile` ran on production, DRY RUN, and reported: 4 open multipart
  uploads (two `_selfcheck/` probes from June/July, two `videos/027d8277…` parts from 2026-07-06 that no
  `video_files` row names); thumbnails 4 orphan + 5 redundant (~2.4 MiB); captions 10 orphan + 5 redundant
  (VTT backups for rows whose captions are inline); crop 5 orphan; exports clean (7, ~3.05 GiB); videos 4
  objects all referenced + ONE dangling row (`videos/431df510…/2d81d995….mp4`); podcasts 69 orphan
  (~87.6 MiB); images/avatar 10 orphan (~20.6 MiB); dubs (878, ~3.13 GiB), editions, playlist-banners clean.
  **Ruling given** (in chat, restated here): abort all four multipart uploads; delete the thumbnails,
  crop, avatar, captions and podcasts orphans/redundants with `--older-than=7d` after (a) nulling
  `captions_vtt_key` where `captions_vtt` is inline and (b) a glance at the podcasts key list
  (`previews/` or deleted episodes only); the dangling video row is a DB repair (delete if it never
  finished uploading, otherwise send the row) — never a storage action. Nothing under `videos/`,
  `hls/`, `editions/`, `blobs/`, `exports/`.
- **Rulings on the product (owner):** the Banners button goes (the sweep stays, silent); the import
  gallery is a ~90% panel like Video settings / the Extended Library, not the whole screen; the
  creator inbox ("Questions") is NOT wanted — feature and functions removed; **Tap to ask must work
  like NotebookLM's interrupt** — ask by voice in real time, hear the answer as voice only, resume
  the episode after a few seconds of silence, and be able to barge in on the linear audio.

### Rulings (owner, 2026-09-03)

- **R2 — YES, staged.** R2 is the media-storage direction; production is NOT flipped now. `R2StorageAdapter`,
  `SupabaseStorageAdapter`, `StorageService`, `getStorageAdapter` and the R2 env names already exist on the
  production backend, and code comments say the R2 token may be read-only with Supabase the writable provider.
  Sequence: audit the R2 bucket/account/token → verify write/delete/list/multipart permissions → run the existing
  storage round-trip probe against R2 in a controlled configuration → design an explicit staged migration (not
  merely `STORAGE_BACKEND=r2`) → preserve rollback/read compatibility while objects move → verify public HLS/sim
  URLs, CORS, cache headers, multipart and server-side copy → only then change production writes. "Do not migrate
  merely because R2 variables happen to be present."
- **Courses — YES, deliberately narrow.** V1 is `Playlist → Publish as course → /course/lesson`. Reuse the
  playlist/lesson/media/simulation infrastructure and the dormant `courses` / `course_lessons` schema (no live
  rows). Creator UI scoped to "Publish playlist as course", not a course-management product. Closes the 🟡
  "Courses have no creator UI" above (decision taken; work in the plan).
- **Listener questions — YES, higher priority than courses.** Build the creator inbox:
  `Listener → question → Creator Inbox → answer`. Minimum: unanswered/answered, project/lesson context,
  timestamp, text or audio question, creator response. Keep it simple. Closes the "creator-facing list of
  listener questions" deferral in plan §11.
- **Priorities for the next phase, in order:** (1) credential rotation, (2) permanent Docker release retention +
  low-disk guard, (3) listener-question creator inbox, (4) safe storage-orphan reconciliation tooling (dry-run),
  (5) staged R2 readiness, (6) narrow playlist → course publishing.

### The owner queue, restated (supersedes plan §9)

- ✅ (owner, afternoon 2026-09-03) **Anam credential rotated.**
- 🟡 Smoke variables `SMOKE_PUBLIC_PATH`, `SMOKE_PLAYLIST_PATH`, `SMOKE_ADMIN_PREVIEW_PATH`: set only to real
  production pages expected to stay valid (a dead path rolls back a healthy deploy). Real public playlist/test
  URLs were created during earlier production work — use those, do not invent routes.
- 🟡 Demo avatar "Max session length" — check.
- 🟡 Paid dubbing probe (~$2.20) — useful; **not without explicit approval**.
- ⚪ Crop-eval dataset (20–50 clips) — deferred; evaluation work, not a blocker.
- ⚪ Previously shared document — re-upload only if continued access to the old URL is sensitive.
- ✅ Backfill, DB census, bucket census, disk cleanup — done (above).

### Ops item the owner wants implemented

- 🔴 **Docker release retention + disk guard in the deploy.** Keep the current production release and one
  previous rollback release; remove older local application image references safely after a successful
  deploy/health gate; never touch running images, persistent volumes, nginx/certbot data or environment backups.
  Add a low-disk warning/refusal before deploy so a >90% VM fails early.

### Adversarial audit of the seven rulings (2026-09-03, before #183 merged)

An audit agent re-checked all seven of the afternoon's UI/feature rulings against the code rather
than against my account of it. Five were clean. It found four gaps, and chasing the first one down
found a fifth that the audit had also passed:

- 🟢 **A brought simulation never reached the picker.** `VideoEditor`'s `onSimulationUpdate` was
  `prev.map(...)` — a REPLACE. Two of its three callers hand up a simulation the project has never
  seen (the load dialog's Import button, and a setup bringing its own package), and a replace drops
  those silently. Fixed by extracting the rule to `client-web/lib/simulationList.ts` (`upsertById`)
  with its own tests, because both spellings compile and only one is right.
- 🟢 **The whole feature was unreachable in its primary case.** Found while writing the test above:
  the "Reuse this setup" row lived inside `{simId && (…)}`, so on a section with NO simulation the
  Load button did not render at all — the one case the portable setup exists for. The row is now its
  own card outside that gate, and says what Load will do when the section is empty. **The audit did
  not catch this**: it verified the button's `disabled` prop no longer names `simId` and stopped
  there. A prop check cannot see an enclosing gate; only rendering it can.
- 🟢 **The two switches were the redesign's leftover fragment.** Simple UI / Auto Script sat
  unnumbered under the numbered steps and were the only part of the card painted in a hardcoded
  light-only amber wash, so they broke in dark mode. They are now step 3 · Apply them, on theme
  tokens.
- 🟢 **`askQuestion` was dead code the owner had asked to delete.** The typed-ask client function
  survived the Questions removal with zero callers. Deleted with its tests; the tour step that still
  advertised "✋ Raise your hand" is rewritten to describe the voice interruption, and the tour test
  now asserts the removed phrase is ABSENT.
- 🟢 **Two untested behaviours, now pinned.** The import dialog's backdrop-click (closes; refused
  mid-import) and the script panel's third outcome state (controls, no prompt → "No AI, no cost").
- 🟢 **`setPresets(r.presets)` had no guard.** The hand-maintained client contract means a backend
  that stops sending `presets` throws inside render and takes the editor down. Now falls back to an
  empty list.

### A UX review of the redesigned panel, after #183 merged (#185)

I asked the ui-ux reviewer to read the panel as a first-time creator would, against the owner's
own words ("really unclear, messy and problematic"). It found things the tests could not:

- 🟢 **Escape closed the whole section editor while a setup dialog was open.** Both dialogs are
  portaled to `<body>`, so the editor's window-level listener heard their keystrokes: backing out
  of "name this setup" shut the panel behind it. Escape now closes the topmost thing, and focus
  returns to the button that opened the dialog.
- 🟢 **The numbering told a lie — mine.** I labelled the two switches "3 · Apply them", but the
  apply is the button BELOW them, which carries no number. A reader following 1-2-3 thought they
  were finished one control early. It reads "3 · How it behaves" now: three numbered inputs, then
  the action.
- 🟢 **One setting, two names.** "Simple UI" on the toggle and "Minimal UI" in the note four lines
  above it. A test asserts "Minimal UI" appears nowhere in the card.
- 🟢 **"bridge" was still leaking into what the author reads** — an aria-label and the regenerate
  sentence, beside dialogs already renamed to "setup".
- 🟢 **Two identical amber cards read as one card continuing.** "Reuse this setup" takes its own
  accent.
- 🟢 **The status surfaces were light-only.** The error box, the low-confidence warning, the
  confidence badge, the keep/hide badges and the regenerate offer were hardcoded pastels — pale
  blocks stamped into a dark editor, worst exactly where a reader most needs to trust the text.
  `--success` and `--warning` join `--destructive` in `globals.css`, all three with dark values,
  and these surfaces use them with translucent washes.
- 🟢 **The switches said nothing to a screen reader** — now `role="switch"` with `aria-checked`.
- 🟢 **The outcome line repeated the button.** "AI writes the script" above "✦ Generate with AI"
  spent a line on nothing; it now says what the button cannot — that it uses AI and counts against
  the generation limit — which mirrors "No AI, no cost" on the other branch.

A verification pass over the PR then found three of its own claims incomplete, all fixed in it:
the last "Minimal UI" survived in a picker state the default view never renders (an empty scan);
the regenerate box had been made dark-safe with a literal amber rather than the new `--warning`;
and the focus restore was implemented but untested — and the test, once written, FAILED. The
capture was in an effect, and the dialog's own autofocused field takes the focus before a parent
effect can look, so it was restoring to an input that had just unmounted. It captures at the click
now.

Not done, recorded rather than lost: the setup dialogs still have no focus TRAP (Tab reaches the
editor behind them), and the file's remaining hardcoded colours outside these two cards are
untouched.

✅ **CLOSED by #184 — the typed-question backend surface.**
`POST /api/v1/public/audio/:slug/questions` and `GET /api/v1/projects/:id/questions` are removed.
The first was public, unauthenticated and spent the project owner's LLM budget by design; with no
caller left it protected nothing. `listener_questions` and `ListenerQuestionService` STAY, and that
part is load-bearing: `askListenerQuestion` records every SPOKEN question, before answering it, and
the voice routes call it exactly as the typed route did.

**Migration 083's four columns are a different case, and the first version of this entry blurred
them together.** `source`, `creator_reply`, `creator_replied_at` and `seen_at` were the inbox's
columns; with the inbox gone they now have no reader and no writer anywhere in `src/`. They are
kept because dropping a column is a contract migration against the previous image, they cost
nothing while nullable, and a creator-facing view of what listeners ASKED BY VOICE is a plausible
thing to want later. Dormant, not load-bearing — do not cite them as evidence the feature is alive.

Three assertions replace the removed suite: each path is no longer registered, and the voice route
through the same service still answers.

## ✅ CLOSED (2026-08-30) — gate v5 reached every stored simulation, and the documented way to do it was wrong

**Closure kind: owner-attested, with numbers.** The owner ran the reinjection on production:
**9 ready simulations, 7 updated, 2 already current, 0 skipped, 0 failed.** A second pass reported
**all 9 unchanged**, which is the idempotency claim in the script's own header verified rather than
assumed. Every stored package now carries the current gate — the residue open since v5 shipped is gone.

**The documented command did not work, and its error named nothing useful.**
`pnpm --filter backend-api sims:reinject-gates` assumes a dev machine. On the VM there is **no Node
and no pnpm at all** — everything runs inside the `backend` container — and inside that container the
package script's env-file flag names a path that does not exist, because the app is not laid out
there as the repo is. The configuration is already in the container's environment, so that file was
never needed; only the script was:

```
docker compose exec backend pnpm --filter backend-api exec tsx src/scripts/reinject-sim-gates.ts [--apply]
```

Now recorded in the script's own header beside the local form, with the production numbers. The
generalisable point: **an ops runbook written from a dev machine is a guess about the VM.** This one
had been a guess since the day it was written, and the first operator to follow it lost time to an
error about a missing file that mentioned nothing about containers.

## ✅ CLOSED (2026-08-30) — the Load-bridge round: three PRs, and six defects an adversarial review found in them

**Closure kind: verified in code, mutation-proven, and driven in a real browser.**

**#162 — Load bridge (owner: "the screen goes black and the simulation stops working").** Two
defects, both reproduced live before fixing. (a) A cross-sim load silently POSTed to
`generate-sim-script/stream` — an unrequested LLM spend that regenerates a bridge for the WRONG
simulation from the preset's minimal prompt; that fragile path is the black screen. It now applies
only the MECHANICAL parts, keeps the sim rendering, and offers regeneration as an explicit
"uses AI" button. (b) A byte-identical load republished the whole package (revisions 1→2). Now a
no-op, keyed on BYTES — not on `judgeBridgeLoad.sameContent`, which rides the legacy
`simulations.bridge_hash` column a revisioned sim never advances, so it is structurally blind on
the modern path. Measured after: same-sim 2→2 revisions, 0 LLM calls; cross-sim 0 LLM calls, sim
still rendering.

**#161 — the public library page** gained sim-poster banners (reusing stored `sim_posters`, zero
bytes written), keyword search (a pure client-side function), and a full-width responsive grid on
the existing design tokens.

**#160 — four contract fields** widened to bare `string` over closed database enums, tightened to
real unions. Typecheck passed unchanged across six workspaces, which is the evidence nothing was
relying on the looseness.

**THE REVIEW IS THE POINT OF THIS ENTRY.** A six-dimension adversarial pass (36 agents, every
finding facing three independent refuters) found six real defects in work that was already green:

1. **HIGH — a sole-emitted b-roll video wore the MAIN video's frame.** Thumbnails are extracted
   from a non-b-roll video, so a failed main + ready b-roll left the b-roll as the only emitted
   video wearing a different video's picture. Probe-verified with a live PGlite seed.
2. **MEDIUM — a poster of a never-published revision could banner.** Poster objects live OUTSIDE
   the `revisions/` prefix, so the status gate that keeps unactivated revision BYTES private never
   covered them — and the canary stores posters for candidates before activation, which
   newest-first ranking then prefers. Now filtered to the served revision's identity.
3. **MEDIUM — the missing-poster-table guard was invisible to every test.** Deleting the `.catch`
   left all 16 green, because the suite always runs every migration. Same silently-absorbed-read
   shape that shipped the audioEdition wrong-table 409s.
4. **MEDIUM — the aspect-preference test asserted seed order, not the rule.** PGlite returns
   insertion order and the wide poster was seeded first, so it passed with the ENTIRE ranking
   deleted.
5. **LOW — the aria-live count region was mounted with its first content**, which assistive tech
   does not reliably announce.
6. **LOW — my own #160 hand-copied a `ProjectStatus` union that already existed**, with a comment
   claiming it was the only statement — the exact sin #160 was written to fix. Consolidated to the
   zod-derived type; the fallout exposed `HomeSidebar` carrying a dead `has_videos` key while five
   real statuses rendered with no label, and one more string-widened field (`PlaylistItem.status`).

Every fix mutation-proven: each was shown red when reverted, then restored.

**The lesson, and it is not a new one here:** two of these six were defects the tests NAMED and
could not SEE. Green suites plus green CI plus a careful agent report are still not evidence — the
only thing that separated them from shipping was an independent pass that read the code and ran
probes against it.

## What is actually open, in full

A post-release audit on 2026-08-26 walked every request of the preceding days against the code
rather than against PR badges. Everything it found is either closed below or listed here. There is
no third category, and that is the point — the audit exists because "merged" and "in the product"
turned out to be different claims.

**Needs the owner, or a machine this one is not:**

1. ~~**`sims:reinject-gates --apply`, from the VM.**~~ **DONE 2026-08-30** — 9 ready simulations,
   7 updated, 2 already current, and a verifying second pass reporting all 9 unchanged. Every
   stored package now carries gate v5. See the closed entry above for the container-only
   invocation the original runbook got wrong.
2. **ADR measurements M1, M4 and M5** — recorded in `ADR-ACTION-RECORDING-SEMANTICS.md` as needing
   a running stack or a real browser, and all three belong to Phase 1, which is not built.
   **M3 is RULED (2026-08-30): a 30-minute draft TTL**, bounded by `GC_MIN_AGE_MS` (1h) — Phase 1
   builds the table with it. M2's byte half is measured.
3. **Owner's own queue:** rotate the Anam key, decide the max session length. The two smoke
   variables are deliberately still unset — see the ruling below.

**Deliberate rulings, not gaps:**

- **Four browser suites are not per-PR gates** — canary, leak, protocol, rebuilt, each carrying
  900–1500s timeouts because they are soak tests. They belong to a scheduled job. The rule that
  keeps this honest rather than convenient is in `ops/release`: every Playwright config is either
  wired to a workflow or named with the reason it is not.
- **Video dedup stays 🟡 OPEN BY DECISION** (see below) — deferred by the owner, not overlooked.
- **Content-addressed revision dedup (FIX C) is DECLINED for now** (owner, 2026-08-30). The
  unchanged-load no-op already removes the duplication the owner actually hit; what remains is
  duplication on a GENUINE change, and removing that needs a manifest-driven serving layer plus GC
  refcounting, piercing the revision immutability invariant. Revisit with a storage measurement,
  not a hunch.
- **`SMOKE_PLAYLIST_PATH` and `SMOKE_ADMIN_PREVIEW_PATH` stay UNSET, deliberately** (2026-08-30).
  The fixture gate WARNS rather than blocks precisely so a missing fixture cannot hold a release —
  and an unset variable EXCLUDES its flow from the post-deploy requirement, while a variable
  pointing at a wrong or stale fixture makes that flow RUN, FAIL, and turn CRITICAL, which the
  post-deploy gate converts into an automatic rollback of a healthy deploy. Guessing a value is
  therefore strictly worse than leaving it empty. They want a real production playlist share token
  and a real admin preview path; only the owner can supply those, and until then the gap is loud
  and recorded rather than silently green.


---

## ✅ CLOSED (found 2026-08-25, fixed 2026-08-26 in #152) — the human-approval gate could never ask; it crashed before the prompt

**Closure kind: verified in code and against the failed runs.** Reported to the owner for two days
as "a release is waiting for your approval". Nothing was waiting. The `Human approval (risky
release only)` job died in its first step:

```
##[error]An error occurred trying to start process '/usr/bin/bash' with working directory
'/home/runner/work/cebu/cebu/podcast-saas'. No such file or directory
```

`defaults.run.working-directory: podcast-saas` applies to EVERY job. This job deliberately checks
nothing out — it exists only to hold the `production-approval` environment — so the directory it
was told to run in does not exist on that runner. It crashed **before** the environment could
raise the approval request, and `deploy` was then skipped as a dependent job.

**Why it read as something else.** A gate that cannot ask looks, from the outside, exactly like a
gate that asked and was not answered: the run reports `deploy: skipped`, the report says approval
was not given, and every layer above repeats it. I repeated it for two days without opening the
job log. **The failure predates the release work of #143** — v0.2.4's run `32850636945` carries the
identical error, so it has never once succeeded.

**Fix:** `working-directory: .` on that job's step, plus a guard in `ops/release`'s workflow tests
that walks every job and requires any job running a command WITHOUT a checkout to override the
default. Mutation-proven: removing the override reddens it.

**Consequence for the next reader:** every release attempt at `a5dcf2f` failed this way (runs
`32891301629`, `32939272042`), which is why #142–#149 sat on `main` unreleased and production
stayed on v0.2.7.

---

## ✅ CLOSED (owner-reported 2026-08-26, fixed same day) — "Create podcast" showed Building for one tick and then reverted, forever, while the build ran fine

**Closure kind: verified in code, mutation-proven on both sides.** The third podcast defect in two
days, and unlike the first two nothing was wrong with the build at all — the creator simply could
not see it.

Three vocabularies had grown for one fact, and nothing forced them to agree:

| where | values |
|---|---|
| database (`project_audio_editions.status`) | `none \| processing \| ready \| failed` |
| the POST's 202 ack | `queued` |
| the client contract (`client-v1.ts`) | `none \| queued \| building \| ready \| failed` |

The GET route returned the **database** value verbatim. So while a build was running the client
received `processing` — a value it has never heard of. Its in-flight test is
`status === 'queued' || status === 'building'`, which `processing` fails, so the row rendered as
idle, **the polling interval was cleared**, and the finished podcast appeared only if the creator
reloaded the page. The intersection of "what the server could send while building" and "what the
client would recognise as building" was **empty**. The one moment "Building" ever appeared was the
client's own optimistic write on click, which the first poll then overwrote.

**What let it ship, and it is the interesting part.** `AudioEditionStatus.status` was typed
`'none' | 'queued' | 'building' | 'ready' | 'failed' | string`. The trailing `| string` collapses
the union to `string`, so every one of these values type-checked and the declared vocabulary was
decoration. `shared/src/generated/` is hand-maintained (CLAUDE.md §5) — nothing regenerates it from
the routes — so the type was the only thing that could have caught this, and it had been disarmed.

**Two suites were green throughout, each testing a fiction.** The route test asserted
`status: 'processing'` — it named the wrong side of a translation that did not exist. The component
test set `state.status = 'building'` **by hand**, a value the server has never sent; a client suite
that invents the server's answers cannot fail when the server's answers change.

**Fixed:** one vocabulary in `shared/src/audio/editionStatus.ts`, exhaustive over the database's own
status list; the route translates at the boundary; the component imports the same in-flight
predicate instead of restating it (it had restated it twice, identically wrong). `| string` is gone,
so the next drift is a compile error. Both suites now drive their statuses **through the shared
mapping**, so the two sides cannot diverge without one going red.

**Mutation-proven:** restoring the pass-through reddens 3 route tests; breaking the client's
in-flight test reddens 3 component tests. Full suites after: shared 1094, backend-api 4687,
client-web 1851, 0 lint errors.

## ✅ CLOSED (found 2026-08-26, fixed 2026-08-26) — the podcast pre-flight and the worker it gates asked different questions about b-roll

**Closure kind: verified in code, mutation-proven.** The second defect in the same gate in two
days, and the same shape as the first.

The route's pre-flight selected every `video_files` row of the project. The job's `loadInputs`
selected only the rows with `is_broll = false`. A project whose only footage is b-roll therefore
passed the gate — rows exist, so 202 accepted — and was refused by the worker minutes later. That
delayed, unexplained refusal is the precise failure the pre-flight was written to prevent, so the
gate was not merely wrong: it was inverted, doing the harm it existed to stop.

**Fix:** both callers now share one query, `services/audio/editionSegments.ts`. The gate cannot
ask a different question from the worker because there is no longer a second question to ask.

**Test.** The suite's `video_files.findMany` mock previously returned its rows regardless of the
`where`, which means it could not fail when a filter was DROPPED — it only ever saw that a query
happened. It now EVALUATES the predicate: it walks the `and`/`eq` tree and keeps only rows equal
on every column named. A b-roll-only project is refused at the gate; b-roll beside real narration
still queues. Mutation-proven — removing the `is_broll` clause reddens both.

**The pattern, twice now:** a pre-flight duplicated in prose from the thing it gates drifts from
it silently, and the drift is invisible to any test that mocks the query instead of the data.

---

## ✅ CLOSED (found 2026-08-26, fixed same day) — the apply-gate e2e test asked for a sample count its window could not contain on a starved runner

**Closure kind: verified in code, cause computed rather than guessed.**
`viewer-e2e.spec.ts` — *"the frame is never presented before the matching SCRIPT_APPLIED"* — failed
on `feat/sim-authoring-layer` with its own vacuity guard:

```
Error: no opacity samples fell between the request and the acknowledgement — vacuous
Expected: > 5
```

**It was never a regression.** The identical test failed on `main` in run `32891258874`, before that
branch existed, and `feat/sim-picker-editor` — which contains every commit of the branch blamed —
passed webkit on the same code.

**The cause is arithmetic, not luck.** The parent's sampler runs on `requestAnimationFrame`. A
comment thirty lines above the assertion already records that CI WebKit under software GL drops to
**~7fps**. The `delayedack` bridge's default acknowledgement delay is **500 ms**. Seven frames per
second across half a second is **3.5 samples**, and the assertion demands more than five. The test
was asking a fixed sample count of a window whose size silently assumed 60fps.

**The fix that was NOT taken, and why.** The obvious move — drive the sampler from a timer so its
density stops depending on the compositor — would have broken something load-bearing. The staleness
bound in `assertVisibleFramesAreCorrect` is deliberately ADAPTIVE: it reads the sampler's own median
gap as a proxy for how starved the environment is, and widens the bound exactly when the parent's
clock is itself coarse. That proxy is what ended three false failures on 2026-08-23. A
frame-rate-independent sampler would have destroyed it and brought those back.

**The fix taken:** a new `delayedack`-only section, `WIDEACK`, acknowledging after **1500 ms**. The
number is chosen against the runtime's own constants rather than tuned until green — it clears six
samples at 7fps with margin, and stays well under `SIM_APPLY_STALL_MS` (3000 ms) so the terminal
stall bound is never what ends the wait, which would prove a different thing. Adding a section to
that package touches no other package's bytes, by the generator's existing design.

**A second bug surfaced while proving the first.** With the wider window the test then failed as
*"the child never acknowledged"* — the sampler's 5s lifetime expired before an acknowledgement that
now arrived later, because activation does not follow the seek instantly (measured elsewhere in this
file at up to ~5.8s on a loaded runner). The sampler must outlive the window it observes; it is now
7s. A sampler that goes home early reports an absence as a product failure.

Verified: passes on chromium and on webkit locally, and the full chromium viewer suite was re-run.

**Note on severity, which the first version of this entry got wrong.** The webkit job is
`continue-on-error: true` in `ci.yml`, so this never blocked a merge — it only ever produced a red
line in `gh pr checks` that reads exactly like a real failure. That is still worth fixing, because a
check nobody can trust is a check everybody learns to skip past.

## ✅ CLOSED (found 2026-08-26, fixed same day) — the viewer freshness-poll suite asserted a dice roll, and failed a release gate on a backend-only branch

**Closure kind: verified in code, diagnosis reproduced on demand.** `release:verify` went red on
#153 — a branch touching nothing but backend audio code — inside
`__tests__/configFreshnessPoll.test.tsx`: *expected 2 calls, got 3*.

The poll delay is `60s × [0.75, 1.25]`, so delays land in [45s, 75s]. The test advanced 75.001s
twice — 150.002s of virtual time — and asserted **exactly two** polls. Three delays fit inside
150.002s whenever they sum to ≤150s, and the floor of three delays is 135s. So the assertion held
only when the dice cleared a 15s margin: **about one run in fifty fails**, computable rather than
mysterious (each delay uniform on [45,75] ⇒ `P = 0.5³/6 ≈ 2%`).

Fixed by pinning `Math.random` to its midpoint in `beforeEach`, so every delay is exactly
`FRESHNESS_INTERVAL_MS` and a count assertion means what it says. The jitter itself keeps its own
head-on test in `configRevision.test.ts`, which injects its own random.

**Diagnosis proven, not assumed:** pinning to the MINIMUM instead reproduces the CI failure exactly
— same test, same assertion, same numbers. Pinned at the midpoint, 25 consecutive runs are green.

**The lesson was already written in this very suite** — a sibling test carries a comment saying
"a test that depends on luck reports the weather, not the behaviour", added when someone hit this
in the loudest case and converted that one assertion to a range. The quieter sibling, failing only
2% of the time, was left alone. A flake rare enough to re-run is a flake nobody fixes.

## ✅ CLOSED (found 2026-08-26) — "Import a simulation" shipped into a feature branch, not into `main`, and the PR said MERGED

**Closure kind: verified in code, then replanted.** PR #147 — the import picker as a gallery with
previews, search, categories and multi-select — reports `state: MERGED`. It was merged into
`fix/api-double-stringify`, whose own content reached `main` as a DIFFERENT squash commit (#145).
The gallery commit therefore never became an ancestor of `main`: production carried the old
127-line two-list picker while every status surface said the feature had shipped.

**Why it was invisible.** `gh pr list` says MERGED without saying merged INTO WHAT, and a
squash-merge of the base branch severs the child's commit from `main` while leaving the PR's badge
green. The ledger line for #147 said "opened", which was true and stopped being the whole truth.
Found only because an audit asked "is the feature present in the code?" rather than "is the PR
merged?" — the two questions have different answers and only one of them is about the product.

**Fix:** the gallery commit replanted onto `main` (`git rebase --onto`, dropping the two files
already there via #145), verified: typecheck clean, its 17 tests green, lint 0 errors.

**The check worth keeping:** for any PR that claims to have shipped a user-visible thing, assert
the THING is on `main` — `git merge-base --is-ancestor <sha> origin/main`, or grep `main` for the
feature — not that the PR is marked merged.

**Three ledger headers were also stale in the same pass** and are now corrected: the podcast
wrong-table entry and the double-stringify entry both still read 🔴 FIXED, NOT YET MERGED after
#146 and #145 landed, and the lost-deep-review entry still demanded a commit that `ca7a9d8` had
already made. §3b's rule — close it in the same pass as the merge — is exactly what did not happen.
## ✅ CLOSED (owner-reported 2026-08-25, fixed 2026-08-26 in #150 + #151) — the Minimal-UI control picker on all three axes the owner named

**Closure kind: verified in code, proven in a real browser.** Recorded here on 2026-08-26 after an
audit found this work had **no ledger entry at all** — three merged PRs' worth of user-visible
feature work, invisible to anyone reading this file. Exactly what §3b exists to prevent, and the
second instance found today.

The owner's three complaints, and what each turned out to be:

1. **"It's not scanning the actions right."** The scanner lived in the rAF gate, which is baked into
   a package at PUBLICATION time — so every already-stored simulation carried an old gate that never
   answered, and the scan timed out after 2s with no signal about which layer failed. Fixed by a
   serve-time authoring layer (`SimAuthoringBootstrap.ts`, `GET /sim-authoring.js`) that reaches
   every stored package instantly, plus a tagged `UiScanOutcome` so "scanned and empty" is
   distinguishable from "unreachable" — the header and the body can no longer contradict each other.
2. **"Show green/red on the buttons themselves."** Badges are drawn in an overlay pinned to each
   control's own client rect, tracking page scroll, nested scroll, viewport resize and node
   replacement. Proven in `e2e/sim-authoring.spec.ts` — which caught a real bug the day it was
   written: a queued rAF rebuilt the overlay after DISARM.
3. **"The panel's UI is horrible and doesn't match the design."** Rebuilt in `SectionEditor.tsx`'s
   own idiom and tokens.

**Amendment A1** to the ADR (binary Keep/Hide replacing D10's four-mode toolbar; `SIM_AUTHORING_DISABLED`
replacing the admin flag) is recorded in `ADR-ACTION-RECORDING-SEMANTICS.md`.

The e2e suite that proves axis 2 ran in **no workflow** until the entry below wired it.

## ✅ CLOSED (found 2026-08-26, fixed same day) — eight of eleven browser suites were invoked by nothing, including the only test of the picker's geometry

**Closure kind: verified in code, mutation-proven both directions.** `client-web` carries eleven
Playwright configs. Three were referenced by a workflow. The other eight ran only if a human typed
the command.

The one that mattered: `playwright.authoring.config.ts` — the ONLY place the control picker's badge
geometry is checked anywhere. It caught a genuine product bug on the day it was written (a queued
rAF rebuilt the overlay after DISARM) and was then wired to nothing, so that class of bug could
regress silently forever while the repository looked covered.

**This is the second time in this package.** `viewer-e2e` exists at all because audit
test-quality-013 found exactly the same thing about the viewer suite: 363 tests, passing locally,
invoked by no workflow. Finding it once is bad luck. Finding it twice means the repository needed a
RULE rather than another audit.

**Fixed in two parts:**

1. A `browser-suites` job runs the three self-contained suites on chromium — authoring (~5s),
   transport (~15s), transitions (~11s), measured. They need no app, no database and no network.
   The four left out (canary, leak, protocol, rebuilt) carry 900–1500s timeouts because they are
   soak suites: a scheduled job's work, not a per-PR gate. Putting them in a PR gate would buy a
   slow signal that gets re-run until green, which is worse than none because it looks like one.
2. A test in `ops/release` that makes the orphan state unreachable: every config is either
   referenced by a workflow or named in `NOT_A_PR_GATE` with the reason it is not a gate. There is
   no third state.

**The gate had a hole on its first draft, and the mutation found it.** It matched the workflow text
as a whole — and every job here carries a long comment naming the suites it runs, so deleting
`authoring` from the matrix still passed: the word survived in the prose. It now strips comment
lines and reads the matrix LIST LITERAL. Mutation-proven twice: dropping one matrix value reddens
it, deleting the whole job reddens it. Reverted, 461 ops-release tests green.

Precisely the lesson already recorded as "mutation-check what a gate can SEE" — written by me,
four days ago, and re-learned here at my own expense.

## ✅ CLOSED (2026-08-25) — `/health` now reports the version that is running

Found 2026-08-25 while verifying the v0.2.0 deploy.

`health.controller.ts:191` returns `version: process.env.npm_package_version ?? '0.1.0'`.
`npm_package_version` is set only when a process is started THROUGH npm/pnpm; production runs
`node dist/server.js` directly (docker-compose.yml), so the variable is never set and the field
reports the literal fallback **`0.1.0` forever** — before and after every release.

**Why it matters:** confirming "the new code is live" is the first question after any deploy, and
the first question during an incident. Yesterday's avatar outage was prolonged partly by not being
able to state plainly what was deployed. Today the only way to verify v0.2.0 actually landed was to
probe a NEW ROUTE and check it answers 401 rather than 404 — which works, but is a workaround.

**The fix is small and the input already exists:** `APP_VERSION` is the git short SHA the deploy
sets to select the image tag (docker-compose.yml:25, and `pgBossDriver.ts:221` already reasons
about it). Pass it into the backend container's environment and report it here, keeping the
package version as a secondary field. Add a test that the field is NOT the hardcoded fallback when
APP_VERSION is present.

**Fixed the same day.** `APP_VERSION` — the git short SHA the deploy already uses to select the
image tag — is now passed INTO both long-lived services (`docker-compose.yml`), and the field reads
`APP_VERSION || npm_package_version || '0.1.0'`. Six tests, mutation-proven on BOTH halves: the fix
needs the code AND the wiring, and removing either turns it red. An empty `APP_VERSION` is treated
as absent rather than reported as a blank version — `${APP_VERSION:-unknown}` means the variable is
always present, so `??` would have accepted `''`.

## ✅ CLOSED — verified in code (2026-08-25) — "Save bridge…" / "Load bridge…" opened BEHIND the modal

Owner-reported: "are not clickables… like nothing happens". Queued behind the action-recording
research by the owner's ordering — and then fixed while that queue note still said open, which is
why this entry survived as red after the work was done: **fixed in `f50cca8`, shipped in v0.2.5.**

The leading hypothesis below was exactly right: the two preset overlays rendered inline inside the
editor modal's own stacking context. The fix is the hypothesized one — both dialogs are
`createPortal`ed to `document.body`, per the file's own `ConfirmDialog` precedent, and
`presetDialogsVisible.test.tsx` asserts the thing that would have caught it: that clicking makes
the dialog VISIBLE in the document above the modal, not merely that state flipped.

**Leading hypothesis, to check first:** the two preset overlays in `SectionEditor.tsx` are
rendered INLINE inside the editor modal's own DOM tree with `zIndex: 70`, while `ConfirmDialog` —
the file's own precedent, used ten lines below — deliberately `createPortal`s to `document.body`.
A `position: fixed` element inside an ancestor with a transform/filter is positioned relative to
THAT ancestor, and z-index competes inside the parent stacking context — either can leave the
dialog rendered invisibly behind/clipped by the modal. That matches the symptom exactly: the
click WORKS (state flips), and nothing visible changes.

Second check: the Save button is `disabled` until `section.sim_meta` exists — correct behaviour,
but at `opacity: 0.55` it may simply read as "not clickable" with no explanation. If that is part
of the report, the fix is feedback, not enablement.

Fix shape: portal both overlays to `document.body` (the ConfirmDialog pattern), then a component
test that CLICKING the button makes the dialog VISIBLE in the document — not merely that state
changed, which is exactly the assertion that would have missed this.

## ✅ CLOSED (found 2026-08-25, fixed 2026-08-25 in #142) — a revision that was never canaried was publicly served, on the strength of a comment describing a mechanism that does not exist

**Closure kind: verified in code.** `isRevisionStatusPublic` (`revisionIdentity.ts`) is now an
ALLOW-list — a status the code has never heard of is private, not public. The header below stayed
red for a day after the fix merged, which is its own small lesson: a ledger entry that is not
flipped in the same pass as the merge asks the next reader to re-diagnose settled work.

Found during Phase 0 of the action-recording work, while looking for somewhere safe to stage an
unproven candidate. Independent of that feature.

`isRevisionStatusPublic` (`revisionIdentity.ts:51-53`) is a **deny**-list:

```ts
return status === null || !NEVER_PUBLISHED_STATUSES.has(status);   // {draft,uploading,validating,failed}
```

Two consequences, both live:

**1. `canary_passed` is served, and the stated reason is false.** The comment at
`revisionIdentity.ts:43-44` justifies it: *"`canary_passed` is served too: the pre-activation canary
drives the real document over this route."* Checked three independent ways — nothing does.

- `RevisionService.validate()` reads bytes back **from storage**. `RevisionService.ts` contains no
  `fetch(`, no `http`, no `getSimPublicUrl`.
- `sim-canary-publish.ts` consumes a **report file** (`--report <path>`); it never drives a browser.
- `sim-canary.spec.ts:1710` routes `${API_ORIGIN}/**` to an in-process server, and `localPathFor:304`
  maps only `/sim-public/__e2e/…`, 404-ing everything else. A real revision key is unreachable there
  by construction.

The repo already contradicts the comment in its own words. `shared/src/sim/simRevision.ts:33-42`:
*"NOT proof that a canary ran. `validate()` moves a revision here on byte verification alone, and
the legacy migration publishes straight into this state, so a migrated package can sit in
`canary_passed` having never been canaried. The name is historical."*

So the file that gates public serving relies on a claim the file that defines the status denies.

**2. An UNKNOWN status is public.** `status === null || !deny.has(status)` — the trailing comment
says so explicitly, *"Unknown status ⇒ yes (legacy)"*. Any status a given backend image has not
heard of is served. That makes the obvious fix ordering-sensitive: shipping a new `proof_pending`
status **first** would have older images serve exactly the unproven bytes it was added to protect.

**Fix, in this order — the order is the fix:**

1. Invert to an explicit **allow**-list: `active`, `retired`, `rolled_back`. One function, no
   migration, no new status. This alone makes `validating` and `canary_passed` non-public.
2. Only in a **later** release, add `proof_pending`/`proof_passed`, once every serving image already
   refuses what it does not recognise. `sim_revisions.status` is `text` + inline `CHECK`
   (`050_sim_revisions.sql:41-43`), not a PG enum, so that is a `DROP`/`ADD CONSTRAINT` and runs
   inside the runner's transaction.

Keep `retired` and `rolled_back` public deliberately — their bytes were served and an in-flight
viewer still holds those URLs. Which is the same reason **rollback is not revocation**: recovery
moves the active pointer, it does not unpublish a URL. That belongs in the runbook.

Full options analysis, with the migration DDL and the idempotency/lease/`section_version` design:
`md-files/PHASE0-PROOF-STATE-AND-IDEMPOTENCY.md`.

## ✅ FIXED (gate v5, 2026-08-25, mutation-proven) — "hide this control" silently did nothing, or hid too much

Found during Phase 0 of the action-recording work, while building the golden fixtures. It is a
**live viewer defect today** and has nothing to do with that feature — the feature is only what
made someone finally execute the code instead of reading it.

`controlSelector` (`SimulationService.ts:541-563`, inside `RAF_GATE_TEMPLATE`) builds a selector by
raw string concatenation: `'#' + el.id`, else `'[name="' + name + '"]'`, else a structural path. No
`CSS.escape` (CSSOM defines it for exactly this), and no uniqueness check on the first two branches.

**The selector is never resolved — it becomes a CSS rule.** `listSimControls` only filters
`/[{}<\\]/` and length ≤300, then the string travels: gate → `simControlsList` → `SectionEditor` →
`ui_controls` → `sim_meta.uiControls.hide` → `buildPlayerConfig.uiHide` → `bootHideFor` →
`#simboot=` → `SIM_BOOT_SNIPPET`'s `<style id="__simBootHide">`, and separately →
`startScript.params.hideSelectors` → `applyHideUi`'s `<style id="__simHideUi">`. There is no
`querySelector` anywhere on that path, so there is nothing that can fail loudly. CSS drops an
invalid rule silently, by design.

**Measured, not reasoned** (jsdom, one rule per selector, exactly as both snippets build them):

| selector | element's effective `display` |
|---|---|
| `#odd:id.v2` | `inline-block` — **not hidden** |
| `#123numeric` | `inline-block` — **not hidden** |
| `#has space` | `inline-block` — **not hidden** |
| `#dup` (duplicate id) | `none` on **both** elements |
| `[name="mode"]` (radio group) | `none` on the **whole group** |
| `#ok` (control) | `none` — correct |

A real browser drops the first two rules at parse time rather than keeping and not matching them;
the end state is identical. So: **any control whose id contains a CSS-special character cannot be
hidden, and the author gets no error.** Duplicate ids and radio groups over-hide.

**Why it survived review.** `rafGate.test.ts` has ~90 assertions covering this scanner and every
one of them matches the gate's SOURCE TEXT — including
`expect(out).toContain("if (el.id) return '#' + el.id;")`, which pins the defective line as if it
were the specification. A correct fix would turn that suite red. This is the
`tests-that-read-source-are-theatre` pattern again, on a second subsystem.

**Fix shape — and escaping alone is NOT it.** The obvious fix (`CSS.escape` on the id branch,
`querySelectorAll(...).length === 1` as the uniqueness proof, a radio option identified by its own
id rather than the group's shared `name`) was applied as a mutation and measured. It works, and it
is not sufficient:

- the duplicate id **is** fixed — both `#dup` elements fall through to distinct structural
  selectors and both resolve to exactly one node;
- but `#odd:id.v2`, `#123numeric` and `#has space` **disappeared from the control list entirely**.
  A correctly escaped selector contains a backslash, and `listSimControls` drops anything matching
  `/[{}<\\]/`. The same regex guards `SimUiControls.ts:61`, `client-web/lib/simUiControls.ts:49`
  and `SIM_BOOT_SNIPPET` — four copies, all rejecting backslash, because the string is destined for
  a `<style>` block and that filter is what keeps CSS injection out of it.

So escaping converts *"the wrong control was hidden"* into *"the control is not offered at all"*.
Still silent, still wrong. Relaxing the filter means letting backslashes into a stylesheet, which
is the thing it exists to prevent.

That measurement is the argument for the action-recording ADR's answer: the wire carries **locator
ids**, never free selector strings, and `data-sim-control` is the first locator strategy — neither
needs the filter relaxed. The two fixes are the same fix, which is why this one waits for that one
rather than being patched ahead of it.

A behavioural harness now exists and is green:
`backend-api/src/services/simulation/__tests__/rafGateRuntimeScanner.test.ts` executes the gate in
jsdom against the fixture and resolves every selector it emits. Mutation-proven both directions on
2026-08-25: under the correct fix the OLD source-text suite goes **red** and exactly the four
defect-describing tests in the new one flip. The golden fixture is
`backend-api/src/scripts/fixtures/controlsFixture.ts`, emitted as the `controls` package by
`gen-sim-fixture.ts`.

**FIXED — `feat/sim-locator-gate`, as Phase 1's opening PR, exactly as ruled.** The fix is the
fall-through the mutation measurement dictated, not escaping: `#id`/`[name]` are emitted only when
clean AND proven unique (`querySelectorAll` → exactly one match that IS this element), everything
else gets the structural child-combinator path, which passes all seven filters unchanged. The
structural ANCHOR gets the same proof — `'#' + parent.id` on any ancestor was the same defect one
level up. The static scanner gets a document-wide counting pre-pass for the same rule. Gate
version 4 → 5.

Three mutations, all caught (revert to raw concat: 4 failed; weaken uniqueness: 2; drop the static
count proof: 2). Real-browser e2e green on regenerated v5 fixtures. **Residue: stored packages keep
v4 bytes until `reinject-sim-gates.ts` runs — an ops step, listed below.**

## ✅ CLOSED (owner-reported 2026-08-25, merged 2026-08-25 in #146 as `3d28212`) — "Create podcast" was refused on EVERY project, for a reason that was never true

Owner, from a live console: *"Could not start the podcast build (This project has no media to
derive audio from.)"* — on a project full of media — plus three `409`s on `/audio-edition`.

**One identifier.** The pre-flight query ran

```ts
db.query.video_files.findMany({ where: eq(projects.id, project.id) })   // ← projects, not video_files
```

a predicate naming a column from a table the query does not select from. Postgres refuses that
outright — and the `.catch(() => [])` beside it turned the refusal into an empty list, which
`editionRefusalReason([])` reads as "no media" and answers `409` with a sentence about the project.

**So the podcast feature could never start, for anyone.** The refusal is a real product answer,
working exactly as designed; it simply fired always. `video_files` HAS a `project_id`
(`schema.ts:434`) — the fix is that one identifier.

**The catch stays.** A transient database fault should not 500 a creator's Create-podcast click.
What changes is that it can no longer hide a query that was wrong every single time.

**Why the suite could not see it — the third instance of this shape in one day.**
`audioEditionAccess.test.ts` mocked `video_files.findMany` **ignoring the `where` entirely**, and
mocked `eq` as `vi.fn(() => ({}))` — **discarding its arguments**, so every predicate looked
identical. The schema mock made it worse: `projects.id` and `video_files.project_id` were the bare
strings `'id'` and `'project_id'`, which is exactly what made the wrong table indistinguishable
from the right one. All three fixed; four new tests assert the PREDICATE, and the genuine "no
media" refusal is pinned separately so the fix cannot delete a real product answer.
Mutation-proven.

**The three, together, are one finding.** The rAF gate's source-text assertions, `/sim-public`'s
storage mock shaped to take the other branch, and this `where`-ignoring mock: each test was
structurally incapable of observing the thing it named. That is worth a protocol rule, not three
separate fixes.

## 📋 SHIPPED AND IN FLIGHT — 2026-08-25 evening

**Merged and deployed (v0.2.7):** #142 the revision-status allow-list · #141 action-recording
Phase 0 · #144 gate v5 (the `ui_hide` selector fix) · #143 the release risk-window fix · #145 the
double-stringify · #146 the podcast wrong-table query.

**Open:** #147 import gallery (stacked on #145) · #148 migration 081 proof states · #149 this
protocol rule.

**Branch hygiene, 2026-08-25.** Sixteen local branches deleted — and *only* those whose PR GitHub
reports as MERGED, which is authoritative. The tempting heuristic was `git diff main..branch`, and
it is wrong: an old branch shows its own STALE content as "additions" against a main that has since
been rewritten, so a large diff proves nothing about whether the work landed. Five branches remain
undeleted for exactly that reason — four tiny ledger-doc branches with no PR, and
`backup/audio-landing-orig`, whose name says what it is for.

**`reinject-sim-gates` is NOT an approval question — it is the wrong machine.** Stored packages
still carry v4 gate bytes after #144, and the fix reaches them only via that script. It reads
`DATABASE_URL` and storage credentials from `.env`; the local one is localhost, so running it here
touches nothing real, and pointing it at production credentials is what CLAUDE.md §7 forbids
outright. It belongs on the VM or in a workflow. Until then, #144's fix is live in the CODE and not
in the already-published packages — a distinction the next reader should not have to rediscover.

## 🟡 OPEN BY DECISION — video is the one media type NOT deduplicated, and it is the largest

Checked 2026-08-25 while wiring images and audio. Video is not an oversight; it is structurally
different, and forcing it would cost more than it saves.

Both upload paths are built so the SERVER NEVER HOLDS THE BYTES:
- `video.controller.ts:177` — the client uploads DIRECTLY to storage with a presigned URL, and the
  server only learns the key. Hashing would mean downloading the whole video back.
- `video.controller.ts:248` — `uploadStreamWithFallback` pipes the multipart straight through. The
  code's own comment states why nothing may buffer it: *"A source stream can't be replayed, so we
  can't try R2 first and fall back."*

So the cheap trick that worked for images (hash the buffer) and for audio (hash the temp file) has
no equivalent here without paying full egress on the biggest files in the product — which is the
opposite of the saving.

**The three real options, none of them a one-liner:**
1. **Hash during the multipart stream** (site 2 only) — tee the stream through a digest while it
   uploads. Correct and cheap, but covers only one of the two paths, and the presigned path is the
   one large uploads actually use.
2. **Hash in the transcode job**, which already reads every byte, and merge retroactively. Best
   coverage and no extra reads — but it rewrites `storage_key` on a LIVE row that the player may
   already be serving, so it needs a careful swap-then-verify, not an update.
3. **Client-supplied digest as a candidate finder**, verified server-side before any merge. Cheapest
   to add and the only one that cannot be trusted on its own.

Recommendation: (2), as its own round, after the current dedup has run in production long enough to
show the actual hit rate on images and audio. Deduplicating video badly is worse than not
deduplicating it: these are the files whose loss is least recoverable.

## ✅ SHIPPED (2026-08-25, v0.2.1 + v0.2.2) — the storage promise kept, and the incident's own path guarded

**v0.2.1:** `/podcasts` → `/edit-podcasts` (P3-A item 2) with three `permanentRedirect` shims so
every shared deep link still lands on its exact destination — verified in production:
`/podcasts/abc/episodes/xyz` → 308 → `/edit-podcasts/abc/episodes/xyz`. `podcasts` STAYS reserved,
because releasing it would hand those old links to a creator. Also: the podcast editor was the
only one of three editor trees `robots.txt` never disallowed.

**v0.2.2 — the correction that matters.** The owner asked for simulation storage NOT to be
duplicated. The `+` import shipped in v0.2.0 did `copyObject` on every file, so importing one
31 MB package into five projects stored it five times — the exact opposite. Migration 080
(`sim_files`) makes a simulation's files content-addressed: each is claimed as a blob, uploaded
only if nobody already holds those bytes, and resolved back at serve time by `simFileResolver`
(AFTER every access check, so sharing can never widen who may read). Proven:
`copiedObjects: 0, reusedObjects: 2` on the second import. A preset can now also bring its source
simulation along, which since 080 costs nothing.

**And the podcast finding, from auditing for the INCIDENT'S SHAPE rather than a reported symptom:**
`PodcastRenderer` had consulted the spend ceiling since it was written; `previewTurn` and
`revoiceTurn` never did. That is backwards — a render is ONE action with a knowable cost, a
preview is unbounded by construction — and it is precisely what happened on 22 August: not one
expensive render but a creator auditioning voices, four auto-top-ups in three and a half hours,
every click through those two functions, metered but unceilinged. Both now check first, still in
shadow. Mutation-proven with the vendor doubles failing loudly if reached, because a guard placed
AFTER the call satisfies "throws when refused" with the money already gone.

## ✅ SHIPPED (2026-08-25) — three features, one release

**#139 + #138 merged; v0.2.0 dispatched with deploy.** Full detail in `HANDOFF-2026-08-25.md`,
which is the next session's entry point — including the LIVE-vs-INERT table that governs how to
reason about storage (dedup ships inert: `claimBlob` is called from nowhere).

Verification beyond CI, because CI alone could not have caught these:
- the two PRs were never tested against EACH OTHER by CI (each runs against main). A combined
  merge tree was built by hand and the full nine-step `release:verify` run on it: **9/9 PASS**.
- that run found two defects that would otherwise have failed inside the release gate, after the
  merge: **079's missing `.rollback.sql`** (broke three live-DB migration tests) and an
  **undocumented env var**. Both fixed; both now have structural guards
  (`rollbackCoverage.test.ts`, and the env ratchet that caught the second).
- **a self-audit of the night's own code found five more** — a bypass of the delete chokepoint, an
  unreachable comparison, a documented flag nothing consulted, two dead exports (one with a false
  claim in its comment), and a status notice that outlived its operation.
- the five new routes were exercised on a **live local server**: all 401 (registered, auth
  working), with a fake control route returning 404 to prove the distinction is real.

**Root cause of why CI missed everything: `cancel-in-progress: true`.** The branch was pushed
eight times in half an hour and **no CI round ever reached its test step** — every one was
cancelled by the next push, while `gh pr checks` reported `pass=0 fail=0 pending=0`, which reads
like "not started". Batch commits, push once, then wait.

## ✅ CLOSED (2026-08-24 → merged 2026-08-25 in #138) — media dedup foundation + the two owner features riding on it

**Closure kind: verified in code 2026-08-26.** The header below said IN FLIGHT and the body said
`claimBlob` "is called from nowhere". Both were true when written and stopped being true when #138
merged: `claimUploadedMedia` is wired at `images.controller.ts:56,118`, `audio.controller.ts:122,287`
and `SimulationImportService.ts:151`. Video is the one path still not deduplicated, and that is the
owner's deferral recorded separately — not an unfinished piece of this.

**PR #138** (`feat/media-dedup`, CI running): store bytes once however many projects reference
them. Content identity = SHA-256 + byte-size taken in the same pass (truncation cannot mint an
identity), HEAD-verified before any reuse; `UNIQUE(sha256, byte_size)`; **no ref_count, no
trigger** — a plain FK means Postgres itself refuses to drop a referenced blob (a counter would
drift on every cascade delete). Project deletion: content-addressed blobs are untouchable by
design; path-owned objects referenced elsewhere are ADOPTED before the project row goes
(`readyToDelete` enforces the crash-safe order); unknown reference state = KEEP. Delete chokepoint
(`deleteWithFallback`) refuses `blobs/` keys so no current or future caller can destroy shared
bytes. Migration 078 in BOTH registries, expand-only. 200 tests, 11 mutations killed.
Also carries CLAUDE.md §3e (the avatar-outage post-mortem rule).

**Owner features this is for (2026-08-24):** (a) `+` in Edit Section imports a simulation from
another project without re-upload/re-store — `importEligibility.ts` (destination-first check
order so the endpoint is not an existence oracle; unlisted needs a non-empty matching token);
(b) **save bridge / load bridge** — save a section's bridge configuration (auto script + minimal
UI + selection) under a label, load it onto a compatible sim elsewhere, skipping regeneration.
UI map done (SectionEditor.tsx:1827-2330 is the sim column; `reuseBridgeScript` precedent at
sections.controller.ts:1060). Bridge-model map in flight; design doc next.

**Save bridge SHIPPED onto the same branch (2026-08-25):** migration 079 (both registries),
`SavedBridgeService` (save reads the selection from sim_meta and the body from the served
bridge.js; unreadable revision degrades to recipe-only), `bridgePresetDecision.ts` (pure,
mutation-proven: artifact only on verified anchors; hashes never shortcut; unverifiable=recipe),
4 routes (`/bridge-presets` CRUD+fit+apply — apply RE-JUDGES server-side, 409=fall back to
generate-with-recipe), `applySavedBridgeBody` as the acknowledged THIRD caller of
uploadSectionBridge (guard test updated 2→3 by name), and the SectionEditor UI (Save bridge…/Load
bridge…, server-composed fit sentence, applyDone extracted to applyPersistedSection shared by both
paths). client-v1 extended; request() errors now carry {status, body}. Client 1708/1708.

**The `+` import SHIPPED too (2026-08-25):** `SimulationImportService` (bucket-side copyObject,
served-content-to-legacy-layout that migration-on-write upgrades later; bridge.js/guidance/posters
deliberately excluded, package_class null — nothing claimed the copy did not produce),
`POST /projects/:id/simulations/import` (sim names its own project; destination-first 404-safe
eligibility), Import button + two-step picker in the editor. 9 tests.

**Owner directive (2026-08-25):** after this feature → RELEASE → STOP; remaining work hands to
the next session. **Not built yet (for that session):** upload-path wiring of media files to
`claimBlob`, the orphan sweeper, share-token import UI, A2.3.

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

## ✅ CROP v2 — RULED 2026-09-03: keep the guarded flag (it is the YuNet plan's rollout lever); the recompute trap is defused in code

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

## 🟡 OWNER ACTION (2026-08-23 incident residue) — two one-time steps

1. **Rotate the Anam key pasted into chat during the incident** — Admin → API Keys → Anam (the
   screen #125/#134 shipped). One minute; the exposed key works until then.
2. **Check "Max session length" in the demo project's Avatar settings** — the ~1-minute
   conversation death is an Anam per-project dashboard value, not a FlowVid code path (the
   code-level 30s watchdog kill was a separate bug, fixed in #137).

(Recorded here from the root scratch file `INCIDENT-AVATAR-500.md`, which is now deleted — an
untracked file is not a ledger.)

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

## ✅ CLOSED IN CODE (2026-08-23/24) — every API token and every dollar, visible in admin

**Status correction 2026-08-25, verified against code (a task-tracker audit re-flagged this as
open — its grep used the wrong symbol names):** all six once-untracked paths now record —
`recordTtsSpend`/`recordSttSpend` sit in `PodcastRenderer` (4 sites), `previewTurn`, `revoiceTurn`,
`GuidanceService`, `audio.controller` (2 each); `PodcastVoiceService` is METERED_BY_CALLER. The
enforcement is not a promise but a TEST: `spendContract.test.ts` walks the import graph from every
paid vendor client and fails the build on any spend path with no recorder (`UNMETERED_TODAY = []`,
with a stale-path guard). Admin gets `GET /api/admin/v1/spend` + the Spend page (per-unit
quantities, never summed across units); the ceiling (`spendCeiling.ts`) ships in SHADOW.
**Remaining, deliberate:** the enforce-mode switch (owner call, after shadow data) and the
vendor-side Auto Top-Up cap (owner-only, at ElevenLabs).

*The original write-up follows for the incident record.*

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

### ✅ WAVE 3 — COMPLETE (2026-08-25), except A2.5 which is deferred BY DESIGN
`PARKED-DESIGNS.md` P3-B, in its stated build order. **A2.1 (audio derivation) is complete**:
migration 071, the pure rules, the ffmpeg pass, the service, the durable job and the API. An edition
is exactly as public as its project — re-derived per request from `requireProjectAccess`, never read
off the edition row — with the artifact under a PRIVATE `editions/` prefix, because `podcasts/` being
public is what made a customer's brief world-readable (security-016). 31 mutations, all caught.
**Corrected 2026-08-25 (task-tracker audit — the ordering below was stale):**
- **A2.2 `/{slug}/audio` landing — BUILT, verified in code:** `client-web/app/[slug]/audio/page.tsx`
  (ISR, `getAudioEditionPage`, `AudioEditionPlayer`, reserved-slug guard) + three test files. No
  ledger line had recorded the closure.
- **A2.4 Raise Your Hand — was HALF-built (the false-green shape), now COMPLETE (PR #139,
  2026-08-25).** The backend had been live and unreachable for days: no affordance existed in the
  player, so no listener could ask anything. The client half ships with the rule that makes the
  feature worth having — the question anchors to the moment the hand went UP, not when typing
  finished (mutation-proven), and the client always requests the full answer while the SERVER
  decides what the budget allows.
- **A2.3 Media Session + offline — COMPLETE, verified in code 2026-08-25.** Six `mediaSession`
  action handlers (play/pause/prev/next/seek ±) in `AudioEditionPlayer.tsx:130-134`, and option (2)
  (`saveForOffline`, blob playback) shipped in `lib/offlineAudio.ts`. Option (1) — narrowing the
  service-worker kill-switch — remains an OWNER RULING and is needed only if offline-by-DEFAULT is
  ever wanted; the shipped design deliberately does not depend on it.

**Nothing in this wave is open.** A2.5 "Call It" stays deferred until A2.4 produces real
listener-question data proving demand — a decision already recorded, not an omission. Now that
A2.4 is actually reachable, that data can finally accumulate.

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

## 🟡 Release correction (2026-08-23): v0.1.43 live; v0.1.44 cancelled; v0.1.45 next

The "dispatch a release" action this entry waited on has happened repeatedly: v0.1.43 deployed
2026-08-23 ~14:20Z through the FULL pipeline — candidate smoke (first ever to pass), digest-pinned
deploy, post-deploy browser verification against the live site with SMOKE_PUBLIC_PATH — no
rollback. v0.1.44 built and passed candidate smoke from the post-incident wave (#118 #121 #130
#131 #132 #133 #134), but was cancelled at the human gate before deploy because it did not yet
contain the two live incident fixes below. Its immutable tag and draft remain; the next patch is
therefore v0.1.45.

**v0.1.45 candidate — PR #137 (absorbs #136):** clears the popup's stale 30-second token watchdog
after a successful start, keeps a same-open retry replayable through that window, accepts only
Supabase's measured simulation-HTML `text/plain` metadata rewrite when the public `/sim-public/*`
delivery contract restores `text/html`, and fixes the release publish job's skipped-needs
condition. It also carries the real-Postgres proof for migration 077 and the candidate-compose
environment contract. None of this is live until #137 and the v0.1.45 release gates pass.

Remaining OWNER action from the original entry, unchanged and still last:

**The probe dub (~$2.20)** — everything code-side is verified; only the paid probe remains.

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
2. ~~**`podcasts/` holds user SOURCE DOCUMENTS on a public prefix.**~~ **ALREADY SHIPPED (PR
   #74, verified in code 2026-08-25):** `podcast.controller.ts:83` writes to
   `PODCAST_SOURCE_PREFIX = 'podcast-sources'` (private). No ruling needed. (The already-shared
   URL from before the fix is still the owner-action item — delete + re-upload.)
3. **`security-001` / STEP 3+4 — when to cut the public bucket over to proxied URLs.**
   *Recommendation: schedule it as its own round, after the C1 gate lands.* It changes URLs people
   already hold (the four ordered landings are documented in
   `supabasePublicMedia.guard.test.ts`); a naive cutover is an outage. The ⚪ "revoked shares keep
   working" acceptance stays accepted until this ships.
4. ~~**`security-012` — the gate returns TRUE on a DB error.**~~ **ALREADY IMPLEMENTED as the
   bounded version (PR #75, verified in code 2026-08-25):** `mediaAccess.ts:127-146` — TTL cache,
   fail-open only for keys last confirmed public, fail-closed for never-seen keys; the in-code
   comment reads "BOUNDED FAIL-OPEN (security-012). Ratified, not removed." This section
   previously described the OLD unbounded state — it postdated the fix and missed it.

**RULED 2026-09-03 (delegated):** #1 → scoped tokens, its own round after the night run; #3 → superseded by the storage plan in `NIGHT-RUN-2026-09-03.md` §7 (no proxied-URL cutover; signed URLs on a CDN-fronted bucket). Nothing in this block waits on a ruling any more.

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
- The classifier boundaries stand: merges yes, `--admin` no; push yes, force-push no.
- **Release dispatch changed hands on 2026-09-03 by owner ruling** — it is MINE to run now, not
  the owner's ("אתה אמור לעשות gh workflow run release.yml ... בעצמך - לא אני"). What the old rule
  was protecting is unchanged and still applies: `production` has 0 required reviewers, so a
  dispatch with `deploy=true` IS a deploy, with only the deterministic gates between it and the
  VM. So before dispatching: local `main` equals `origin/main`, clean worktree, zero open PRs, CI
  green on that SHA — and check whether a release is ALREADY in flight. The first time this ruling
  applied, the owner had dispatched seconds before telling me to; a second dispatch would have cut
  two versions and deployed twice. Deploy approval, where a risk plan sets `requires_human`,
  remains the owner's — confirmed the same night: the #187 hotfix touched `publicOrigins.ts`, the
  risk plan set `requiresHuman: true` (`"touches public origin configuration (CSP and URL
  minting)"`), and the run sat at `waiting` on `production-approval` until the owner clicked
  approve, ~80 minutes later. I did not attempt to approve it myself even though the API reported
  `current_user_can_approve: true` for the token in use — that gate exists specifically so a human
  looks at a change to this file, and I was the one who wrote the change.
- Migration numbers: the note above says "latest reserved 070" and is stale by fourteen. The live
  answer is the two registries themselves, and as of 2026-09-03 the latest is **084**.

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
* 🟡 Small open from v0.1.43's run: the **Publish GitHub release job reported `skipped`** even
  though `inputs.deploy` was true and the deploy succeeded — v0.1.40–43 all sit as Drafts while
  v0.1.39 published fine. Cosmetic (tag+draft exist), but the `if:` on the publish job deserves a
  look before the next release; publish v0.1.43's draft by hand or fix the condition.
  **FIXED (#136, verified 2026-08-25): v0.1.45 published as Latest — the first post-fix release.**
* ✅ **PROD INCIDENT RESOLVED 2026-08-23 ~14:20Z: /avatar/start 500 → 200 in v0.1.43.** Root: PERSONA_MAP never learned the 'guide' default (undefined ?? undefined → entry.personaId TypeError, statusless, pre-vendor). Fixed #127 (+ sanitizer class-defense), verified live: real sessionToken minted on the reported page; both pages 200. Full debrief: `INCIDENT-2026-08-23-avatar.md` — **MECHANISM CRACKED + reproduced: wrong-typed avatar_config field → statusless TypeError → bare 500 pre-vendor; fix = #127 (sanitize at both seams); v0.1.42 (diagnostic+admin key) deploying, v0.1.43 (the fix) right behind**

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

## ✅ CLOSED (found 2026-08-25, fixed 2026-08-25 in #143) — `release-risk` measured from the last TAG, not the last DEPLOYED version, so a gated change could reach production ungated

**Closure kind: verified in code.** `release-risk.ts` and `.github/workflows/release.yml` now
resolve `refs/deployed/production` and diff from it, failing CLOSED when the ref cannot be
resolved. The ref does not exist yet — the last successful deploy predates the fix — so the first
release after it will legitimately report `diff base: unresolved` and demand human approval. That
is the fail-closed path working, and it self-resolves once one deploy has stamped the ref.

**The gate did its job once and was then bypassed by its own bookkeeping — OBSERVED, not predicted.**

Confirmed live at 2026-08-25 while this entry was being written: run `32854681109` reported
`Human approval (risky release only): skipped` and proceeded to deploy, carrying `8c4fa66`'s
compose change to production. The prediction below was made from the source before that job
reported, and the run then produced exactly it.

Verified chain, every link from a log or the source — not inference:

1. **v0.2.4 (run `32850636945`) was correctly gated.** The reason, verbatim from the run log:
   `release-risk: HUMAN APPROVAL REQUIRED — 1 reason(s):`
   `  - touches production deployment configuration: podcast-saas/deploy/docker-compose.yml`
   That is `SENSITIVE_PATH_PATTERNS` entry 8 in `ops/release/src/release-risk.ts` firing on commit
   `8c4fa66 fix(health): report the version that is actually running`. `--backfill-policy report-only`
   was passed, so reason 2 did not fire; there was exactly one reason.
2. **The tag was created BEFORE the gate ran.** Job order in that run: `Manifest, tag & draft
   release :: success`, THEN `Human approval :: failure`, THEN `Deploy to production :: skipped`.
   `refs/tags/v0.2.4` exists on origin. Production never received it.
3. **`currentTag` has no idea whether a tag deployed.** `computeNextVersion` (`ops/release/src/semver.ts:56-67`)
   sorts the semver tag list and takes the highest. Nothing consults deployment state.
4. **So the next release measures from a version that never shipped.** `release.yml:125` runs
   `git diff --name-only "$current_tag"..HEAD`. For the release after v0.2.4 that range is
   `v0.2.4..HEAD` — ten files, none matching any of the nine sensitive patterns. The compose
   change sits in `v0.2.3..v0.2.4`, outside the window.
5. **But the deploy ships HEAD's tree, not the window's.** `release.yml:756` pins the VM checkout
   to `plan.outputs.git_sha` and compose runs from that checkout — which contains `8c4fa66`.

**⇒ A change the gate demanded a human for reaches production with no human, and the release
report will correctly say no approval was required.** Silent in exactly the way §3b warns about.

**Blast radius is the rule, not this instance.** The change in flight (`APP_VERSION` into the
container) is one the owner wants, so the outcome this time is benign. The hole is general: any
auth, secret, media-token, billing or deploy-config change that lands in a tagged-but-undeployed
release is invisible to the next release's classifier. Every failed or rejected approval creates
one of these windows, and a rejected approval is precisely when the change was most suspect.

**Why no fix is committed yet.** The classifier is not wrong — `assessReleaseRisk` correctly
judges what it is handed. The defect is the base ref, and fixing it needs a source of truth for
"what is actually deployed", which is a mechanism choice with several defensible shapes:

* a moving `deployed-production` ref pushed by the deploy job — most inspectable, but sits badly
  beside `assertTagAvailable`'s "refuse to reuse or overwrite an existing tag under any circumstances";
* a GitHub Deployment recorded on success — purpose-built, needs `deployments: write`;
* derive it from the last run of this workflow whose deploy job succeeded — no new state, most brittle.

A fail-closed addition is available under all three: pass the deployed version alongside
`currentTag` and have `assessReleaseRisk` add a reason when they differ ("the previous release was
tagged but never deployed — measuring from it would hide its changes"). That keeps the failure
mode on the safe side whatever the mechanism.

**Owner decision needed: which mechanism.** Nothing here blocks the release in flight.

## ✅ CLOSED — verified in code + mutation-checked (2026-08-25) — the share block's Library row could never render

`ProjectShareLinks` accepts `hasLibrary?: boolean` and its test proves the Library row appears when
it is true — but **neither mount site passes it**. `PermalinkEditor.tsx:220` renders
`<ProjectShareLinks projectId={contentId} permalinkUrl={info.permalinkUrl} />` and that is the only
mount for projects (`ProjectHeader.tsx:364`; the `PlaylistEditorDialog` mount is correctly excluded
by the `contentType === 'project'` guard).

So the block the owner asked for — "all the links are terribly confusing, organise everything" —
lists two of the three addresses. `/{slug}/library` is still reachable only by someone who already
knows the URL shape, which is the exact complaint.

**Same dead-capability class as `MEDIA_DEDUP_STRICT_COMPARE`** (documented, tested, read by nothing —
removed earlier the same day). A prop with a passing test and no caller is not a feature.

**Why it is not a one-line wire.** A library is a PUBLIC SHARE, not a project attribute: the
mini-site reads `GET /api/v1/public/library/{slug}` (`client-web/lib/libraryApi.ts:32`) and 200 comes
back only when a share is active. So the honest signal is "is there a live library share for this
slug", which the editor does not currently hold. Two defensible shapes:

* **surface it** — have the project/permalink payload carry whether a library share is active, and
  pass it through. Correct, costs a field on an existing response;
* **link unconditionally** — show the Library row always. Cheaper, but re-creates the rule the
  podcast row exists to honour: never offer a URL that 404s.

**FIXED, and neither of the two shapes above was the right one.** The server already computes the
answer: `LibraryShareInfo.cleanUrl` IS the `/{permalink}/library` form, returned null unless a LIVE
share (not revoked, not expired — `liveShareForProject`) exists on a project that is public with a
permalink (`LibraryShareService.ts:82`). So the 404 rule is enforced where the truth lives instead
of being guessed in the component, and **no backend change was needed at all** — `api.getLibraryShare`
was already in the typed client.

What shipped:
* the `hasLibrary` prop is GONE (no caller ever passed it, so no caller changed);
* the row reads `library?.cleanUrl ?? library?.url ?? null` — the coded `{title}-{code}/library`
  form is the fallback, so a live share whose project is not public still gets a working link
  rather than no link;
* read ONCE, not polled: a library share is created by a person in another dialog, not derived by
  a job, so there is no build to watch settle;
* a failed read hides that row only — the same trade the audio row already makes.

Mutation-checked, both directions: reverting to the string-built URL fails three tests
(`shows NO library row when the project has no live share`, the coded fallback, and the
failed-read isolation); dropping the `?? library?.url` fallback fails exactly the coded-fallback
test and nothing else. 1820 client-web tests green, typecheck clean.

## ✅ CLOSED (found 2026-08-25, committed same day as `ca7a9d8`) — a deep review of the action-recording research was started and lost; its header outlived it

The working tree carried an uncommitted edit to `RESEARCH-ACTION-RECORDING-2026-08-25.md` that
changed the status line to *"סקירת עומק הושלמה — GO מותנה לבוחר, NO-GO לארכיטקטורת ההקלטה
המקורית"* and added a reading-rule saying sections 6–11 are the revised architectural ruling and
12–17 its English parallel.

**Those sections do not exist.** The file has sections 1–5 and ends at line 270. The verdict —
a conditional GO for the element picker and a NO-GO for the recording architecture as proposed —
was reached somewhere and only its header survived.

**Reverted, deliberately.** A document whose own reading-rule points at sections it does not
contain is worse than one with no ruling: the next reader trusts the status line, goes looking for
the reasoning, and finds nothing. That is the exact failure `CLAUDE.md`'s opening paragraph was
written about.

**What is actually lost:** the reasoning behind the NO-GO — which contracts and blockers the
recording architecture has to close first. The research report itself (sections 1–5: the
recommended architecture, the licence-verified open-source survey for both halves, and the
four-phase build plan) is intact and committed.

**Next:** re-run the deep review before any build starts, and write its ruling INTO the file in the
same pass that changes the status line. The report's own §1 still says "טרם הוחלט על בנייה", which
is now the honest state.

**Update 2026-08-25 — the deep review was re-run and IS written in, but is UNCOMMITTED.** The
working tree now carries 2,647 lines against 264 committed: §§6–11 are the revised ruling in
Hebrew, §§12–17 the full English parallel, and §§1–5 are explicitly marked as the superseded
original proposal. The ruling is a **conditional GO for the visual picker** and a **NO-GO for the
recording architecture as proposed**, with the contracts and blockers enumerated.

So the document is no longer a header without its sections — but it is once again 2,384 lines
living only in a working tree, which is exactly the state that lost the first attempt. **It must be
committed before anything else happens on this branch.**

All 13 evidence claims in §6.3 were re-verified against source on 2026-08-25: **13/13 CONFIRMED**,
no line drift beyond ≤3 lines of leading comment. Two precision notes worth carrying: the
structural `nth-of-type` branch IS single-match by construction, so the uniqueness hole is
specifically the `#id` and `[name]` branches that run before it; and `canary_passed` is public by
OMISSION from `NEVER_PUBLISHED_STATUSES` rather than by an affirmative allow-list entry — a new
proof flow relying on that status would be relying on a doc comment.

## ✅ CLOSED (owner-reported 2026-08-25, merged 2026-08-25 in #145 as `4cdfb12`) — three API bodies were JSON-encoded TWICE

Owner: *"Save bridge — stuck with a bug: A label between 1 and 120 characters is required"*, on a
perfectly good label. Filed as low priority. It was not low priority.

`ClientV1Api.request` owns serialisation — it sets `Content-Type` and calls
`JSON.stringify(opts.body)` itself. Three call sites passed `JSON.stringify(...)` **into** it:

```
JSON.stringify(JSON.stringify({ label: 'x' }))  ->  "\"{\\\"label\\\":\\\"x\\\"}\""
```

Measured: that is valid JSON, Fastify accepts it and parses it back to a **string**. Every handler
does `z.object({…}).safeParse(request.body)`, which fails against a string, and each then returns
its own schema's message — naming the field it wanted rather than the shape it got. The label was
never the problem.

**The blast radius is three endpoints, and the reported one is the least of them:**

| method | consequence | reported? |
|---|---|---|
| `saveBridgePreset` | "Save bridge" could never save | yes |
| **`importSimulation`** | **the `+` import could never import** | **no** |
| `buildAudioEdition` | audio editions could never be requested | no |

**`importSimulation` is the one that matters.** This ledger and the 2026-08-25 handoff both record
the `+` import as **live and shipped** — wired, service working, tests passing. Every real call
from a browser was rejected at the schema. *A feature can be fully built, fully tested, and never
once have run.* Nothing in the suite could see it, because the tests exercise the service and the
route, and the defect lives in the one hand-maintained file between them.

**Why it survived:** `shared/src/generated/` is hand-maintained (CLAUDE.md §5) — nothing generates
`client-v1.ts`, so a call site disagreeing with `request()` breaks no build. Six call sites pass a
plain object; three did not, and the difference is one `JSON.stringify` on a line that reads
perfectly naturally.

**Two guards, each mutation-proven separately.** `request`'s `body` is typed `object`, so a
pre-serialised string fails to COMPILE (`TS2322: Type 'string' is not assignable to type
'object'`). And `apiClientBody.test.ts` drives the real client against a recording fetch, parsing
the wire bytes the way Fastify would. The type stops the known mistake; the test stops any other
route to the same wire shape.

**Lesson for the ledger, not just the fix:** "shipped" was asserted from merged code and green
tests. Neither is evidence that a user path executed. The `+` import needed one manual click to
disprove, and never got one.

## 📋 PR #141 (opened 2026-08-25) — action-recording Phase 0

`feat/action-recording-phase0`, seven commits, **zero behaviour change** — docs, fixtures and tests
only. Carries the deep review (§ the entry further down), the owner-approved ADR, the nine-shape
golden fixture package, three mutation-proven test files, and M2's measured byte half. Phase 0 exit
criteria 6 of 9. Belongs to the action-recording round opened by the research report.

The two live defects it uncovered — `ui_hide` silently failing, and the publicly-served
`canary_passed` — are **not** in it. They are 🔴 entries below with their own PRs, deliberately, so
a research branch does not carry viewer- and serving-behaviour changes.

## ✅ OWNER-APPROVED (2026-08-25) — the action-recording ADR, and four rulings with it

Approved in one pass, after the evidence below was measured rather than argued. Recording the
approvals separately from the work, because "the owner approved this" and "the code proves this"
are different claims and a ledger that blurs them is worth less than one that admits the difference.

1. **The ADR is approved** — `md-files/ADR-ACTION-RECORDING-SEMANTICS.md`. Its twelve decisions are
   settled and the build may not reopen them. Approved with exit criteria 4, 6 and most of 8 still
   open, on the explicit ruling that none of them can move a §2 decision.
2. **The public-status fix is ordered, and the order IS the fix.** Release N inverts
   `isRevisionStatusPublic` to an allow-list; `proof_pending`/`proof_passed` land in a LATER
   release. Shipping a new status first would have older images serve exactly the unproven bytes it
   was added to protect, because an unknown status is currently public.
3. **The `ui_hide` defect waits for Phase 1** rather than getting its own patch. Measured: escaping
   alone converts "the wrong control was hidden" into "the control is not offered at all", because
   a correctly escaped selector carries a backslash and four separate copies of `/[{}<\\]/` drop it.
   The real fix is LocatorV1 — locator ids on the wire instead of selector strings — which is the
   same fix. Patching ahead of it would ship a second silent failure mode.
4. **M2's target is 1KB gzip dormant, not the report's 5KB.** Measured: the rAF gate is already
   5,878 gzip bytes on every entry document, so a 5KB bootstrap would nearly double what every
   viewer downloads to buy a capability only an author reaches. The serve-time precedent
   (`SIM_BOOT_SNIPPET`) is 457.

## 🟢 IN PROGRESS (2026-08-25) — action recording, Phase 0

Per the report's own final recommendation: **not** the original Phases B–D, but a short Phase 0
(blocking ADRs and spikes) and a hardened picker first, then one vertical slice.

Delivered so far:

- **`md-files/ADR-ACTION-RECORDING-SEMANTICS.md`** — the twelve decisions the build is not allowed
  to re-open (data-not-code, reload-document default, entry-relative clock with restart-on-seek,
  no generic click, blocking locator diagnostics, non-public proof state, ephemeral raw capture,
  tri-state picker with list fallback, typed LLM patches, zero new dependencies), the five Phase-0
  measurements that are deliberately left open, the module boundaries, and the exit criteria.
- **`backend-api/src/scripts/fixtures/controlsFixture.ts`** — the golden fixture package, emitted
  as `controls` by `gen-sim-fixture.ts` through the same `emit()` as every other package, so it
  carries the real gate, the real boot snippet and the real combined bridge. Nine DOM shapes, each
  present because something in the code or a cited standard says it will fail: vanilla controls, a
  faithful React controlled-input value-tracker, node replacement under a stable id, CSS-special
  ids, a duplicate id, radio and checkbox groups sharing a `name`, a `display:none` Advanced panel,
  an interactive canvas, and a button gated on `event.isTrusted`.

That fixture is what produced the 🔴 `ui_hide` entry above.

**Completed after the approval** (same branch, PR #141):

- **`rafGateRuntimeScanner.test.ts`** — the gate's control scanner, EXECUTED in jsdom against the
  fixture, with every emitted selector resolved. Mutation-proven both directions.
- **`sim-public.localParity.test.ts`** — the local-disk serve branch, which had no test, and its
  parity with cloud, which had none either. It doubles as the exit-criterion-3 proof: a
  legacy-shaped stored document gains the capability at serve time, on both storage paths, with the
  stored bytes untouched.
- **`actionPlanScheduler.test.ts`** — one handle ever, pause/resume on the REMAINING delay, rate,
  restart-on-seek, adapter seek both ways, graded drift. Four mutations; the fourth initially
  survived and produced a second test on a deliberately leaky clock.
- **`actionPlanLifecycle.test.ts`** — one reset generation, ordered generation-stamped barriers,
  per-barrier deadlines, and a reveal that is emitted from exactly one place after freshness is
  re-checked. Five mutations, all caught. Writing them found a real bug in the coordinator:
  generation 1's freshness evidence vouched for generation 2 whenever both landed on the same
  documentId, which after reloading the same section is the ordinary case.

**Phase 0 exit criteria: 8 of 9 met, the ninth partial.** Criterion 4 is PR #142. What remains is
M1 and M3–M5 — fresh-document proof p95, draft TTL, reload cost and the rebase source hash — all of
which need a running stack or a browser, and none of which can move a settled ADR decision.

A note worth keeping: `pnpm --filter backend-api typecheck` runs `tsconfig.json`, which EXCLUDES
`*.test.ts`. "Typecheck clean" therefore says nothing about a test file, and vitest runs TypeScript
without checking it. `deploy/scripts/typecheck-tests-ratchet.sh` is the only thing that looks, and
it caught this branch. Run it before claiming a test file typechecks.

## ✅ CLOSED — fixed + mechanism proven (2026-08-25) — `release:verify` was not a gate: its exit code was `tee`'s

**`CLAUDE.md §4` calls `release:verify` "the real gate, and it is what CI runs". In the RELEASE
workflow it could not fail.**

```yaml
run: pnpm release:verify 2>&1 | tee "$ART/release-verify.log"     # release.yml:236, before
```

A `run:` step with no explicit `shell:` runs under GitHub's default `bash -e` — which does **not**
set `pipefail`. So the step's status is `tee`'s, always 0. Proven locally, not asserted:
`bash -e -c 'false | tee /dev/null'` → **exit 0**; with `set -euo pipefail` → **exit 1**.

**This already shipped a failure to production.** Run `32854681109`, the v0.2.5 release, printed
in that very step:

```
backend-api lint: ✖ 8 problems (1 error, 7 warnings)
backend-api lint: Failed
```

…and the job reported **success**, the pre-deploy gate passed, and it deployed. The error was real:
`simFileResolver.ts:76` initialised `blobKey` to null where the catch returns, so the initialiser
was dead code (`no-useless-assignment`). PR #140's `ci.yml` lane caught it immediately — **`ci.yml`
sets `pipefail` and `release.yml` did not**, so the weaker check was the one guarding production.

**Both fixed here:** the dead initialiser is gone (declared without one, since the catch returning
is what makes the assignment total), and line 236 now sets `set -euo pipefail` — matching the
**eleven** other piped steps in the same file that already did. This was an isolated one-line
`run:` among multi-line blocks that all got it right, which is exactly how it survived review.

**Related gap, NOT fixed — owner's call.** `SENSITIVE_PATH_PATTERNS` covers `deploy/docker-compose`,
nginx and systemd, but **not `.github/workflows/`**. So this very PR — which edits the release
pipeline's own verification gate — does not require human approval, while a one-line `APP_VERSION`
change to compose did. If deployment configuration deserves an eye, the pipeline that decides what
deploys deserves one at least as much.
