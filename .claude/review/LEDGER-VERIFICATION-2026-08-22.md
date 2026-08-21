# Ledger verification sweep — the open tail

**Date:** 2026-08-22 · **Tree:** `/Users/ofeklevy/cebu` @ `7ebe9cc` · **Method:** adversarial re-verification, code + tests, no production access

---

## 1. Headline

**93 of the adjudicated findings are real and still live.** That is the number to work from.

The open tail held 235 never-checked findings. This sweep returned **164 individual verdicts** — the
canonicals; the remaining 71 ids resolve through the ledger's alias/cluster mechanism and were not
separately adjudicated (see §6, which explains why that mapping must not be trusted for a bulk close).

| Verdict | Count | Share of 164 |
|---|---:|---:|
| CONFIRMED — real, still live | **93** | 57% |
| ALREADY_FIXED — closed by work that landed since | **65** | 40% |
| REFUTED — the claim is false | **6** | 4% |

Severity of the 93 confirmed, **as it stands today** (not as originally filed):

| Severity now | Count | Action split |
|---|---:|---|
| P1 | **2** | both `fix-now` |
| P2 | **41** | 20 `fix-now`, 19 `schedule`, 2 `needs-owner` |
| P3 | **50** | 45 `schedule`, 5 `needs-owner` |

Totals by action across all 164: **22 fix-now · 69 schedule · 7 needs-owner · 66 close.**

Two facts worth pulling out of that table before anything else:

1. **40% of the tail was already dead.** Sixty-five findings had been fixed by work that landed since
   they were filed, and in most cases the fixing commit names the finding id in a comment. That is the
   review loop working — but it also means the ledger was carrying 65 items of false debt.
2. **Severity moved down, not up.** Of the 93 confirmed, the verifiers *downgraded* far more than they
   escalated: only two escalations (`test-quality-015` to P1, `job-queue-011` to P1), against dozens of
   drops to P3 on reachability grounds. Several findings survive as facts while their stated
   consequence does not (`job-queue-010`, `job-queue-012`, `security-013`, `security-014`).

---

## 2. Confirmed, ranked by severity as it stands today

Ranked by `severityNow`, not by the severity on the original ticket. Each entry: the claim, the failure
scenario a verifier could actually construct, and the first step.

### P1 — 2

#### `job-queue-011` — a rollback crash-loops the only worker container, and the health gate says it worked
*Claim:* there is no expand/contract rule for queue names, and `rollback.sh` re-points `APP_VERSION`
without checking out the old tree.
*Scenario:* rollback runs. The **new** `docker-compose.yml` hands the **old** image
`WORKER_QUEUES=…,dub`. `resolveWorkerQueues` (pgBossDriver.ts:157-162) throws on the unknown name,
`worker.ts:38-41` exits 1, and `restart: unless-stopped` crash-loops the only container that runs
background work. `rollback.sh`'s `wait_healthy` checks backend, client-web, admin-web and nginx — not
`worker` — so the rollback reports healthy while all background processing is dead.
*First step:* add the `git checkout` of the target tag to `podcast-saas/deploy/scripts/rollback.sh`
(mirroring `deploy.sh:57`), add `worker` to `wait_healthy`, then make `resolveWorkerQueues` skip an
unknown queue name with a warning instead of throwing — that is the expand/contract rule, and it is
what makes the next name addition survivable in either direction.

#### `test-quality-015` — RUM field refinement is silently dead in production, and its tests cannot see it
*Claim:* `RumService.fieldAggregates` binds a raw `Date` into a raw `sql` fragment; drizzle's
postgres-js session sends it via `client.unsafe(query, params)`, where no type OID is inferred and Bind
serialises it as `'' + x`, i.e. `Date.prototype.toString()`.
*Scenario:* real Postgres rejects that string — verified: `time zone "gmt+0300" not recognized`. The bare
`catch` at RumService.ts:456-464 turns the rejection into an empty `Map` plus a `logger.warn`, so field
refinement **never runs in production** and nothing surfaces it. The tests stay green because PGlite's JS
driver serialises `Date` itself. The catch's own comment records that this exact failure mode already
shipped once.
*First step:* `${cutoff.toISOString()}::timestamptz` at RumService.ts:440 — the sibling
`reapRumEvents` at :252-262 already does exactly this and says why. Then extend
`rumService.test.ts`'s `params.filter(p => p instanceof Date)` assertion (currently only at :305-312) to
the `fieldAggregates` block, and narrow the catch so a query error is distinguishable from "no data".

### P2 — 41

#### Storage and media authorization

**`security-001` — public-bucket media URLs are unrevocable permanent grants.**
`SupabaseStorageAdapter.getPublicUrl` returns the raw `/object/public/` bucket URL; production is
`STORAGE_BACKEND=supabase`; only STEP 1 of the four-step migration landed.
*Scenario:* a viewer reads `hls_url` from player-config, keeps it, and keeps fetching after the project
goes private, the share token rotates, or a purchase is refunded. Presigned download TTLs are fiction
because the same object also answers unsigned. This round's dubbing work widened the surface
(`buildPlayerConfig.ts:562-563`).
*First step:* STEP 3 of the in-repo checklist — mint `/hls-proxy/t/{token}/` URLs in
`buildPlayerConfig` instead of calling `storage.getPublicUrl`, including the new dub site; then STEP 4,
private bucket.

**`security-005` — `/sim-public/*` never looks at the owning project.**
Only guards are `startsWith('simulations/')` and a traversal check.
*Scenario:* project P is `visibility='private'`; its sim entry URL appears in a player config, share
preview or browser history; anyone with that string fetches the full package — HTML, JS, data — anonymously,
forever.
*First step:* make `mediaKeyScope`/`canServeMediaKey` prefix-complete (add `simulations/`, `podcasts/`)
or route every serve handler through one authorization function. One change closes `security-016` too.

**`security-016` — user source documents live under a prefix modelled as public.**
`podcasts/` is in `PUBLIC_LOCAL_PREFIXES` and returns public-bucket URLs on Supabase; the prefix was
chosen for immutable studio clips, and source documents were added to it without revisiting that.
*Scenario:* a confidential brief uploaded to an episode is readable by anyone who obtains the URL — a
screenshot, a proxy log, a browser sync — with no credential.
*First step:* same gate fix as `security-005`; separately, move source documents off the public prefix.

**`simulation-007` — publication is gated, visibility is not.** *(needs-owner)*
The revision publication gate now exists and names the finding; there is still no project lookup, no auth
and no token, and `isRevisionStatusPublic` returns true for an unknown status so legacy keys serve
unconditionally.
*Scenario:* unsharing a project does not revoke access to its simulation package.
*First step:* owner decides the sim-public policy (token-scoped URL vs project-visibility lookup), then it
lands in the same gate as `security-005`.

#### Resource exhaustion on a 2-vCPU host

**`security-007` — six multipart routes still `toBuffer()` the whole file.**
`UPLOAD_MAX_BYTES` covers four routes; images, playlists, avatar knowledge-docs and two thumbnail paths
either have no size check or check *after* the allocation.
*Scenario:* an authenticated user POSTs 1.9 GB to `/api/v1/projects/:id/images` with
`Content-Type: image/jpeg`. MIME passes, `toBuffer()` materialises 1.9 GB in the Node heap, the API is
OOM-killed, and every other tenant's in-flight request dies with it.
*First step:* extend `UPLOAD_MAX_BYTES` to the six routes and convert them to the
`declaredTooLarge()` + `withBoundedTempFile`/`readStreamBounded` pattern already shipped in
`audio.controller.ts:93-114`.

**`config-003` — no `cpus`, `mem_limit` or `deploy.resources` on backend or worker.** *(fix-now)*
The shape exists in the same directory (`docker-compose.export-worker.yml:48-50`), so this is an omission,
not an unsupported feature.
*Scenario:* the `security-007` OOM is not confined to the container — it takes the host down, along with
nginx and every other service on it.
*First step:* copy the `mem_limit`/`memswap_limit`/`cpus` stanza onto `backend` and `worker`, sized below
host RAM. This is the containment half of `security-007` and of `anam-latency-008`.

**`media-009` — nothing compares expected frame bytes against the capture container's tmpfs or cgroup.**
Frames are written to `os.tmpdir()`, which inside the container is a 512 MiB RAM-backed `/tmp`, and the
adapter then *copies* them to `/output` — both copies resident at peak, both charged to the 2048 MiB cgroup
alongside Chrome.
*Scenario:* a 70s sim section at 1920x1080@30 is 2100 JPEGs at ~250 KB ≈ 525 MB into a 512 MiB tmpfs →
`writeFile` ENOSPC or cgroup OOM (exit 137) → the boundary reports "exited 137 with no readable
result.json" → poster fallback, or a failed export under `forbid`, with nothing in the message naming the
tmpfs.
*First step:* compute expected bytes from window duration × fps × mean frame size before the container
starts, refuse or size `tmpfsScratchMb` accordingly, and move `framesDir` to a disk-backed volume rather
than `/tmp`.

