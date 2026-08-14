# Security findings — run 2026-08-13T2227

Scope: full codebase audit through a security lens. Route inventory built across all 27 v1
controllers, 7 admin controllers, 2 root controllers (`sim-public`, `sim-rum`) and `stubs.ts`.

**Headline: the four things I was asked to prove out came back mostly clean.** The IDOR sweep
found the ownership discipline in this repo to be unusually good — see "Verified clean" below.
The one real authorization break is not an IDOR at all: it is the collaborator invite claim
trusting an *unverified* email address.

---

### [P1] A pending collaborator invite can be claimed by anyone who signs up with the invitee's email — `email_verified` is never checked
- id: security-001
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:77
- category: security
- confidence: high
- status: confirmed
- what: On first login `firebaseAuthMiddleware` claims every pending `collaborators` row whose
  `invited_email` equals the new account's email, keyed purely on `decoded.email` from the Firebase
  ID token. `decoded.email_verified` is never consulted — the string does not appear anywhere in
  the repo. Independently, `collabAccess.ts:29-33` grants access by matching
  `collaborators.invited_email` against `users.email` directly, so the grant does not even depend
  on the claim in step 4 landing.
- why: Concrete attack, no preconditions beyond an outstanding invite:
  1. Alice invites `bob@corp.com` to her project (`POST /api/v1/projects/:id/collaborators`).
     Bob has no account, so the row is stored `user_id: NULL, invited_email: 'bob@corp.com'` —
     the documented "pending" state this feature is *built for*.
  2. The attacker calls `createUserWithEmailAndPassword(auth, 'bob@corp.com', …)` against the
     public Firebase project (live path — `podcast-saas/client-web/lib/firebase.ts:132`). Firebase
     Email/Password signup does not verify the address; the account is created immediately with
     `email_verified: false`.
  3. The attacker's very first authenticated request runs firebase-auth.ts:77-86, which sets
     `collaborators.user_id` to the attacker's new user id.
  4. `editableProject()` now returns Alice's project for the attacker, who gets full collaborator
     edit rights: read/write sections, markers, videos, simulations, share tokens, corpus.
  Firebase enforces one account per address, so this only works while the real invitee has not yet
  signed up — which is exactly the window the pending invite exists to cover.
- evidence: Read firebase-auth.ts:77-86 (claim on `decoded.email`, no verification check) and
  collabAccess.ts:29-33 (`eq(collaborators.invited_email, user.email.toLowerCase())`).
  `grep -rn "email_verified|emailVerified"` across backend-api/src, client-web, admin-web and
  shared/src returns **zero** hits outside node_modules. `createUserWithEmailAndPassword` is
  imported and called at client-web/lib/firebase.ts:13,132, so the provider is enabled.
- fix: In `firebaseAuthMiddleware`, gate the invite claim on `decoded.email_verified === true`, and
  make the same requirement structural in `collabAccess.ts` — the `invited_email` branch of
  `matchUser` should only match when the requesting user's email is verified. Carry a
  `users.email_verified` column (synced from the token on each login) so the SQL predicate can
  express it, rather than resolving it per-request in JS. Anonymous accounts (`is_anonymous`) have
  no email and are already excluded.
- verify: New backend test — seed a pending invite for `bob@corp.com`, present a token with
  `email_verified: false`, assert `editableProject()` returns undefined and the `collaborators` row
  is still `user_id: NULL`; repeat with `email_verified: true` and assert the claim happens.
- cross: @backend-reviewer
- effort: M

---

### [P2] `canServeMediaKey` fails **open** — a database fault makes every private and paid video world-streamable
- id: security-002
- location: podcast-saas/backend-api/src/services/storage/mediaAccess.ts:82
- category: security
- confidence: high
- status: confirmed
- what: The `catch` around the project lookup returns `true`, logging
  `'[mediaAccess] lookup failed — allowing (fail-open)'`. Every media authorization decision that
  needs a DB read — i.e. every request that does *not* carry a valid scoped token — resolves to
  ALLOW while the database is unreachable.
