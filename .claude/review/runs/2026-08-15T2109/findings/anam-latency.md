# Anam avatar startup — end-to-end latency budget

User report: "The Anam avatar comes up VERY VERY slowly." This is the cross-cutting waterfall a
component-level review can't produce: every step from click to first rendered frame, whether it's
serial or parallel, and where FlowVid's own code — not the Anam vendor call — is the tax.

Scope read in full: `client-web/components/avatar/{AvatarPopup,AvatarConversation,avatarApi}.tsx/.ts`,
`backend-api/src/controllers/v1/avatar.controller.ts` (`POST /api/v1/avatar/start`),
`backend-api/src/services/avatar/{anamService,anamKey,avatarAccess}.ts`,
`backend-api/src/services/transcriptPropagation.ts` (`getProjectTranscript`),
`backend-api/src/middleware/firebase-auth.ts`, `deploy/docker-compose.yml`,
`backend-api/src/queue/{registry,pgBossDriver}.ts`, `backend-api/src/server.ts` (worker bootstrap),
`client-web/app/layout.tsx`. Sizes were measured directly from `node_modules`/pnpm-store dist
files (no build was run — no installs/builds allowed under the fleet guard).

**Every timing number below not backed by a direct measurement is marked `status: reasoned` or
`status: suspected`.** The single highest-leverage finding in this report is that none of this is
measured today in production — see anam-latency-001.

---

## The waterfall (click → first rendered avatar frame)

| # | Step | Where | Serial/Parallel | Cost | Status |
|---|---|---|---|---|---|
| 0 | User clicks "Ask!" | `components/avatar/AskAvatarButton.tsx:15` → parent sets `open=true` | — | ~0ms | measured |
| 1 | `AvatarPopup` open-effect fires; `authHeaders()` calls `auth.currentUser?.getIdToken()` | `avatarApi.ts:7-9`, triggered from `AvatarPopup.tsx:56` | **Serial**, blocks the POST | 0ms if the Firebase ID token is cached & fresh; a network round trip to Google (~100-300ms) if it needs silent refresh | reasoned |
| 2 | `POST /api/v1/avatar/start` | `avatarApi.ts:216-221` | Serial (network RTT) | client↔backend RTT, unmeasured | suspected |
| 3 | `firebaseAuthOptionalMiddleware`: JWT verify (local, cached certs) + `db.query.users.findFirst` | `middleware/firebase-auth.ts:94-108` | Serial (Fastify preHandler runs before the route) | 1 DB round trip to the **external** Supabase Postgres (`deploy/docker-compose.yml:19-21` — no local DB container) | reasoned |
| 4a | `db.query.projects.findFirst({avatar_config, visibility, created_by})` | `avatar.controller.ts:171` | Serial | 1 DB round trip | reasoned |
| 4b | `avatarProjectAllowedAsync` | `avatar.controller.ts:173` → `avatarAccess.ts:19-28` | Serial, but **0 DB calls** for the common case (public/unlisted, or the owner — sync check first); 1 DB call only for a private-project collaborator | ~0ms common case | measured |
| 4c | `resolveAnamKeyForProject(projectId)` | `avatar.controller.ts:177` → `anamKey.ts:14-24` | Serial, **and independent of 4d/4e — parallelizable** | 1 DB call (`admin_settings`) always; **+2 more DB calls** (re-fetch `projects` — duplicate of 4a — then `users`) if BYOK is enabled | measured (code); cost reasoned |
| 4d | `enrichAvatarConfigFromAnam(cfg, apiKey)` — only when `cfg.avatarId` is set but a display field is missing | `avatar.controller.ts:182-184` → `anamService.ts:203-235` | Serial after 4c; internally 2 Anam calls in `Promise.all` (`listAnamResource('avatars'/'voices')`, fetch loop at `anamService.ts:731`) | conditional; 1 vendor RTT (parallel pair) when it fires | reasoned |
| 4e | `getProjectTranscript(projectId)` | `avatar.controller.ts:190` → `transcriptPropagation.ts:41-51` | Serial after 4c/4d, **but has no data dependency on either — parallelizable** | 1 DB call (`video_files.findMany`) + synchronous VTT-to-text parsing of every non-broll caption track, unbounded by track count or length | measured (code) |
| 5 | `getSessionToken(characterId, cfg, apiKey)` | `avatar.controller.ts:202` → `anamService.ts:461-544` | Serial (required — this mints the token the browser needs) | see 5a-5c | — |
| 5a | `resolveDefaultLlmId(key)` | `anamService.ts:473` (fetch inside `listAnamResource`, loop at `:731`) | Serial | 0ms if `ANAM_LLM_ID` env is set, or cached (1h TTL); else 1 vendor RTT | measured (code) |
| 5b | `buildPersonaConfig(...)` | `anamService.ts:474` → `:355-424` | Serial | **0ms** when `cfg.personaId` is already saved (fast path); else `getPersona(entry.personaId, key)` — fetch at `anamService.ts:551` — 1 vendor RTT, **on every start for any video with no saved avatar config** | measured (code) |
| 5c | `mintWithToolFallback` → `mintSessionToken` | `anamService.ts:504` → fetch at `anamService.ts:434` | Serial — the one genuinely unavoidable vendor call | 1 vendor RTT (`POST /v1/auth/session-token`) | measured (code) |
| 6 | Controller display-resolution: `if (!displayCfg?.avatarId)` → `getPersona(cfg.personaId, apiKey)` (fetch `:551`) then `describeAvatar(...)` → `listAnamResource('avatars')` (fetch loop `:731`) | `avatar.controller.ts:208-222` | **Serial, and entirely redundant on every request** — see anam-latency-003 | 1-2 **more** vendor RTTs, on top of 5a-5c, whenever the session config doesn't already carry `avatarId` (true for every default-character video, and any video whose config predates the enrich-on-save fix) | measured (code) |
| 7 | `reply.send({...})` | `avatar.controller.ts:223-229` | — | trivial JSON serialize | measured |
| 8 | Backend → client: token response | — | Serial (network RTT) | client↔backend RTT, unmeasured | suspected |
| 9 | `AvatarPopup` sets `token` state → re-renders → **only now** mounts `<AvatarConversation>` | `AvatarPopup.tsx:136-142` | Serial — the video element with id `anam-avatar-video` does not exist in the DOM before this | React re-render, ~0ms | measured |
| 10 | `createClient(sessionToken, ...)` | `AvatarConversation.tsx:183` | Serial | ~0ms, in-memory SDK construction | measured |
| 11 | `new AudioContext()` + `audioCtx.resume()` | `AvatarConversation.tsx:192-194` | Serial, and **starts only now** — see anam-latency-005 | fast if resolved off the click's user-activation window (it is: this is downstream of the same click), but this is 100% local work that had 300ms+ of idle wait (steps 2-8) it could have overlapped | reasoned |
| 12 | Silent-oscillator setup → `videoEl.play()` → **unconditional `await setTimeout(150)`** | `AvatarConversation.tsx:195-204` | Serial, fixed cost, no early-exit | **150ms, every single session, no exceptions** | measured (code) |
| 13 | `client.streamToVideoElement(VIDEO_ELEMENT_ID)` | `AvatarConversation.tsx:210` | Serial — hands off to the SDK | vendor-owned from here | — |
| 14 | Anam SDK: WebRTC/WebSocket negotiation, ICE, TTS/LLM warm-up, first frame → `VIDEO_PLAY_STARTED`/`VIDEO_STREAM_STARTED` | `@anam-ai/js-sdk` internals; listeners at `AvatarConversation.tsx:110-114` | Vendor-owned, opaque | **Entirely unmeasured.** This class of product (WebRTC avatar + live TTS/LLM) commonly costs several hundred ms to a few seconds for connection + first-frame. FlowVid has a 20s watchdog (`AvatarConversation.tsx:75-81`) that assumes this can legitimately take that long. | suspected |

