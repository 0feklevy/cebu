# Security review — FlowVid @ 2d187e3

Scope swept: `backend-api/src/middleware/**`, all 27 `controllers/v1/**` + 7 `controllers/admin/v1/**`
+ `controllers/sim-public.controller.ts` / `sim-rum.controller.ts` / `stubs.ts` (route-by-route authn +
ownership inventory), `services/storage/**` (pathSafety, mediaAccess, mediaToken, all three adapters,
serveFile), `server.ts` (every filesystem/proxy route), `services/security/**`, `services/secrets/**`,
`services/collabAccess.ts` / `projectAccess.ts` / `podcastAccess.ts` / `avatar/avatarAccess.ts`,
outbound `fetch` sinks, `spawn`/`execFile` sinks, `sql``` sinks, upload/zip handling, and the LLM
visual/simulation generation path.

**Clean areas worth stating (no findings filed):** every one of the 7 admin controllers goes through
`firebaseAdminRequired`; `NEXT_PUBLIC_ADMIN_BYPASS` is a client-only convenience gate that fails closed
in a production build (`admin-web/components/AdminGate.tsx:42`) and never weakens the backend;
the Stripe webhook verifies the signature against a genuinely raw buffer in an encapsulated content-type
scope (`stripe-webhook.controller.ts:12-25`); `safeLocalPath` is correct and is on **every** route in
`server.ts` and `sim-public.controller.ts` that reaches disk; nested-resource ids are consistently
re-scoped to the parent (`markers`, `sections`, `branch`, `simulations`, `images`, `broll`, `export`,
all `podcast-*` via `ownedEpisodeInShow`); no `shell: true`, no `sql.raw`/`sql.unsafe` outside
`db/migrate.ts` and one-shot scripts, no `Math.random()` used for anything token-like, no `eval`;
`/sim-rum` is a model of a hardened unauthenticated endpoint; zip-slip is blocked by
`normalizeSimulationPath` (`SimulationService.ts:202-227`); `YouTubeIngester` rebuilds a canonical URL
from a validated 11-char id instead of passing the raw URL to `yt-dlp`.

---

### [P1] Production storage serves HLS from a public bucket, so the per-object media authorization never runs
- id: security-001
- location: podcast-saas/backend-api/src/services/storage/SupabaseStorageAdapter.ts:428
- category: security
- confidence: high
- status: confirmed
- what: `SupabaseStorageAdapter.getPublicUrl()` returns
  `{origin}/storage/v1/object/public/{bucket}/{key}` — a raw, unauthenticated bucket URL — and
  `buildPlayerConfig.ts:484-487` uses exactly that for `hls_url`. Supabase is the production adapter
  (`getStorageAdapter.ts:94-99`: `backend === 'supabase' || (!backend && hasSupabaseStorage())`, and the
  prod guard at :70-84 forbids local). The `canServeMediaKey` gate built for security-002
  (`services/storage/mediaAccess.ts`) only runs on the `/hls-proxy`, `/hls-public`, `/video-raw`,
  `/video-proxy` and `/local-storage` routes — which the R2 and local adapters route through
  (`R2StorageAdapter.ts:316-324`, `LocalStorageAdapter.ts:150-155`) and Supabase does not.
- why: In the deployed configuration the media authorization control is inert. Concretely: an owner
  flips a project public → private, revokes its share link, or removes a collaborator; the HLS master
  and every segment stay readable forever by anyone still holding the bucket URL, because that URL was
  never gated and cannot be revoked. Same for `crop_url` (`buildPlayerConfig.ts:530`) and captions
  (`CaptionService.ts:261`). The bucket must in fact be public — the comment at
  `SupabaseStorageAdapter.ts:90` says so, and if it were private every video in production would fail
  to play, so "maybe it's a private bucket" is not an available refutation.
- evidence: Read `SupabaseStorageAdapter.ts:88-95` (constructor `publicBase`), `:428-430`
  (`getPublicUrl`), `:201-205` (`getPresignedDownloadUrl` — the only signed path, used for downloads,
  not playback). Read `buildPlayerConfig.ts:484-489, 530, 562-567, 595-600` — all HLS/broll/crop URLs
  come from `getPublicUrl`, none from a proxy route. Compare `R2StorageAdapter.ts:316-324`, which mints
  a scoped media token in the path for `hls/` keys. `grep -rn "getPublicUrl(" services/ controllers/`
  shows 14 non-adapter call sites, none of which re-check access.
- fix: Make `SupabaseStorageAdapter.getPublicUrl()` route media prefixes through the backend the way
  R2 already does — for `hls/`, `videos/`, `exports/` and `crop/` keys return
  `${publicApiOrigin()}/hls-proxy/t/${mintMediaToken(scope)}/${path}` (and teach `/hls-proxy` to fetch
  from `this.publicBase` when the adapter is Supabase, mirroring the existing R2 branch in
  `server.ts:330-357`). Then flip the Supabase bucket to private and serve everything through the
  authorized routes. Minimum interim step if the bucket must stay public: make the bucket keys
  unpredictable per-visibility-change (re-key on visibility downgrade) so revocation means something.
- verify: add a test that builds a player config for a `visibility: 'private'` project under the
  Supabase adapter and asserts the returned `hls_url` points at the backend origin, not at
  `/storage/v1/object/public/`.