- why: This is the single gate behind `/local-storage/*`, `/hls-public/*`, `/hls-proxy/*`,
  `/video-raw/*` and `/video-proxy/*` (server.ts:227-248). During any Postgres blip, pool
  exhaustion, or failover, an unauthenticated request for a known key streams a private draft or a
  paid, unpurchased video. Keys are not secrets in this design: they are `videos/{projectId}/…`,
  `hls/{videoFileId}/…` and `exports/{projectId}/…`, and project ids are handed to the browser by
  every player-config and share response — so a viewer of one public video already holds
  well-formed key material for probing. The comment argues the token path covers "every URL we mint
  ourselves", which is true and is exactly why the fallback is unnecessary: legitimate players
  already pass at step 1 without touching the DB. The fail-open only ever helps requests that had
  no token.
- evidence: Read mediaAccess.ts:60-88. Step 1 (`verifyMediaToken`) returns before the `try` block,
  so the tokened path — every URL the app mints — is unaffected by making this deny. The three
  `resolveProjectForKey` branches (lines 26-57) are the only DB work inside the `try`.
- fix: Return `false` in the catch and keep the `logger.error`. Availability for real players is
  already preserved by the token check above; the health endpoint (server.ts:204) already sheds the
  instance from the load balancer when the DB is down, so honest 403s during an outage are strictly
  better than serving paid content for free.
- verify: Unit test that stubs `db.query.projects.findFirst` to reject and asserts
  `canServeMediaKey('videos/<uuid>/a.mp4', null, null) === false`; assert the tokened call still
  returns true with the DB stubbed to reject.
- cross: @backend-reviewer
- effort: S

---

### [P2] Path traversal in the simulation source reader — `?key=` is prefix-checked but never `..`-checked, and `LocalStorageAdapter.readObject` joins raw
- id: security-003
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:563
- category: security
- confidence: high
- status: confirmed
- what: `GET /api/v1/projects/:id/simulations/:simId/file-content?key=…` validates the key with
  `key.startsWith(sim.storage_prefix + '/')` only. A `..` segment after that prefix satisfies the
  check and then escapes, because `LocalStorageAdapter.readObject` is
  `readFile(join(BASE_DIR, key))` — bare `join`, no `safeLocalPath`.
- why: An authenticated user who owns *any* project sends
  `?key=simulations/<their-simId>/../../../../package.json` and reads files outside the simulation
  tree; pointed at a sibling prefix it reads **another tenant's simulation source**. The extension
  allowlist (`isTextSimulationFile`, SimulationService.ts:182-185) bounds the damage — `.env` and
  `/etc/passwd` are rejected for lacking a listed extension — but `json, js, ts, md, yml, yaml,
  css, html, txt, csv, xml, map` covers application source and config.
  **Ranked P2, not P0, because production cannot reach it:** `getStorageAdapter()` fails closed and
  throws rather than ever returning `LocalStorageAdapter` when `NODE_ENV=production`
  (getStorageAdapter.ts:66-85), and on R2/Supabase a `..` key is a literal S3 key that simply 404s.
  The exposure is dev machines and any self-hosted non-production deployment.
- evidence: Read simulations.controller.ts:547-585 — no `keyHasTraversal`, unlike its sibling
  `/sim-public/*` which applies it at sim-public.controller.ts:123. Read
  LocalStorageAdapter.ts:194-196 (`readFile(join(BASE_DIR, key))`); the adapter's own comment at
  lines 115-117 concedes only `copyObject`/`copyPrefix` were retrofitted with `safeLocalPath` and
  "the rest of this adapter predates it". `uploadFile` (36), `deleteFile` (103),
  `deleteWithPrefix` (107), `objectExists` (174), `headObject` (182) and `listObjects` (199) share
  the raw-`join` shape; I checked their callers and all currently pass DB-derived prefixes, so this
  route is the only user-controlled reachable one today.
