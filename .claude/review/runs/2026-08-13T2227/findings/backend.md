# Backend findings — `backend-reviewer`

Run `2026-08-13T2227` · commit `ae4b65b` · scope: full codebase audit of
`podcast-saas/backend-api/src/**` (routes, controllers, lib, and the non-specialist services).

**Baseline established before judging anything**

- `pnpm -C podcast-saas --filter backend-api typecheck` → **exit 0, clean**. Nothing here is a
  typecheck artefact.
- Stack confirmed against `.claude/reference/stack.md`: **Fastify 4.28** (`backend-api/package.json:41`)
  over Postgres. Every judgement below uses Fastify semantics (`return`/`throw`, `reply.sent`,
  `setErrorHandler`), never Express.
- **Route table is sound.** I extracted all 245 `app.<method>(path)` registrations across
  `src/**` and checked two failure modes the orchestrator asked about:
  - duplicate `method+path` pairs → **none**;
  - conflicting param names at the same path position (a find-my-way boot crash) → **none**.
  Every `register*Routes` imported in `server.ts` is also called (`server.ts:500-584`). No finding
  here — recording the negative so it is not re-litigated.

Ordering: P1 first, then P2, then P3.

---

### [P1] Every `request.file()` upload buffers the whole file into the heap before any size check — the effective cap is the global 10 GB

- id: backend-001
- location: podcast-saas/backend-api/src/controllers/v1/images.controller.ts:35
- category: bug
- confidence: high
- status: confirmed
- what: `@fastify/multipart` is registered once, globally, with `limits: { fileSize: 10 GB }`
  (`server.ts:198-200`). Nine handlers then call `await request.file()` / `await data.toBuffer()`
  **without passing a per-call `limits`**, so each one will materialise up to 10 GB in the Node
  heap. Four of them apply no size check at all, and the fifth checks only *after* the buffer
  exists:
  - `images.controller.ts:35` and `:84` — no cap anywhere in the handler
  - `audio.controller.ts:67` — no cap; the buffer is then written to a temp file as well
    (`probeUploadedAudioDuration`, `audio.controller.ts:32-44`), so peak cost is heap **+** disk
  - `corpus.controller.ts:69` — no cap
  - `podcast.controller.ts:397` — no cap
  - `avatar.controller.ts:845` and `:935` — no cap
  - `projects.controller.ts:362-365` — buffers first, *then* rejects >10 MB with a 413. The
    thumbnail route advertises a 10 MB limit it does not enforce until the 10 MB is already spent.
- why: This is not theoretical. A creator dragging a lecture recording into the audio picker, or a
  video file into the thumbnail picker, is a routine mis-click, and the process pays full heap for
  it before the "Thumbnail must be 10MB or smaller" message is even computed. On the single-process
  managed host (`server.ts:663`, `WORKER_INLINE=1`) an OOM takes the API *and* the in-process job
  worker down, killing every concurrent request and every in-flight transcode. Node's
  `Buffer.concat` also hard-fails past `buffer.constants.MAX_LENGTH`, so large-but-legal inputs
  turn into an opaque 500 rather than a 413.
- evidence: Read `server.ts:193-200` (single global multipart registration, 10 GB). Grepped every
  `request.file(` / `.toBuffer()` call site in `src/**` (9 hits, listed above) and every
  `bodyLimit`/`limits:` declaration (7 hits) — the two sets do **not** intersect for any
  `request.file()` route. The repo already knows the right shape: `simulations.controller.ts:138-144`,
  `avatar.controller.ts:577-583` and `video.controller.ts:133,143` all pass explicit per-route
  `limits` and stream chunk-by-chunk with a running `totalBytes` guard that 413s mid-stream. The
  `request.file()` routes are the ones that were never converted. `typecheck` is clean, so this is
  not a type artefact.
- fix: Pass an explicit per-route cap at the call site and reject on the limit rather than after
  it — `await request.file({ limits: { fileSize: MAX } })` — with `MAX` set per route
  (10 MB thumbnails/images, ~200 MB audio, ~50 MB corpus/podcast documents, ~25 MB avatar
  knowledge docs). Catch `@fastify/multipart`'s `RequestFileTooLargeError` (thrown by `toBuffer()`
  once `throwFileSizeLimit` trips) and answer 413 with the route's own limit in the message. Delete
  the now-dead post-hoc check at `projects.controller.ts:363`.