- cross: @backend-reviewer @config-deploy-reviewer
- effort: L

### [P1] `POST /api/v1/avatar/start` is unauthenticated, unmetered and unrate-limited, and mints billable Anam session tokens on the platform key
- id: security-002
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:166
- category: security
- confidence: high
- status: confirmed
- what: The route's only preHandler is `firebaseAuthOptionalMiddleware`, so no auth is required. With
  no `projectId` in the body the whole ownership branch (`:170-199`) is skipped, `apiKey` stays
  `undefined`, and `getSessionToken(characterId, undefined, undefined)` falls back to the shared
  `ANAM_ENV.ANAM_API_KEY` (`services/avatar/anamService.ts:463`) and POSTs
  `${ANAM_BASE}/auth/session-token` (`:434`). There is no `rateLimit(...)` call in the handler — unlike
  its two neighbours `/avatar/visual/analyze` (`:245`) and `/avatar/image/analyze` (`:266`), which do
  have per-IP caps.
- why: `curl -X POST https://api.<domain>/api/v1/avatar/start -H 'content-type: application/json' -d '{}'`
  returns a live Anam `sessionToken` to anyone on the internet, as many times as they ask. Each token is
  a real avatar streaming session billed to the platform's Anam account, and the token is handed to the
  caller, so an attacker can both burn the budget and resell/embed free avatar sessions. The long
  comment in `server.ts:152-155` names "the two avatar routes" as the rate-limited unauthenticated
  surface — this is the third one, and it was missed.
- evidence: Read `avatar.controller.ts:166-235` in full: no `rateLimit`, no `assertGenerationAllowed`,
  no `UsageTrackingService` call on this path (contrast `:414` on the authenticated library route,
  which does call `assertGenerationAllowed`). Read `anamService.ts:461-470` — `const key = apiKey ||
  ANAM_ENV.ANAM_API_KEY`. `grep -n "rateLimit" controllers/v1/avatar.controller.ts` → lines 245 and 266
  only.
- fix: Add `if (!rateLimit(\`avatar-start:${request.ip}\`, 5, 60_000)) return reply.code(429).send(...)`
  as the first statement, and require a resolvable `projectId` (reject a bodyless start) so every
  session is attributable to a project and can be metered by `UsageTrackingService`. Longer term the
  limiter must move off `lib/rateLimit.ts`'s per-process map (see security-013).
- verify: unit test that the 6th call from one IP inside a minute gets 429 and never reaches
  `getSessionToken`.
- cross: @billing-integrity-reviewer
- effort: S

### [P1] Firebase `email` is trusted without `email_verified`, so an unverified signup can claim admin or a pending collaborator invite
- id: security-003
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:45
- category: security
- confidence: high
- status: confirmed
- what: `isAdminEmail(decoded.email)` (`:9-13, :45`) grants `is_admin: true` on account creation
  (`:68`) and promotes an existing row (`:52`) purely on the email string in the ID token. The same
  middleware then claims every pending collaborator invite whose `invited_email` matches the new
  account's email (`:77-85`), and `collabAccess.ts:30-35, 115-121` matches collaborators by
  `invited_email` thereafter. Nothing in the repo reads `email_verified`:
  `grep -rn "email_verified\|emailVerified" backend-api/src client-web admin-web` returns **zero**
  matches. The email/password provider is live — `client-web/lib/firebase.ts:132` calls
  `createUserWithEmailAndPassword`.
- why: Two concrete attacks. (a) If any address in `ADMIN_EMAILS` does not yet exist as a Firebase
  account, an attacker calls `createUserWithEmailAndPassword('<that address>', 'x')` from the public
  sign-up form, hits any API route once, and `firebase-auth.ts:68` writes `is_admin: true` — full
  `/api/admin/v1/**` access, including reading every user row and rotating provider API keys. (b) The
  collaborator flow is *designed* around emails that have not signed up yet
  (`collabAccess.ts:11-13`: "invites work for people who haven't signed up yet"), so any pending invite
  is claimable by whoever registers that email first, with unverified email/password signup. Firebase's
  default "one account per email" only blocks (a) when the admin address is *already* registered — it
  is not a guarantee the app makes for itself.
- evidence: Read `firebase-auth.ts:9-13, 41-88` in full. Read `collabAccess.ts:24-38, 108-127`. Read
  `client-web/lib/firebase.ts:9-13, 118-133` (anonymous + Google + email/password + createUser all
  wired). The grep for `email_verified` across `backend-api/src`, `client-web`, `admin-web` is empty.
- fix: In `firebaseAuthMiddleware`, treat the email as untrusted unless verified: compute
  `const verifiedEmail = decoded.email_verified ? decoded.email : null;` and use `verifiedEmail` for
  `isAdminEmail(...)` and for the invite-claiming update at `:77-85`. In `collabAccess.ts`, drop the
  `invited_email` arm of `matchUser` and resolve invites to `user_id` only at claim time (which is now
  verification-gated). Keep `decoded.email` for display/`users.email`.
- verify: test that a decoded token with `{ email: '<admin email>', email_verified: false }` produces
  `is_admin === false`, and that a collaborator invite is not claimed for an unverified email.
- effort: M