- fix: Two independent changes, both worth making. (1) In the controller, reject the key with the
  existing `keyHasTraversal(key)` helper before use, matching sim-public. (2) In
  `LocalStorageAdapter`, route every filesystem method through `safeLocalPath(BASE_DIR, key)` and
  throw on `null`, closing the class rather than this one instance.
- verify: Test asserting the route 403s on
  `?key=<prefix>/../../other/app.js`; adapter unit test asserting `readObject('a/../../b')` throws.
- cross: @backend-reviewer
- effort: S

---

### [P2] Firebase ID tokens are accepted in the query string on **every** authenticated route, and nginx logs them in plaintext
- id: security-004
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:28
- category: security
- confidence: high
- status: confirmed
- what: `firebaseAuthMiddleware` falls back to `request.query.token` when no `Authorization` header
  is present. The comment scopes the intent to SSE streams (EventSource cannot set headers), but
  the fallback is in the shared middleware, so it is live on every route that uses it — the great
  majority of the API.
- why: A Firebase ID token is a bearer credential valid for one hour. Putting it in the URL puts it
  in nginx's access log (`podcast-saas/deploy/nginx/nginx.conf:14-18` logs `"$request"`, which is
  the full request line including the query string, to `/var/log/nginx/access.log`), in browser
  history, and in the `Referer` of any cross-origin subresource the response triggers. Anyone with
  log read access — ops, log shipping, a backup — can replay a captured token as the user until it
  expires. `access_log off` appears only on a single location block in
  `nginx/templates/app.conf.template:16`, not on the API proxy.
- evidence: Read firebase-auth.ts:26-33: `const token = authHeader?.startsWith('Bearer ') ?
  authHeader.slice(7) : tokenQuery;` — no route allowlist, no SSE check. Read nginx.conf:14-18 for
  the log format.
- fix: Restrict the query-parameter fallback to the routes that genuinely need it. Either add a
  dedicated `sseAuthMiddleware` that reads `?token=` and use it only on the SSE endpoints
  (`/generate-sim-script/stream`, `/generate-guidance/stream`, `/publish-guidance/stream`), leaving
  `firebaseAuthMiddleware` header-only; or mint a short-lived, single-scope SSE token the way
  `mediaToken.ts` already does for media, and keep the ID token out of URLs entirely. Add
  `access_log off` (or a log format that strips the query) on the API location as defence in depth.
- verify: Test asserting a protected non-SSE route 401s when the credential is passed only as
  `?token=`, and still 200s with the `Authorization` header.
- cross: @config-deploy-reviewer @observability-reviewer
- effort: M

---

### [P3] `PUT /local-storage/upload/*` lets any authenticated user overwrite any key under the storage root
- id: security-005
- location: podcast-saas/backend-api/src/server.ts:525
- category: security
- confidence: high
- status: confirmed
- what: The handler authenticates, then writes `request.body` to `safeLocalPath(BASE_DIR, key)` with
  no scoping of the key to the caller. Containment to the base directory holds, but *within* it any
  authenticated user may overwrite any object — another tenant's video, an HLS playlist, an export
  master, or a file under a `PUBLIC_LOCAL_PREFIXES` entry (server.ts:253).
- why: Bounded to non-production by the `NODE_ENV === 'production'` 404 at server.ts:529-531, which
  is why this is P3 and not higher. It is still a cross-tenant write on any shared dev or staging
  box, and the bar is low because anonymous sign-in is enabled (`signInAnonymously`,
  client-web/lib/firebase.ts:104) — "authenticated" does not mean "known person". Content-type
  handling limits the follow-on: `getLocalStorageContentType` (server.ts:80-93) defaults unknown
  extensions to `application/octet-stream` and the route sets `X-Content-Type-Options: nosniff`, so
  an uploaded `.html` will not execute. `.svg` does map to `image/svg+xml`, which can carry script
  when navigated to directly, but only against the API origin and only in dev.
