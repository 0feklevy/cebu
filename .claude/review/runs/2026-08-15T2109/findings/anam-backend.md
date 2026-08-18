# Anam avatar start path — backend root-cause investigation

**Report under investigation:** "The Anam avatar comes up VERY VERY slowly."
**Scope:** backend half of `POST /api/v1/avatar/start` only.
**Baseline:** `pnpm -C podcast-saas --filter backend-api typecheck` → clean (`tsc --noEmit`, no output).

## Method — a real timing harness, no real API key, no network

I ran `podcast-saas/backend-api/src/services/avatar/anamService.ts` under `tsx` with `globalThis.fetch`
replaced by a stub that records every URL/method/body-size and sleeps a fixed simulated round-trip
(`SIM_RTT_MS`). This is the same stubbing technique the repo's own
`src/services/avatar/__tests__/anamStaleFallback.test.ts:12` uses. **The real Anam API was never
called and no `.env` was read**; `ANAM_*` values were passed as literal fake strings on the command
line (they must be process env, because `ANAM_ENV`/`PERSONA_MAP` at `anamService.ts:12,30` snapshot
`process.env` at module-load time).

The harness measures the thing that matters: **how many round-trips are SEQUENTIAL**, since wall
time ÷ RTT gives the depth of the waterfall regardless of what Anam's real latency is.

`getSessionToken` has no DB import, so it runs standalone. The controller's DB steps are reasoned
about from the code and measured separately for CPU/bytes.

For the session-lifecycle questions I also read the **vendored SDK**,
`podcast-saas/client-web/node_modules/@anam-ai/js-sdk@4.13.1` — its `.d.ts` surface is direct
evidence of the v4 API and settles what no amount of backend reading could.

---

## THE ANSWER: the ordered round-trip list

Every hop between the client's `POST /api/v1/avatar/start` and the client receiving a usable
`sessionToken`. "Depth" = position in the sequential chain (same number = actually parallel).

| # | Depth | Hop | file:line | Critical path? | Parallel / cacheable / skippable? |
|---|---|---|---|---|---|
| 1 | 1 | DB `projects.findFirst` (avatar_config, visibility, created_by) | `podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:171` | yes — it is the auth gate | must be first |
| 2 | 2 | DB `isCollaborator` (private project + non-owner only) | `.../services/avatar/avatarAccess.ts:29` | rare | fine |
| 3 | 2 | DB `admin_settings` BYOK-flag select — **unconditional, uncached** | `.../services/avatar/anamKey.ts:13` | yes | **parallelisable with #1**; a global flag, cache for 30 s |
| 4 | 3 | DB `projects.findFirst` **again** — re-reads the row #1 just read | `.../services/avatar/anamKey.ts:15` | BYOK on only | **eliminable**: pass `created_by` from #1 |
| 5 | 4 | DB `users.findFirst` + `decryptKey` | `.../services/avatar/anamKey.ts:17` | BYOK on only | cacheable per user |
| 6 | 5 | **Anam** `GET /avatars` + `GET /voices` (each a 1–6-page *sequential* loop) | `.../services/avatar/anamService.ts:210` → `:731` | only when `avatarName`/`avatarImageUrl`/`voiceId` were not persisted | **precomputable at save time**; uncached |
| 7 | 6 | DB `video_files.findMany(captions_vtt)` for **every** video, no LIMIT + VTT parse | `avatar.controller.ts:190` → `.../services/transcriptPropagation.ts:45` | yes | **parallelisable with #1/#3**; wasted entirely on the stateful path |
| 8 | 7 | **Anam** `GET /llms` | `anamService.ts:473` → `:270` → `:731` | only if `ANAM_LLM_ID` unset or BYOK | cached 1 h **per process** (useless across replicas) |
| 9 | 8 | **Anam** `GET /personas/{base}` | `anamService.ts:382` → `:551` | yes on the ephemeral path | **skippable** — see anam-backend-005 |
| 10 | 8 | **Anam** `GET /avatars` + `GET /voices` live-default probe | `anamService.ts:395` → `:314` | only when no avatar/voice anywhere | cached 1 h per process |
| 11 | 9 | **Anam** `POST /auth/session-token` — **the only strictly necessary call** | `anamService.ts:434` | yes | — |
| 12 | 10 | **Anam** retry mint without `toolIds` (on a 400) | `anamService.ts:456` | conditional | — |
| 13 | 10–11 | **Anam** stale/legacy rebuild: `buildPersonaConfig` again (→ another `GET /personas`) + second mint | `anamService.ts:515`, `:521` | conditional, but **permanent** once a personaId goes stale | see anam-backend-010 |
| 14 | 12 | **Anam** `GET /personas/{video}` for the popup's face | `avatar.controller.ts:211` | **after the token exists, before the reply** | display only |
| 15 | 13 | **Anam** `GET /avatars` (full paging loop, *second* time this request) | `avatar.controller.ts:213` → `anamService.ts:343` → `:731` | **after the token exists, before the reply** | display only |

**No LLM provider is called on this path** (`services/llm/*` is untouched by `/avatar/start`).
**No DB transaction is held across the external HTTP calls** — I read the whole handler
(`avatar.controller.ts:166-235`); there is no `db.transaction`, and drizzle/postgres-js acquires and
releases per statement. So the pool is not pinned during the Anam waits. That one is clean.

### Measured (SIM_RTT_MS=120, 40-avatar account)