### [P2] `mediaToken` accepts a non-hex `ENCRYPTION_KEY` and silently HMACs with a truncated/empty key
- id: security-004
- location: podcast-saas/backend-api/src/services/storage/mediaToken.ts:16
- category: security
- confidence: medium
- status: suspected
- what: `getMediaSecret()` does `Buffer.from(process.env.ENCRYPTION_KEY, 'hex')` with no validation.
  Node's hex decoder stops at the first non-hex pair and returns what it decoded, so a key that is not
  64 hex chars (a base64 string, a passphrase, a value with a stray space) yields a short or
  **zero-length** Buffer. `createHmac('sha256', <empty buffer>)` does not throw — it happily produces a
  deterministic MAC that anyone can reproduce. The boot guard in `server.ts:609` checks only that
  `ENCRYPTION_KEY` is *set*, not that it is valid hex of the right length.
- why: If prod's `ENCRYPTION_KEY` is not clean 32-byte hex, every media token becomes forgeable:
  `sign(scope, exp) = hmac_sha256('' , \`${scope}.${exp}\`)[0..32]`, so an attacker computes
  `t/{exp}-{sig}/hls/{anyVideoFileId}/master.m3u8` offline and streams any private project's media
  through `/hls-public`, `/video-raw`, `/video-proxy` or `/local-storage` — `canServeMediaKey` returns
  `true` at step 1 without touching the database. `ApiKeyService.getEncryptionKey()` has the same
  parse but fails loudly (`createCipheriv` throws on a wrong key length), which is exactly why this one
  is easy to miss. I cannot read `.env`, so I cannot confirm the deployed value — the *defect* (no
  validation, silent degradation) is confirmed in code.
- evidence: Read `mediaToken.ts:15-20, 34-36, 62-75` and `services/secrets/ApiKeyService.ts:9-14`.
  Read `server.ts:608-612` — presence check only. `.env.example:94-95` documents
  `openssl rand -hex 32`, so the correct shape is intended but unenforced.
- fix: Add a shared `requireEncryptionKey()` that asserts `/^[0-9a-f]{64}$/i` and throws otherwise, use
  it from both `mediaToken.getMediaSecret()` and `ApiKeyService.getEncryptionKey()`, and call it from
  the boot guard at `server.ts:609` so a malformed key refuses to start instead of silently weakening
  every token.
- verify: unit test that a non-hex `ENCRYPTION_KEY` throws at boot; test that `getMediaSecret()` never
  returns a buffer shorter than 32 bytes.
- effort: S

### [P2] `/sim-public/*` serves every simulation key with no authorization, including private projects'
- id: security-005
- location: podcast-saas/backend-api/src/controllers/sim-public.controller.ts:123
- category: security
- confidence: high
- status: confirmed
- what: The only gate is `key.startsWith('simulations/') && !keyHasTraversal(key)`. Simulation packages
  are written to `simulations/{projectId}/{simId}/…` (`simulations.controller.ts:218`,
  `SimulationService.processUpload`) regardless of the owning project's `visibility`, and this route
  never resolves the project or checks it. It is the one media family that did **not** get the
  security-002 per-object gate that `videos/`, `hls/` and `exports/` received
  (`services/storage/mediaAccess.ts:26-57` handles exactly those three prefixes and returns `null` for
  anything else).
- why: A private project's simulation HTML/JS/data — which is authored content the owner has not
  published — is world-readable to anyone who learns the key. Keys leak the normal ways: browser
  history, a shared screenshot of the editor's Files tab, nginx access logs, a `Referer` from a sim that
  loads a third-party script (the sim CSP allows `https:` in `script-src`, `:178`). Unlike a share
  token there is no revocation: turning the project private changes nothing here.
- evidence: Read `sim-public.controller.ts:115-292` — no `firebaseAuth*`, no project lookup, no
  visibility check on any branch. Read `mediaAccess.ts:26-57` — `resolveProjectForKey` handles
  `videos/`, `exports/`, `hls/` only; `mediaKeyScope` (`mediaToken.ts:23-32`) likewise. Read
  `simulations.controller.ts:210-225` — upload path is project-scoped but visibility-agnostic.
- fix: Extend `mediaKeyScope`/`resolveProjectForKey` to understand `simulations/{projectId}` (the
  project id is already the second segment), have `LocalStorageAdapter.getSimPublicUrl` and
  `SupabaseStorageAdapter.getSimPublicUrl` mint a scoped media token into the path the way
  `getPublicUrl` does for `hls/`, and add the same `authorizeMediaRequest` call to `/sim-public/*` that
  `/hls-public/*` uses (`server.ts:302`). Keep the anonymous-pass ordering so public/unlisted projects
  and token-bearing players are unaffected.
- verify: request a `simulations/{privateProjectId}/…/index.html` key with no auth and no token and
  assert 403; assert a public project's sim still returns 200 anonymously.
- cross: @simulation-reviewer
- effort: M