- verify: New vitest cases posting a file one byte over each route's cap assert 413 and assert the
  handler never allocated the full body (spy on `toBuffer`); red before, green after.
  `pnpm -C podcast-saas --filter backend-api typecheck` stays clean.
- cross: @test-quality @performance
- effort: M

---

### [P1] The background `.catch(async …)` on simulation upload/replace can itself reject, and an unhandled rejection kills the process

- id: backend-002
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:230
- category: bug
- confidence: high
- status: confirmed
- what: Both simulation processing paths detach a promise chain and return 202 immediately:

  ```ts
  processPromise
    .then(async ({ entryKey, bridgeFunctions }) => { await db.update(simulations)…; })
    .catch(async (err: unknown) => {
      const msg = …;
      await db.update(simulations).set({ status: 'failed', error: msg })…;   // ← may reject
      logger.error({ simId, err }, 'Simulation processing failed');
    });
  ```

  The `.catch` is correctly chained *after* the `.then`, so a failure inside the `then` handler is
  caught — that part is fine. What is not fine is that the **catch handler's own `await` is
  unguarded**, and the promise it returns is consumed by nobody. If that recovery `db.update`
  rejects (DB restart, pool exhaustion, connection reset — precisely the conditions that made
  `processUpload` fail in the first place), the chain's tail promise rejects with no handler.
  Same shape at `:438-445` for the replace path.
- why: Node 22 (`>=22` per `stack.md`) defaults to `--unhandled-rejections=throw`, so this is not a
  warning — it terminates the process. The failure mode is self-amplifying: the trigger is a
  database fault, and a database fault is exactly when the recovery write is most likely to reject.
  The blast radius is the whole single-process host: every in-flight HTTP request and every inline
  job dies with it, and the sim row is left at `processing` forever (`recoverStuckSimulations`,
  `server.ts:117-126`, only runs at boot, so it does clean up — after the crash).
- evidence: Read `simulations.controller.ts:217-241` and `:427-446` in full. Grepped `.catch(async`
  across `src/**`: exactly these two non-script call sites. The repo has already diagnosed this bug
  class and fixed it *elsewhere* — `podcast.controller.ts:44-63` wraps its identical
  "mark the row failed" write in a nested `try/catch` and its docstring says why, verbatim:
  *"so it can never surface an unhandled promise rejection (which is fatal on newer Node)"*. The
  two simulation call sites never got that treatment.
- fix: Wrap each `.catch` body in its own `try/catch` that only logs, or — better — reuse the
  existing `extractSourceInBackground` shape from `podcast.controller.ts:49-63` as a shared
  `runInBackground(label, fn)` helper and route both simulation paths through it.
- verify: A vitest case that makes `svc.processUpload` reject **and** the subsequent
  `db.update` reject, asserting `process.on('unhandledRejection')` never fires. Red before, green
  after.
- cross: @test-quality @simulation
- effort: S

---

### [P2] A non-numeric `:v` path segment reaches Postgres as `NaN` and 500s the request

- id: backend-003
- location: podcast-saas/backend-api/src/controllers/v1/podcast-script.controller.ts:180
- category: bug
- confidence: high
- status: confirmed
- what: Four handlers coerce the `:v` path parameter with a bare `Number()` and hand the result
  straight to a query: `:180` (PATCH one turn), `:215` (PUT turns), `:237` (regenerate turn),
  `:276` (approve). `Number('abc')` is `NaN`, which flows into
  `eq(podcast_scripts.version, NaN)` in `loadScript` (`:25-37`). The query-string sibling at `:162`
  has the same hole (`?version=abc`), plus `?version=0` is falsy and silently means "latest".
- why: `podcast_scripts.version` is `integer('version').notNull()` (`db/schema.ts:1164`), so
  Postgres receives the literal text `NaN` for an `int4` parameter and raises `22P02
  invalid input syntax for type integer`. Nothing catches it — `setErrorHandler`
  (`server.ts:587-601`) has no 22P02 branch — so a malformed URL becomes a **500** instead of the
  404 the route already knows how to send two lines later. Wrong status code, spurious 5xx in
  whatever watches the error rate, and a client that retries a request that can never succeed.