### The bundle question — a separate axis, not on this waterfall

`@anam-ai/js-sdk` (**4.15.0** resolved — `package.json:18` pins `^4.13.1`, so this is not the exact
version the task named, but semver-compatible) is **statically imported**
(`AvatarConversation.tsx:5`, no `next/dynamic` anywhere under `components/avatar/**` — already
filed as `performance-009`, `status: suspected`/`confidence: medium` in `findings/performance.md`,
independently re-confirmed here). Measured from `node_modules` (pnpm store), not a build:

| Package | Installed size | Relevant dist file | Uncompressed |
|---|---|---|---|
| `@anam-ai/js-sdk@4.15.0` | 2.5 MB (incl. maps/types) | `dist/module/*.js` (ESM, what Next would tree-shake from) | 141 KB |
| `katex@0.16.47` (via `EquationRenderer.tsx`) | 4.3 MB (incl. fonts) | `dist/katex.mjs` | 601 KB |
| `chart.js@4.5.1` (via `ChartRenderer.tsx`) | 6.2 MB (incl. maps) | `dist/chart.js` | 408 KB |

Sum of the three ESM entry points: **~1.15 MB uncompressed** (gzip typically 3-4x smaller for JS —
roughly 300 KB, `confidence: medium`, no build available to confirm the actual chunk).