### [P2] Arbitrary user-authored HTML/JS is stored and served as `text/html` from the API origin
- id: security-006
- location: podcast-saas/backend-api/src/services/avatar/libraryService.ts:403
- category: security
- confidence: high
- status: confirmed
- what: `storeSimulationHtml(html, projectId)` writes caller-supplied HTML to
  `simulations/avatar/{uuid}/index.html` and returns its `/sim-public/…` URL. Three callers feed it
  content that is not the platform's: (a) `avatar.controller.ts:514-523` — an authenticated user
  drag-drops any `.html` file into the library and the raw bytes are stored verbatim; (b)
  `avatar.controller.ts:560-567` — the same via a `.json` upload with a `html` field; (c)
  `visualService.ts:290` — the model's raw completion, validated only by
  `startsWith('<!DOCTYPE') && includes('</html>')` (`:277-280`), reachable from the **unauthenticated**
  `POST /api/v1/avatar/visual/analyze`, whose message steers `simTopic` and therefore
  `buildSimPrompt` (`visualService.ts:83-108`). `buildMermaidHtml` (`:70-83`) additionally splices raw
  model output into a `<div>` with no escaping.
- why: The result is a permanent, unauthenticated URL on `api.<domain>` serving attacker-chosen
  JavaScript with `Content-Security-Policy: … script-src 'self' 'unsafe-inline' 'unsafe-eval' … https:`
  (`sim-public.controller.ts:176-187`). Today the direct blast radius is bounded — the API uses Bearer
  tokens, not cookies, so there is no session to steal on that origin, and `frame-ancestors` stops
  reframing — so this is a P2, not a P0. What it *is* today: malware/phishing hosting on the company's
  own API domain, reachable by any registered user in one request; and it converts any future
  cookie-based auth, or any same-origin admin surface on `api.<domain>`, into an instant account
  takeover.
- evidence: Read `libraryService.ts:403-409`, `avatar.controller.ts:495-575` (the `isHtml` and `json`
  branches call `storeSimulationHtml` with unmodified bytes), `visualService.ts:257-300` and `:70-83`,
  `sim-public.controller.ts:158-187` (CSP) and `:198-212` (local HTML branch emits `Content-Type:
  text/html`, `getSimulationContentType`).
- fix: Serve user-authored sim HTML from a separate, cookie-less sandbox origin (e.g.
  `sims.<domain>`), which is what actually contains it; that is the structural fix and it is already
  half-built (`getSimPublicUrl` is a distinct method on every adapter). Cheap immediate mitigations:
  drop `'unsafe-eval'` from the sim CSP and add `sandbox allow-scripts` on the response
  (`Content-Security-Policy: sandbox allow-scripts allow-pointer-lock`) so the document is forced into
  an opaque origin; and HTML-escape `mermaidCode` in `buildMermaidHtml` before interpolation.
- verify: upload an `.html` containing `<script>fetch('/api/v1/platform/settings')</script>`, fetch the
  returned URL, and assert the response carries an origin-isolating `sandbox` directive.
- cross: @simulation-reviewer @config-deploy-reviewer
- effort: L

### [P2] Global multipart limit is 10 GB and several routes `toBuffer()` before checking size
- id: security-007
- location: podcast-saas/backend-api/src/server.ts:198
- category: security
- confidence: high
- status: confirmed
- what: `app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 * 1024 } })` sets the default
  for every route that does not override it, and no `files` / `parts` / `fieldSize` limits are set at
  all. Routes that use `request.file()` with no per-route limits then call `data.toBuffer()`, which
  materialises the whole upload in the Node heap: `images.controller.ts:36` and `:83`,
  `projects.controller.ts:363` (the 10 MB check is at `:364`, *after* the buffer),
  `avatar.controller.ts:934` (8 MB check after the buffer), `corpus.controller.ts:68`,
  `podcast.controller.ts:398`, `audio.controller.ts:69`, `playlists.controller.ts:373`.
- why: One authenticated request — `POST /api/v1/projects/{own project}/thumbnail` with
  `Content-Type: image/png` and a multi-gigabyte body — allocates until the process OOMs. The
  declared MIME passes the allow-list check because it is client-supplied, and the size check runs only
  after `toBuffer()` resolves. On the single-process managed host this is a full API outage, and the
  attacker needs nothing but a free account.
- evidence: Read `server.ts:198-200` (no `files`, `parts`, `fieldSize`). Read
  `projects.controller.ts:354-366` — `ALLOWED_THUMBNAIL_MIME` check on `data.mimetype`, then
  `await data.toBuffer()`, then `if (buf.length > MAX_THUMBNAIL_BYTES)`. Read `images.controller.ts:25-37`
  — same shape with no size check at all. Contrast `avatar.controller.ts:577-583`, which is the one
  route that does it right (`request.parts({ limits: { fileSize, files: 40, fields: 20 } })` plus a
  running `totalBytes` guard at `:595-598`).
- fix: Lower the global default to something sane (e.g. 25 MB) and add explicit
  `{ limits: { fileSize } }` per route: 10 MB for thumbnails/images/banners/circle-faces, 8 MB for
  avatar circle faces, the existing 10 GB only on `POST /api/v1/projects/:id/videos/upload` (which
  already streams rather than buffers, `video.controller.ts:161`). Also set `files: 1`, `parts: 20`
  and `fieldSize: 1MB` globally.
- verify: post a 100 MB body to `/api/v1/projects/:id/thumbnail` and assert a 413 before any buffer is
  allocated.
- cross: @performance-reviewer
- effort: S