- evidence: Read all four call sites and `loadScript` (`:25-37`). Confirmed the column type at
  `db/schema.ts:1161-1179`. The decisive evidence is the sibling controller: at
  `podcast-render.controller.ts:162-166` the *same* `:v` parameter is read and the author guarded
  it explicitly —
  `where: Number.isFinite(version) ? and(…, eq(podcast_scripts.version, version)) : eq(…episode_id…)`
  — which is this exact bug, found and fixed in one file and not the other.
- fix: Parse once, at the top of each handler:
  `const v = Number(request.params.v); if (!Number.isInteger(v) || v < 1) return reply.code(400).send({ message: 'Invalid script version' });`
  For `:162`, use `Number.isFinite` rather than truthiness so `?version=0` is rejected instead of
  silently meaning "latest".
- verify: `PATCH /api/v1/podcasts/{s}/episodes/{e}/script/abc/turns/{t}` returns 400, not 500.
- cross: @test-quality
- effort: S

---

### [P2] An invalid-UUID path parameter 500s instead of 404, on essentially every id-taking route

- id: backend-004
- location: podcast-saas/backend-api/src/services/collabAccess.ts:82
- category: bug
- confidence: high
- status: confirmed
- what: No route in the app declares a Fastify `schema.params`, and no handler validates that an id
  segment is a UUID before putting it in a `where`. `editableProject(projectId, user)` builds
  `eq(projects.id, projectId)` with whatever arrived in the URL, and 40+ routes call it as their
  first statement (`projects.controller.ts:143`, `video.controller.ts:417`,
  `sections.controller.ts:695`, `images/audio/broll/markers/...`). Same pattern for the non-project
  ids: `collaborators.controller.ts:132` (`eq(collaborators.id, request.params.collabId)`),
  `video.controller.ts:422` (`:videoId`), `simulations.controller.ts:705` (`:simId`),
  `podcast-render.controller.ts:148` (`:renderId`).
- why: `projects.id` is `uuid(...)` and postgres-js sends the parameter untyped, so Postgres infers
  `uuid` from context and raises `22P02 invalid input syntax for type uuid` on anything that is not
  one. `setErrorHandler` (`server.ts:587-601`) has no 22P02 branch, so `statusCode` defaults to 500
  and the client gets `{"error_type":"server_error","message":"Internal server error"}` for what is
  simply a bad URL. `GET /api/v1/projects/undefined` — the classic frontend template bug — is a
  500. So is any stale bookmark or crawler hit. The result is a permanently noisy 5xx rate that
  makes real 5xx alerting useless, and 404-vs-500 confusion on the client's retry path. Nothing is
  *leaked* (the handler genericises 5xx bodies), which is why this is P2 and not higher.
- evidence: Grepped `z.string().uuid()` across `src/controllers/**` — 7 hits, **all** on request
  *body* fields (`billing`, `broll`, `audio`, `playlists`, `avatar`), **zero** on path params.
  Grepped for `22P02`, `isUuid`, `UUID_RE` in `src/**`: no error-handler mapping exists, and the
  only production `UUID_RE` guards are `services/storage/mediaAccess.ts:21,28,37,44` and
  `services/simulation/revisionIdentity.ts:33,49,51` — i.e. the two places that *do* take
  attacker-shaped path input already pre-filter with a UUID regex before querying, for exactly this
  reason. Read `server.ts:587-601` to confirm no 22P02 branch. Read `collabAccess.ts:43-83` to
  confirm the id goes into `eq()` unvalidated.
- fix: Two layers, cheapest first. (1) In `setErrorHandler`, map Postgres `22P02` to 400:
  `const pgCode = (err as {code?: string}).code; const statusCode = pgCode === '22P02' ? 400 : ((err as {statusCode?: number}).statusCode ?? 500);`
  — one edit, covers all 245 routes. (2) For the hot id routes, add
  `schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } }`
  so Fastify rejects with 400 before the handler runs and before the DB round trip.
- verify: `GET /api/v1/projects/not-a-uuid` with a valid token returns 400 (or 404), not 500;
  `pnpm -C podcast-saas --filter backend-api test` stays green.
- cross: @test-quality @observability
- effort: M

---

### [P2] Guidance SSE routes strand `guidance_status` at `analyzing`/`publishing` forever — the one in-flight status in the app with no reaper