**The counter-intuitive part: this is not click-to-frame latency today.** Because none of
`AvatarPopup`/`AvatarConversation` is dynamically imported, this ~300 KB is downloaded and parsed
as part of the viewer page's own JS bundle *before* the user can click "Ask!" — it's a Time-to-
Interactive tax on every page load (all four viewer surfaces, every visitor, whether or not they
ever open the avatar), not a tax on the click itself. **If `performance-009` is fixed with
`next/dynamic`, this cost moves from page-load to click-time** unless it's paired with a prefetch
(see anam-latency-006) — fixing the bundle finding in isolation would make the reported symptom
("avatar comes up slowly") measurably *worse* unless the chunk is prefetched before the click.
This trade-off should be made explicit to whoever picks up performance-009.

---

## Answers to the questions that decide the fix

**What fraction is FlowVid's code vs. the Anam API vs. the browser?** Unmeasured (see
anam-latency-001) — but structurally, FlowVid's own code contributes, in the worst realistic case
(a video with no saved persona — likely the common/default case, not an edge case; see
anam-latency-003), **up to 8 sequential network round trips it fully controls** before the vendor's
own unavoidable negotiation (step 14) even starts: 1 client→backend RTT, up to 7 DB round trips to
an *external* Supabase instance (steps 3, 4a, 4c×1-3, 4e), and up to **4 sequential Anam API round
trips** (5a llmId, 5b getPersona, 5c mint, 6 getPersona+describeAvatar) — of which only 5c is
strictly unavoidable. That is squarely FlowVid's own serialization tax, not Anam's. Step 14 (the
actual WebRTC/TTS negotiation) is real vendor latency this app cannot shorten — but it is being
paid *in addition to*, not instead of, everything above it. **The fix is therefore both**: stop
serializing/duplicating FlowVid's own calls (cheap, high-confidence wins), and separately look at
prefetch/caching to get step 14 starting closer to click-time (the "vendor round trip" fix the task
asked to distinguish) — they are not the same fix and the first one is available today with no
product trade-offs.

**Which steps are serialized that could be parallel?** Three, concretely, all inside
`POST /api/v1/avatar/start`:
```ts
// avatar.controller.ts:177-190 — today, 4c → 4d → 4e run one after another.
// 4c and 4e have no data dependency on each other; 4d only depends on cfg/apiKey, not on 4e.
const [apiKey, transcript] = await Promise.all([
  resolveAnamKeyForProject(body.projectId).catch(() => undefined),
  getProjectTranscript(body.projectId).catch(() => null),
]);
// then enrichAvatarConfigFromAnam(cfg, apiKey) if still needed — it's the only one that
// genuinely depends on apiKey's result.
```
Separately, `resolveAnamKeyForProject` (`anamKey.ts:14-24`) re-fetches the `projects` row
(`created_by` column) that the controller **already has** in scope at `avatar.controller.ts:171`
(`project.created_by` is already selected). Passing `project.created_by` in instead of the
`projectId` removes one full DB round trip outright, no parallelization needed — this is a plain
duplicate query within one request (anam-latency-002).

**What could be moved off the critical path entirely?** The two Anam display-lookup calls in step 6
(`getPersona` + `describeAvatar`) resolve data — the avatar's display name/portrait — that changes
only when a project owner changes their persona settings. It is being re-fetched from Anam **on
every single viewer's every single session start** instead of once, at save time or on first
resolution (anam-latency-003). This is the single largest FlowVid-controlled, vendor-latency chunk
on the path, and it is pure waste: the data doesn't change between requests.

**Is there a warm-path opportunity?** Three, ranked by how safely they avoid wasting a (paid,
likely rate-limited) vendor mint:
- **Safe, do now:** `<link rel="preconnect" href="https://api.anam.ai">` in `client-web/app/layout.tsx` —
  the SDK's own base URL is `https://api.anam.ai` (confirmed via string search in
  `dist/module/lib/constants.js` of the installed 4.15.0 package — same origin the backend calls
  server-side), so warming DNS+TLS to it costs nothing and saves one full handshake off whichever
  request (client SDK or, indirectly, nothing server-side benefits from a client preconnect) needs
  it first (anam-latency-007).
- **Safe, do now:** pre-create the `AudioContext` (and start the 150ms decoder prewarm) the instant
  the popup opens, in parallel with the token fetch, instead of after it — this doesn't touch the
  vendor at all, it only reorders local browser work (anam-latency-005).
- **Needs a product decision, not safe to do blindly:** prefetching the session token itself (on
  hover, or on video-page mount) risks minting real Anam sessions that are never used — the code's
  own comment states "Anam session tokens are effectively single-use per stream," so an unused
  prefetch is a wasted (and possibly billed) mint, not a free warm-up (anam-latency-006). This is
  the one to design carefully rather than ship reflexively.