- evidence: Read server.ts:525-542 — `safeLocalPath` is applied, no ownership or prefix scoping is.
- fix: Scope the key to the caller — require it to start with a prefix derived from the
  authenticated user or from a project the user can edit (`editableProject`), rejecting anything
  else with 403 — mirroring the `sim.storage_prefix` check the sim routes perform.
- verify: Test asserting user B gets 403 PUTting `videos/<userAProjectId>/x.mp4`.
- cross: @backend-reviewer
- effort: S

---

### [P3] Rate limiting is per-process in-memory, so it dilutes with every added instance
- id: security-006
- location: podcast-saas/backend-api/src/lib/rateLimit.ts:11
- category: security
- confidence: high
- status: confirmed
- what: `rateLimit()` keeps counters in a module-level `Map`. It is the only limiter protecting the
  unauthenticated, billable avatar endpoints (`/api/v1/avatar/visual/analyze` at 30/min/IP,
  `/api/v1/avatar/image/analyze` at 10/min/IP, which runs `gpt-image-1`).
- why: Correct on today's single-VM topology (`deploy/docker-compose.yml`), and the `trustProxy`
  constant is carefully set to 1 hop so `request.ip` is not spoofable — so this is a latent
  scaling defect, not a live hole. The moment a second API replica is added, the effective limit
  multiplies by the replica count with no code change and no signal. Buckets also reset on every
  deploy. Noting it so the cost ceiling is a deliberate decision rather than an accident of
  process count.
  Separately: `middleware/rate-limit.ts:6` is named `scriptGenerationRateLimit` but only checks a
  global pause flag — its own comment says "per-user rate limits disabled". Its sole importer is
  under `_archive/`, which is out of review scope, so it is dead code rather than a live gap; the
  misleading name is worth deleting with it.
- evidence: Read lib/rateLimit.ts:1-27 and the two call sites at
  controllers/v1/avatar.controller.ts:245,266. `grep -rn scriptGenerationRateLimit` returns only
  `_archive/v1-podcast-pipeline/controllers/stream.controller.ts`.
- fix: When a second replica becomes real, move the buckets to Postgres or Redis. Until then, add a
  comment at the call sites tying the limit to the single-instance assumption, the way
  `config/trustProxy.ts` documents its own hop-count dependency.
- verify: n/a (design note).
- cross: @performance-reviewer @llm-pipeline-reviewer
- effort: S

---

## Verified clean — the four priorities I was dispatched on

Recording these explicitly, because "we looked and it holds" is the useful result for a re-audit.

**1. IDOR across the route inventory — clean.** Every route in all 27 v1 and 7 admin controllers
carries an authentication preHandler except the deliberately public set (below), and — the separate
question — the handlers do verify ownership of the specific id. The pattern is consistent and
correct: load the parent through an access helper, then scope the child id by the parent's id in
the same query. `markers.controller.ts:85-88` and `:131-135` are the reference shape
(`and(eq(marker.id, mid), eq(marker.project_id, project.id))`), and `export.controller.ts:191-194`,
`simulations.controller.ts:558-560`, `collaborators.controller.ts:130-136` all match it. Nested
podcast routes go through `ownedEpisodeInShow` (podcastAccess.ts:50), which exists specifically so
`/shows/:showId/episodes/:epId` cannot be crossed. All 7 admin controllers use
`firebaseAdminRequired` on every single route — no exceptions.
Two controllers looked like gaps on a grep for ownership helpers and are not:
`courses.controller.ts` has zero helper references because authorization lives one layer down in
`CoursePublishingService.loadOwned` (:30-35), and the bare-id routes `PATCH/DELETE
/api/v1/course-lessons/:lessonId` correctly resolve the lesson and then authorize its parent course
(:128-142). `billing.controller.ts`'s pricing PATCH re-checks `created_by` inline (:203, :208).

