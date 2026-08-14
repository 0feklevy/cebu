# FlowVid — Full Codebase Review

**Run** `2026-08-13T2227` · branch `feat/agent-fleet-upgrade` · commit `ae4b65b`
**Fleet** v2 — 16 specialist reviewers dispatched in parallel, `fleet-maintainer` auditing the fleet
itself, and **a complete adversarial verification pass over every P0/P1**.

---

## Executive summary

**All 16 domains reviewed. 168 findings raised · 167 survive · 12 P1 · 114 P2 · 41 P3 · 0 P0.**

Every one of the 27 findings filed as P1 was handed to an independent `finding-verifier` whose only
instruction was to **refute** it. **No P0 or P1 in this report lacks a verdict.** The pass changed
the result substantially:

| Verdict | Count | Effect |
|---|---|---|
| **CONFIRMED** at filed severity | 12 | these are the P1s below |
| **CONFIRMED but downgraded** | 9 | → P2 |
| **REFUTED** | 5 | 1 dropped entirely, 4 left a P2/P3 residue |
| **UNCERTAIN** | 2 | demoted to P2, `confidence: low`, with the settling experiment named |

**15 of 27 P1s did not survive at the severity they were filed at, and one did not survive at all.**
An unverified version of this report would have more than doubled its own top-priority list. The
verification pass is not ceremony — it is the difference between a list you can act on and a list
you have to re-check.

Severity as filed → after verification: **P1 27 → 12**, P2 103 → 114, P3 38 → 41.

### No P0 — and that is a measured result

The four highest-risk hypotheses this codebase invites were each hunted deliberately and came back
clean, with evidence:

| Hypothesis | Verdict |
|---|---|
| IDOR across the 34 controllers | **Clean.** Consistent parent-then-scoped-child ownership; the two controllers with no access helper authorize one layer down in `CoursePublishingService.loadOwned`. |
| Path traversal in local media serving | **Clean.** All six filesystem paths in `server.ts` pass `safeLocalPath`, and `keyHasTraversal` is ordered *before* the public-prefix branch — the ordering most implementations get wrong. |
| Stripe webhook forgery | **Clean.** Signature verified over genuine raw bytes; the buffer parser is registered in an encapsulated scope and `verifyWebhook` throws rather than degrading when the secret is absent. |
| Migration-runner drift | **Clean.** All 58 forward migrations present in the hardcoded list in `migrate.ts`, order matches filename sort, zero drift either direction. |

Two more deliberate checks came back clean and are worth recording because they are the failure
modes teams usually *do* have: all 245 routes are free of duplicate method+path collisions and every
`register*Routes` is actually called; and **all 11 job types write a terminal `failed` status with a
user-visible reason on throw**, so the "stuck spinner forever" class does not exist here.

### The three themes that matter

**1. Deliberate deferrals that production no longer matches.** The most consequential findings are
not mistakes — they are staged migrations whose second half never landed while the deployment config
advertises the finished state. `PGBOSS_JOB_NAMES` is `['crop','video_generate']`, so 9 of 11 job
types still run inline on the web tier while `docker-compose.yml` presents a worker container that
handles heavy jobs it never receives. Same shape in simulation: revisioned packages became the read
path, but "Replace simulation" still writes to the legacy prefix — and the compatibility gate that
should have caught that reads the legacy path too, so it reports a clean bill of health.

**2. Buffering on every media path.** Export assembly, captured sim clips, and podcast renders pull
whole files into heap. The export worker runs with `mem_limit: 2048m` while sources are capped at
10 GB.

**3. Configuration that lies about itself.** `podcast-saas/CLAUDE.md` describes a GoDaddy/MySQL
deployment that does not exist. An undocumented `AVATAR_MEMORY_SECRET` silently falls back to using
`DATABASE_URL` as an HMAC key. This is the class that has caused this project's worst incidents, and
the class that poisons agents — the v1 fleet reasoned about the wrong database engine for months
because of it.

---

## The 12 confirmed P1s

Each survived an active refutation attempt. Verifier corrections are included, because they change
what you should actually do.