- id: backend-005
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:739
- category: bug
- confidence: high
- status: confirmed
- what: Both guidance SSE handlers write a non-terminal status *before* the work
  (`:739` → `analyzing`, `:846` → `publishing`) and then guard **both** terminal writes behind
  `if (!controller.signal.aborted)` (`:747` success / `:760` failure; `:856` / `:881`). The signal
  is aborted by `request.raw.on('close', …)` (`:737`, `:844`). So when the viewer closes the tab,
  navigates away, or loses the connection mid-generation, neither branch runs and the row keeps the
  in-flight status permanently. A process restart mid-generation does the same.
- why: `guidance_status` is user-visible state — the editor renders a spinner off it — so the
  simulation reads as "analysing…" forever. Every other in-flight status in this codebase has an
  explicit recovery path, which is what makes this one an omission rather than a design choice:
  `recoverStuckTranscodes`, `recoverStuckCrops`, `recoverStuckSimulations` (`server.ts:97-141`),
  `recoverStuckPodcastScripts/Renders/Mixes`, `recoverStuckVideoGenerations` (`server.ts:644-650`),
  plus `startDuplicationSweep` and `startExportSweep` (`server.ts:518-522`). `guidance_status` is in
  none of them.
- evidence: Read both handlers end to end (`:711-772`, `:814-893`). Grepped every `guidance_status`
  writer in `src/**`: the only writers are these two routes; nothing resets it on boot or on a
  timer. Grepped `export async function recoverStuck` — four functions, none touching
  `simulations.guidance_status`. Confirmed the column and its state set at `db/schema.ts:487`
  (`none|analyzing|draft|publishing|ready|error`).
- fix: In each handler's `finally`, when `controller.signal.aborted` is set, write the honest
  terminal state — `guidance_status: 'error'`, `guidance_error: 'Interrupted — the connection
  closed before generation finished'` — fenced on the in-flight status so a newer run is not
  clobbered. Add `guidance_status` to the boot recovery in `server.ts` alongside
  `recoverStuckSimulations`, using the same "any in-flight row at boot is orphaned" rule.
- verify: A test that aborts the request mid-`analyzeAndDraft` asserts the row lands on `error`,
  not `analyzing`.
- cross: @simulation @test-quality
- effort: S

---

### [P2] Six hand-built 5xx bodies echo raw upstream/internal error text, defeating the genericisation `setErrorHandler` exists to enforce

- id: backend-006
- location: podcast-saas/backend-api/src/controllers/v1/corpus.controller.ts:82
- category: bug
- confidence: high
- status: confirmed
- what: `setErrorHandler` (`server.ts:587-601`) deliberately replaces every ≥500 body with
  `'Internal server error'`, and the comment says why: *"return a generic message so internal detail
  (Postgres/R2/fs paths, connection strings) is logged but never sent to clients."* Six handlers
  construct their own 5xx reply and therefore never reach it:
  - `corpus.controller.ts:82` — `` `Failed to upload file: ${(err as Error).message}` `` (S3/R2 SDK error)
  - `podcast.controller.ts:405` — identical shape, same source
  - `projects.controller.ts:340` — `(err as Error).message?.slice(0, 200)` from the OpenAI image SDK
  - `audio.controller.ts:161` / `:166` / `:173` — ElevenLabs transport error and up to 300 chars of
    its raw response body
  - `avatar.controller.ts:856` — `reply.code(502).send({ message: (e as Error).message })`, bare
- why: These are the exact strings the global handler was written to suppress. An AWS/R2 SDK error
  carries the endpoint host, bucket, and region; a provider 4xx body carries account and key hints.
  Beyond the disclosure, it is an inconsistent error envelope across the 27 v1 controllers: the same
  class of failure is `{error_type, message}` with a generic message on one route and a raw vendor
  string on another, so no client can handle 5xx uniformly.
- evidence: Read `server.ts:587-601` (the genericisation and its rationale). Grepped
  `code(5xx).send(` across `src/controllers/**` and filtered for interpolated error text — the six
  sites above, listed with line numbers. Contrast `export.controller.ts:172-173`, which does it
  correctly: `logger.error({ err, … })` server-side, then a fixed user-facing string.