```
A. STATEFUL happy path (personaId kept)          132ms  ~1 sequential RTT, 1 call, 118 B body
B. EPHEMERAL (personaId dropped at :197)         243ms  ~2 sequential RTT, 2 calls, 29 705 B body
D. + enrich preflight                            367ms  ~3 sequential RTT, 4 calls
E. no avatar pinned + describeAvatar             366ms  ~3 sequential RTT, 3 calls
F. stale personaId → 400 → rebuild               367ms  ~3 sequential RTT, 3 calls
G. brainless persona → legacy → rebuild          369ms  ~3 sequential RTT, 3 calls
H. two SIMULTANEOUS /start (double-mount)        243ms  ~2 sequential RTT, 4 calls  ← 2 full mints
```

### Measured (SIM_RTT_MS=120, `ANAM_LLM_ID` unset, 250-avatar/250-voice account)

```
A. STATEFUL happy path                           256ms  ~2 sequential RTT, 2 calls
D. + enrich preflight                            730ms  ~6 sequential RTT, 9 calls   ← 6 deep
E. no avatar pinned + describeAvatar             729ms  ~6 sequential RTT, 6 calls
H. two SIMULTANEOUS /start                       366ms  ~3 sequential RTT, 6 calls
```

**Read the ratio, not the milliseconds.** The waterfall is **1 round-trip deep at best and 6 deep in
realistic production shapes**, plus 3–5 sequential DB round-trips in front of it. A real
`POST /auth/session-token` carrying a 30 KB persona is not 120 ms — at a realistic 400–900 ms it is
2.5–6 s of pure backend serialisation before the browser can even begin the WebRTC join.

### Straight answer for the orchestrator: which layer dominates?

**The vendor round-trips dominate, but the count of them is ours.** One `POST /auth/session-token` is
unavoidable. Everything else in the table — up to 5 extra sequential Anam calls and 4 extra DB calls
— is work this repo chose to do per-start that can be precomputed, parallelised, cached, or skipped.
The frontend's serialised steps and its unconditional 2 s `VIDEO_STREAM_STARTED` fallback
(`client-web/components/avatar/AvatarConversation.tsx:114`) are real and worth fixing, but they are
additive to a backend chain that is 2–6 vendor round-trips deep.
Fix anam-backend-001 first: it collapses the common case from 6 hops to 1.

---

## SESSION LIFECYCLE — the escalation, tested against the vendored SDK

The orchestrator escalated the `/avatar/end` stub as *"a monotonically accumulating slot leak …
every session ever started is held until Anam's own server-side timeout … possibly the single
highest-value fix in the whole audit."*

**I tried to confirm that and could not. The core claim is refuted by the vendor SDK's own type
surface.** The stub is real, but it leaks nothing, because **the backend never creates an Anam
session in the first place.**

### The evidence, from `client-web/node_modules/@anam-ai/js-sdk@4.13.1`

`dist/main/lib/CoreApiRestClient.d.ts` declares the *entire* v4 core REST surface:

```ts
export declare class CoreApiRestClient {
    startSession(personaConfig?, sessionOptions?): Promise<StartSessionResponse>;
    unsafe_getSessionToken(personaConfig: PersonaConfig): Promise<string>;
}
```

Two methods, and they are different things:

- **`unsafe_getSessionToken`** is the `POST /v1/auth/session-token` call our backend re-implements by
  hand at `anamService.ts:434`. It returns *a string*. No session id, no engine host.
- **`startSession`** returns `StartSessionResponse`
  (`dist/main/types/coreApi/StartSessionResponse.d.ts`):
  `{ sessionId, engineHost, engineProtocol, signallingEndpoint, clientConfig }`.
  **This is where a `sessionId` first exists.**

`startSession` is called only from the browser: `dist/main/AnamClient.js:133` →
`this.apiClient.startSession(config, sessionOptions)` → `this.sessionId = sessionId` at `:143`,
reached via `startSessionIfNeeded` (`:195`, `:198`) from the streaming entry points (`:223`, `:273`).
Our backend never calls it and could not — it has no `sessionId` to hold.

**The concurrency limit is enforced at `startSession`, not at mint.** `CoreApiRestClient.js:116-117`:

```js
if (errorCause === 'Concurrent session limit reached') {
  throw new ClientError('Concurrency limit reached, please upgrade your plan',
    ErrorCode.CLIENT_ERROR_CODE_MAX_CONCURRENT_SESSIONS_REACHED, 429, { cause: data.message });
}
```

That code path is inside the *client* REST helper, raised from the `startSession` attempt loop.

### Consequences, in order

1. **A minted-but-never-streamed token consumes no slot.** There is no session to hold. The frontend
   agent's cancelled-fetch case (anam-frontend-001) wastes a token and a couple of Anam round-trips;
   it does not leak a concurrency slot. On my read that is a **P2/P3**, not a P1.
2. **A normally-closed popup does not leak either**, contrary to the escalation.
   `AvatarConversation.tsx:221` calls `client.stopStreaming()` on unmount, `:213` on `unload`, and
   `:231` on leave. `stopStreaming` (`AnamClient.js`) emits `CONNECTION_CLOSED`, awaits
   `streamingClient.stopConnection()`, and nulls `this.sessionId`. Tearing down the transport **is**
   the release mechanism in this SDK.