### `security-001` — a pending collaborator invite can be claimed by anyone who registers the email
`podcast-saas/backend-api/src/middleware/firebase-auth.ts:77`
`email_verified` has **zero** occurrences repo-wide, and the Email/Password provider is provably
enabled (`admin-web/components/LoginPage.tsx:18` ships a live form against the same Firebase config),
so `accounts:signUp` is reachable through the Identity Toolkit REST API with the public web API key.
Whoever registers the address first inherits full edit rights.
**Verifier corrections:** the cited line is **too narrow** — `collabAccess.ts:28-33` and `:118-123`
match `invited_email` on every request, so gating only the middleware would not close the hole. The
invite also never expires (`schema.ts:745-759` has no `expires_at`, token, or single-use marker).
**Fix:** require `decoded.email_verified` at all three sites; add expiry and a single-use token.
*effort M*

### `billing-001` — a late `payment_intent.payment_failed` erases a completed sale
`podcast-saas/backend-api/src/services/billing/BillingService.ts:226`
`markFailed`'s `where` is `eq(billing_transactions.id, …)` with no status term, and both the failure
and success events resolve to the **same row** (`createCheckoutSession:161-162` stamps
`transactionId` into both the PaymentIntent and session metadata; the PI-id fallback at `:235` also
matches the succeeded row). The sale disappears from creator earnings (`billing.controller.ts:155`)
and admin revenue while the buyer keeps access, because access comes from the never-revoked
`user_purchases` grant (`024_billing.sql:53`).
**Verifier note:** `reconcileCheckout` would re-flip the row, but only if the buyer happens to
revisit `/unlock?session_id` — accidental self-healing, not a guard. No ordering test exists.
**Fix:** `and(eq(status,'pending'))` on the update; record and check Stripe's `event.id` in the same
transaction as the effect. *effort S*

### `config-deploy-003` — the database password is the avatar-memory HMAC key
`podcast-saas/backend-api/src/services/avatar/memoryToken.ts:19-21`
`resolveSecret()` returns `AVATAR_MEMORY_SECRET || DATABASE_URL || 'insecure-dev-only-secret'`, and
`AVATAR_MEMORY_SECRET` appears nowhere in `.env.example` — so in every real deployment the signing
key **is** the connection string, password included. The comment says this is deliberate; it is still
a key-separation violation, and the third fallback is a hardcoded literal.
**Fix:** require and document `AVATAR_MEMORY_SECRET`; fail fast in production. *effort S*

### `config-deploy-004` — `podcast-saas/CLAUDE.md` documents a platform that does not exist
It describes GoDaddy Node.js Hosting, managed **MySQL** (`DB_HOST`/`mysql2`), `npm start`, and "no
Docker". Reality: Docker Compose + nginx + systemd over **PostgreSQL**. Every claim about platform,
database, and deploy mechanism is false — and it is the first file both a new engineer and every AI
agent reads. **Fix:** rewrite against `podcast-saas/deploy/`, or reduce to a pointer at
`.claude/reference/stack.md`. *effort S*

### `backend-002` — an unhandled rejection can kill the process
`podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:230` (and `:438`)
No inner `try`/`catch` or trailing `.catch`; **zero** `unhandledRejection`/`uncaughtException`
handlers repo-wide; no `--unhandled-rejections` flag in `package.json` or `backend.Dockerfile:73`;
image is `node:22-bookworm-slim`, so Node 22's default `throw` terminates the process.
**The verifier's refutation backfired and made this worse:** it tried to argue "improbable compound
failure", then found `SimulationService.generateBridgeScript` queries the DB itself
(`SimulationService.ts:2727`) — so a **single** DB fault rejects both the outer promise and the
recovery write. This is a single-fault crash, not a rare coincidence. *effort S*

### `job-queue-001` — B-roll jobs duplicate across a deploy
`podcast-saas/backend-api/src/jobs/video.generate.ts:229`
`recoverStuckVideoGenerations` (`:229-249`) filters on status alone — no age cutoff, no advisory
lock at its only caller (`server.ts:650`). `runVideoGenerate`'s sole guard is
`status === 'ready' || 'failed'` (`:58`), `downloadAndStore` mints a fresh `randomUUID()` key with an
unconditional insert (`VideoGenerationService.ts:293,318`), and there is **no unique index over
`timeline_sections` anywhere** in the migrations (contrast `uniq_project_exports_inflight` in 058).
**Verifier precision correction:** recovery does not re-enqueue *every* non-terminal row — rows
lacking `external_task_id` and not `queued` are marked `failed` (`:242-246`), which is a **separate
hazard**: it can fail a job another worker is actively running. *effort M*