**Is the 2-vCPU backend host itself the problem?** **No, not the way the task's premise assumed —
here's what's actually configured**, confirmed by reading `deploy/docker-compose.yml` directly
(not assumed from `stack.md` or memory):
- `backend` (the API/web tier, `deploy/docker-compose.yml:24-59`) sets `WORKER_INLINE: 'false'`
  explicitly, and `server.ts:659-668` only starts the in-process pg-boss worker when
  `WORKER_INLINE === '1'`. **In production, transcode/export/podcast jobs run in the separate
  `worker` container (`docker-compose.yml:62-85`), not inside the process serving
  `/api/v1/avatar/start`.** The "8 of 11 job types run inline" premise, if accurate at all, describes
  the managed-host / local-dev fallback mode (`WORKER_INLINE=1`, mentioned in the `backend`
  service's own comment as the alternative for hosts that can't run a second process) — **not** the
  Docker Compose production topology this repo actually ships (`stack.md` confirms Docker
  Compose + systemd is the real deploy target). So a concurrent transcode does not block the
  `/avatar/start` event loop in production as deployed today. This narrows, but does not eliminate,
  the host-contention question (anam-latency-008 below).
- What **is** true and unaddressed: neither `backend` nor `worker` sets `mem_limit`, `cpus`, or any
  other resource block in `deploy/docker-compose.yml` (confirmed — no such keys appear anywhere in
  the file for either service; contrast `deploy/docker-compose.export-worker.yml:48-49`, which does
  set `mem_limit`/`memswap_limit` for the capture worker). Docker's default CPU scheduling gives
  every container a fair, but not reserved, share of the host's cores — so a CPU-saturating
  `worker` container (running `ffmpeg` at `FFMPEG_CONCURRENCY=2`, `ffmpegLimit.ts:8`) on the same
  2-vCPU host can still delay the OS from scheduling the `backend` container's own JS execution
  slices (JWT verify, JSON parse, the AES decrypt in `resolveAnamKeyForProject`) — even though none
  of `/avatar/start`'s work is itself CPU-bound. This is plausible but **not measured** — no CPU
  scheduling data was available to this static review (anam-latency-008, `status: suspected`).

**RUM/telemetry — is avatar start-time measured anywhere today?** **No.** Grepped
`components/avatar/**` and `services/avatar/**` for `performance.now`, `console.time`, and any
analytics/RUM call — the only `Date.now()`/`performance.now()` usages in the whole avatar subtree
are cache-TTL bookkeeping (`anamService.ts:269,276,313,333,500,542`) and UI debounce timers
(`useVisualTrigger.ts`, `useImageTrigger.ts`), none of which measure or report latency. A RUM system
already exists in this codebase for a different feature — `controllers/sim-rum.controller.ts` +
`services/simulation/RumService.ts` — but nothing avatar-specific reuses it (anam-latency-001).

---

## Findings

### [P1] Avatar start-to-frame latency has zero instrumentation — every number above is a reasoned estimate, not a measurement
- id: anam-latency-001
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:110 (client marks belong here); podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:166 (server marks belong here)
- category: perf
- confidence: high
- status: confirmed
- what: Grepped `performance.now|console.time|Date.now()` across `components/avatar/**` and
  `services/avatar/**` — every hit is cache-TTL or debounce bookkeeping, none report duration
  anywhere. No client-side mark exists between "popup opened" and "video started"; no server-side
  timing exists around the DB/Anam calls in `/avatar/start`; no RUM event ships for either. The
  codebase already has a working RUM pipeline for a different feature
  (`controllers/sim-rum.controller.ts`, `services/simulation/RumService.ts`, migration
  `051_sim_rum.sql`) that nothing avatar-related reuses.