3. **There is no session-termination REST endpoint to implement.** I searched the SDK for one:
   no `stop`/`end`/`delete` session method exists on `CoreApiRestClient`, and no `/v1/...` session
   path is embedded anywhere in `dist/`. So "write `endSession()` in `anamService.ts`" is not a fix
   that can be written — there is nothing to call.
4. **A truly orphaned session is bounded, not unbounded.** Every `personaConfig` we send carries
   `maxSessionLengthSeconds`, defaulted at `anamService.ts:361` to **600 s** and constrained to
   60–3600 by `AvatarConfigSchema` (`avatar.controller.ts:697`). It is applied on both the stateful
   (`:366`) and ephemeral (`:403`) branches. So the vendor-side TTL is **ours to set and is already
   set**; the worst case is bounded by (orphan rate × 10 min), not monotonic accumulation.
5. **No server-side reaper is needed, and none could be written today anyway** — the backend retains
   no session identity: `anamService.ts:443` destructures only `{ sessionToken }`, `tokenTypeClaim`
   (`:284`) decodes the JWT but keeps only the `type` claim, and
   `grep -n "pgTable" src/db/schema.ts | grep -i session` returns nothing (the avatar tables are
   `schema.ts:804,825,835`). But per (1)–(3) there is nothing for it to reap.

I also searched the whole backend for any release path, as asked:
`grep -rniE "endSession|terminateSession|deleteSession|stopSession|closeSession|recoverStuck" src`
→ the only matches are the podcast/video/crop/simulation `recoverStuck*` sweeps wired at
`server.ts:644-650`. None touches avatars. Confirmed: no route, hook, job or cron releases an Anam
session — and none needs to.

### What survives from the escalation

The stub is still a defect, just a small one — filed as **anam-backend-004 (P3)**. And one useful
thing does fall out of the SDK read: the 429 concurrency error is a *typed* `ClientError` the
browser can catch, so the 20-second watchdog hang at `AvatarConversation.tsx:78` is avoidable
client-side. Signalled to @frontend.

**Severity call, on the evidence and against the framing I was given: this is not the
highest-value fix in the audit. anam-backend-001 is.**

---

### [P1] The saved Anam persona is thrown away on every start, forcing a slow ephemeral mint
- id: anam-backend-001
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:197
- category: perf
- confidence: high
- status: confirmed
- what: `if (cfg.personaId && !cfg.knowledgeToolId) cfg = { ...cfg, personaId: undefined };` discards
  the per-video Anam persona that `PUT /avatar/config` already created and saved
  (`avatar.controller.ts:788` → `upsertVideoPersona`), for every start of any project that has a
  caption transcript but no `knowledgeToolId`. `buildPersonaConfig` then takes the ephemeral branch
  (`anamService.ts:369-418`) instead of returning `{personaId}` in one line at `anamService.ts:365`.
- why: this is the single largest latency item and the direct answer to the user's report. Measured
  with the harness: the stateful path is **1 sequential round-trip with a 118-byte body**; the
  ephemeral path this line forces is **2 round-trips (small account) to 6 round-trips / 9 HTTP calls
  (250-avatar account, unpinned `ANAM_LLM_ID`) with a 29 705-byte body**. Beyond the round-trips,
  Anam must construct a brand-new persona and prime its LLM with a ~30 KB system prompt on *every
  single session* rather than reusing a persona it already has resident — vendor-side warm-up the
  stateful path skips entirely. The persona is already precomputed at save time; this line makes
  that precomputation pointless. Introduced by b06feb4 (2026-07-30), "avatar video knowledge + live
  Anam defaults", which matches a "suddenly slow" report.
- evidence: read `avatar.controller.ts:185-198` and `anamService.ts:355-424`. Harness scenarios A vs
  B/D: `A 132ms ~1 RTT / 1 call / 118B` vs `D 367ms ~3 RTT / 4 calls / 29705B` at 40 avatars, and
  `A 256ms ~2 RTT` vs `D 730ms ~6 RTT / 9 calls` at 250 avatars. `git show b06feb4` adds exactly
  these lines. `git log` confirms no later commit touches them.
- fix: keep the stateful path and move the knowledge to save time, where it already belongs.
  (a) Delete line 197. (b) Have `upsertVideoPersona` (`anamService.ts:560`) record what it actually
  baked — add `personaToolIds: string[]` and `personaKnowledgeHash` to `avatar_config` when it
  writes the persona. (c) At start, take the ephemeral path only when
  `personaKnowledgeHash !== hash(currentTranscript)`, and when that happens, re-bake the persona
  asynchronously so the *next* start is fast again. (d) `transcriptPropagation.ts:201-213` already
  re-bakes the persona on caption-ready — widen its guard (see anam-backend-011) so it fires for
  every project and this branch is reached ~never.
- verify: extend `src/services/avatar/__tests__/anamStaleFallback.test.ts` with a case asserting
  that a cfg carrying `personaId` + a baked knowledge hash produces exactly **one** fetch, whose
  `personaConfig` is `{personaId, maxSessionLengthSeconds}` and whose body is < 200 bytes. Red
  before, green after. Then re-run the harness: scenario D should collapse from ~6 RTT to ~1.
- cross: @frontend, @performance
- effort: M

### [P1] No timeout on any Anam call — a slow vendor hangs /avatar/start for minutes
- id: anam-backend-002
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:434
- category: bug
- confidence: high
- status: confirmed
- what: not one of the Anam `fetch` calls passes a `signal`. `:434` (mint), `:551` (`getPersona`),
  `:617` (persona upsert), `:639` (`anamFetch`, which fronts every knowledge/tools call), `:731`
  (the resource paging loop) all call bare `fetch`. Node's built-in fetch applies **no**
  request-level timeout.