### `job-queue-002` — 9 of 11 job types are not durable, and the deploy config says otherwise
`podcast-saas/backend-api/src/queue/pgBoss.ts:17`
**Framing correction from verification:** `queue/index.ts:10-16` documents the short list as a
deliberate staged rollout ("Phase B") with inline fallback, so a job is never lost *in-process*. The
defect is that `deploy/docker-compose.yml:39` presents a worker container handling heavy jobs it
never receives, and that an in-process crash still loses export, transcode, and podcast render.
**Fix:** extend `PGBOSS_JOB_NAMES`, or correct the compose file so the deployment stops describing a
state that does not exist. *effort M*

### `media-001` — one silent source makes a project permanently unexportable
`podcast-saas/backend-api/src/services/export/exportPlan.ts:233`
Every refutation route closed: no ffprobe of source stream layout anywhere on the export path;
`buildAudioMixBatch` emits a bare `[${i}:a]` with no optional specifier and `anullsrc` is reachable
only when `audio.length === 0`; uploads accept arbitrary files with no audio validation on either
side; and `ExportGateError` is a plain `Error` subclass that `classifyExportFailure`
(`ProjectExportService.ts:100-118`) drops to `unknown`/retryable — so it retries forever.
**Strongest evidence in the whole run:** this repo's own plan document already measured the failure —
`md-files/LINEAR-VIDEO-EXPORT-PLAN.md:682`.
**Verifier correction:** AI-generated video is `is_broll: true` and excluded from `mainVideos`, so it
is *not* an additional trigger. *effort S*

### `perf-001` — export assembly buffers every source video into heap
`podcast-saas/backend-api/src/services/export/LinearAssembler.ts:761-765`
`readObject` into a Buffer, then `writeFile`, over raw source keys capped at 10 GB
(`video.controller.ts:143`) — in a worker with `mem_limit: 2048m`
(`deploy/docker-compose.export-worker.yml:48`).
**Two verifier corrections that change the fix:** `streamObject` is **not** on the `StorageService`
interface (`StorageService.ts:86` declares only `readObject`) and exists on `R2StorageAdapter` alone
(`:98`) — the production Supabase adapter and the local adapter have none, so this is an interface
change plus two implementations, not a one-line swap. And "heap held twice" is wrong: the transient
2× is `Buffer.concat` inside `readObject`; the loop is sequential, so peak is one object, not N.
*effort M → L given the interface work*

### `simulation-001` — "Replace simulation" is a silent no-op for any revisioned sim
`podcast-saas/backend-api/src/services/simulation/SimulationService.ts:2614`
`processReplace` uploads under the legacy mutable `storage_prefix` and never flips
`active_revision_entry_key`, which is what every read path serves from
(`simulationUrlResolver.ts:72-74`). The route returns 202, nothing changes, and the next bridge
generation rebases off the active revision — stranding the replaced bytes permanently.
**Independently corroborated:** a repo-wide grep finds exactly one writer of
`active_revision_entry_key` outside tests and migrations — `scripts/seed-sim-pool-synthetic.ts:222`.
No service or controller sets it. *effort M*

### `simulation-002` — the replace-compatibility gate is blind for exactly the packages that matter
`podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:381-384`
Reads `${sim.storage_prefix}/bridge.js` with `.catch(() => '')` and nothing else — contrast
`SimulationService.ts:3031-3059`, which branches on `active_revision_id`. An empty bridge genuinely
yields `compatible: true` with `sectionsTotal: 0` **and** `sectionsUnverifiable: 0`
(`SimBridgeContract.ts:390-400`), so nothing looks wrong. The legacy copy is never refreshed
(publication writes bridge.js only into the new revision, `:3136-3145`; migration copies without
deleting, `RevisionMigration.ts:275-285`).
**Verifier addition:** pre-revision sims are still checked correctly, but migration-on-write means
the first live section generation revisions the package — so the gate goes blind for exactly the
packages that have a bridge worth preserving. It is reachable read-only today via `?dry_run=true`
(`:398-400`), which reports a **false clean bill of health**. Fix with `simulation-001`. *effort M*