**2. Filesystem paths in `server.ts` — all contained.** Traced all six. `/local-storage/*` (:284),
`/hls-public/*` (:305), `/video-raw/*` (:375) and `PUT /local-storage/upload/*` (:536) each pass
through `safeLocalPath` and 403 on `null`. `/hls-proxy/*` and `/video-proxy/*` never touch the
filesystem — they apply `keyHasTraversal` and go to R2. The ordering on `/local-storage/*` is
notably right: `keyHasTraversal` runs at :267 *before* the public-prefix branch, which is what stops
an encoded-slash key like `podcasts/..%2fexports/…` from matching a public prefix (skipping auth)
and then resolving back into the private tree. The only bare-`join` traversal I found is in
`LocalStorageAdapter`, reached from a controller rather than from `server.ts` — filed as
security-003.

**3. Stripe webhook — correct.** `stripe-webhook.controller.ts:12-17` registers the route inside an
encapsulated Fastify scope with `addContentTypeParser('application/json', { parseAs: 'buffer' })`,
so the handler receives the unparsed body and passes that `Buffer` straight to
`BillingService.verifyWebhook` (:25). The rest of the app keeps the normal JSON parser. Signature
failure 400s before any handler runs (:26-29). This is the correct pattern.
*Not assessed, and not mine:* replay/idempotency of the event handlers themselves — signalled to
`billing-integrity-reviewer`.

**4. Public-link authorization — is a DB flag, not a path prefix.** `share.controller.ts:19-21`
looks the token up as a column predicate (`eq(projects.share_token, …)`), and revocation nulls the
column (:117-120), so a revoked link dies immediately. `projectAccess.ts:19-28` gates on
`project.visibility === 'public'`, an owner match, or a share-token equality check.
`player.controller.ts` applies that gate to player-config (:39), captions (:79) and the VTT
route (:119), returning 404 rather than 403 so a private project's existence is not disclosed.
`public-courses.controller.ts` reads through `PublicCourseQueryService` on published-state columns.
`/sim-public/*` is prefix-restricted *and* `keyHasTraversal`-guarded (sim-public.controller.ts:123)
and serves under a restrictive CSP whose `frame-ancestors` is the app origin list.

## Other things checked and found sound
- **Crypto:** `services/secrets/ApiKeyService.ts` uses AES-256-GCM with a fresh 12-byte random IV
  per encryption and a stored auth tag — no IV reuse, authenticated mode. `mediaToken.ts` signs
  HMAC-SHA256 and compares with `timingSafeEqual` (:71) after a length check. Both fall back to a
  hardcoded dev key only when `ENCRYPTION_KEY` is unset, and `server.ts:609-612` refuses to boot in
  production without it.
- **Zip-slip:** `normalizeSimulationPath` (SimulationService.ts:202-227) rejects absolute paths,
  Windows drive letters, and any `..` segment before a zip entry becomes a key, and additionally
  reserves the system `revisions/`/`posters/` namespaces.
- **SSRF:** `YouTubeIngester` rebuilds a canonical URL from a validated 11-char video id rather than
  passing the user's URL to `yt-dlp` (:16-18), and passes the id as `argv` rather than interpolating
  it into the Python program text (:38-51). `CorpusBuilder` inverts its own storage URL and
  presigns rather than fetching a user-supplied host (:75-82).
- **Injection:** no interpolated user input reaching `sql\`\``; every `spawn`/`execFile` call uses
  argument arrays, never a shell string. No `eval`/`new Function` on request data — the
  `new Function` hits in `SimulationService`/`GuidanceService` are syntax *validators* over
  generated code plus regex denylists.
- **`NEXT_PUBLIC_ADMIN_BYPASS`:** browser-visible but harmless. `admin-web/components/AdminGate.tsx:42`
  disables it whenever `NODE_ENV === 'production'`, and it gates only UI rendering — every admin API
  route independently enforces `firebaseAdminRequired`, so flipping it grants no data access.
  No server secret is exposed under a `NEXT_PUBLIC_*` name; the full set is Firebase browser keys,
  origins, and the Stripe *publishable* key, all of which are public by design.
- **`dangerouslySetInnerHTML`:** six uses, all static or serialized JSON-LD, none on request data.