### [P2] `findManageableVisual` admits global (`project_id IS NULL`) rows, so any user can edit or delete another tenant's shared library items
- id: security-008
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:374
- category: security
- confidence: high
- status: confirmed
- what: The helper matches `and(eq(id, visualId), or(eq(project_id, projectId), isNull(project_id)))`.
  Rows with `project_id = null` are the *global* pool written by every viewer's avatar session —
  `visualService.ts:291` (`projectId: null, scope: 'extended'`) and `storeFast` at `:360`. The three
  management routes that use it (`:621` edit-simulation, `:641` PATCH, `:655` DELETE) therefore accept
  any global visual id from any caller who owns any project. The read side was deliberately narrowed —
  `listVisuals({ …, includeGlobal: false })` at `:298` and `:390`, commented "per-project Extended
  Library (no shared globals)" — but the write side was not updated to match.
- why: `DELETE /api/v1/projects/{my project}/avatar/library/{someone else's global visual id}` returns
  204 and removes a row other tenants' avatars retrieve; `POST …/edit-simulation` rewrites its stored
  HTML in place (`editLibrarySimulation`) and spends a billable LLM call doing it. The only thing
  standing between an attacker and full destruction of the shared pool is guessing UUIDs — but the
  authorization decision itself is simply absent, and the read-path comment shows the intended rule is
  "this project's rows only".
- evidence: Read `avatar.controller.ts:373-378` and the three call sites at `:627`, `:647`, `:661`.
  Read `visualService.ts:288-297` and `:355-365` for the `projectId: null` inserts. Read `:298` and
  `:390` for the deliberate `includeGlobal: false` on the read path.
- fix: Drop the `isNull(avatar_visuals.project_id)` arm — `where(and(eq(id, visualId),
  eq(project_id, projectId)))` — so manage routes match the read routes. If global items must remain
  editable, gate that on `request.dbUser!.is_admin`.
- verify: test that PATCH/DELETE/edit-simulation against a `project_id = null` visual returns 404 for a
  non-admin.
- effort: S

### [P2] Avatar knowledge-document delete does not verify the document belongs to the project's group
- id: security-009
- location: podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:877
- category: security
- confidence: high
- status: confirmed
- what: The handler checks project ownership (`requireOwnedProject`) and then calls
  `deleteKnowledgeDocument(request.params.docId, apiKey)` with the caller's raw `docId`. `docId` is an
  Anam-side identifier; nothing checks it is a member of this project's `cfg.knowledgeGroupId`. When
  BYOK is off — the default, `resolveAnamKeyForProject` returns `undefined` unless
  `admin_settings.avatar_byok_enabled` and the owner set a key (`services/avatar/anamKey.ts:12-19`) —
  every project on the platform shares one Anam account, so `docId` is not tenant-scoped either.
- why: A user who owns any project can delete another project's RAG knowledge documents by id, silently
  degrading that project's avatar (it stops being able to answer about its own source material) with no
  audit trail on our side. Compare the sibling GET at `:862-875`, which correctly scopes to
  `cfg.knowledgeGroupId`.
- evidence: Read `avatar.controller.ts:862-887`. Read `services/avatar/anamKey.ts:11-20`.
- fix: Before deleting, `const docs = await listKnowledgeDocuments(cfg.knowledgeGroupId, apiKey)` and
  404 unless `docs.data.some(d => d.id === request.params.docId)` — the same shape every other nested
  route in this codebase already uses.
- verify: test that deleting a docId absent from the project's group returns 404 and never calls
  `deleteKnowledgeDocument`.
- effort: S

### [P2] `reply.sent` is the auth-denied signal, and in Fastify 4 it is a `writableEnded` probe, not a flag `send()` sets
- id: security-010
- location: podcast-saas/backend-api/src/server.ts:281
- category: security
- confidence: high
- status: confirmed
- what: Three places call an auth middleware as a plain function and then decide whether the request was
  rejected by reading `reply.sent`: `server.ts:281` (the private branch of `/local-storage/*`),
  `server.ts:533` (`PUT /local-storage/upload/*`), and `middleware/firebase-admin-required.ts:9`. In
  Fastify 4.29.1 `reply.sent` is a *getter*:
  `return (this[kReplyHijacked] || this.raw.writableEnded) === true`
  (`node_modules/.pnpm/fastify@4.29.1/…/lib/reply.js:104-110`). It is true after `.send()` only because
  `onSendHook` short-circuits to `onSendEnd` synchronously when the route context has **no** onSend
  hooks (`reply.js:553-565`), so `res.end()` runs inline.
- why: The invariant holding this together is "nobody registers an onSend hook". The moment one is
  added — `@fastify/compress` switched to `global: true`, a response-logging hook, a metrics hook, an
  ETag plugin — `onSendHookRunner` defers `res.end()`, `reply.sent` reads `false` immediately after the
  401, and `server.ts:282` falls through to `safeLocalPath` + `serveLocalFile`: a private storage
  object is streamed to an unauthenticated caller (with a 401 body queued behind it). That is a
  fail-open hinged on a plugin registration in a different file. Today `grep -rn "addHook"
  backend-api/src` returns nothing, so it is correct now — which is exactly why it will not be noticed
  when it breaks.
- evidence: Read `reply.js:104-110` (the getter) and `:543-565` (`send` → `onSendHook` → `onSendEnd`).
  Read `server.ts:279-286`, `:532-537`, `firebase-admin-required.ts:4-14`.
  `grep -rn "addHook" backend-api/src --include=*.ts` → no matches outside tests.