- fix: At each site, log the error with `logger.error({ err, … }, '…')` and send a fixed message
  (`'Could not upload the file. Please try again.'`, `'Audio generation is unavailable right now.'`).
  Keep the vendor detail in the log, never in the body — the shape `export.controller.ts` and
  `video.controller.ts:306-307` already use.
- verify: Grep for interpolated `err`/`.message` inside any `code(5xx).send(` returns zero hits.
- cross: @security @observability
- effort: S

---

### [P2] `/video-proxy/*` drops the media token on its local-disk fallback, so the fallback 403s for exactly the requests that need it

- id: backend-007
- location: podcast-saas/backend-api/src/server.ts:490
- category: bug
- confidence: high
- status: confirmed
- what: `/video-proxy/*` authorises via `authorizeMediaRequest`, which returns both `key` **and**
  `token` (`server.ts:457-459`). The local-dev branch preserves the token when it redirects
  (`:466`: `` reply.redirect(token ? `/video-raw/t/${token}/${key}` : …) ``). The two R2-failure
  branches do not:

  ```ts
  if (code === 404 || code === 403) return reply.redirect(`/video-raw/${key}`);   // :490
  …
  return reply.redirect(`/video-raw/${key}`);                                     // :492
  ```

- why: `/video-raw/*` re-authorises through the same `authorizeMediaRequest` (`:372`), and
  `canServeMediaKey` grants an anonymous request only via a valid scoped token or a public/unlisted
  project. Players never send an `Authorization` header — the comment at `:238` says so explicitly.
  So for a **private** project the tokenless redirect lands on a 403 and playback dies, in precisely
  the case the fallback was written for: the object is missing from R2 and the durable local copy is
  the only one there is. The sibling `/hls-proxy` handler gets this right in both of its fallback
  branches (`:343`, `:361`), which is what makes this a slip rather than a policy.
- evidence: Read `server.ts:454-495` (video-proxy, all three redirect sites), `:227-248`
  (`authorizeMediaRequest`), `:319-364` (hls-proxy, token preserved twice), and
  `services/storage/mediaAccess.ts:60-88` (`canServeMediaKey` allow-order: token, then
  public/unlisted, then authenticated owner/collaborator).
- fix: Use the same token-preserving expression as `:466` at both `:490` and `:492`:
  `` reply.redirect(token ? `/video-raw/t/${token}/${key}` : `/video-raw/${key}`) ``.
- verify: With a private project and a tokenised media URL, force the R2 read to 404 and assert the
  redirect target still carries `t/{token}/` and serves 200/206 rather than 403.
- cross: @media-pipeline
- effort: S

---

### [P2] `hls-status` is the one presign call site without `.catch(() => null)`, so a presign failure 500s a polled endpoint

- id: backend-008
- location: podcast-saas/backend-api/src/controllers/v1/video.controller.ts:438
- category: bug
- confidence: high
- status: confirmed
- what: `GET /api/v1/projects/:id/videos/:videoId/hls-status` calls
  `await storage.getPresignedDownloadUrl(videoFile.storage_key, 3600)` with no `.catch`. Every
  other presign in the same file degrades to `null`: `:105`, `:126`, `:185`, `:478`, and so do
  `export.controller.ts:204`, `editor-state.controller.ts:73`, `podcast-render.controller.ts:29-31`.
- why: This is the endpoint the editor **polls** while a transcode runs. A transient credential or
  clock error in the storage adapter turns a status poll into a 500, so the client loses the
  `hls_status`, `hls_error` and `duration_sec` it was polling for — the fields that would have
  explained what is happening — over a URL that is optional to the response. The value is already
  modelled as nullable everywhere else in the file.
- evidence: Read `video.controller.ts:411-453` and compared against the four sibling presign sites
  in the same file plus the four in other controllers. `raw_url` is documented as a convenience at
  `:437` ("lets the browser play it directly without auth headers"), not a required field.
- fix: `const raw_url = videoFile.storage_key ? await storage.getPresignedDownloadUrl(videoFile.storage_key, 3600).catch(() => null) : null;`
- verify: A test that makes the adapter's presign reject asserts 200 with `raw_url: null` and a
  populated `hls_status`, not 500.
- effort: S

---

### [P2] `/api/v1/hosts` asserts `default_org_id` non-null where the projects route returns a 400 for the same condition