**`database-005` — the hottest read path fetches every scene's transcript to use four scalars.**
`db.query.scenes.findMany` at `buildPlayerConfig.ts:229` has no `columns:` narrowing, so `transcript`
(text) and `aligned_words` (jsonb word-level alignment) come back on every row — and `allScenes` is only
consumed when `avatarCircles` is configured.
*Scenario:* every player-config, share, playlist-item and course render pays a full transcript read; for
projects without circles it is pure waste. The same `Promise.all` narrows elsewhere, so `scenes` is the
outlier.
*First step:* add `columns: { script_version, speaker, start_ms, end_ms }` and gate the query on
`avatarCircles` being configured.

**`performance-009` — katex and chart.js ship in the initial JS of every public viewer route.**
The Anam SDK half was fixed (dynamic chunk 8034, preloaded on hover), but `AvatarConversation` imports
`VisualPanel`, which imports `EquationRenderer` and `ChartRenderer` at module scope, and `next/dynamic`
appears nowhere in client-web.
*Scenario:* ~465 KB of unnecessary initial JS on `/[slug]` and `/v/[shareToken]` for every viewer,
including those who never open the avatar.
*First step:* `next/dynamic` the two renderers inside `VisualPanel.tsx:5-6`.

#### Multi-tenant authorization

**`security-009` — a knowledge-document DELETE never proves the document belongs to the project.** *(fix-now)*
`request.params.docId` goes straight to the vendor. `resolveAnamKeyForProject` returns undefined unless
BYOK is enabled *and* the owner stored a key, so the default deployment sends every tenant's request under
one shared platform Anam key.
*Scenario:* user A owns project PA and calls
`DELETE /api/v1/projects/PA/avatar/knowledge/documents/{docId of another tenant's project PB}`. The
document is destroyed in the shared Anam account, degrading PB's avatar, with no audit trail on this side.
*First step:* scope the delete by `cfg.knowledgeGroupId` exactly as the sibling GET at
`avatar.controller.ts:1502-1506` already does — extract one helper and reuse it for `security-008`.

**`security-011` — Firebase ID tokens are written to the nginx access log.** *(fix-now)*
The `?token=` fallback is read in the shared `firebaseAuthMiddleware`, so it is accepted on *every* route
that uses it as a preHandler, while only one client call site sends it that way. nginx logs `"$request"`
(path + query) and `access_log off` is scoped to the port-80 `/healthz` location only.
*Scenario:* live credentials sit in the `nginx_logs` volume, in browser history, and in `Referer` headers.
The app's own logging was hardened (`safeRequestPath`), which is why this reads as fixed at a glance.
*First step:* restrict the query-token fallback to the two SSE routes that need it, and strip the query
string from `log_format main` on the `${DOMAIN_API}` vhost.

**`backend-011` — a throw inside a fire-and-forget failure handler terminates the API process.** *(fix-now)*
Both chains end in `.catch(async (err) => { await db.update(...) })` with nothing handling the promise
`.catch()` returns. Node 22, no `process.on('unhandledRejection')` anywhere in `src/`.
*Scenario:* `err.message` carries a NUL byte (Postgres rejects it in text), or the DB faults at the exact
moment processing failed → unhandled rejection → process termination. `restart: unless-stopped` makes it a
restart rather than an outage, which is why it is P2 and not higher.
*First step:* wrap both catch bodies (`simulations.controller.ts:266-273`, `:562-569`) in their own
try/catch, and register a process-level `unhandledRejection` logger.

#### Configuration and supply chain