- fix: Make the denial explicit rather than inferred. Change `firebaseAuthMiddleware` to return
  `boolean` (or a `{ ok: false }` result) and have every non-preHandler caller branch on that value:
  `const ok = await firebaseAuthMiddleware(request, reply); if (!ok) return;`. Keep the reply-sending
  behaviour so its use as a Fastify preHandler is unchanged.
- verify: register a trivial async `onSend` hook in a test app and assert `/local-storage/videos/…`
  still 401s instead of streaming bytes.
- cross: @backend-reviewer
- effort: S

### [P2] Firebase ID tokens are accepted from a `?token=` query parameter on every authenticated route
- id: security-011
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:28
- category: security
- confidence: high
- status: confirmed
- what: `const tokenQuery = (request.query as Record<string, string>)?.token;` then
  `const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : tokenQuery;`. The comment
  says this exists for SSE (`EventSource` cannot set headers), but the fallback is unconditional — it
  applies to all ~150 routes that use `firebaseAuthMiddleware`, and to the `/local-storage/*` gate at
  `server.ts:280`.
- why: A Firebase ID token is a one-hour bearer credential. Putting it in a URL puts it in nginx access
  logs, any CDN or WAF log, browser history, and — for cross-origin subresources — potentially a
  `Referer`. Anyone with read access to a log file (an on-call engineer, a log-shipping vendor, a
  leaked backup) can replay it against the full API for up to an hour. The SSE routes that actually
  need this are a handful (`sections.controller.ts` generate-stream); every other route pays the risk
  for nothing.
- evidence: Read `firebase-auth.ts:26-33`. `grep -rn "firebaseAuthMiddleware" controllers/` shows it on
  every authenticated route, all of which inherit the fallback. `server.ts:280` uses the same
  middleware for private local-storage objects, so an image `<img src="…?token=…">` would also carry it.
- fix: Gate the query fallback to the routes that need it — e.g. accept `request.query.token` only when
  `request.headers.accept?.includes('text/event-stream')`, or introduce a separate
  `firebaseAuthSseMiddleware` used only by the SSE routes. Also add `token` to the logger's redaction
  list.
- verify: test that `GET /api/v1/projects?token=<valid>` returns 401 while the SSE route with the same
  query token still authenticates.
- cross: @observability-reviewer
- effort: S

### [P2] `canServeMediaKey` fails **open** on any database error
- id: security-012
- location: podcast-saas/backend-api/src/services/storage/mediaAccess.ts:82
- category: security
- confidence: high
- status: confirmed
- what: The `catch` around the project lookup logs and `return true` — "Availability bias: a DB blip
  must not take down all playback." This is the authorization function for `/hls-public`,
  `/hls-proxy`, `/video-raw`, `/video-proxy` and the private branch of `/local-storage`.
- why: Any condition that makes `db.query.projects.findFirst` throw turns the media gate into an
  allow-all: connection-pool exhaustion (the pool is 10 — see the note in `sim-rum.controller.ts:66`),
  a failover, a statement timeout. An attacker who can induce pool pressure (many concurrent
  `/api/v1/projects/:id/captions` calls, which each enqueue work) gets a window in which every private
  media key is served to anonymous callers. The reasoning in the comment — "the token path already
  covers every URL we mint ourselves" — argues that *legitimate* traffic does not need the fallback,
  which is precisely the argument for removing it.
- evidence: Read `mediaAccess.ts:60-88`. The token check at `:69` is outside the try, so a valid token
  still works when the DB is down — the fail-open branch only ever helps callers who have **no** token
  and are **not** authenticated.
- fix: `return false` in the catch. Legitimate players carry a scoped token minted at URL-build time
  and are unaffected; the only requests the current behaviour rescues are the ones it should deny.
- verify: test with a mocked `db.query.projects.findFirst` that rejects, and assert
  `canServeMediaKey('videos/<uuid>/x.mp4', null, null) === false`.
- effort: S

### [P2] The SSRF guard exists but is wired to exactly one call site, and that one does not need it
- id: security-013
- location: podcast-saas/backend-api/src/services/security/assertPublicHost.ts:41
- category: security
- confidence: high
- status: confirmed
- what: `grep -rn "assertPublicHost" backend-api/src` returns two hits: the definition and
  `WebIngester.ts:8`. In `WebIngester` the URL is then handed to *Firecrawl* and *r.jina.ai*
  (`:21-36`) — third-party services that do the fetching — so the guard protects a request our server
  never makes. Meanwhile the guard itself has two gaps: it resolves DNS and then lets `fetch` resolve
  again (a classic rebind TOCTOU — the comment at `:7-8` claims "DNS-rebind-aware", which the
  resolve-then-fetch shape does not deliver), and it does not constrain redirects, so a public host can
  302 to `169.254.169.254`.
- why: Every other server-side fetch of a semi-trusted URL runs unguarded. The reachable ones are
  `playlists.controller.ts:125` (`fetch(item.url)` where `item.url` comes from the OpenAI image
  response — provider output driving a server-side GET) and
  `services/video-generation/VideoGenerationService.ts:304` (`fetch(videoUrl)` from the Kling/Seedance
  API response). Neither is attacker-controlled *today*, but both are "trust a third party's JSON to
  pick our next outbound request", which is one compromised/spoofed upstream away from an internal
  fetch, and the redirect gap means even the guarded path can be walked to metadata.