- id: backend-009
- location: podcast-saas/backend-api/src/controllers/v1/projects.controller.ts:637
- category: bug
- confidence: medium
- status: confirmed
- what: `POST /api/v1/projects` guards the invariant properly — `if (!orgId) return reply.code(400).send({ message: 'User has no default org' })` (`:69-70`). The two host routes in the same file
  do not: `GET /api/v1/hosts` uses `eq(hosts.org_id, orgId!)` (`:613`) and `POST /api/v1/hosts`
  uses `org_id: user.default_org_id!` (`:637`).
- why: `users.default_org_id` is nullable, and `firebase-auth.ts:47-54` reconstructs `request.dbUser`
  by spreading `{...existing, ...updates}` — it never asserts the field is set. For a user whose
  org link is missing (a partially-failed first-login upsert at `firebase-auth.ts:56-74`, where the
  `orgs` insert, the `users` insert, and the owner back-link are three separate un-transacted
  statements), the POST sends `null` into a `NOT NULL` column and the request 500s instead of
  returning the 400 the sibling route already defines for the identical state. The GET degrades
  silently to an empty list.
- evidence: Read `projects.controller.ts:62-114` (correct guard) and `:605-641` (both non-null
  assertions). Read `middleware/firebase-auth.ts:41-88` to confirm `dbUser.default_org_id` is never
  validated and that first-login user/org creation is not wrapped in a transaction. `typecheck` is
  clean only because of the `!` operators — removing them would surface this.
- fix: Hoist the existing guard into a small helper and use it in all three routes:
  `const orgId = user.default_org_id; if (!orgId) return reply.code(400).send({ message: 'User has no default org' });`
- verify: Existing tests stay green; add one with `default_org_id: null` asserting 400 on `POST /api/v1/hosts`.
- cross: @database
- effort: S

---

### [P3] `uploadStreamWithFallback` has no fallback any more, but three comments and two runtime branches still assume it does