- why: this is the mechanism that turns "Anam is having a bad minute" into the user's literal
  complaint. With 2–6 of these chained (see the waterfall), one stalled hop stalls the whole reply
  with no error and no fallback — the client just sits there. The repo already knows the right
  pattern and uses it in a sibling service:
  `podcast-saas/backend-api/src/services/course/transcript.ts:30-36` builds an `AbortController`
  with a 4000 ms timeout for exactly this reason. **Anam's own SDK does it too** —
  `client-web/node_modules/@anam-ai/js-sdk/dist/main/lib/CoreApiRestClient.d.ts` has private
  `requestTimeoutMs` and `retryOptions` fields. Our hand-rolled backend client is the only caller of
  this API with no bound at all.
- evidence: `grep -n "AbortSignal.timeout\|signal:" src/lib/ src/services/avatar/ src/server.ts` →
  only `src/server.ts:337`, nothing in `services/avatar`. Empirically confirmed the default: a bare
  `fetch()` to a socket that accepts and never responds was **still pending after 12 s** with no
  rejection (undici's only bounds are its 300 s headers/body timeouts). Also note
  `src/lib/fetchWithRetry.ts` exists and is **not used** by `anamService.ts`.
- fix: add `signal: AbortSignal.timeout(ms)` to every Anam fetch — 8000 ms for the two mints
  (`:434`), 4000 ms for `getPersona` (`:551`) and each page in `listAnamResource` (`:731`), and have
  the *optional* hops degrade instead of failing: `listAnamResource` already `break`s on a bad
  response, so an abort there should be caught per-page and return what it has; `getPersona`
  already returns `null` on failure. Only the mint should surface an error, as a 504 with a clear
  message rather than a hang.
- verify: a vitest case that stubs `fetch` with a never-resolving promise and asserts
  `getSessionToken` rejects within ~9 s rather than hanging; `pnpm -C podcast-saas --filter
  backend-api test` stays green.
- cross: @observability
- effort: S

### [P1] The double-mount guard does not guard the double-mount — two simultaneous starts both mint
- id: anam-backend-003
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:498
- category: bug
- confidence: high
- status: confirmed
- what: the comment at `anamService.ts:148-151` says the 6 s `tokenCache` exists *"just long enough
  to dedupe React StrictMode's double-mount (two near-simultaneous /start calls)"*. It does not. The
  cache is read at `:499` and only written at `:542`, **after** the mint resolves, and there is no
  in-flight promise map. Two requests that arrive within the same round-trip both miss the cache and
  both mint.
- why: the exact scenario the comment names — a *simultaneous* double-mount — is the one case the
  cache cannot catch; it only helps a second call that arrives after the first has fully completed.
  So every avatar open costs Anam two full session mints (and, on the ephemeral path, two of every
  preflight call as well), doubling vendor load and doubling the preflight latency contention on the
  account. Note this does **not** double slot usage (see the session-lifecycle section: slots are
  taken at `startSession` in the browser, not at mint) — the cost is vendor round-trips and mint
  quota, not concurrency.
- evidence: harness scenario H, two `getSessionToken` calls started at t=0 with an identical config:
  `4 HTTP calls` at 40 avatars (`GET /personas` ×2 at t+0, `POST /auth/session-token` ×2 at t+122)
  and `6 HTTP calls` at 250 avatars (`GET /llms` ×2, `GET /personas` ×2, mint ×2). Read `:495-543`:
  no in-flight map, `tokenCache.set` appears exactly once, at `:542`.
- fix: memoise the *promise*, not the result. Keep a `Map<string, Promise<SessionInfo>>` keyed by
  the same `cacheKey` computed at `:498`; on a miss store the in-flight promise before awaiting it,
  and delete it in a `finally`. Keep the existing 6 s result cache behind it. Note the cacheKey is
  computed from `personaConfig`, i.e. *after* the preflight hops — to dedupe those too, key an outer
  guard on `{projectId, characterId, key-suffix}` at the controller.
- verify: a vitest case that fires two `getSessionToken` calls with `Promise.all` and asserts
  `fetch` was called with `/auth/session-token` exactly **once**. Red today (it is called twice),
  green after.
- cross: @frontend
- effort: S

### [P3] /avatar/end is a dead stub that the client calls on every close
- id: anam-backend-004
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:238
- category: maintainability
- confidence: high
- status: confirmed
- what: `app.post('/api/v1/avatar/end', async (_request, reply) => reply.send({ ok: true }));` — the
  handler ignores its body, contacts nothing, writes nothing, and always returns 200. The client
  calls it on unmount, on `unload`, and on leave (`AvatarConversation.tsx:213,221`) and via
  `avatarApi.ts:224` with `keepalive: true`.
- why: **down-ranked from the P1 it was escalated as.** It is not a slot leak: the backend never
  creates an Anam session, so it has nothing to release — see the session-lifecycle section above
  for the SDK evidence (`CoreApiRestClient.d.ts` exposes only `startSession` and
  `unsafe_getSessionToken`; `sessionId` is minted browser-side at `AnamClient.js:143`). The real
  teardown is `client.stopStreaming()`, which the client already calls on all three paths. What is
  left is genuine but minor: a public route whose name promises a side effect it does not have, a
  wasted request per close, and a trap for exactly the reasoning that produced the escalation — a
  future fix (including the one proposed for anam-frontend-001) can "call `/avatar/end`" and appear
  to work while doing nothing.
- evidence: read `avatar.controller.ts:237-238` in full — the route comment already concedes
  "no-op". `anamService.ts:443` keeps only `{ sessionToken }`. No session table
  (`grep -n "pgTable" src/db/schema.ts | grep -i session` → no matches). No termination method in
  the vendored SDK. `grep -rniE "endSession|terminateSession|deleteSession|stopSession|closeSession|recoverStuck" src`
  → only the podcast/video/crop/simulation sweeps at `server.ts:644-650`, none avatar-related.
- fix: either delete the route and the client calls to it, or make it honest — rename the comment to
  state that transport teardown (`stopStreaming`) is the release mechanism and that this endpoint
  exists only as a client-side analytics/no-op hook. If session bookkeeping is ever wanted (e.g. to
  count concurrent sessions ourselves), the prerequisite is capturing a session id, which requires
  the *client* to report the `sessionId` from `StartSessionResponse` — the backend cannot obtain it.
- verify: if deleted, `grep -rn "avatar/end" podcast-saas` returns nothing; client tests still pass.
- cross: @frontend
- effort: S

### [P2] The base persona is fetched even when the avatar and voice are already known
- id: anam-backend-005
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:381
- category: perf
- confidence: high
- status: confirmed
- what: `if (entry.personaId && (!cfg?.avatarId || !cfg?.voiceId || !cfg?.llmId))` fires a full
  `GET /personas/{base}` round-trip whenever any of the three is missing. `llmId` is essentially
  never persisted — `AvatarConfigSchema` (`avatar.controller.ts:696`) marks it optional and the
  settings form does not require it — so `!cfg.llmId` is true almost always and the hop happens even
  when `avatarId` **and** `voiceId` are both pinned. The identical condition is duplicated at
  `anamService.ts:573` in `upsertVideoPersona`.
- why: one wasted sequential round-trip on every ephemeral start, and the only thing it can
  contribute in that case is `llmId` — which `resolveDefaultLlmId` (`:473`) has already resolved for
  free from the env pin or its 1 h cache. Measured: it doubles the ephemeral start from 1 hop to 2.
- evidence: harness scenario C, cfg = `{avatarId:'avatars-3', voiceId:'voices-3'}` with
  `ANAM_LLM_ID=llm-pinned`: `243ms ~2 sequential RTT, 2 calls` —
  `t+0ms GET /personas/base-einstein`, `t+122ms POST /auth/session-token`. The persona response's
  avatar/voice are then discarded at `:387-388` because `cfg` wins.
- fix: only fetch the base persona when it can actually contribute:
  `if (entry.personaId && (!cfg?.avatarId || !cfg?.voiceId || (!cfg?.llmId && !defaultLlmId)))`.
  Apply the same change at `:573`, where `defaultLlmId` is resolved lazily at `:584` and can be
  hoisted above the condition.
- verify: extend the harness/test — cfg with avatarId+voiceId and a pinned `ANAM_LLM_ID` must
  produce exactly one fetch (the mint) and no `/personas/` call.
- effort: S

### [P2] Display-only lookups run after the token is minted but before the reply is sent
- id: anam-backend-006
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:211
- category: perf
- confidence: high
- status: confirmed
- what: once `getSessionToken` has returned a usable token, the handler does up to two more Anam
  round-trips before `reply.send`: `getPersona(cfg.personaId)` at `:211` and `describeAvatar(...)`
  at `:213`, the latter running a full uncached `GET /avatars` paging loop
  (`anamService.ts:343` → `:721`). Both exist only to fill `avatarDisplay` — a name, a variant, and
  a portrait URL.
- why: the token the client is waiting for is already in hand and is being withheld for cosmetic
  metadata. Measured scenario E at 250 avatars: `729ms ~6 sequential RTT`, of which `t+365 → t+729`
  is three sequential `GET /avatars` pages that happen strictly after the mint at `t+243`. That is
  **half the request** spent on a portrait.
- evidence: harness scenario E, both account sizes; the call log shows `POST /auth/session-token` at
  `t+243ms` followed by `GET /avatars?page=1..3` at `t+365/486/608ms`, reply at `t+729ms`.
- fix: send the token immediately with whatever display fields are already persisted in
  `avatar_config` (which `PUT /avatar/config` fills via `enrichAvatarConfigFromAnam` at `:779`), and
  drop the post-mint lookups from the critical path. If the popup genuinely needs a live-resolved
  face for the defaults case, expose it as a separate `GET /api/v1/avatar/display?projectId=` the
  client fetches in parallel with its WebRTC join, or serve it from the TTL cache in
  anam-backend-007. `buildAvatarDisplay` (`anamService.ts:237`) already degrades gracefully when
  `avatarId` is absent.
- verify: harness scenario E should drop from ~6 sequential RTT to ~3; a route test asserting the
  response is sent without any `GET /avatars` after the mint.
- cross: @frontend
- effort: M

### [P2] listAnamResource is uncached and pages sequentially, and /start can run it twice
- id: anam-backend-007
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:730
- category: perf
- confidence: high
- status: confirmed
- what: the paging loop `for (let page = 1; page <= MAX_PAGES; page++)` awaits each page before
  requesting the next, and the function has **no cache at all** — every caller pays full price. It
  is bounded (`MAX_PAGES = 6`, so **not** unbounded — the loop does stop, and it breaks early on a
  short page or when `meta.lastPage` is reached), but on the `/start` path it can be entered up to
  four times: `avatars`+`voices` from `enrichAvatarConfigFromAnam` (`:210`), `llms` from
  `resolveDefaultLlmId` (`:270`), `avatars`+`voices` from `resolveDefaultAvatarVoice` (`:314`), and
  `avatars` again from `describeAvatar` (`:343`).
- why: account listings are near-static data being re-fetched per viewer per session. On a
  600-avatar account a single listing is 6 sequential round-trips. `resolveDefaultAvatarVoice` and
  `resolveDefaultLlmId` do cache (1 h, `anamService.ts:257,307`) but `enrichAvatarConfigFromAnam`
  and `describeAvatar` — the two on the `/start` path — do not, so the same `GET /avatars` can run
  twice in one request.
- evidence: harness scenario D at 250 avatars: 9 HTTP calls, with `avatars?page=1,2,3` and
  `voices?page=1,2,3` interleaved across `t+0/122/243` — three sequential rounds before any other
  work starts. Read `:721-745`: no cache read or write.
- fix: (a) put `listAnamResource` behind a TTL cache keyed by `(key.slice(-8), kind)`, reusing the
  exact `_defaultAvatarCache` pattern at `:307` (1 h, invalidated by the existing
  `invalidateAnamLlmCache` seam at `:297`, which should be renamed); (b) fetch page 1, then issue
  pages 2..`meta.lastPage` with `Promise.all` instead of serially. (a) alone removes almost all of
  it from the start path.
- verify: harness with `SIM_AVATARS=250` — scenario D should fall from 9 calls / ~6 RTT to 2 calls
  / ~2 RTT on a warm cache.
- cross: @performance
- effort: M

### [P2] Four independent DB round-trips are serialised in front of the Anam calls, one of them a duplicate read
- id: anam-backend-008
- location: podcast-saas/backend-api/src/services/avatar/anamKey.ts:15
- category: perf
- confidence: high
- status: confirmed
- what: the `/start` preamble awaits, strictly in order: `projects.findFirst`
  (`avatar.controller.ts:171`) → `resolveAnamKeyForProject` (`:177`), which itself awaits
  `admin_settings` (`anamKey.ts:13`) → `projects.findFirst` **again** (`anamKey.ts:15`) →
  `users.findFirst` (`anamKey.ts:17`) → `getProjectTranscript` (`avatar.controller.ts:190`). Nothing
  in that chain depends on the previous step's result except the BYOK lookups.
- why: 3–5 sequential DB round-trips before the first Anam byte, all avoidable. `anamKey.ts:15`
  re-reads the very `projects` row that `avatar.controller.ts:171` already loaded, one line earlier
  in the same request — it just does not select `created_by` into the right scope. The
  `admin_settings` read at `anamKey.ts:13` is a single global boolean fetched fresh on every avatar
  open by every viewer.
- evidence: read `avatar.controller.ts:166-199` and `anamKey.ts:11-20` end to end; every call is a
  bare `await` in statement order, with no `Promise.all` anywhere in the handler.
- fix: (a) `avatar.controller.ts:171` already selects `created_by` — give
  `resolveAnamKeyForProject` an overload taking the already-loaded `{ created_by }` so
  `anamKey.ts:15` is skipped entirely; (b) run the project read, the `admin_settings` read and the
  transcript read concurrently with `Promise.all`, applying the visibility gate on the project
  result before using the other two; (c) cache the `admin_settings` BYOK flag for 30 s in module
  scope — it is a global admin toggle, not per-request data.
- verify: a route test that counts queries via a drizzle spy, asserting the non-BYOK start path
  issues 2 queries rather than 3, and that they overlap.
- cross: @database, @performance
- effort: M

### [P2] The whole caption transcript is read from Postgres on every start, and discarded on the fast path
- id: anam-backend-009
- location: podcast-saas/backend-api/src/services/transcriptPropagation.ts:45
- category: perf
- confidence: high
- status: confirmed
- what: `getProjectTranscript` runs `db.query.video_files.findMany({ where: eq(project_id), columns:
  { captions_vtt, is_broll } })` — **no LIMIT**, and the `is_broll` filter is applied in JavaScript
  at `:50` rather than in SQL. Every VTT for every video of the project crosses the wire on every
  `/avatar/start`, gets parsed, and then 24 000 characters are kept
  (`avatar.controller.ts:153,195`). Worse: when `knowledgeToolId` *is* set, `personaId` survives and
  `buildPersonaConfig` returns `{personaId, maxSessionLengthSeconds}` at `anamService.ts:365-366`,
  **ignoring `cfg.knowledge` entirely** — so on the fast path the entire read is wasted.
- why: measured cost of the read+parse per request: 29 KB / 1.1 ms for one 10-minute video; 430 KB /
  5.2 ms for five 30-minute videos; 1 736 KB / 16.8 ms for ten 60-minute videos — of which 24 KB is
  ever used. The CPU is main-thread and blocking; the bytes are per-viewer-per-open.
- evidence: benchmarked `vttToPlainText` (`src/services/course/transcript.ts:7`) over synthetic VTTs
  at realistic cue density; numbers above. Read `transcriptPropagation.ts:44-56` for the query shape
  and `anamService.ts:365` for the discard.
- fix: (a) do not read it at all when the stateful path will be taken — hoist the
  `cfg.personaId && cfg.knowledgeToolId` check above the `getProjectTranscript` call at
  `avatar.controller.ts:190`; (b) push the filter and the pick into SQL:
  `where is_broll = false and captions_vtt is not null order by length(captions_vtt) desc limit 1`;
  (c) best of all, store the derived 24 KB plain text once on the project (or in `avatar_config`)
  when captions land — `transcriptPropagation.ts:59` already runs at exactly that moment — so
  `/start` reads one small column.
- verify: query-count/byte assertion in a route test; the harness's scenario-A body stays 118 bytes.
- cross: @database, @performance
- effort: M

### [P2] A stale or brainless saved persona costs two extra round-trips on every start, forever
- id: anam-backend-010
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:514
- category: perf
- confidence: high
- status: confirmed
- what: when the saved `personaId` is stale (400 `invalid_persona_configuration`) or brainless (a
  200 whose JWT `type` claim is `legacy`), `getSessionToken` rebuilds a full ephemeral persona at
  `:515` — which re-enters `buildPersonaConfig` and fires another `GET /personas/{base}` — and mints
  a second time at `:521`. The recovery is correct and well-tested. What is missing is that
  **nothing repairs the stored config**: `avatar_config.personaId` keeps its dead value, so the very
  next viewer pays the same doomed first mint plus the same rebuild, indefinitely. The warning at
  `:517` is logged and forgotten.
- why: measured F and G: `487ms ~4 sequential RTT, 4 calls` versus `256ms ~2 RTT` for a healthy
  stateful start — a permanent ~2× on every avatar open for that video, invisible except in logs. A
  persona deleted once in the Anam dashboard degrades the video for good.
- evidence: harness scenarios F (`stale400`) and G (`legacyThenOk`), 250-avatar config:
  `GET /llms → POST mint(121B) → GET /personas/base → POST mint(29695B)`. Read `:504-524`; the only
  side effect on the recovery path is `logger.warn` at `:517`.
- fix: give `getSessionToken` a caller-supplied callback (or return a `personaStale: true` flag) so
  `avatar.controller.ts` can clear `avatar_config.personaId` after a `staleRejected`/`legacyMinted`
  recovery and, better, schedule a re-bake via `upsertVideoPersona`. The next start then takes the
  1-hop path. Emit a counter so a chronically broken persona is visible rather than merely logged.
- verify: a test asserting that after a stale-400 recovery the controller issues the config update
  clearing `personaId`; the harness's F should drop to ~2 RTT on the second run.
- cross: @observability
- effort: M

### [P2] knowledgeToolId is used as a proxy for "the persona carries the RAG tool", and the two are set independently
- id: anam-backend-011
- location: podcast-saas/backend-api/src/services/transcriptPropagation.ts:203
- category: bug
- confidence: medium
- status: confirmed
- what: `avatar.controller.ts:197` decides whether the saved persona knows the video by testing
  `cfg.knowledgeToolId`. But `knowledgeToolId` records that a *tool* exists, while the knowledge
  actually reaches a session through the persona's `toolIds`, written only by `upsertVideoPersona`
  (`anamService.ts:613`). `propagateToAvatar` sets `knowledgeToolId` at `transcriptPropagation.ts:185`
  and only then re-bakes the persona at `:203`, behind
  `if (merged.personaId && merged.avatarId && merged.voiceId)`.
- why: the guard fails both ways. A video whose avatar/voice are inherited from the base persona
  (so `avatar_config` has `personaId` but no `avatarId`/`voiceId` — a shape `upsertVideoPersona`
  explicitly supports, inheriting at `anamService.ts:573-580`) gets `knowledgeToolId` written but
  its persona **never** gets `toolIds`. `/start` then keeps the stateful persona because
  `knowledgeToolId` is set, and the avatar silently does not know the video — the exact failure the
  transcript inlining was added to prevent. The mirror case is anam-backend-001: `knowledgeToolId`
  absent while the persona is perfectly fine, forcing the slow path.
- evidence: read `transcriptPropagation.ts:168-213` and `anamService.ts:560-614`; the re-bake guard
  at `:203` requires `avatarId && voiceId` which `upsertVideoPersona` does not itself require.
- fix: record the truth instead of inferring it. Have `upsertVideoPersona` write back the `toolIds`
  it baked (and a knowledge hash) into `avatar_config`, and key both `avatar.controller.ts:197` and
  the `transcriptPropagation.ts:203` re-bake on that, not on `knowledgeToolId`. Drop the
  `avatarId && voiceId` precondition at `:203` — `upsertVideoPersona` inherits them itself.
- verify: a test where `avatar_config` is `{personaId, knowledgeGroupId, knowledgeToolId}` with no
  `avatarId`, asserting the persona is re-baked with `toolIds` containing the knowledge tool.
- effort: M

### [P3] tokenCache is an unbounded module-level Map with no eviction
- id: anam-backend-012
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:153
- category: bug
- confidence: high
- status: confirmed
- what: `const tokenCache = new Map<string, CachedToken>()` is only ever written (`:542`); nothing
  deletes an expired entry. Staleness is handled by comparing `issuedAt` at read time (`:500`), so
  entries for configs never requested again live for the process's lifetime. `_llmIdCache` (`:257`)
  and `_defaultAvatarCache` (`:307`) have the same shape, bounded by the number of distinct API-key
  suffixes — which grows with BYOK users.
- why: a slow leak, not a latency cause: one entry per distinct `(key-suffix, personaConfig)` per
  process, each holding a JWT string. High-traffic multi-project accounts accumulate them. Also note
  all three caches are per-process, so with the replica'd Docker deployment each replica warms
  independently — worth knowing before treating the 1 h caches as effective.
- evidence: read the whole of `anamService.ts`; `tokenCache.delete` and `tokenCache.clear` appear
  nowhere (`invalidateAnamLlmCache` at `:297` clears only the llm and default-avatar caches).
- fix: sweep expired entries on write when `tokenCache.size` exceeds a cap (e.g. 500), or use a
  small LRU. Add `tokenCache.clear()` to `invalidateAnamLlmCache` for the test seam.
- effort: S

### [P3] POST /api/v1/avatar/start has no body schema
- id: anam-backend-013
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:167
- category: bug
- confidence: high
- status: confirmed
- what: `const body = (request.body ?? {}) as { character_id?: string; projectId?: string };` — a
  bare cast. The route registers only a `preHandler`, no `schema`, so nothing validates the body.
  `projectId` is not checked to be a UUID before reaching `eq(projects.id, body.projectId)` at
  `:171`; on a malformed value Postgres raises an invalid-uuid error which the `.catch(() => null)`
  swallows into a 404. `character_id` is unbounded in length, though it is safely narrowed by the
  `CHARACTERS[characterId]` lookup at `anamService.ts:462`.
- why: not exploitable — the failure mode is a misleading 404 rather than a leak, and the sibling
  routes in this file do use zod (`MemorySchema:313`, `AvatarConfigSchema:682`). It is an
  inconsistency on the single most-hit avatar route, and the swallowed cast is what lets a client
  bug present as "project not found".
- fix: add a `schema.body` (or a zod `safeParse` matching the file's own convention) with
  `projectId: z.string().uuid().optional()` and `character_id: z.string().max(64).optional()`, and
  return 400 for a malformed `projectId` instead of 404.
- verify: a route test posting `{projectId:'not-a-uuid'}` expects 400, not 404.
- cross: @types-contracts
- effort: S

### [P3] ANAM_ENV and PERSONA_MAP snapshot process.env at module load
- id: anam-backend-014
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:30
- category: maintainability
- confidence: high
- status: confirmed
- what: `ANAM_ENV` (`:12`) reads `process.env` once at import, and `PERSONA_MAP` (`:30`) is then
  built from `ANAM_ENV` — also once. Mutating `ANAM_ENV` later (as the tests do) does **not** update
  `PERSONA_MAP`.
- why: minor, but it is a real trap: an operator who fixes `ANAM_PERSONA_ID_*` needs a restart, and
  a test that sets `ANAM_ENV.ANAM_PERSONA_ID_EINSTEIN` in `beforeEach` silently exercises a
  different branch than production. I hit exactly this while building the harness — the base-persona
  hop vanished until I moved the value to the process env — which means the existing suite's
  coverage of `buildPersonaConfig`'s base-persona branch is thinner than it appears.
- evidence: `:12-35`; harness run 1 (`ANAM_ENV` mutated in code) shows no `GET /personas/` call,
  run 2 (same value as a process env var) shows it at `t+0ms`.
- fix: make `PERSONA_MAP` a function of `ANAM_ENV` evaluated per call, or derive `personaId` inside
  `buildPersonaConfig`/`upsertVideoPersona` from `ANAM_ENV` directly.
- cross: @test-quality
- effort: S

---

## Ranked by latency contribution (largest first)

1. **anam-backend-001** — stateful → ephemeral downgrade. Measured 1 → 3 RTT (small account) or
   2 → 6 RTT (large account), plus a 118 B → 29 705 B persona body and vendor-side persona
   construction per session. This is the answer to the user's report.
2. **anam-backend-006** — post-mint display lookups. Up to 4 RTT after the token already exists;
   measured as half of a 729 ms request.
3. **anam-backend-007** — uncached, sequentially-paged account listings, run up to twice per start.
   Up to 3 RTT per listing at 250 items, 6 at 600.
4. **anam-backend-002** — no timeouts. Contributes 0 ms when Anam is healthy and unbounded seconds
   when it is not; it is what makes the slowness *feel* pathological rather than merely slow.
5. **anam-backend-010** — stale/legacy persona, never repaired: a permanent +2 RTT for the affected
   video.
6. **anam-backend-005** — needless base-persona fetch: +1 RTT on every ephemeral start.
7. **anam-backend-008** — serialised DB preamble: +2–3 DB RTT (small individually, first in line).
8. **anam-backend-003** — double mint: no added depth for one request, but 2× vendor round-trips
   and 2× mint quota per open.
9. **anam-backend-009** — transcript read: 1–17 ms CPU and 30 KB–1.7 MB per request, wasted
   entirely on the fast path.
10. **anam-backend-004** — the `/avatar/end` stub: 0 ms. Kept as a P3 for honesty about what it is.

## Suggested fix order

`001` (collapses the common case to one round-trip) → `002` (bounds the tail) → `005` + `006` +
`007` (remove the remaining avoidable hops) → `008` + `009` (the DB preamble) → `010` / `011`
(self-healing) → `003` → the P3s.