- evidence: Read `assertPublicHost.ts:41-74` and `WebIngester.ts:1-38`. `grep -rnE "await fetch"
  backend-api/src` enumerated 40+ sinks; the ones taking a non-env, non-storage-derived URL are the two
  named above plus `services/course/PublishingInvalidationService.ts:58` (env-derived) and
  `services/course/transcript.ts:33` (storage-derived).
- fix: Give `assertPublicHost` teeth and reuse it: add `redirect: 'manual'` + a re-check on every hop
  (or use an agent with a `lookup` hook that rejects private addresses at connect time, which closes the
  rebind window properly), then call it before `fetch` in `playlists.controller.ts:125` and
  `VideoGenerationService.ts:304`. Add a unit test that a host resolving to `169.254.169.254` is
  rejected and that a 302 to it is rejected too.
- verify: the new redirect test is red before the change, green after.
- effort: M

### [P2] `LocalStorageAdapter`'s read/write primitives bypass `safeLocalPath`, and the dev upload route lets any account overwrite any key
- id: security-014
- location: podcast-saas/backend-api/src/services/storage/LocalStorageAdapter.ts:35
- category: security
- confidence: high
- status: confirmed
- what: `uploadFile` (`:36`), `uploadStream` (`:43`), `deleteFile` (`:103`), `deleteWithPrefix`
  (`:107`), `objectExists` (`:174`), `headObject` (`:182`), `readObject` (`:195`) and `listObjects`
  (`:199`) all use bare `join(BASE_DIR, path)`. Only `copyObject` (`:118-126`) applies `safeLocalPath`,
  and its own comment states the rest "predates it and relies on its callers". Separately,
  `PUT /local-storage/upload/*` (`server.ts:525-541`) is gated on `NODE_ENV !== 'production'` plus
  *any* authenticated user, then writes `request.body` to `safeLocalPath(BASE_DIR, key)` — containment
  is correct, but there is no ownership check on the key at all.
- why: The adapter's containment is an unenforced convention across ~30 call sites; the next key built
  from a filename or an id without sanitising is a write-anywhere primitive with no guard to catch it.
  (I traced the current callers and found no live escape — notably `video.controller.ts:150`'s
  `split('.').pop()` can inject `/` into the key but never `..`, because a `..` segment cannot survive a
  split on `.` — so this is hardening, not an exploit.) The dev upload route *is* live in every
  developer environment: any account can `PUT /local-storage/upload/videos/{someone else's
  projectId}/{uuid}.mp4` and overwrite another user's media, or plant an `.html` under a `simulations/`
  key that `/sim-public` then serves as HTML.
- evidence: Read `LocalStorageAdapter.ts:35-53, 101-126, 173-222` and the comment at `:110-117`. Read
  `server.ts:524-542`. Traced `video.controller.ts:148-151` and `corpus.controller.ts:76`
  (`corpusObjectName`, `:29-40`) and `podcast.controller.ts:402` (`safeFilename`, `:40-42`) — all three
  are sanitised today.
- fix: Apply `safeLocalPath` inside every method of `LocalStorageAdapter` (throw on `null`) so the
  invariant lives with the primitive instead of with its callers — this is the same argument the
  `copyObject` comment already makes, applied consistently. For the upload route, require the key's
  second segment to be a project the caller can edit (`editableProject`), or delete the route and use
  the multipart upload endpoints in dev too.
- verify: unit test that `uploadFile('../escape.txt', …)` throws.
- cross: @backend-reviewer
- effort: M

### [P2] Zip extraction has no decompressed-size or entry-count cap
- id: security-015
- location: podcast-saas/backend-api/src/services/simulation/SimulationService.ts:3326
- category: security
- confidence: medium
- status: confirmed
- what: `extractZip` iterates `zip.getEntries()` and calls `entry.getData()` for each, collecting every
  decompressed buffer into an in-memory `Map`. `normalizeSimulationPath` blocks zip-slip and caps path
  length, but nothing caps the number of entries or the total decompressed bytes. The two reachable
  callers are `simulations.controller.ts:218` (sim upload) and `avatar.controller.ts:530` (library ZIP,
  capped at 250 MB *compressed*).
- why: A 250 MB zip bomb decompresses to hundreds of gigabytes; the process OOMs long before that. Any
  authenticated user with a project can send it, and on the single-process host that is a full API
  outage. `zipHasHtml` at `avatar.controller.ts:143-149` also parses the archive a second time.
- evidence: Read `SimulationService.ts:3326-3336` and `:202-227` (the path guard, which is the only
  guard). Read `avatar.controller.ts:526-537` and `:577-600` (the 250 MB cap is on the wire bytes,
  measured at `:595-598`).
- fix: In `extractZip`, track a running `totalBytes` across `entry.getData()` results and throw past a
  budget (e.g. 500 MB), and reject archives with more than a few thousand entries. Prefer
  `entry.header.size` (the declared uncompressed size) for a cheap pre-check before decompressing
  anything.
- verify: unit test with a small high-ratio archive asserting a thrown "bundle too large" rather than
  an allocation.
- cross: @performance-reviewer
- effort: S