- why: **Every other finding in this report, and every fix proposal, is reasoning from code
  structure, not measurement.** Without real numbers this investigation (and any follow-up "did the
  fix help?" check) is guesswork. This is why the task named instrumentation as the prerequisite
  deliverable, and it is the only finding here that blocks all the others from being verifiable in
  production.
- evidence: Grep results above; read the full `sim-rum.controller.ts`/`RumService.ts` pair to
  confirm a reusable pattern exists (event ingestion + storage), so this is "wire up an existing
  pipeline to a new event," not "build RUM from scratch."
- fix: Client: `performance.mark('avatar:open')` when the popup's open-effect fires
  (`AvatarPopup.tsx:56`), `performance.mark('avatar:token')` when `startAvatarSession` resolves
  (`AvatarPopup.tsx:57`), `performance.mark('avatar:prewarm-done')` after the 150ms wait
  (`AvatarConversation.tsx:205`), `performance.mark('avatar:video-started')` inside the
  `VIDEO_PLAY_STARTED` listener (`AvatarConversation.tsx:111`) — then `performance.measure()` the
  gaps and ship them via the existing RUM beacon pattern (`sendBeacon` to a small new
  `/api/v1/avatar/rum` endpoint, or reuse `RumService.ts`'s ingestion shape). Server: wrap the
  DB-query group, the `getSessionToken` call, and the display-resolution branch in
  `avatar.controller.ts` with `Date.now()` deltas logged via the existing pino `logger`, and/or a
  `Server-Timing` response header so client marks and server marks correlate in one waterfall
  without needing a second dashboard.
- effort: M
- cross: @observability

### [P1] `/avatar/start` re-fetches the avatar's display identity from Anam on every session start instead of caching it — likely the single largest FlowVid-controlled vendor-latency chunk on the path
- id: anam-latency-003
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:208-222
- category: perf
- confidence: high
- status: confirmed
- what: When `!displayCfg?.avatarId` — true for every video using the default-character/base-persona
  path (no per-video `avatar_config.avatarId` saved), and for any video whose config predates the
  save-time enrich fix — the controller does, **sequentially, on every single request**:
  `getPersona(cfg.personaId, apiKey)` (fetch at `anamService.ts:551`) then
  `describeAvatar(sessionAvatarId, apiKey)` (→ `listAnamResource('avatars')`, fetch loop at
  `anamService.ts:731`). Both calls resolve data — an avatar's display name, variant, and portrait
  URL — that is static for a given `avatarId` and only changes when someone edits it in the Anam
  dashboard or the video's own settings.
- why: **Cost model: this is N vendor round trips per session start, where N = number of viewer
  sessions, for data with an effective change frequency near zero.** Two full Anam API calls sit
  directly in the critical path of every avatar open for the default-character case, on top of the
  one unavoidable `mintSessionToken` call (step 5c in the waterfall) and the `getPersona` already
  potentially called inside `buildPersonaConfig` (step 5b, `anamService.ts:382`) for the same
  persona in the same request — i.e. `getPersona(entry.personaId, ...)` can be called **twice** in
  one `/avatar/start` request (once from `buildPersonaConfig`, once from the controller's display
  branch) when neither the video's own `avatarId`/`voiceId`/`llmId` nor a stateful `personaId` fully
  cover both call sites. Every one of these is a real network round trip to `api.anam.ai`, and
  they're all serialized one after another before the response goes back to the browser (which
  itself hasn't even started the vendor's own WebRTC negotiation yet).
- evidence: Read `avatar.controller.ts:200-229` and `anamService.ts:203-235,355-424,548-554` in
  full, tracing every call site of `getPersona`/`describeAvatar`/`listAnamResource` reachable from
  `/avatar/start`. Confirmed `_llmIdCache` and `_defaultAvatarCache`
  (`anamService.ts:257,307`) are the *only* two caches in this file with any TTL — avatar display
  identity (`avatarName`/`avatarVariantName`/`avatarImageUrl`) has no cache anywhere.
- fix: Cache the resolved `{avatarId, avatarName, avatarVariantName, avatarImageUrl}` tuple
  in-process, keyed by `avatarId` (or `personaId`), with the same 1h TTL pattern already used for
  `_llmIdCache`/`_defaultAvatarCache` in this file — a `describeAvatar` result changes at the same
  cadence those two already assume is safe to cache. Better still: when `upsertVideoPersona` (the
  save path, `anamService.ts:560-632`) already resolves and stores these fields on save
  (`avatar.controller.ts:779` calls `enrichAvatarConfigFromAnam` before saving), the `/avatar/start`
  branch should almost never need to hit Anam again for a *configured* video — investigate why the
  default-character path never gets this same treatment (it has no per-video `avatar_config` row to
  cache into) and give it an equivalent process-level cache instead.
- effort: M
- cross: @backend (this file/route is otherwise `backend-reviewer`'s column; filed here because
  caching an expensive, deterministic vendor result is explicitly perf's column per the ownership
  matrix)

### [P2] Three independent lookups in `/avatar/start` are awaited sequentially with no data dependency between them, including one that duplicates a query the caller already ran
- id: anam-latency-002
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:177-190
- category: perf
- confidence: high
- status: confirmed
- what: `resolveAnamKeyForProject(body.projectId)` (line 177), the conditional
  `enrichAvatarConfigFromAnam(cfg, apiKey)` (line 183), and `getProjectTranscript(body.projectId)`
  (line 190) run one after another with plain `await`. `getProjectTranscript` depends on neither
  `cfg` nor `apiKey`'s *result* — only on `projectId`, which is already known before any of the
  three starts. Separately, `resolveAnamKeyForProject` (`anamKey.ts:17-21`) does
  `db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { created_by: true } })`
  — a second, duplicate fetch of the exact row the controller already loaded two lines earlier at
  `avatar.controller.ts:171` (which already selects `created_by`).
- why: **Cost model: each `await` here is a full round trip to an external Postgres instance**
  (`deploy/docker-compose.yml:19-21` — "Database is EXTERNAL (Supabase)", no local DB container),
  not a loopback call. Three-to-five DB round trips are being paid sequentially on every avatar
  start when two of them (`resolveAnamKeyForProject`'s DB work and `getProjectTranscript`) could run
  concurrently, and one specific query (the duplicate `projects` fetch) is pure waste — the data it
  fetches is already in scope.
- evidence: Read `avatar.controller.ts:166-235` and `anamKey.ts:14-24` in full; confirmed
  `resolveAnamKeyForProject`'s `projects.findFirst` selects only `created_by`, which
  `avatar.controller.ts:171`'s `project` variable already has (its `columns` list is
  `{ avatar_config: true, visibility: true, created_by: true }`).
- fix: Wrap the independent calls in `Promise.all([resolveAnamKeyForProject(...), getProjectTranscript(...)])`
  (with `enrichAvatarConfigFromAnam` staying sequential after `apiKey` resolves, since it genuinely
  needs that result). Change `resolveAnamKeyForProject`'s signature to accept the already-known
  `createdBy: string | null` instead of re-deriving it from `projectId`, so the controller passes
  `project.created_by` directly and the duplicate query disappears — this also benefits every other
  one of the ~8 call sites of `resolveAnamKeyForProject` across `avatar.controller.ts` that already
  have `project` in scope.
- effort: S
- cross: @backend

### [P3] A fixed, unconditional 150ms delay is added to every avatar session start with no early-exit
- id: anam-latency-004
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:204
- category: perf
- confidence: high
- status: confirmed
- what: `await new Promise<void>((r) => setTimeout(r, 150))` runs unconditionally inside the
  connect-effect's IIFE, after the silent oscillator starts and before
  `client.streamToVideoElement(...)` is called (line 210). The comment explains the intent (warm the
  OPUS decoder so the first word of the greeting isn't dropped) but the wait is a flat constant, not
  tied to any observable readiness signal (e.g. an `audioCtx.currentTime` delta, or a fixed number
  of `AudioContext` callback ticks).
- why: 150ms is added to **every** session, unconditionally, on top of everything else in the
  waterfall — it is small next to the DB/vendor round trips above it, but it is also the one number
  in this entire path that is 100% within FlowVid's control and currently has zero data behind the
  constant (it was "ported from darwin-avatar" per the comment, not derived for this app).
- evidence: Read `AvatarConversation.tsx:186-211` in full; the comment at lines 187-189 states the
  intent but the value itself is a bare literal with no citation or measurement in this repo.
- fix: Before touching the number, add the RUM mark from anam-latency-001 around this specific wait
  so its real-world necessity/duration can be tuned with data instead of guessed. If it does need
  fixing, prefer an event-driven readiness check (e.g., wait for one `AudioContext` processing
  callback rather than a fixed wall-clock delay) over shortening the constant blindly, since a
  regression here (dropped first word of every greeting) would be worse than the current cost.
- effort: S
- cross: @frontend (the audio-warm-up technique's correctness is theirs to own; this finding is the
  fixed-cost-with-no-evidence angle)

### [P2] The AudioContext/video-element prewarm cannot start until after the full `/avatar/start` network round trip completes, even though it needs no server data
- id: anam-latency-005
- location: podcast-saas/client-web/components/avatar/AvatarPopup.tsx:136-142
- category: perf
- confidence: high
- status: confirmed
- what: `AvatarPopup`'s render gates `<AvatarConversation>` (and therefore its `<video id="anam-avatar-video">`
  element) behind `!token ? <spinner> : <AvatarConversation ... />` (lines 136-142). The
  `AudioContext` creation, silent-oscillator setup, and the 150ms decoder-warm wait (steps 11-12 in
  the waterfall, `AvatarConversation.tsx:192-204`) all require that video element to exist
  (`document.getElementById(VIDEO_ELEMENT_ID)`, line 200), so none of that local browser work can
  begin until the token fetch (the entire backend waterfall, steps 2-8) has already finished.
- why: **Cost model: ~150ms+ of local-only work (no network, no server dependency) is serialized
  after, instead of overlapped with, a backend round trip that this report estimates at several
  hundred ms.** The audio prewarm doesn't need `sessionToken` — it only needs a DOM node to attach
  a `MediaStream` to. Every millisecond of steps 11-12 could instead run concurrently with steps
  2-8, for free.
- evidence: Read `AvatarPopup.tsx:20-148` and `AvatarConversation.tsx:171-224` in full — confirmed
  `sessionToken` is a required, non-optional prop of `AvatarConversation` (`AvatarConversation.tsx:20`)
  and is only used at line 183 (`createClient(sessionToken, ...)`) and by extension line 210
  (`streamToVideoElement`, which needs a live client) — nothing in the audio-prewarm block
  (lines 190-207) references `sessionToken`.
- fix: Render the video element (and start the `AudioContext`/oscillator prewarm) as soon as the
  popup opens, independent of whether the token has arrived yet — either by rendering a stub video
  element in `AvatarPopup` itself and passing its warmed `AudioContext`/`MediaStream` down once
  `AvatarConversation` mounts, or by restructuring `AvatarConversation` to mount immediately with
  `sessionToken` as `string | null` and gating only the `createClient`/`streamToVideoElement` call
  (not the whole component) on the token's arrival.
- effort: M
- cross: @frontend (component restructuring/correctness is their column; this is the
  overlap-instead-of-serialize angle)

### [P2] No prefetch/warm path exists — the entire backend waterfall starts only after the click, even though the "Ask!" button's presence already tells the page an avatar session will likely be requested
- id: anam-latency-006
- location: podcast-saas/client-web/components/avatar/avatarApi.ts:216-221
- category: perf
- confidence: medium
- status: suspected
- what: `startAvatarSession` (and therefore the entire waterfall in this report, both the DB round
  trips and the Anam mint) is invoked exactly once, from `AvatarPopup`'s open-effect
  (`AvatarPopup.tsx:56`) — there is no earlier trigger anywhere in `components/avatar/**` (grepped
  `startAvatarSession(` — the only call sites are `AvatarPopup.tsx:56` and the reconnect path
  `AvatarConversation.tsx:239`). Nothing prefetches on hover, on video-page mount, or after the
  video has played for N seconds.
- why: **Cost model: the full backend waterfall (up to ~8 sequential round trips per this report,
  plus the vendor's own WebRTC negotiation) sits entirely between the click and the first frame,
  when at least part of it could be moved earlier if the product is willing to accept the
  trade-off below.**
- evidence: Grepped `startAvatarSession(` across `client-web/components/avatar/**` — 2 call sites,
  both reactive to an already-open popup, none anticipatory (hover/idle/mount-based).
- fix: Marked `confidence: medium`/`status: suspected` deliberately — Anam session tokens are
  described in this same file's own comment as "effectively single-use per stream" (`anamService.ts:148-151`),
  so a naive prefetch-on-hover risks minting a real (and likely billed) vendor session that's
  discarded unused. Do not implement this without: (a) the RUM data from anam-latency-001 showing
  hover-then-click is common enough to be worth it, and (b) confirming with Anam's billing model
  whether an unconsumed minted token has cost. A safer first step that avoids wasting a mint
  entirely: prefetch/parallelize only the FlowVid-owned parts that don't touch Anam (DB lookups,
  BYOK key resolution) on hover, and keep the actual `mintSessionToken` call triggered by the click.
- effort: L
- cross: @frontend

### [P3] No `<link rel="preconnect">` to the Anam origin the client SDK connects to
- id: anam-latency-007
- location: podcast-saas/client-web/app/layout.tsx:18
- category: perf
- confidence: high
- status: confirmed
- what: The installed `@anam-ai/js-sdk@4.15.0`'s base URL constant is `https://api.anam.ai`
  (confirmed by string search in `dist/module/lib/constants.js`/`ClientMetrics.js` of the resolved
  package) — the same origin the backend calls server-side to mint tokens. No page in `client-web`
  emits a `<link rel="preconnect">` (or `dns-prefetch`) for it — grepped `preconnect` across
  `client-web/app` and `client-web/components`, zero hits.
- why: A cold DNS+TLS handshake to a new origin typically costs on the order of 50-200ms depending
  on network conditions (reasoned, not measured here) — that entire cost is paid the first time the
  client SDK talks to `api.anam.ai`, which today is not warmed until `streamToVideoElement()` is
  called (step 13 in the waterfall, already well downstream of the click).
- evidence: `grep -ro "https\?://[a-zA-Z0-9._-]*" node_modules/.pnpm/@anam-ai+js-sdk@4.15.0/.../dist/module`
  → `https://api.anam.ai` appears in `ClientMetrics.js`/`constants.js`. `grep -rn preconnect client-web/app client-web/components` → no hits.
- fix: Add `<link rel="preconnect" href="https://api.anam.ai" crossOrigin="anonymous" />` to the
  `<head>` in `client-web/app/layout.tsx` (near line 18, alongside the existing font/meta setup) —
  global, since every viewer page can show the "Ask!" button. This is pure upside: a preconnect
  that's never used costs the browser one idle connection, not a wasted vendor call (unlike
  anam-latency-006).