### `observability-001` — every auth failure looks identical
`podcast-saas/backend-api/src/middleware/firebase-auth.ts:89`
Both catches are bare `catch {` with `return reply.code(401)` instead of a rethrow, so
`server.ts:587`'s `setErrorHandler` never sees them (and it only logs at 5xx). `services/firebase.ts`
has no logging either, and the 401 reuses the same `error_type: 'connection_error'` as the no-token
branch — nothing distinguishes a bad token from a Firebase outage or a Postgres failure in the upsert.
**Verifier correction:** the finding's `verify` step was wrong — breaking `FIREBASE_PROJECT_ID` fails
loudly at boot (`server.ts:689-691`). The silent path is the runtime subclasses: expired/revoked key,
clock skew, network partition, DB error during upsert. *effort S*

---

## Refuted claims

Kept visible on purpose. A report that never rejects anything is not being checked.

- **`frontend-001` (was P1) — REFUTED, dropped.** Every guidance SSE frame is written as
  `data: ${JSON.stringify(data)}` (`simulations.controller.ts:732`, `:839` — the only writers), so the
  malformed-payload trigger does not exist; a truncated frame is never dispatched at all, because SSE
  dispatches on the blank-line terminator, and it surfaces on the *guarded* `es.onerror`
  (`SectionEditor.tsx:1037-1045`). "Permanently disabled" is also wrong: the Cancel button
  (`:2300-2307`) renders whenever `guidanceBusy` is truthy and is not gated on it.
- **`observability-002` (was P1) → P3.** `/health` really is DB-only, but every load-bearing claim
  failed: the failure is logged at `error` not `warn` (`server.ts:668`); only 2 of 11 job types route
  through pg-boss, so 9 are unaffected by `startWorker()`; and the cited block is gated on
  `WORKER_INLINE === '1'` while production sets `'false'` (`docker-compose.yml:39`) — unreachable in
  the documented topology, where `worker.ts:27-30` exits(1) into a visible crash loop.
- **`config-deploy-001` (was P1) → P3.** The backend guard is unimportable from client-web (different
  package and container) and would break the deploy, since compose deliberately sets
  `BACKEND_API_URL: http://backend:8080` for private-network SSR. The value is server-only
  (`courseApi.ts:7` is `import 'server-only'`) and the browser side already has its own fail-closed
  guard (`next.config.ts:12-27`) plus a release-blocking `scan-bundle-localhost.sh`. Residual P3:
  `getPage()` lacks the try/catch its two siblings have.
- **`config-deploy-002` (was P1) → P3.** The two ceilings never gate the same request.
  `MAX_UPLOAD_BYTES` guards only the direct-to-cloud control routes, where bytes go browser→Supabase
  and never traverse nginx. The one route whose bytes cross nginx is capped by a hardcoded `TEN_GB`
  and surfaces a clear pre-transfer 413 ("The maximum is 10.0 GB").

### A systematic error the verifiers caught

Two independent verifiers noticed that some findings assumed `WORKER_INLINE=1` in production, when
`deploy/docker-compose.yml:39` sets `'false'`. A targeted sweep confirmed the contamination is
**contained to exactly the two findings already caught** (`backend-001`, `observability-002`) — both
already downgraded. `job-queue` and `config-deploy` cited it correctly. Recorded because a shared
wrong premise is precisely what a single-reviewer process cannot catch.

---

## Unresolved — with the experiment that would settle each

- **`config-deploy-014`** `services/podcast/audio/ffmpegAudio.ts:179` — whether the pinned ffmpeg-8
  image **rejects** or merely **warns** on `-filter_complex_script`. Every empirical statement in the
  repo says *deprecated*, never removed; but there is no version probe, no fallback, no test, and the
  ffmpeg-8 pin landed 3 commits ago, so podcast renders have never run against it in production.
  **One command decides between P3 and P0:**
  `docker run --rm <ffmpeg-n8.1-image> ffmpeg -filter_complex_script /dev/null -f null -`
  (exit 0 with a warning → P3 hygiene; non-zero → **every podcast render breaks on the next deploy**).
  Not run here: docker is denied to the fleet by design.