### [P2] Podcast source uploads land under the `podcasts/` public prefix, so private source documents are served without auth
- id: security-016
- location: podcast-saas/backend-api/src/controllers/v1/podcast.controller.ts:402
- category: security
- confidence: high
- status: confirmed
- what: The upload writes to `podcasts/{showId}/episodes/{epId}/sources/{ts}_{name}`. `podcasts/` is in
  `PUBLIC_LOCAL_PREFIXES` (`server.ts:253`), whose comment scopes the intent narrowly — "studio clips +
  render masters: immutable, public-URL-modeled" — but the prefix match is `key.startsWith(p)`, so the
  `sources/` subtree is covered too. In production the same keys live in the public Supabase bucket
  (`SupabaseStorageAdapter.ts:428`, see security-001), i.e. unauthenticated there as well.
- why: A podcast source is whatever the creator uploaded to brief the writers' room — a PDF, a
  contract, an internal doc. `GET /local-storage/podcasts/{showId}/episodes/{epId}/sources/…` returns it
  with no auth header at all. The show and episode ids are UUIDs so it is capability-only, but the
  ids are handed to the browser on every studio page load and end up in logs and history.
- evidence: Read `podcast.controller.ts:387-410`. Read `server.ts:250-283` — `isPublic` short-circuits
  the auth branch entirely for any key starting with `podcasts/`.
- fix: Move source uploads to a non-public prefix (`podcast-sources/{showId}/…`) and serve them through
  an owner-gated route, or narrow `PUBLIC_LOCAL_PREFIXES` to the exact subtrees intended
  (`podcasts/*/clips/`, `podcasts/*/renders/`) using a regex rather than a bare `startsWith`.
- verify: request a source key with no auth and assert 401/403.
- cross: @backend-reviewer
- effort: S

### [P3] `/api/v1/billing/access/:contentType/:contentId` leaks the title of any project or playlist by id
- id: security-017
- location: podcast-saas/backend-api/src/controllers/v1/billing.controller.ts:38
- category: security
- confidence: high
- status: confirmed
- what: The route is optional-auth and returns `pricing.title` (plus `accessType`, `priceCents`,
  `creatorUserId` comparison) for any valid `contentId`, with no visibility check. Every other read
  path in the app runs `requireProjectAccess`/`projectReadable` first (`player.controller.ts:39`) and
  404s to hide existence.
- why: An unauthenticated caller holding a project UUID — from a leaked URL, a log, a former
  collaborator — can confirm the project still exists and read its title and price even after it was
  made private. Small, but it is a deliberate exception to a rule the rest of the codebase follows.
- evidence: Read `billing.controller.ts:30-53` and compare `player.controller.ts:30-41`.
- fix: Load the row, run `projectReadable` (or the playlist equivalent) before answering, and 404
  otherwise; keep the paid stub shape for content the caller may see.
- verify: request the endpoint anonymously for a private project and assert 404.
- effort: S

### [P3] An anonymous viewer of a public project can trigger billable transcription
- id: security-018
- location: podcast-saas/backend-api/src/controllers/v1/player.controller.ts:96
- category: security
- confidence: medium
- status: confirmed
- what: `GET /api/v1/projects/:id/captions` is optional-auth (it must be, for share-link viewers) and
  calls `enqueueCaptionsForProject(projectId)` as a side effect of a **status read**. Captions run
  through Groq transcription (`services/captions/CaptionService.ts`), which is billable.
- why: The route is correctly access-gated, so the attacker must target a *public* project — but any
  public project is a free trigger. The neighbouring force-retry route at `:136-151` was already
  hardened for exactly this reason ("Existence probe alone allowed cross-tenant retries → IDOR + ffmpeg
  cost-DoS"); the same argument applies to the implicit enqueue here, just with a lower ceiling because
  the enqueue is not `force`.
- evidence: Read `player.controller.ts:72-99` and the comment at `:141-143`.
- fix: Only enqueue when the caller is the owner/collaborator (`request.dbUser` present and
  `editableProject` resolves); for anonymous viewers return the current status without side effects.
- verify: test that an anonymous GET against a public project with no captions does not call
  `enqueueCaptionsForProject`.
- cross: @billing-integrity-reviewer
- effort: S

### [P3] Agent prompt contradicts `stack.md`: four LLM providers vs three
- id: security-019
- location: .claude/reference/stack.md:70
- category: fleet
- confidence: high
- status: confirmed
- what: My dispatch prompt describes "four LLM providers". `stack.md` §2 states there are **three**
  (Anthropic, OpenAI, Google GenAI) and that Groq is speech-to-text only, with no `GroqProvider` and no
  membership in the LLM abstraction. Per PROTOCOL §0, `stack.md` wins and the contradiction is itself a
  finding.
- why: The v1 fleet incident this file exists to prevent was agents reasoning about the wrong engine.
  An agent that believes in a fourth provider will look for a `GroqProvider` in `services/llm/`, not
  find one, and either invent a finding or waste the budget.
- evidence: `ls backend-api/src/services/llm/` → `ClaudeProvider.ts`, `GeminiProvider.ts`,
  `OpenAIProvider.ts`, `LLMProvider.ts`, `LLMService.ts`, `ContentModerationService.ts`, `systemAi.ts`.
  No Groq provider. `stack.md:70-71` says exactly this.
- fix: Correct the `security-reviewer` agent prompt in `.claude/agents/` to say three LLM providers plus
  Groq for STT, matching `stack.md:70-71`.
- cross: @fleet-maintainer
- effort: S