**`config-012` — the frontend CSP has no production branch.**
`script-src 'self' 'unsafe-inline' 'unsafe-eval' https:` plus `connect-src 'self' https: wss:`, used by
both `next.config.ts` files for the real header. The only `dev` conditionals *add* to the policy.
*Scenario:* script-src provides zero XSS containment. It stays P2 rather than higher only because
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` and an enumerated
`frame-src` do lock the ambient surface.
*First step:* add a production branch in `shared/src/csp.ts` with a per-request nonce; extend
`incident-regressions.test.ts` to assert the prod policy, not just that the builder is used.

**`dependency-006` — the ffmpeg "pinned static build" is not pinned.**
`ARG FFMPEG_BUILD=ffmpeg-n8.1-latest-linux64-gpl-8.1` fetched from the BtbN `latest` release tag; only the
major/minor is fixed, and the bytes are re-uploaded nightly. No `sha256sum`, no cosign, no
`--output-verify`.
*Scenario:* a rebuild silently changes the binary that runs the entire media pipeline. The comment
asserting a guarantee the command does not provide is what makes this worth P2.
*First step:* pin a dated release tag and add a checksum verify step to
`backend.Dockerfile:56-62`; do the same for the `DOCKER_CLI_VERSION=27.5.1` tarball at :69-75.

**`database-010` — one env var, three interpretations.**
`parseDbUrl` reads five fields and never touches `u.search`, so `sslmode=` is silently dropped and TLS is
decided by a hardcoded `.supabase.co`/`.supabase.com` suffix; `pgBoss.ts:181-188` duplicates that suffix
rule; `migrate.ts:477` passes the URL whole to postgres.js and therefore honours query params the app drops.
*Scenario:* latent for today's Supabase hosts. A custom domain, an IP, or a provider migration sends the
database password across the network in plaintext with nothing logged.
*First step:* one shared connection-config module that honours the URL's query parameters and fails closed
on an unrecognised host; delete the duplicated suffix check.

#### Playback and export correctness

**`broll-data-008` — nothing defines or prevents overlapping timeline sections.** *(fix-now)*
No `EXCLUDE` constraint in any migration; `TimelineSectionViolationCode` has no overlap member.
*Scenario:* the viewer and the export planner each invented a tie-break, and they disagree — the planner
even emits a warning promising "the viewer's stacking order decides which is visible", a stacking order
the viewer does not have.
*First step:* add an `overlap` violation code plus writer-side rejection, and extract one shared resolver
both sides call. Same fix as `broll-player-002`.

**`broll-player-002` — the viewer and the export pick different overlapping clips.** *(fix-now)*
Viewer: `[...broll_clips, ...clip_overlays]` then first match. Export: `LAYER_PRIORITY`, then greater
`startF`, then greater `order`.
*Scenario:* A(`sort_order=1`, offset 35, 10s) and B(`sort_order=2`, offset 40, 10s); at t=42 the viewer
shows A and `resolvePlan.ts:166-172` picks B. Cross-lane is worse — a `clip_overlay` can never beat any
`broll_clip` in the viewer regardless of times. What the author previews is not what the master contains.
*First step:* move `resolvePlan`'s rule into `shared/` and call it at `useProjectPlayer.ts:2409` and the
second first-match at `:2904`.

**`media-003` — the capture sanity gate discards correct frames from canvas-free simulations.** *(fix-now)*
The sampler returns `'null'` for any document with no `<canvas>`, so `samples` stays empty and the gate
fails on both `enoughSamples` and `intraFrameNonUniform`. `SIM_PAINTED` fires from the first rAF callback
and is canvas-independent, so the handshake completes and correct JPEGs are written before the gate throws
them away. A canvas drawn once and never animated fails `interFrameDelta` for the same reason.
*First step:* fall back to a full-viewport screenshot hash when `cs.length === 0`, and treat "no canvas" as
not-applicable rather than as a failed sample.

**`simulation-008` — every republication leaks the previous revision's posters, forever.** *(fix-now)*
`posterService.invalidate()` has exactly one caller and it is an operator script; `cleanupOrphans()` has no
caller at all. The production activation path touches no poster, and the scheduled `revisionGcSweep`
mentions posters nowhere.
*Scenario:* unbounded growth of `sim_posters` rows and storage objects that no future key will ever name.
*First step:* call `invalidate()` from the two real activation sites
(`SimulationService.ts:3409-3417`, `RevisionDerivation.ts:454`) and give `revisionGcSweep` poster
handling — but fold it into the standing Supabase storage census rather than deleting in isolation.

**`simulation-009` — an aborted section's error is stamped with the live section's identity.** *(fix-now)*
`runMaybeAsync`'s rejection handler reads the module-level mutable `current` at settle time instead of the
activation captured at call time. Broader than reported: the async success path has the same defect —
`finish` posts `SECTION_APPLIED` against `current` too.
*Scenario:* section A has an async `prepare()`; the viewer scrubs to B; `releaseCurrent('superseded')`
aborts A's signal and sets `current = {B}`; A's prepare rejects on the abort; the child posts
`SECTION_ERROR` carrying **B's** activationId/variantKey/configHash; the parent's `matchesActivation`
passes and `failModern` kills a healthy section B.
*First step:* capture `var activation = current` at call time and re-check identity before posting —
`onPresent` at `simRuntimeChild.ts:837-845` already does exactly this and calls the alternative "a forged
match". Apply it to both the reject path (:1097) and `finish` (:814-818).

#### Queue and job durability

**`job-queue-013` — the inline fallback runs encodes on the request-serving tier.** *(fix-now)*
The named example is closed (`project_export` is in `NEVER_INLINE`), but `pgBossSend`'s catch still runs
the inline handler in the API container for every other durable kind.
*Scenario:* the queue database is unhealthy — the worst possible moment — and the API starts `transcode`'s
full HLS ladder for a source up to 2 GB, or `podcast_render` (TTS + ffmpeg stitch), or `dub` (ffmpeg mux +
HLS), in-process, while still serving requests.
*First step:* extend `NEVER_INLINE` to every CPU-bound kind and let `enqueueJob` throw, as it already does
for export.

**`job-queue-014` — test files are not type-checked, and the drift has already recurred.** *(fix-now)*
`tsconfig.json` excludes `src/**/*.test.ts`, and `tsconfig.test.json` is referenced by no script and no CI
file. `routing.test.ts`'s exhaustive `{ [N in JobName]: … }` map still has 4 of 12 names, and
`durability.test.ts`'s map is missing `dub` — with the suite green.
*Scenario:* a job name is added, the exhaustive maps silently stop being exhaustive, and the gap ships.
This is the mechanism that let `job-queue-011` reach P1.
*First step:* add a `typecheck:test` script running `tsc --noEmit -p tsconfig.test.json` to CI and fix the
four current errors.

#### LLM pipeline

**`llm-pipeline-007` — prompt caching is plumbed into the provider and wired to nothing.** *(fix-now)*
`ClaudeProvider` honours `systemPromptCacheable`/`systemPromptCachePrefix`, but no production caller sets
either, `SendStructuredOpts`/`SendTextOpts` do not declare them, and `_sendStructuredOnce`'s payload does
not forward them — so every Claude call takes the default branch and cache-writes the whole system prompt.
*Scenario:* ScriptRoom's compiler system prompt embeds `JSON.stringify(draft.turns)`, i.e. is unique per
call by construction, so every call pays a full cache write for a cache that can never hit.
*First step:* add the two fields to the opts types, forward them in the payload, and set a stable prefix
boundary at ScriptRoom's call sites.

**`llm-pipeline-011` — `sendText` has neither reasoning controls nor a quota block.** *(fix-now)*
Its payload carries only model/systemPrompt/userPrompt/maxTokens/temperature, and the generation-quota
check exists only in `_sendStructuredOnce`.
*Scenario:* GuidanceService's pass-1 deep analysis is task `guidance_plan`, tier `complex`, and goes through
`sendText` — so the product's deepest reasoning call runs thinking-off and un-metered against the cap.
*First step:* hoist the quota block and the reasoning payload into a shared preamble both entry points call.

**`llm-pipeline-016` — the compile pass has no proportional floor.** *(fix-now)*
The only guards are `directed.turns.length >= compiled.turns.length` and an all-or-nothing fallback when
`out.length === 0`.
*Scenario:* a compiler that returns 3 turns from a 60-turn draft passes both, is hashed, and the script is
written `status: 'ready'` / episode `script_ready` — a gutted paid deliverable marked complete.
*First step:* add a ratio floor before the hash and fall back to the draft below it.

**`llm-pipeline-012` — the parse-retry loop has no backoff and escalates the tier mid-task.**
No `setTimeout`/`sleep` anywhere in `LLMService`, and `resolveProviderAndModel` swaps the model — possibly
the vendor — once `(retryCount ?? 0) + attempt >= complex_min_retries` (default 2).
*Scenario:* three immediate re-invocations against a provider that is rate-limiting, the third against a
different model than the caller asked for.
*First step:* bounded jittered backoff between attempts; make the escalation explicit and logged rather
than an emergent property of the attempt counter.

**`llm-pipeline-013` — system prompts are edited in place with no bound, no history and no provenance.**
`PUT /api/admin/v1/system-prompts/:key` validates only `z.string().min(1)`; `system_prompts` has no version
column; ScriptRoom's telemetry records provider/model/cost and no prompt revision.
*Scenario:* a prompt edit changes every downstream deliverable with no way to attribute a regression to it
or roll it back.
*First step:* add `.max()`, a revisions table written on every update, and stamp the revision id into
ScriptRoom telemetry.

#### Operations, scripts and tests

**`observability-005` — 13 raw `console.*` calls in the transcode job, including the terminal status.**
Interleaved with structured pino calls in the same function, so half the job's status trail is
unstructured text in an NDJSON stream, unaffected by `LOG_LEVEL`, and now also missing the `cid` the pino
mixin stamps on everything else.
*First step:* replace them with the module logger and add an eslint `no-console` rule for `src/` outside
`scripts/`.

**`scripts-ship-005` — a rejected production deploy is journalled as approved.** *(fix-now)*
The remote-approval poll infers approval from the **absence** of a pending deployment, and a rejection in
the GitHub UI removes the pending deployment exactly as an approval does. Nothing anywhere reads the
deployment's review state; `gh.ts`'s `reviewDeployment` is write-only.
*Scenario:* an operator rejects a production deploy; the conductor writes "production approved on GitHub"
and sets the verdict to `RUNNING`.
*First step:* add a review-state accessor to `gh.ts` and read the decision instead of inferring it from a
disappearance. Same root as `scripts-ship-003`.

**`scripts-ship-003` — the approval gate discards a decision it already accepted.**
Ctrl-C at the gate persists `AWAITING_APPROVAL` by design; `ship approve` is then accepted and prints "the
running conductor will act on it within a few seconds" with no conductor running; `ship resume` re-enters
`stageApproval` (status `running`, so `done()` is false) and `rmSync`s the APPROVE file before waiting again.
*First step:* persist the decision into the run journal at `cmdDecision` time and have `stageApproval` read
the journal before the sentinel file.

**`scripts-ship-004` — nothing prevents two shipments at once.**
`cmdRun` mints a fresh runId and calls `setCurrent` unconditionally; `setCurrent` is a plain
`writeFileSync` with no `O_EXCL`, no pid and no staleness check. `state.ts:5` admits it is "a pointer, not
a lock".
*Scenario:* two concurrent `pnpm ship` runs each open or adopt a PR, merge, and dispatch a release against
the same base.
*First step:* `O_EXCL` lock with pid + mtime staleness in `setCurrent`; `cmdRun` refuses on a live lock.

**`scripts-ship-010` — `NaN` disarms the destructive-backfill ceiling.** *(fix-now)*
`Number(argValue('--max-affected') ?? '50')` is `NaN` for a missing or malformed value, and the ceiling
test is `totalAffected > maxAffectedRows`, which is false against `NaN`.
*Scenario:* an `--apply` run of unbounded rewrites passes the gate without `--approve-unsafe`. Not only a
typo path: `ops/release/src/cli.ts` does `Number(flags.get('max-affected'))` and `remote-commands.ts`
stringifies the result, so `--max-affected foo` travels to the VM as the literal `'NaN'`. Same defect in
`backfill-avatar-circles.ts`.
*First step:* one shared arg parser that rejects a missing value, a value starting with `--`, and a
non-finite `Number` — then apply it to both scripts and to `scripts-ship-011`.

**`scripts-ship-011` — `--sim` with no value silently becomes "every simulation".**
`out.simId = argv[++i]` leaves `simId` undefined and `main()` falls to the unscoped branch: every
simulation with `active_revision_id IS NULL`, capped only by `--limit` (default 25), each copying a whole
package through the Node heap into a new prefix. `--sim --dry-run` is worse — it swallows the flag, so
`dryRun` stays false.
*First step:* the same shared parser; the repo's own correct pattern is at
`backfill-bridge-capabilities.ts:378` (`--limit=<n>` + `Number.parseInt`).

**`scripts-ship-013` — a seed script guards storage and not the database.** *(fix-now)*
`seedGuards.ts` contains one predicate and it is storage-only. `assertLocalStorageOnly` runs immediately
before `wipe()` and the inserts; nothing anywhere inspects `DATABASE_URL`'s host.
*Scenario:* `STORAGE_BACKEND=local` with a production `DATABASE_URL` wipes and seeds a public
`[SYNTHETIC]` project into production — precisely the standing "never touch prod from local" rule.
*First step:* add `assertLocalDatabase(DATABASE_URL)` with an explicit `ALLOW_NONLOCAL_DB` escape hatch and
call it beside `assertLocalStorageOnly` in every wipe/seed script.

**`scripts-ship-012` — the fixture manifest is written last, so a mid-run throw orphans everything.**
`writeFileSync(FIXTURES_FILE, …)` is the final statement of `create()`, after all ten blocks; block 10
queries real `video_files`/`projects` — a realistic place to throw; `cleanup()` is entirely
manifest-driven and returns "No manifest; nothing to clean." The outer `finally` calls `process.exit`, not
a flush.
*First step:* append to the manifest after each block and flush it in a `finally`.

**`scripts-ship-015` — the storage self-check leaks its own probe objects on failure.**
The three cleanup deletes are the last statements of the `try`; the first is not even `.catch()`-guarded,
so its own failure skips the other two; the `catch` does no cleanup and there is no `finally`. The
multipart catch only logs — `abortMultipartUpload` is never called.
*Scenario:* a throw from the presigned GET/PUT leaves `_selfcheck/probe-*`, `presigned-*` and a 55 MB
`multipart-*.bin` in the bucket, plus an in-progress multipart upload holding whatever parts landed.
*First step:* move cleanup to a `finally`, guard each delete, and call the already-implemented
`abortMultipartUpload` (`SupabaseStorageAdapter.ts:268`) in the multipart catch.

**`scripts-ship-016` — an unbounded rewrite script with no drift check.**
The only guard is `--apply`; it iterates every `status='ready'` simulation and uploads unconditionally. No
`--sim`, no `--limit`, no re-read before the PUT — and a network `fetch` fallback sits in the read-to-write
gap.
*Scenario:* a concurrent guidance publish, which rewrites the same entry HTML, is silently reverted.
*First step:* add `--sim`/`--limit`, a content re-read and drift check before the PUT, and the backup
precondition its sibling `rebuild-sim-bridges.ts` documents at :12-14 and :117-125.

**`test-quality-001` — billing and the Stripe webhook have zero tests anywhere.**
The headline number was wrong (21 of 30 v1 controllers are covered, not 22%), but the specific risk
survives: `billing.controller.ts` and `stripe-webhook.controller.ts` have no test file in the tree, and
the raw-body suite exercises the plumbing, not the handler.
*First step:* a request-level webhook suite (signature verification, replay, idempotency) and coverage of
billing's checkout/refund paths.

**`test-quality-007` — no test anywhere asserts a non-zero ffmpeg exit.**
The fake ffmpeg emits `close 0` and only `close 0` — one emission in the whole file — and the three
rejection tests all come from the conformance gate, never from the process failing.
*Scenario:* ffmpeg dies mid-transcode and the handler's behaviour — partial uploads, temp-file cleanup,
error shape — is entirely unverified.
*First step:* parameterise the fake's exit code and add failure cases asserting cleanup and error
classification.

**`security-002` — avatar capability and budget enforcement are both dark.**
`capabilityMode()` and `budgetMode()` default to `'shadow'` and neither env var is set in any compose file,
so the 401 at `avatar.controller.ts:373-376` never fires and budget refusals are computed then discarded.
What still binds is a per-process burst shield that resets on deploy.
*Scenario:* an attacker distributes `POST /api/v1/avatar/start` across N addresses naming any public
project's UUID. Each replica permits ~6 starts/min/IP and resets on every deploy; the durable cluster-wide
cap computes a refusal and drops it, so billable Anam sessions are minted on the platform key with no
cluster ceiling. Note: "unauthenticated" is deliberate — anonymous avatar use is intended product
behaviour, so requiring Firebase auth is explicitly *not* the fix.
*First step:* finish step 3 of the documented 5-step ordering in `.env.example:230-231` (wire the
capability into every client surface), then flip the two modes to `enforce` in compose.

**`ui-ux-006` — the editor timeline is mouse-only.** *(needs-owner)*
The V1 video track is a bare `<div onMouseDown onClick>` with no role, tabIndex or key handler; the only
`<input type="range">` in the file is a volume slider in a popover; the only window keydown handlers are
mode-scoped Escape and Delete.
*Scenario:* a keyboard-only editor reaches the B-roll panel and the volume slider and cannot move the
playhead, select a clip, trim an edge or place a section. WCAG 2.1.1 on the core editing surface. Commit
`384a782` shipped every other ui-ux a11y finding and excluded this one in its own message as "a feature,
not a defect fix" — which is why it needs an owner, not a fix ticket.
*First step:* owner decides scope. The minimum is a focusable track with arrow-key playhead movement and
Enter-to-select.

### P3 — 50

Real, verified, and bounded — almost all by reachability rather than by a fix. Ordered by area.

| id | Claim | Failure scenario | First step |
|---|---|---|---|
| `performance-005` | Simulation zip is fully buffered and `zip.toBuffer()` copies it again; ~2x256 MiB per in-flight request, no concurrency bound | 4-8 authenticated editors GET `download.zip` for near-cap packages → 2-4 GB simultaneous heap → OOM, no 413 because each request is individually legal | Stream entries into the archive and stream the archive out; separately add `limit_conn` in nginx for the download route |
| `config-002` | Both DSN builders fall back to a hardcoded localhost URL and boot does not fail fast | Unset `DATABASE_URL` yields a running-but-broken API with a misleading error (it cannot silently hit the wrong DB — there is no `db` container) | Add a `assertDatabaseUrlForProd()` beside the existing `assertEncryptionKeyEnv()`/`assertPublicOriginsForProd()` two lines above |
| `dependency-004` | 6 of 7 `@radix-ui` packages plus cva/clsx/tailwind-merge are declared and never imported in either app | Install time, lockfile size and audit surface — not shipped bytes, since Next never bundles an unimported package | Remove the nine unused declarations; keep `@radix-ui/react-dialog` |
| `security-006` | `storeSimulationHtml` writes arbitrary HTML as `text/html` served from the **API origin** | User-authored script executes same-origin with the API. Bounded because the backend uses no cookies at all, so there is no ambient credential to steal; residual is phishing on a trusted subdomain and localStorage/service-worker footholds under `/sim-public/` | Serve sim packages from a distinct origin, or add a `Content-Disposition`/sandbox layer at the sim-public handler |
| `security-008` | `findManageableVisual` gates on `or(project_id = :id, project_id IS NULL)`, so any project owner can mutate any global row | PATCH/DELETE/edit-simulation on another tenant's global visual. Bounded because both LIST endpoints now pass `includeGlobal:false`, so no route leaks the id | One helper that scopes by project and refuses NULL — shared with `security-009` |
| `security-012` | `canServeMediaKey` returns true on any DB error (documented, deliberate availability bias) | Supabase blips; a request for `videos/{privateProjectId}/master.mp4` with no token and no auth is served instead of refused. Bounded: every URL the product mints carries a scoped token, so it needs a raw key holder without one | **needs-owner** — ratify or reverse the confidentiality-under-fault vs availability trade |
| `security-013` | `assertPublicHost` is dead defensive code: its one call site hands the URL to Firecrawl/Jina and never dereferences it server-side | No open SSRF exists today — every server-side fetch with a non-constant URL uses an adapter-minted or vendor-returned URL. Risk is that the next feature to fetch a user URL will have no habit of calling it | Document the guard as the required entry point for any user-URL fetch, or delete it |
| `security-014` | `LocalStorageAdapter` upload/delete `join(BASE_DIR, path)` with no `safeLocalPath`, unlike the serve routes | Dev-only: on a developer's machine any authenticated account can PUT to `/local-storage/upload/{any key}` and overwrite another local project's asset. Production is fail-closed three ways over | Add `safeLocalPath` to the three write methods for symmetry |
| `backend-002` | The dev local-storage PUT has no binary content-type parser; `video/mp4`, `application/octet-stream` and `image/png` all 415 before the handler | Local dev uploads silently fall back to the slower multipart-through-API path; the route 404s in production | `addContentTypeParser` for binary on the dev route |
| `backend-003` | `courses.controller` `handle()` rethrows non-`CourseAuthzError`, and `apiErrorHandler` has no `ZodError` branch → 500 at paging-grade `logger.error` | A malformed body pages someone. Bounded: these routes have zero consumers (`types-002`) | `safeParse` → 400, as `branch.controller.ts:436` already does |
| `backend-006` | Both SSE handlers arm the keep-alive and flush headers, then `await db.update(...)` outside the try/finally that owns `clearInterval` | A throw from that one update escapes after headers are sent; the client's EventSource hangs with no error and no end. Bounded by the socket-close handler | Move the update inside the try, or before the interval is armed |
| `backend-008` | Corpus ingest runs `builder.ingest(id).catch(log)` in-process with no timeout; the durable `corpusIngestTask` is referenced by nothing | An ingest that hangs holds API resources indefinitely. The stuck-row half is fixed by `corpusRecovery` | Add an `AbortSignal` deadline to `CorpusBuilder`, then move ingest onto the queue (`job-queue-015`) |
| `backend-009` | `ops/ship/src/state.ts` claims write-then-rename and does `writeFileSync(stateFile, readFileSync(tmp))` — a truncating copy; no `rename()` in the file | The CLI process reads inside the O_TRUNC window, gets an empty file, and `loadRun` returns null — "no run" | Replace the copy with an actual `renameSync(tmp, stateFile)` |
| `backend-010` | `fix-migration-tracking.ts` takes `DATABASE_URL` from the env with a localhost default and inserts `schema_migrations` rows with no dry-run, confirmation or prod guard | A fresh or restored database gets migrations 014-017 marked applied that were never run. Bounded today because the runner is at 069 | Delete the script — 014-017 are applied everywhere real |
| `database-006` | `/branch/analytics` loads every `branch_path_events` row for a project with no limit or date range and aggregates in JS; no retention sweep for the table | Unbounded query as the table grows. Bounded because no client calls the read path — only the write path has a consumer | Add a retention sweep beside `startRumRetentionSweep`; bound the query when the read path gets a consumer |
| `database-011` | `SitemapService.videoEntries` awaits `listByCourse` once per published course; the projects/video_files N+1 right below it was already batched | Sequential queries proportional to published courses. Bounded to ~0 by `types-002` | `inArray` batch, matching the comment at :49-51 |
| `types-002` | `registerCourseAuthoringRoutes` is registered and called by nothing — no client, test or script references any of its paths | **needs-owner** — this is the root the courses cluster hangs off. `backend-003`, `database-004` and `database-011` are all bounded by it | Product decision: build the creator UI or delete the surface, `CoursePublishingService` and both repositories with it |
| `types-006` | `AvatarPersonaConfig` is declared twice outside `shared/` and the two have diverged by five fields | Drift hazard, not a live bug — the PUT handler explicitly re-carries each server-managed field. `AvatarCirclesConfig` is declared three times | Move both into `shared/src` as one definition |
| `media-011` | `fetchPackageFiles` + `prepareOfflinePackage` run per `captureSection` with no memoisation, and the provider is constructed per job | N sections of one simulation download and re-stage the same package N times (up to 256 MiB each) and run N containers | Cache the staged package by revision key for the lifetime of the export run |
| `media-012` | Capture and assembly drive one `objects_done/objects_total` counter in different units; the assembler emits no progress until the audio track is built | The progress bar runs to 100%, drops to 0, and sits there through the batched mixes and two-pass loudnorm | Render `current_phase`/`phase_done`/`phase_total` (already in the schema) in `useProjectExport.ts` |
| `media-014` | `localCaptureProvider.ts` is untracked by git, imported by nothing, and `EXPORT_CAPTURE_LOCAL` appears only inside the file itself | `EXPORT_CAPTURE_LOCAL=1` changes nothing anywhere; the file's unlimited ffmpeg spawn is outside the global cap but never runs | Commit and wire it, or delete it — it is currently a lie about a capability |
| `media-015` | A source consumed by more than one window gets `seekSec = 0` and `split=N`, so the decoder walks source time forward while concat fills an earlier segment | Frames for a later window queue on that concat input. Documented residue of the `media-008` fix; needs two layers over the same `storageKey` to reach | Same change as `media-008`: give shared inputs a per-branch seek |
| `simulation-005` | The parent's modern message switch has no case for `AUTOMATION_PAUSED`/`RESUMED`/`SECTION_RELEASED`/`QUALITY_APPLIED` — all four hit `default: return` | Not even a telemetry line. `setQuality`'s docstring claims the `unsupported` outcome "is reported", which is false because `QUALITY_APPLIED` carries it and is dropped. `RELEASE_SECTION` advances optimistically, so a child that fails to release is never detected | Add the four cases; at minimum telemetry, and a real ack for RELEASE |
| `simulation-006` | `buildLegacyManifest` hardcodes `bridgeProtocolVersion: 0` / `runtimeProtocolVersion: 0`; `buildDerivedManifest` spreads the base without overwriting either | Every later revision inherits the 0 forever. P3 because nothing gates on the value — the only readers are a read-back and the manifest hash | Set the real versions at the one origin; then the field can be gated on |
| `job-queue-010` | `crop` has no heartbeat (`crop_updated_at` written at claim and terminally), `STALE_CLAIM_MS` 20 min vs `expireInSeconds` 30 min | The claimed outcome — two concurrent crops — is **not reachable**: one container consumes `crop` at `localConcurrency: 1`, so pg-boss cannot redeliver into a running handler. A latent inequality | Add `heartbeatSeconds`, or make the two bounds agree, before crop concurrency is ever raised |
| `job-queue-012` | `recoverStuckCrops` updates every `crop_status='processing'` row with no age predicate on every API boot; its comment's premise ("no live crop worker after a restart") is false now that crop runs in a separate container | It flips a live crop to `failed` and releases its claim. Double-crop is blocked by the single consumer, so what reaches a user is a spurious failed→ready flicker | Add a cutoff, as `recoverStuckTranscodes` at `server.ts:115` already has |
| `job-queue-015` | `corpus.ingest.ts` is a `@trigger.dev/sdk/v3` task nothing imports, `'corpus'` is absent from `JOB_NAMES`, and both upload branches fire a floating promise | Ingest is not durable. The no-recovery half is closed by `startCorpusIngestionSweep` | Add `corpus` to `JOB_NAMES` and move ingest onto pg-boss; delete the trigger.dev task |
| `llm-pipeline-010` | Admin LLM config accepts any string as a model id and `thinking_budget_tokens` has a floor and no ceiling | A typo makes every call on that tier 502 while being metered at 0 cents. Bounded: authenticated-admin-only, temperature is bounded, and both consequences now log loudly | Validate model ids against the rate card; add a max to the thinking budget |
| `llm-pipeline-015` | `QUOTA_EXEMPT_TASKS` lists 5 of 20 task names; every avatar/thumbnail utility task carries a `user_id` and is counted by the rolling-24h `count(*)` cap | `avatar_visual_classify` fires once per avatar turn and eats the user's generation quota. Bounded: the cap is off by default | Exempt the utility tasks, or count by cost rather than by row |
| `llm-pipeline-017` | No golden-output or end-to-end test for `ScriptRoom`, the nine-call chain that produces the paid deliverable | A silent quality regression in the product's core output ships unnoticed. Two of the three originally named gaps were closed | A golden-output suite over a fixed corpus with a stability assertion |
| `observability-006` | No `by_status`, failure-rate or duration metric for `project_exports`, `podcast_renders`, `video_generation_jobs` or `project_duplications` on any admin endpoint | Job health is invisible above the queue-depth layer that did land | Add the four `groupBy` aggregates beside the existing `hls_status`/`simulations.status` ones |
| `performance-007` | `buildClips` issues one `findFirst` per turn inside the loop | Code hygiene only: each iteration already runs an ffmpeg tempo bake, a full-file read, a sha256, a duration probe, peak extraction and an upload — the round trip is noise | Batch the lookup outside the loop when the file is next touched |
| `anam-backend-010` | The dead-persona cache landed but the durable half did not: `getSessionToken` returns `personaRepair` and nothing in production reads it | The saved config is never repaired, so the double vendor hop returns after every TTL expiry, every deploy, and on each replica separately | Consume `personaRepair` in `avatar.controller.ts` and write the repair through `personaBake` |
| `anam-frontend-004` | The unconditional 150ms sleep is gone but `primeVideoElementForAutoplay` still runs serially between the token arriving and `streamToVideoElement`, now bounded to 1000ms | Up to 1s of added avatar start latency. The function's own docblock concedes its user-activation justification does not hold on this path | Same fix as `anam-latency-005` — one change |
| `anam-latency-005` | `AvatarPopup` renders `AvatarConversation` only once the token exists, and the primed `<video>` is rendered by that component, so the prime cannot start before the `/avatar/start` round trip | Same 1s as above; one root, not two items | Render the video element (hidden) before the token resolves, so the prime overlaps the mint |
| `fleet-021` | `stack.md` presents `corpus.ingest` beside `video.generate`/`video.transcode` as peers under job-queue-reviewer; it is not in `JOB_NAMES` and is an orphaned trigger.dev task | A reviewer believes a job kind exists that does not | Fix the row; the underlying orphan is `job-queue-015` |
| `fleet-022` | The "Last verified" stamp reads 2026-08-18 @ `ef651a9`; HEAD is 148 commits and 28 merges past it, and the counts it dates are provably wrong (79/62 migrations claimed vs 93/69 actual; 27 controllers claimed vs 30) | Reviewers work from wrong facts. Root of `fleet-021/023/026/027` | Derive the counts at run time, or fail CI on drift — one fix closes five |
| `fleet-024` | Both `backend-reviewer` and `llm-pipeline-reviewer` claim `services/seo/**`, violating PROTOCOL.md's exclusivity rule, and unlike `storage/` it carries no deliberate-split annotation | **needs-owner** — a fleet-ownership decision, not an engineering one | Decide the boundary once, then generate the matrix |
| `fleet-025` | `backend-reviewer` claims `podcast/` and `lib/**` wholesale on the stated grounds that no specialist owns them; four specialists do, and `stack.md` documents both splits | **needs-owner** — same root as `fleet-024`; fix both in one pass | As above |
| `fleet-026` | `sim-public.controller.ts`, `sim-rum.controller.ts` and `stubs.ts` appear nowhere in `stack.md`; only `stubs.ts` is genuinely unowned (the other two are claimed in agent prompts) | The `stack.md` gap is the `fleet-022` root again | Add the three to the subsystem map; assign `stubs.ts` |
| `fleet-027` | `md-files/` (32 files) and `references/` (13) are unowned by any agent and unmentioned in `stack.md` — grown since filing | Exactly the stale-doc class `stack.md` exists to prevent | Fold into the `fleet-022` fix |
| `fleet-028` | ~21 TypeScript files under `ops/release/src`, `migration-audit.ts` among them, are enumerated by no agent prompt; only `stack.md`'s map row assigns them | Release tooling reviews its own JSON output but not the code that produces it | Add the source tree to `release-auditor`'s scope, as it already did for `ops/ship/**` |
| `fleet-030` | `podcast-saas/docker-compose.yml` (a real local stack, postgres:16 on 5432) is outside `deploy/` and named by no agent and no `stack.md` row | The root compose file is genuinely unreviewed. `capture.yml`/`gpu-worker.yml` do fall inside the `deploy/**` glob | Name it in `config-deploy-reviewer`'s scope |
| `fleet-031` | `frontend-reviewer`'s scope is a five-entry enumeration; `client-web/{scripts,docs,public}` are named by no agent, while `stack.md` assigns `client-web/**` wholesale — prompt and map contradict | Same drift as `fleet-021/022` | Reconcile prompt against map in the `fleet-022` pass |
| `fleet-032` | Seven agents lack the "How you will be wrong" section — six named in the original prose plus `patent-scout`, added since; the three release advisors remain the thinnest prompts at 46/50/52 lines | Agents with no calibration section produce the least self-doubting output | Add the section to all seven |
| `scripts-ship-006` | `watch.mjs`'s main loop is `for (;;)` with a 2s sleep, no deadline, no mtime-staleness check and no exit but `run.end` | A second Ctrl-C bypasses `process.once('SIGINT')` and kills the conductor after the journal exists, so the watcher hangs forever. Costs a hung watcher, not data | Add a staleness deadline on the journal's mtime |
| `scripts-ship-014` | The migration list is duplicated in `migrate.ts` and `check-db.ts`; `migration-audit.ts` extracts only the former | Latent, not active — both lists carry 69 entries through `069_placement_impact_review.sql` and have been kept in sync by hand across eleven additions | Export one list from `migrate.ts` and import it in `check-db.ts` |
| `test-quality-005` | `RateLimitService` has exactly one reference in the whole backend — its own class declaration — next to a middleware whose comment says per-user rate limits are disabled | **needs-owner** — dead code advertising a token-budget enforcement the product does not perform. Writing tests for it would be the wrong fix | Decide: wire it up or delete it |
| `test-quality-006` | `EXPORT_REAL_ENCODE` appears in no workflow and no package script, so the real-ffmpeg suite never runs outside a deliberate local invocation | Defensible on its own terms — the suite spends real CPU. Read with `test-quality-007`, though, no ffmpeg failure path is exercised anywhere | A nightly/scheduled job, not a CI gate |
| `test-quality-008` | `queue/registry.ts` is never executed — the only test references are `vi.doMock` calls that replace it | The twelve payload→service adapters are unverified. The `pgBoss.ts` half is now covered by five suites | One suite that imports the real registry and asserts each handler's payload shape |

---

## 3. Root-cause clusters

The 93 confirmed findings are not 93 tickets. Fourteen clusters account for 63 of them; several were
named as shared roots by the verifiers themselves. Ordered by what one fix buys.

### C1 — The media authorization gate knows exactly three key prefixes (6 findings, 5 P2)
`resolveProjectForKey`/`canServeMediaKey` handle `videos/`, `exports/` and `hls/`. Everything else —
`simulations/`, `podcasts/` — is served by a handler that invented its own, weaker, check. Separately, the
Supabase adapter hands out `/object/public/` URLs that never traverse any backend route at all, so even a
prefix-complete gate would not cover them until the bucket goes private.

**Members:** `security-005` (sim-public has no project check) · `security-016` (podcasts/ is public and
holds user documents) · `simulation-007` (sim-public has no visibility check — the same handler, the other
half) · `security-001` (public-bucket URLs are unrevocable) · `security-006` (sim HTML served from the API
origin) · `security-012` (the gate fails open on a DB error).

**The one fix:** make `mediaKeyScope`/`canServeMediaKey` prefix-complete and route *every* serve handler
through one authorization function; then finish the STEP 3/STEP 4 migration so no URL bypasses it. That is
the largest single security win available in this tail.

### C2 — Unbounded allocation on a 2-vCPU host with no container limit (4 findings, all P2)
Three findings allocate without a bound; one removes the only thing that would contain the consequence.
`uploadLimits.ts:11-14` states the premise in-tree: "two concurrent uploads are an out-of-memory kill of
the whole API process".

**Members:** `security-007` (six routes `toBuffer()` the whole file) · `performance-005` (zip buffered
twice, ~2x256 MiB, no concurrency bound) · `media-009` (capture frames exceed a 512 MiB tmpfs inside a
2048 MiB cgroup) · `config-003` (no `mem_limit` on backend or worker, so the OOM kills the host).

**The one fix:** `config-003` first — it is cheap, it is copy-paste from a sibling compose file in the same
directory, and it converts every other member from a host outage into a contained restart. Then bound the
allocations.

### C3 — A mutating route resolves an object by id and never proves the caller owns it (2 findings)
**Members:** `security-008` (P3, global avatar visuals mutable by any project owner) · `security-009` (P2,
knowledge-document DELETE crosses tenants under a shared platform Anam key).
**The one fix:** one helper that scopes by project and refuses NULL. The correct pattern already exists a
few lines away in each file.

### C4 — Viewer and export disagree about overlapping clips (2 findings, both P2, both fix-now)
**Members:** `broll-data-008` (nothing defines or prevents overlap) · `broll-player-002` (the two sides
resolve it differently).
**The one fix:** one shared resolver in `shared/` plus an `overlap` violation code on the writer. Until
then, what an author previews is not what the exported master contains.

### C5 — Destructive one-shot scripts have no argument discipline and no guard (6 findings, 5 P2)
Two of them are the same parsing bug; the rest are the same missing-guard habit. `scripts-ship-010`'s
`NaN` path even survives a trip through the release CLI to the VM as the literal string `'NaN'`.

**Members:** `scripts-ship-010` (NaN disarms the affected-rows ceiling) · `scripts-ship-011` (`--sim` with
no value means every simulation; `--sim --dry-run` disables dry-run) · `scripts-ship-013` (seed guards
storage, not the database) · `scripts-ship-016` (unbounded rewrite, no drift check) · `scripts-ship-012`
(manifest written last, so a throw orphans everything) · `scripts-ship-015` (cleanup inside the try, no
multipart abort). `backend-010` (P3) is the same class.

**The one fix (partial):** one shared arg parser rejecting missing values, `--`-prefixed values and
non-finite numbers closes `scripts-ship-010` and `-011` and the sibling `backfill-avatar-circles.ts`. The
guard habit — `assertLocalDatabase`, cleanup in `finally`, a dry-run default — is a checklist the other four
need individually.

### C6 — The ship conductor infers decisions instead of recording them (4 findings, all P2)
**Members:** `scripts-ship-005` (a GitHub rejection is indistinguishable from an approval, so it journals
"approved") · `scripts-ship-003` (a local approval is accepted and then `rmSync`ed on resume) ·
`scripts-ship-004` (no lock, so two shipments can run at once) · `scripts-ship-006` (P3, the watcher never
exits after abnormal termination).
**The one fix:** the gate must persist the decision — read the deployment's review state from GitHub, and
journal the local decision — rather than reading absence as consent.

### C7 — Hand-maintained fleet facts with no auditor (5 findings, all P3)
`stack.md` exists specifically to prevent reviewers working from stale beliefs, and it is itself stale: the
stamp is 148 commits behind and its migration and controller counts are wrong.
**Members:** `fleet-022` (stamp and counts wrong) · `fleet-021` (a job kind listed that does not exist) ·
`fleet-026` (three controllers absent from the map) · `fleet-027` (`md-files/`, `references/` absent) ·
`fleet-031` (prompt scope contradicts the map). `fleet-023` was REFUTED — but only because two scripts were
added since, so the count drifted back into agreement by accident. That is the cluster in miniature.
**The one fix:** derive the counts at run time from the tree, or fail CI on drift.

### C8 — Reviewer ownership is enumerated by hand in each prompt and collides (5 findings, all P3)
**Members:** `fleet-024` (`services/seo/**` claimed twice) · `fleet-025` (`podcast/` and `lib/**` claimed
wholesale against four specialists) · `fleet-028` (`ops/release/src` unowned) · `fleet-030`
(root `docker-compose.yml` unowned) · `fleet-031` (client-web subtrees unowned).
**The one fix:** decide the boundary once and *generate* the ownership matrix into every prompt instead of
restating it in each. Two of these are `needs-owner` because they are fleet-policy decisions.

### C9 — The LLM service's controls exist only on the structured path (4 findings, all P2)
Reasoning parameters, the generation quota and prompt caching are each implemented once, in
`_sendStructuredOnce` or in the provider, and are not reachable from the other entry points or from any
caller.
**Members:** `llm-pipeline-011` (`sendText` has no thinking controls and no quota block — and the deepest
call in the product uses it) · `llm-pipeline-007` (caching plumbed into `ClaudeProvider`, forwarded by
nothing) · `llm-pipeline-012` (no backoff; silent tier escalation) · `llm-pipeline-015` (P3, quota
exemptions cover 5 of 20 tasks).
**The one fix:** one shared preamble both entry points call, carrying quota, reasoning payload and cache
directives.

### C10 — Fire-and-forget work in the request-serving process (4 findings)
**Members:** `backend-011` (P2, a throw inside the `.catch` terminates the process) · `job-queue-013` (P2,
the inline fallback runs full encodes in the API container) · `backend-008` (P3, corpus ingest is a
floating promise with no timeout) · `job-queue-015` (P3, the durable corpus task is orphaned).
`fleet-021` documents the same orphan from the reviewer side.
**The one fix:** move corpus onto pg-boss, extend `NEVER_INLINE` to every CPU-bound kind, and add a
process-level `unhandledRejection` handler so the class fails loudly rather than fatally.

### C11 — A whole product surface has no consumers (4 findings, all P3, one needs-owner)
**Members:** `types-002` (root — the courses authoring API is called by nothing) · `backend-003`
(ZodError → 500 on those routes) · `database-011` (N+1 in the course sitemap) · `database-004` (REFUTED,
and moot for the same reason).
**The one fix:** the product decision in `types-002`. Build the creator UI and the other three become real;
delete the surface and they vanish with it.

### C12 — Tests are green because they cannot see the defect (3 findings)
The most expensive class in the tail, because it hides the others.
**Members:** `test-quality-015` (P1 — PGlite serialises `Date` where real Postgres rejects it, so a live
production failure is invisible to six passing tests) · `job-queue-014` (P2 — test files are not
type-checked, so exhaustive maps silently stop being exhaustive; this is how `job-queue-011` reached P1) ·
`test-quality-007` (P2 — the fake ffmpeg emits exit 0 and only exit 0).
**The one fix:** none shared, but the lesson is: a test that cannot fail on the real mechanism is not
coverage. Type-check the tests, and make fakes capable of failing.

### C13 — Writer/deleter asymmetry in storage (1 confirmed, 1 open census)
**Member:** `simulation-008` (P2, posters are written on every publication and deleted by two functions
that production never calls). This is the same class as the standing Supabase storage leak census — fold it
in rather than deleting in isolation.

### C14 — Avatar start-latency (2 findings, both P3, one root)
**Members:** `anam-frontend-004` and `anam-latency-005` are the same serial prime between token arrival and
`streamToVideoElement`, reported twice. One fix. `anam-latency-006` was REFUTED — the warm path exists.

### Not clustered
`config-002`, `config-012`, `dependency-004`, `dependency-006`, `database-005`, `database-006`,
`database-010`, `security-002`, `security-011`, `security-013`, `security-014`, `backend-002`,
`backend-006`, `backend-009`, `media-003`, `media-011`, `media-012`, `media-014`, `media-015`,
`simulation-005`, `simulation-006`, `simulation-009`, `job-queue-010`, `job-queue-011`, `job-queue-012`,
`llm-pipeline-010`, `llm-pipeline-013`, `llm-pipeline-016`, `llm-pipeline-017`, `observability-005`,
`observability-006`, `performance-007`, `performance-009`, `types-006`, `ui-ux-006`, `scripts-ship-014`,
`test-quality-001`, `test-quality-005`, `test-quality-006`, `test-quality-008`, `anam-backend-010`,
`fleet-032`.

---

## 4. Refuted and already fixed — 71 closable

### 4a. REFUTED — 6

The claim itself is false. These are not "fixed"; they were wrong when written, and in four of the six the
verifier had to build a probe to establish it.

| id | Why it is false |
|---|---|
| `security-010` | The premise is right (`reply.sent` is a probe, not a flag) and the consequence is wrong: every denial branch **returns** the reply, an async function that returns a thenable adopts it, and `Reply.prototype.then` fires on stream end — so `writableEnded` is true by construction. Measured three ways against real fastify 4.29.1 (inject, real socket, real socket with a 20 ms deferred `onSend`); a control middleware that sends *without* returning reproduced the reported bug, proving the code does not have it. Worth a comment and a regression test, not a P2. |
| `database-004` | `EXPLAIN` against the real index shows the query **does** use it — `Index Scan using uniq_courses_host_slug, Index Cond: (slug = …), Filter: (canonical_host IS NULL)` — because Postgres can apply a condition on a non-leading index column. "Cannot use any index" is false; what is lost is the seek on the leading column (9 buffers / 3 index searches vs 3 / 1 on 5000 rows), and that is moot under `types-002`. |
| `media-013` | The availability memo cannot outlive one export: the registry constructs `resolveConfiguredCaptureProvider()` inside the job handler body, so a fresh provider and a fresh `available` field exist per `project_export` job. A late image pull is picked up by the very next export, not "every export until restart". |
| `anam-latency-006` | A warm path exists and predates the click — `AskAvatarButton` binds `preloadAnamSdk` to `onMouseEnter`/`onFocus`/`onTouchStart`. The only other prefetchable thing is the billable vendor mint, which the finding itself said must not be prefetched. |
| `fleet-020` | `claude-api` is a CLI-bundled skill, not a project or user skill, so its absence from `.claude/skills/` proves nothing. It resolves — it is in this session's roster and the CLI extracts its assets to the bundled-skills cache. The declaration is valid. |
| `fleet-023` | The count matches today: `ls src/scripts/*.ts` is exactly 31, which is what `stack.md` says. **It matched by drift, not by repair** — two scripts were added since filing. The claim is false as it stands; the mechanism behind it (`fleet-022`) is untouched. |

### 4b. ALREADY_FIXED — 65, grouped by the commit that closed them

This is the evidence the review loop is landing where it was aimed. In most of these the fixing commit
names the finding id in an inline comment, and in several the fix ships with a test that fails if the
defect returns.

**`384a782` — "fix(queue,export,a11y): durability, wasted decode, and controls a keyboard can reach" — 23 findings.**
The single largest closure in the tail.
*Queue durability (6):* `job-queue-004` (stop_grace_period vs a tested shutdown budget) · `job-queue-005`
(12 job kinds on pg-boss, none left inline) · `job-queue-006` (mandatory per-queue policy +
`reconcileQueuePolicies`) · `job-queue-007` (`createQueue` then `updateQueue`) · `job-queue-008`
(per-queue concurrency) · `job-queue-009` (dead-letter depth is now readable).
*Export/media (2):* `media-007` (stream to disk, never `arrayBuffer()`) · `media-008` (input seek —
6.70s → 0.10s user CPU, byte-identical output).
*Frontend failure surfacing (7):* `frontend-editor-001` · `frontend-editor-002` · `frontend-editor-003` ·
`frontend-001` · `frontend-002` · `frontend-003` · `types-003`. Four of these were one root, closed by the
shared `failureSurface.ts` module.
*Accessibility (8):* `ui-ux-001` · `ui-ux-002` (reworked in `c8b2d0b` after the first attempt was rejected
as UNSOUND — a flat timeout that declared healthy builds dead) · `ui-ux-003` · `ui-ux-004` · `ui-ux-005` ·
`ui-ux-007` · `ui-ux-010` · `ui-ux-011`.

**`02e1dda` — "feat(observability,contracts): a request you can follow, and a boundary that is one definition" — 9.**
`observability-003` (correlation id via AsyncLocalStorage mixin) · `observability-004` (auth failures are
classified, not silent) · `observability-007` (four bounded fetch-retry events, query stripped) ·
`observability-008` (`/health` vs `/health/ready`, queue-aware) · `types-001` (`SimMeta` rewritten to what
the server writes, with a compile-time gate) · `types-004` (tsoa deleted; a real route-contract test in its
place) · `types-005` (`EdgePatchSchema`) · `config-008` (dead `generate` script) · `dependency-003` (tsoa
removed, with `8a54fbe`).

**`f7c2aab` — "fix(uploads): spool to disk, and undo the four things the guard got wrong" — 4.**
`performance-001` (audio) · `performance-002` (corpus) · `performance-003` (podcast source) — all three now
`declaredTooLarge()` + `withBoundedTempFile`, peak heap one 64 KiB chunk · `security-004` (media token
secret throws on a bad key instead of decoding to a truncated buffer; boot gate + deny-on-error).

**`750b476` — LLM pipeline — 4.** `llm-pipeline-006` (deadline below the call sites, one budget per
logical call) · `llm-pipeline-008` (real Haiku 4.5 pricing; no invented rate) · `llm-pipeline-009`
(allowlist inverted, so `claude-opus-5`/`sonnet-5` default safe) · `llm-pipeline-014` (mid-stream abort
throws `ABORTED` with partial usage instead of returning half an answer as `end_turn`).

**`b581d8e` — "fix(races): stop paying twice for one click, and rotate a key without a gap" — 4.**
`backend-004` (slug allocated from the namespace the constraint enforces, with bounded retry) ·
`backend-005` (key rotation in one transaction) · `backend-007` (podcast mix/export claims take
`SELECT … FOR UPDATE`) · `database-008` (episode render claim, same).

**`d2a8cc1` — capture isolation — 2.** `media-004` (every ffmpeg spawn under the global limiter) ·
`media-005` (clip directory ownership explicit on both sides).

**Individually closed — 13.**
`media-006` (`57a84c9` — a failed transcode un-publishes before it un-stores) · `media-010` (`1d5d837` —
the job's real AbortSignal reaches `docker stop`/`kill`) · `security-015` (`bb90573` — a ZIP's *declared*
values are bounded before anything is allocated) · `config-005` (`984b7cb` — a three-engine viewer-e2e job
that fails closed on zero specs; 2 of 9 configs now run, not 1 of 9 never) · `broll-data-006`
(`ef651a9`/`f975c23` — finalisation locks, adopts, and fences) · `broll-data-007` (`962deed` — the
cut-to-fit clamp is gone; duration changes file a review row) · `broll-data-004` (migration 063 — four
read sites collapsed into one resolver, plus a writer-side `missing_offset` violation) · `broll-data-005`
(both section endpoints parse through Zod; no mass assignment) · `frontend-viewer-001` (`410a658` — a
corrected clip list reaches the player without swapping a live shot) · `fleet-029` (`e4146a7` — the guard
reads the command the shell will run) · `scripts-ship-002` (`ef0c13c` — the pre-approval snapshot moved
out of the directory `readArtifact` recurses into) · `simulation-004` (every reachable postMessage listener
now checks `e.source !== window.parent`) · `database-009` (migration checksums, verified before anything
is applied).

**Closed by a new test suite — 6.** `test-quality-009` (a real-Postgres crash matrix for b-roll
idempotency) · `test-quality-010` (non-uuid `:id` 404s, asserting the DB was never touched) ·
`test-quality-011` (the DB-seeded vs admin-customised prompt branch) · `test-quality-012` (metering of
failed, aborted and truncated calls) · `test-quality-014` (every `ClientV1Api` call maps to a registered
route) · `test-quality-004` (four middleware suites, covering authz behaviour rather than plumbing).

**Fixed but carrying a residual (9).** Close the original; file the residual separately.
`ui-ux-003` (P3 — `ExtendedLibraryModal.tsx:382` close button still anonymous) · `ui-ux-005` (P3 — the
avatar knowledge-docs dropzone is still a plain `<div onClick>`) · `ui-ux-007` (P3 — the admin BYOK toggle
resolves to an anonymous button) · `test-quality-004` (P3 — `firebase-admin-required.ts`, the admin gate
itself, and `rate-limit.ts` still untested) · `test-quality-014` (P3 — the contract test checks route
*shape* only; payload drift is unchecked) · `types-001` (P3 — a now-redundant double cast at
`SectionEditor.tsx:2116`) · `types-004` (P3 — the directory is still called `generated/`) ·
`broll-data-004` (P3 — the NULL→0 coercion survives, but single-sourced and named `absolute_missing`) ·
`llm-pipeline-009` (P3 — cosmetic).

---

## 5. Uncertain

**This section is small, and that is worth saying plainly: no verdict came back as UNCERTAIN.** Every one
of the 164 reached CONFIRMED, REFUTED or ALREADY_FIXED. That is not a claim of perfection — it is a
statement about where this sweep's evidence could reach. The verifiers could read code, run tests, run
`EXPLAIN` against PGlite, probe fastify locally and inspect build manifests. They could not observe
production. Everything below is a determination that rests on inference from the tree rather than on an
observation of the running system.

| id | What is inferred | The evidence that would settle it |
|---|---|---|
| `security-001` | The Supabase bucket's actual ACL. The reasoning is sound — `/object/public/` serves only from a public bucket, and production media plays — but it is an inference, and the verifier said so explicitly. | One `curl` of a known media key with no credential, from outside the VPC. If it 200s, the finding is confirmed by observation. |
| `performance-005` | That 4-8 concurrent near-cap downloads actually OOM the box. Peak heap per request is computed from the code (`buf.length` sum + `zip.toBuffer()`), not measured. | A load run against staging with `--max-old-space-size` matching production and 8 concurrent 250 MiB `download.zip` requests; watch RSS. |
| `media-009` | That 2100 frames × ~250 KB is representative. Frame size is estimated from JPEG q80 at 1920x1080, not sampled from a real capture. | Instrument one real capture run to log `framesDir` bytes at peak, and compare against `tmpfsScratchMb`. |
| `job-queue-011` | That `rollback.sh` produces the crash-loop end to end. The chain is read from the scripts and the code, each link verified, but the rollback was never executed. | One rehearsed rollback in staging across a commit that added a queue name; check whether `worker` comes back. |
| `backend-011` | The *trigger*, not the mechanism. The unhandled rejection is proven from the code and Node's documented behaviour; the specific cause (a NUL byte in `err.message`, or a DB fault at that exact moment) is offered as "plausible". | Whether the process has actually restarted for this reason: search production logs for a terminal `UnhandledPromiseRejection` near a simulation-processing failure. |
| `security-011` | That live tokens are in fact present in the current nginx log volume. The mechanism is proven (query-string logging is on for the api vhost, one client sends the token that way); the contents were not read. | `grep -c 'token=' /var/log/nginx/access.log` on the host. |
| `security-015` | Nothing about the code — the fix is verified. The **ledger record** is internally inconsistent: verdict `ALREADY_FIXED`, `severityNow: P2`, action `close`. | A human reconciling the record. Treat as `severityNow: NONE` unless the P2 was a deliberate note about the guard's default limits. |

**And one structural uncertainty, larger than any row above:** 164 verdicts were returned against a tail of
235. The other 71 ids are aliases resolving to these canonicals. Four of the verdicts explicitly warn that
the alias mapping is unreliable — see §6.

---

## 6. What this means for the ledger

### Recommended disposition

| Group | Count | Disposition |
|---|---:|---|
| ALREADY_FIXED, no residual | 56 | **Close.** Cite the fixing commit in the ledger entry so the closure is auditable. |
| ALREADY_FIXED with a residual | 9 | **Close the original, file the residual as a new P3.** Do not leave the original open — its claim is false, and a false-but-open entry is what produced 40% of this tail. |
| REFUTED | 6 | **Close as refuted, with the probe.** `security-010` and `database-004` in particular should keep their measurement in the entry; someone will re-file them otherwise. |
| CONFIRMED, `fix-now` | 22 | **Work queue, in cluster order.** `job-queue-011` and `test-quality-015` first — both P1, both cheap. Then C2's `config-003` (one compose stanza, converts three other findings from host outage to contained restart). |
| CONFIRMED, `schedule` | 64 | **Backlog, grouped by cluster, not by id.** C1 (6 findings, one gate) and C5/C6 (10 findings across two roots) are the highest-value batches. |
| CONFIRMED, `needs-owner` | 7 | **Escalate, do not schedule.** `security-012` (fail-open trade-off), `simulation-007` (sim-public policy), `types-002` (build or delete the courses surface), `ui-ux-006` (timeline keyboard access, deliberately excluded once already), `test-quality-005` (wire up or delete `RateLimitService`), `fleet-024`/`fleet-025` (fleet ownership). Each is a decision, and a fix-agent given one of these will produce something that looks done and is not. |

### Do not bulk-close by alias

Four verdicts explicitly warn that closing a canonical would wrongly close a live finding:

- `dependency-003` is fixed and `dependency-007` (pino-pretty) is fixed, but **`dependency-008`
  (`groq-sdk` pinned at `^0.8.0`) is not**, and is still declared at that version.
- `security-012`'s cluster canonical is `billing-012` (OUT_OF_SCOPE_BILLING). Closing that canonical must
  not silently close this.
- `media-011` is mechanically aliased to `performance-004`, which is already REFUTED — but they are
  **different claims**. `media-011` is not covered by that verdict.
- `simulation-004` is mechanically aliased to `security-015`. They are unrelated findings at different
  lines; the `simulation-004` verdict does not address the ZIP cap.

The lesson generalises: the alias mapping was built mechanically and is wrong often enough that the 71
unadjudicated ids must be re-checked individually against their canonical's verdict before any of them is
closed. Assume the mapping is a hint, not a fact.

### What this sweep did not do

It read code at `7ebe9cc`, ran targeted vitest suites, ran `EXPLAIN (ANALYZE, BUFFERS)` against PGlite,
probed fastify 4.29.1 over real sockets, exercised the real `runVideoGenerate` against a real Postgres
engine, and inspected `.next` build manifests.

**It did not exercise production.** No bucket ACL was observed. No container was run under its real cgroup.
No rollback was rehearsed. No load was applied. No production log was read. Every scenario phrased as "N
concurrent requests" or "the host is OOM-killed" is *computed* from limits declared in the tree, not
measured on the box. Where a verdict turns on a production-observable fact — `security-001`'s bucket ACL,
`security-011`'s log contents, `backend-011`'s restart history — §5 names the single observation that would
settle it, and those observations are cheap. They should be made before the corresponding fix is designed,
not after.

One further honest note on scope: this sweep judged findings, not the codebase. A CONFIRMED verdict means
"the reported defect is still present as described"; it does not mean the surrounding code is otherwise
sound, and 235 findings that had never been checked is itself evidence that the ledger's intake ran well
ahead of its verification. The 40% already-fixed rate says the fixing loop is healthy. The 6% refuted rate
says intake quality is high. The 235-item unchecked tail says the *closing* loop was not running at all —
that is the process defect this sweep actually found.