- **`dependency-001`** `adm-zip` — version and reachability confirmed (`^0.5.10`, lockfile resolves
  **0.5.17**, imported at `simulations.controller.ts:3`, `avatar.controller.ts:12`,
  `SimulationService.ts:1`, all attacker-reachable upload paths). The specific advisory the reviewer
  cited was **not independently confirmed**. Confirm the advisory and its affected range before
  changing the pin.

---

## P2 and P3

90 P2 and 36 P3 are in `findings/*.md`, one file per domain, each with `file:line`, evidence, a
concrete fix, and effort. Recurring shapes:

- **`security-002` — the media authorization gate fails open on a DB fault** (P2, CONFIRMED).
  `mediaAccess.ts:82-87` logs and returns `true`. Held at P2 because it is not attacker-inducible and
  needs prior possession of an unguessable double-UUID key — but note the verifier's warning: the
  `/health` 503 drain **stays green** under exactly the statement-timeout conditions that trip this
  catch, so do not count it as a mitigation. Flagged independently by three agents.
- **`int8` returned as a string.** Postgres `count(*)`/`sum()` come back as strings because
  `db/index.ts` registers no int8 parser. Most importantly `services/usage/RateLimitService.ts:19` —
  **the LLM-spend gate holds only by JS coercion.**
- **Untransacted multi-writes** — polymorphic `collaborators` cleanup at `projects.controller.ts:436`
  and `playlists.controller.ts:467` orphan invite rows on a crash.
- **`migrate.ts:49`** records a migration as applied even when its transaction rolled back on a
  tolerated error code, so genuinely-new DDL in that file is dropped and can never be retried.
- **Accessibility** — missing accessible names and focus traps across modals, dropzones, and icon
  buttons; the editor timeline is entirely mouse-driven.

---

## What looks healthy

- **Authorization design.** Parent-then-scoped-child ownership applied consistently across all 34
  controllers. The IDOR sweep found nothing.
- **Path containment.** `pathSafety.ts` is correct *and correctly ordered*.
- **The Stripe raw-body path.** Genuinely hard under Fastify, and right down to throwing rather than
  degrading when the secret is missing. The `UNIQUE (user_id, content_type, content_id)` grant is real
  in SQL, and platform-fee arithmetic is correct integer minor units summing exactly to the total.
- **Job failure surfacing.** All 11 job types write a terminal `failed` status with a reason.
- **The migration runner list.** Zero drift across 58 files.
- **`ffmpegLimit.ts`** — a real global concurrency bound with a written rationale.
- **`ContentModerationService`, `ScriptRoom`'s per-pass timeout, `parseAndRepair`** — examined and
  deliberately not filed against.
- **Backend suite green:** 125/128 files, 2185 tests. Both frontends typecheck clean.

---

## Coverage gaps

- **`test-quality` landed on rerun** (14 findings, 0 P1 after verification). Nothing is red: a
  targeted subset ran 27 files / 339 tests green, the full backend suite is 125/128 files with 2185
  green, and repo-wide there are **zero snapshots**, no PGlite leakage across files, bounded
  randomness, and exactly one `describe.skip` (an env gate, not a disablement). Both of its P1s were
  knocked down on verification: `test-001` **REFUTED** — `FAKE_SIM` is a legacy sim by construction,
  so the legacy-prefix assertions are the correct outcome for the case under test and stay green
  after `simulation-001` is fixed; it is an ordinary coverage gap, not a test that protects a bug.
  `test-002` CONFIRMED → P2: `ClaudeProvider.test.ts:203` is named "throws AppError ABORTED when
  signal fires" but awaits the promise and asserts only `toBeDefined()`, which passes for `''` — and
  the mock ignores the signal, so it can never reach the real `AppError(ABORTED)` path
  (`ClaudeProvider.ts:153-154`).