- effort: S
- cross: (none)

### [P3] Backend/worker containers have no CPU or memory resource limits — a CPU-saturating sibling container could still delay the API's own request handling on the 2-vCPU host, even though jobs no longer share its event loop
- id: anam-latency-008
- location: podcast-saas/deploy/docker-compose.yml:24-85
- category: perf
- confidence: medium
- status: suspected
- what: Production `WORKER_INLINE: 'false'` (`docker-compose.yml:39`) plus `server.ts:659-668`'s
  `WORKER_INLINE === '1'` gate together confirm that in the deployed topology, `transcode`/`export`/
  podcast jobs run in the separate `worker` container (`docker-compose.yml:62-85`), **not** inside
  the `backend` process that serves `/avatar/start` — so the specific "does a running transcode
  block the avatar-start event loop" concern the task asked about does not apply to this deploy
  config as written. However, neither `backend` nor `worker` sets `mem_limit`, `mem_reservation`,
  `cpus`, or `cpu_shares` anywhere in `docker-compose.yml` (grepped the whole file — those keys
  appear only in `deploy/docker-compose.export-worker.yml:48-49`, a different service). On a 2-vCPU
  host with no CPU shares/reservation between containers, the OS scheduler still time-slices fairly
  by default, so a `worker` container running `ffmpeg` at `FFMPEG_CONCURRENCY=2`
  (`services/ffmpegLimit.ts:8`) pinning both cores can delay the `backend` container's own CPU
  slices for its synchronous work (JWT verify in `firebaseAuthMiddleware`, JSON parsing, the AES
  decrypt in `resolveAnamKeyForProject`) even though none of `/avatar/start`'s work is itself
  CPU-bound.