- id: backend-010
- location: podcast-saas/backend-api/src/services/storage/uploadStreamWithFallback.ts:8
- category: maintainability
- confidence: high
- status: confirmed
- what: The function is now a one-line pass-through to `getStorageAdapter().uploadStream(...)`, and
  its own docstring says so: *"**Cloud-only** … there is no longer a local-disk fallback"*
  (`:4-12`). Three places still describe and depend on the removed behaviour:
  `video.controller.ts:155-159` ("Stream the upload to durable local disk first, then best-effort
  re-upload to R2"); `server.ts:486-490` ("R2 may not have the object when a read-only token forced
  the upload to fall back to durable local disk (uploadStreamWithFallback)"); and the analogous
  comment at `server.ts:338-343`.
- why: The two `server.ts` fallback redirects are now unreachable-by-design for stream uploads —
  there is no local copy to fall back *to* — so a reader debugging a missing object is sent down a
  path that cannot exist. The name itself is the main trap; it is the reason the stale comments read
  as current.
- evidence: Read the whole file (21 lines) and all three comment sites.
- fix: Rename to `uploadStreamToCloud` (or inline it — it adds no behaviour), and correct the three
  comments to say the local fallback covers only the buffered `uploadWithFallback` path.
- effort: S

---

### [P3] `lib/sse.ts` is dead code, and its `close()` leaks the timer its `keepAlive()` hands out

- id: backend-011
- location: podcast-saas/backend-api/src/lib/sse.ts:29
- category: maintainability
- confidence: high
- status: confirmed
- what: No route calls `initSSE`. The only reference to the module anywhere is a `import type
  { SSEEmitter }` in `services/ingestion/CorpusBuilder.ts:14` for an optional parameter that is
  never supplied. Meanwhile the three real SSE endpoints (`sections.controller.ts:616-683`,
  `simulations.controller.ts:711-772`, `:814-893`) hand-roll headers, `sendEvent`, and keep-alive.
  Separately, `SSEEmitter.keepAlive()` (`:15-21`) returns a `NodeJS.Timeout` that `close()`
  (`:23-26`) does not clear — a caller that follows the class's own API leaks an interval writing
  to an ended socket every 15 s.
- why: A helper that looks canonical but is unused invites the next SSE route to adopt it and
  inherit the timer leak, while the three hand-rolled copies keep drifting apart (only
  `sections.controller.ts:649-654` has the stall-aware progress heartbeat).
- evidence: Grepped `initSSE|keepAlive|SSEEmitter` across `src/**`: 4 hits inside `lib/sse.ts`
  itself, 1 type-only import in `CorpusBuilder.ts`, and 6 hits that are the controllers' own
  `const keepAlive = setInterval(...)` locals — every one of which *is* cleared, in both the
  `'close'` handler and the `finally`.
- fix: Either delete `lib/sse.ts` and the dead `CorpusBuilder` parameter, or make it the single
  implementation — store the timer on the instance and `clearInterval` it in `close()` — and
  convert the three controllers to it.
- cross: @observability
- effort: S

---

### [P3] `isAllowedAudio` short-circuits on `audio/`, making the MIME allowlist above it dead

- id: backend-012
- location: podcast-saas/backend-api/src/controllers/v1/audio.controller.ts:29
- category: bug
- confidence: high
- status: confirmed
- what: `return ALLOWED_MIME.has(base) || base.startsWith('audio/');` — the second clause accepts
  every `audio/*` value, so the 11-entry `ALLOWED_MIME` set at `:19-25` can never reject anything it
  was written to reject. The client controls `Content-Type` entirely, so `audio/anything` passes.
- why: Not a serious hole on its own (the bytes are only handed to ffmpeg for a duration probe and
  stored under a server-chosen key), but the allowlist reads as enforced and is not — and it feeds
  `uploadWithFallback(key, buf, data.mimetype…)` at `:70`, so a client-chosen type is what gets
  stored on the object.
- evidence: Read `:19-30` and the call site at `:61-70`. The sibling image routes
  (`images.controller.ts:29`, `projects.controller.ts:358`) have no such escape hatch — they check
  set membership only.
- fix: Drop the `startsWith` clause and extend `ALLOWED_MIME` if a real format is missing.
- cross: @security
- effort: S

---

### [P3] `stubs.ts` still registers an unauthenticated `GET /api/admin/v1/billing` 501 after the real admin billing routes shipped

- id: backend-013
- location: podcast-saas/backend-api/src/controllers/stubs.ts:33
- category: maintainability
- confidence: high
- status: confirmed
- what: `app.get('/api/admin/v1/billing', stub)` is registered with **no `preHandler`**, while the
  real routes — `/api/admin/v1/billing/overview` and `/api/admin/v1/billing/transactions` — ship in
  `controllers/admin/v1/billing.controller.ts:10,37` behind `firebaseAdminRequired`. The comment
  block immediately above (`stubs.ts:28-30`) already documents the equivalent cleanup for the export
  URL space when the linear export replaced its stub; the billing stub was missed.
- why: No collision (the paths differ, which is why the app still boots), and the stub reveals only
  a fixed 501 body. It is a stale route that makes the admin surface look larger than it is and
  advertises an unauthenticated `/api/admin/` path to anyone probing.
- evidence: Read `stubs.ts` in full (35 lines) and `admin/v1/billing.controller.ts` in full.
  Enumerated all admin route paths across the 7 admin controllers — nothing declares the bare
  `/api/admin/v1/billing`. My duplicate-route scan across all 245 registrations confirms no
  method+path collision.
- fix: Delete lines 33 (and `:34`, `/api/admin/v1/renders`, if that namespace is likewise settled),
  following the comment pattern already used at `:28-30`.
- effort: S

---

### [P3] The inline queue registers a job for shutdown-draining one tick too late

- id: backend-014
- location: podcast-saas/backend-api/src/queue/inlineDriver.ts:22
- category: bug
- confidence: medium
- status: confirmed
- what: `enqueue` schedules `setImmediate(() => { const p = …; inFlight.add(p); })`. The promise
  only joins `inFlight` inside the callback, i.e. on the **next** event-loop turn. `drainInlineJobs`
  (`:40-47`) returns immediately when `inFlight.size === 0`.
- why: A `SIGTERM` arriving between `enqueueJob(...)` returning and that `setImmediate` firing —
  a real window during a redeploy, since `enqueueJob` is called synchronously right before the
  response is sent (`video.controller.ts:180`, `export.controller.ts:153`) — makes the shutdown path
  (`server.ts:674-686`) believe there is nothing in flight and `process.exit(0)` while the job is
  about to start. That is the exact failure `drainInlineJobs` was added to prevent (the comment at
  `:14-16` cites `backend-004`). Minor: `drainInlineJobs` also never clears its 25 s race timer
  (`:45`), which is harmless only because `process.exit(0)` follows.
- evidence: Read `queue/inlineDriver.ts` in full (47 lines), `queue/index.ts` in full (confirming
  `enqueueJob` is synchronous and returns `void`, so no caller can await the registration), and the
  shutdown sequence at `server.ts:674-688`.
- fix: Register a placeholder synchronously. Create a deferred promise in `enqueue`, add it to
  `inFlight` before returning, and resolve it from inside the `setImmediate` chain's `finally`.
- cross: @job-queue
- effort: S

---

### [P3] The video-replace path deletes the old object before it has confirmed the row it just updated exists

- id: backend-015
- location: podcast-saas/backend-api/src/controllers/v1/video.controller.ts:103
- category: bug
- confidence: medium
- status: confirmed
- what: In `finalizeUpload`'s replace branch:

  ```ts
  const [updated] = await db.update(video_files).set({…}).where(eq(video_files.id, replaceVideoId)).returning();
  if (oldStorageKey && oldStorageKey !== storage_key) deleteWithFallback(oldStorageKey).catch(() => {});  // :103
  enqueueVideoProcessing(updated.id);                                                                     // :104
  ```

  The existence check is a separate `findFirst` twelve lines earlier (`:82-86`). If the row is
  deleted in between (a concurrent `DELETE /videos/:videoId`), the update matches zero rows,
  `updated` is `undefined`, **`:103` still deletes the old object**, and `:104` throws a TypeError →
  500. Order matters: the destructive step runs first.
- why: Narrow race, but the failure is asymmetric — the old media is gone, the new row was never
  written, and the client gets an opaque 500 with no way to tell that its previous video no longer
  exists. Also `.catch(() => {})` here is the only fire-and-forget in the file that discards the
  error without logging (compare `video.controller.ts:574-576` and `podcast.controller.ts:176-178`,
  which both log).
- evidence: Read `finalizeUpload` in full (`:67-128`) and the delete route (`:487-517`) that races
  it. `.returning()` on a zero-match update yields `[]` in drizzle, so the destructure is
  `undefined` and `typecheck` does not catch it (the row type is non-optional by declaration).
- fix: Guard before the destructive call — `if (!updated) return null;` immediately after the
  update (the caller at `:263`/`:383` already maps `null` to a 404 "Video to replace not found"),
  and give the delete a `.catch((err) => logger.warn({ err, oldStorageKey }, 'old video object GC failed'))`.
- effort: S

---

## Summary

| Severity | Count | Ids |
|---|---|---|
| P0 | 0 | — |
| P1 | 2 | backend-001, backend-002 |
| P2 | 7 | backend-003 … backend-009 |
| P3 | 6 | backend-010 … backend-015 |

**Deliberately not reported** (checked, and clean — recorded so they are not re-opened):

- Route registration: 245 routes, no duplicate `method+path`, no conflicting param names at the same
  path position, every `register*Routes` imported in `server.ts` is called.
- The four statement-level `db.update(...).catch(() => {})` view-count increments
  (`share.controller.ts:42`, `permalink.controller.ts:90`/`:107`, `playlists.controller.ts:204`) are
  deliberate fire-and-forget on a value the response does not depend on. Drizzle's `QueryPromise`
  implements `catch`, so they do execute — not a lost write.
- The `setImmediate(...).catch(log)` background kicks (`video.controller.ts:573`,
  `transcriptPropagation.ts:64`, `projects.controller.ts:129`) all carry a logged catch and a
  self-contained `try` — design choices, per the reviewer brief.
- `ProjectExportService.run` (`:257-554`) clears both its timers and removes its work directory in
  `finally`, fences every status write, and classifies failures. Its resource discipline is correct.
- The three real SSE routes all clear their keep-alive interval in **both** the `'close'` handler
  and the `finally`.
- `lib/rateLimit.ts` bounds its bucket map with an unref'd 60 s sweep;
  `services/simulation/revisionIdentity.ts` bounds its cache at 5 000 entries with oldest-first
  eviction. Neither is an unbounded module-level cache.