- **`types-contracts` landed on rerun** (15 findings, **0 P1**) and its headline is a **negative
  result worth stating loudly: path/verb drift is zero.** All 160 client call sites and all 79
  hand-rolled frontend calls resolve to registered routes (sole exception `sse-client.ts:14`, dead
  code); all 23 `204` routes map to `Promise<void>`; the export contract this branch touches is
  clean. The anticipated "guaranteed 404" P1 class **does not exist**. All four packages typecheck
  green with zero errors — which is evidence *for* `types-001/002` rather than reassurance, since no
  compilation unit spans a route and its caller.
  Honest edges, in the reviewer's own words: its scanner **produced convincing false drift three
  times** before it was fixed (a verb lookahead invented 16, a query-suffix strip invented 37, a
  quote anchor hid 60 of 95 call sites), and field-level shapes were **sampled, not exhaustively
  diffed** — `admin-v1.ts` fully audited, `client-v1.ts`'s 144 methods checked at the boundary and
  on the admin/export/billing/playlist paths. A rename deep inside an unvisited nested response
  would not have been caught.
  What it did find is structural: every API response enters through an unvalidated
  `JSON.parse(...) as T` (`client-v1.ts:801`) while the zod schemas that would validate it already
  exist in `shared/src/types/*` and are imported `import type` only; and
  `updateSettings(Partial<AdminSettings>)` advertises 33 settable fields while non-strict zod
  silently strips 16 and returns 200 with an unchanged row
  (`admin-v1.ts:180` ↔ `admin/v1/settings.controller.ts:9-30`).
- **Directly relevant to in-flight work:** `test-007` flags
  `services/export/capture/localCaptureProvider.ts` as 330 untested lines, which the working-tree
  change to `queue/registry.ts:14` gives **precedence over the container provider** — whose sibling
  shipped with a 10.8 KB suite on the same branch.
- **Playwright suites reviewed statically only**, by design.
- **`dependency-auditor` could not run `pnpm audit`** (blocked by policy, correctly).
- **Nine backend service directories had no owning agent** when this run started (`podcast/`,
  `course/`, `avatar/`, `ingestion/`, `project/`, `seo/`, `secrets/`, `security/`,
  `video-generation/` — 78 files). `fleet-maintainer` caught it; ownership is now assigned explicitly
  in `stack.md` and `PROTOCOL.md`, but **those directories were not reviewed in this run.**

---

## The fleet audited itself

`fleet-maintainer` ran against `.claude/` and found **2 blocking issues, 11 drift items, 9 coverage
gaps, and 13 ways to bypass the enforcement hook.** Its central finding: the guard was a denylist of
command spellings, and denylists of shell syntax do not hold — `sed -i`, `tee`, `>` redirection, a
`..` walk through the Write allowlist, `Grep path=.env`, `.ENV` on a case-insensitive filesystem,
`git -C … push`, `pnpm -C … add`, and `tsx migrate.ts` all sailed past it.

All fixed and re-tested: the guard is now an **allowlist** in readonly mode with resolved paths,
`.claude/settings.json` adds a project-wide secrets floor so an agent that forgets to opt in is still
covered, and **47/47 tests pass** — every one of the 13 bypasses denied, legitimate work still
allowed. `PROTOCOL.md`'s safety claim was rewritten to state precisely what is and is not enforced,
because the original claim was false.

Full detail: `.claude/review/FLEET-AUDIT.md`.

---

## Suggested order of work

See `FIX_PLAN.md` for mechanical detail.

1. **`billing-001`** — one `and(eq(status,'pending'))` clause. Confirmed, S, stops erased sales.
2. **`config-deploy-003`** — require and document `AVATAR_MEMORY_SECRET`. Confirmed, S.
3. **`config-deploy-004`** — fix or delete `podcast-saas/CLAUDE.md`. Confirmed, S, and it stops
   poisoning every future agent run.
4. **`backend-002`** — a `.catch` on the recovery write. Confirmed, S, prevents a process crash from a
   single DB fault.
5. **`media-001`** — probe for an audio stream before emitting the mix window. Confirmed, S, and the
   repo already documented the failure.
6. **`security-001`** — `email_verified` at all three sites, plus invite expiry. Confirmed, M.
7. **`simulation-001` + `-002` together** — the replace path. Both confirmed; treat as a designed
   change, not a patch.
8. **Run the `config-deploy-014` ffmpeg command** before the next deploy. One command, and the answer
   is either "hygiene" or "podcast renders are about to break".