- why: This is a plausible secondary contributor to occasional slow avatar starts specifically
  during a concurrent export/transcode burst, but it cannot be confirmed or sized without CPU
  scheduling data (`docker stats`, cgroup throttling counters) that this static review has no access
  to — hence `status: suspected`. Flagging so it isn't silently ruled out just because the
  event-loop-sharing premise (the more obvious version of this concern) turned out to be false.
- evidence: Read `deploy/docker-compose.yml` in full; grepped `mem_limit|cpus|cpu_shares` — zero
  hits for `backend`/`worker`, present only for `export-worker` in the sibling compose file. Read
  `server.ts:655-670` and `ffmpegLimit.ts:1-38` to confirm the inline-worker gate and the ffmpeg
  concurrency default.
- fix: Not a code fix — a deploy config question. If this is worth chasing, add `cpus:` reservations
  (e.g. `backend: cpus: 0.5`, leaving headroom so a `worker`-container ffmpeg burst can't starve it)
  and correlate with the RUM data from anam-latency-001 timestamped against `worker` container CPU
  usage, before spending effort on an isolation change that may not be the actual bottleneck.
- effort: M
- cross: @config-deploy

---

## Ranked interventions

| Rank | Finding | Est. seconds saved | Effort | Vendor-call-safe? |
|---|---|---|---|---|
| **1 (do this first)** | anam-latency-001 — instrument click→frame with RUM marks + Server-Timing | N/A — this is the prerequisite for sizing every other row honestly | M | yes |
| 2 | anam-latency-003 — cache the Anam display-identity lookup instead of re-fetching it every session | Likely the largest single number here — removes 1-2 full vendor RTTs from *every* default-character session start | M | yes (fewer calls, not more) |
| 3 | anam-latency-002 — parallelize the 3 independent backend lookups + drop the duplicate `projects` query | Small per-call, but removes 1 full DB RTT outright and collapses 2-3 more into one wait | S | yes |
| 4 | anam-latency-005 — start the AudioContext/video prewarm the instant the popup opens, not after the token arrives | ~150-300ms overlapped instead of stacked | M | yes |
| 5 | anam-latency-007 — preconnect to `api.anam.ai` | ~50-200ms (reasoned) off the client SDK's own connection | S | yes, free even if unused |
| 6 | anam-latency-004 — re-derive (don't blindly shorten) the fixed 150ms decoder-warm delay | up to 150ms, but only safe to touch once anam-latency-001 exists | S | yes |
| 7 | anam-latency-006 — prefetch/warm path for session start | Potentially removes the entire backend waterfall from the click-to-frame path for the hover-then-click case | L | **no — needs a product decision on wasted-mint risk first** |
| 8 | anam-latency-008 — CPU isolation between `backend`/`worker` containers | Unknown — unconfirmed contributor | M | n/a (deploy config, not code) |

**Do this first:** anam-latency-001 (instrumentation). Every other row in this table is a reasoned
estimate from reading code, not a measurement — and the two next-highest-value fixes
(anam-latency-002, anam-latency-003) are both low-effort, code-only, vendor-call-*reducing* changes
that are safe to ship without waiting on instrumentation if the team wants a quick win in parallel.
The one intervention that must **not** ship before instrumentation (or at least before a product
decision) is anam-latency-006 — it is the only fix here that can make things worse (wasted vendor
mints) if built on guesses about hover-then-click behavior instead of real usage data.
