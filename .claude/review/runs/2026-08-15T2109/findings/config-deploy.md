# config-deploy findings

Scope: `podcast-saas/deploy/**`, `backend-api/src/config/{trustProxy,publicOrigins}.ts`,
`shared/src/csp.ts`, `client-web/next.config.ts`, `admin-web/next.config.ts`,
`client-web/middleware.ts`, `.env.example` (names only), `.github/workflows/**`, package.json
scripts. Commit `2d187e3` (main).

---

### [P1] The one route that actually streams upload bytes through nginx admits up to 10 GB; nginx's documented default rejects anything over 2 GB first
- id: config-001
- location: podcast-saas/backend-api/src/controllers/v1/video.controller.ts:133
- category: bug
- confidence: high
- status: confirmed
- what: `POST /api/v1/projects/:id/videos/upload` (used live by `VideoUploader.tsx:143` and
  `SectionEditor.tsx:1098`) sets `bodyLimit: TEN_GB` and streams multipart file parts with
  `limits: { fileSize: TEN_GB }` (video.controller.ts:27,39,133,143). That request goes through
  nginx's `api.<domain>` server block. `client_max_body_size` there is templated from
  `${MAX_UPLOAD_SIZE}` (nginx/templates/app.conf.template:69), which docker-compose.yml:176
  and deploy/.env.example default to `2g`. `MAX_UPLOAD_BYTES` (the backend's own advertised
  ceiling, video.controller.ts:39) is not referenced anywhere in deploy/.env.example,
  docker-compose.yml, or the nginx template, so there is no config wiring that keeps the two
  numbers in sync.
- why: Any operator who deploys with the documented default (`MAX_UPLOAD_SIZE=2g`, the only
  value shown in deploy/.env.example) will have nginx return 413 for any upload between 2 GB
  and 10 GB on this exact route, before the request reaches Fastify at all — even though the
  backend's own bodyLimit/fileSize ceiling advertises 10 GB and the presigned/multipart-to-cloud
  paths (upload-url, multipart/start) exist specifically to route around a single-PUT size cap.
  A user uploading a 4K/long-form video over this legacy streaming path gets an opaque nginx 413
  with none of the app's friendly `humanBytes()` messaging (video.controller.ts:213-215).
- evidence: Read video.controller.ts:27-39 and 130-193 (route registration, bodyLimit, parts
  limit); read deploy/docker-compose.yml:176 (`MAX_UPLOAD_SIZE: ${MAX_UPLOAD_SIZE:-2g}`); read
  deploy/.env.example (`MAX_UPLOAD_SIZE=2g` under `---- NGINX ----`); read
  deploy/nginx/templates/app.conf.template:69 (`client_max_body_size ${MAX_UPLOAD_SIZE};` on the
  api server block); read deploy/nginx/nginx.conf:28 (global default is also 2g). Confirmed the
  route is live via `grep -rn "videos/upload\b" client-web/components/VideoUploader.tsx
  client-web/components/SectionEditor.tsx`.
- fix: Either raise the documented `MAX_UPLOAD_SIZE` default (deploy/.env.example and
  docker-compose.yml:176) to match `TEN_GB` (e.g. `11g` to allow for multipart overhead), or —
  better — lower `bodyLimit`/`MAX_UPLOAD_BYTES` on this route to something nginx is actually
  configured to pass at the documented default, and add a one-line comment on both sides
  pointing at each other so the two numbers can't drift silently again.
- verify: set `MAX_UPLOAD_SIZE=2g` (the documented default), attempt a >2 GB upload through
  `POST /api/v1/projects/:id/videos/upload` against a local nginx+backend compose stack, and
  confirm today it 413s before the fileSize check in video.controller.ts ever runs.
- effort: S

---

### [P2] DATABASE_URL / QUEUE_DATABASE_URL have no boot-time fail-fast assertion; both silently fall back to a hardcoded local connection string
- id: config-002
- location: podcast-saas/backend-api/src/db/index.ts:6-7
- category: maintainability
- confidence: high
- status: confirmed
- what: `db/index.ts:6-7` and `db/migrate.ts:11` both resolve the connection string as
  `process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas'`.
  `queue/pgBoss.ts:38-44` does the same with `QUEUE_DATABASE_URL ?? DATABASE_URL ?? <same
  localhost literal>`. Unlike `BACKEND_API_URL`/`NEXT_PUBLIC_APP_URL` — which have an explicit
  `assertPublicOriginsForProd()` boot check (publicOrigins.ts:96-120, called from
  server.ts:616 and worker.ts:21) — there is no equivalent `NODE_ENV === 'production' &&
  !process.env.DATABASE_URL` guard anywhere in server.ts/worker.ts.
- why: The repo already has, and enforces, the "fail closed on a missing required origin"
  pattern for browser-visible URLs (publicOrigins.ts's own header comment describes exactly this
  class of incident). DATABASE_URL is the single most load-bearing required var in
  `.env.example`'s config surface and gets no analogous guard: if `env_file: ../.env`
  (docker-compose.yml:32,68) is ever pointed at a `.env` missing `DATABASE_URL` — e.g. a typo in
  the key name, or a `.env` that was regenerated without it — the container starts, and
  `checkDatabaseConnection()` (server.ts:624-629) deliberately only warns ("will retry on first
  request"), so the operator sees a generic connection-refused/timeout against
  `localhost:5432` from inside a container with no local Postgres, not a clear
  "DATABASE_URL is required" message.
- evidence: Read db/index.ts:1-20, db/migrate.ts:1-15, queue/pgBoss.ts:38-53, and
  server.ts:606-629 end to end; no `DATABASE_URL` presence check exists alongside the
  `ENCRYPTION_KEY` one at server.ts:609.
- fix: Add a `NODE_ENV === 'production' && !process.env.DATABASE_URL` fail-fast next to the
  existing `ENCRYPTION_KEY` check at server.ts:609-612 (and worker.ts), and drop the localhost
  literal fallback from db/index.ts / db/migrate.ts / pgBoss.ts in production so a
  misconfiguration is a clear boot-time error instead of a cryptic runtime connection failure.
- verify: unset `DATABASE_URL` in a `NODE_ENV=production` run; today the process starts and
  logs a warning; after the fix it should exit non-zero with a clear message.
- effort: S

---

### [P2] backend/worker containers have no cpus/mem_limit despite running ffmpeg, on the same host that already had an OOM incident
- id: config-003
- location: podcast-saas/deploy/docker-compose.yml:24-86
- category: perf
- confidence: high
- status: confirmed
- what: The `backend` and `worker` service definitions (docker-compose.yml:24-86) — the two
  services that run ffmpeg/transcode/export-assembly work (`FFMPEG_CONCURRENCY`,
  `VIDEO_GEN_CONCURRENCY`, `QUEUE_CROP_CONCURRENCY` all default to 2 concurrent jobs; see
  `ffmpegLimit.ts:8`, `jobs/video.generate.ts:184`, `queue/pgBossDriver.ts:18`) — set no
  `mem_limit`, `memswap_limit`, `cpus`, or `pids_limit`. Contrast with
  `docker-compose.export-worker.yml:47-50`, the isolated capture container, which sets
  `mem_limit: 2048m`, `memswap_limit: 2048m`, `cpus: 2`, `pids_limit: 256` explicitly.
- why: `queue/pgBoss.ts:17-20` documents that "the 2026-08-13 incident was the kernel
  OOM-killing the API container mid-assembly, taking every in-flight request down with it" —
  the fix applied was moving `project_export` off the web tier onto the dedicated `worker`
  service. That mitigates blast radius (web requests survive), but the `worker` container itself
  still has no memory ceiling, so an ffmpeg assembly that runs away can still trigger the
  kernel's system-wide OOM killer, which picks victims across ALL containers on the host
  (nginx, backend, admin-web included) rather than being contained to one cgroup. The
  export-worker compose file proves the team already knows how to set these limits; the two
  services that actually run the concurrent ffmpeg work in steady state do not have them.
- evidence: Read docker-compose.yml:24-86 (no resource keys on backend/worker) vs
  docker-compose.export-worker.yml:47-50 (explicit limits); read the incident comment at
  queue/pgBoss.ts:17-20; read ffmpegLimit.ts:8 for the concurrency default.
- fix: Add `mem_limit`/`memswap_limit`/`cpus` to the `backend` and `worker` service blocks in
  docker-compose.yml, sized to the VM (the export-worker file's 2 GB/2 CPU pattern is a
  reasonable starting point), so a runaway encode is contained to its own cgroup instead of
  becoming a host-wide OOM event.
- effort: S

---

### [P3] LINEAR_EXPORT_ENABLED gates the export endpoint but is undocumented anywhere in the deploy config surface
- id: config-004
- location: podcast-saas/backend-api/src/controllers/v1/export.controller.ts:33
- category: maintainability
- confidence: high
- status: confirmed
- what: `exportEnabled()` gates the whole export controller on
  `process.env.LINEAR_EXPORT_ENABLED === 'true'` (export.controller.ts:33), 404-ing every export
  request when unset (line 74). This var appears in neither `podcast-saas/.env.example` nor
  `deploy/docker-compose.yml`'s `backend`/`worker` `environment:` blocks — every other
  browser/feature-relevant var those blocks carry (`STORAGE_BACKEND`, `BACKEND_API_URL`, etc.)
  is explicit there.
- why: An operator following `.env.example` (the only documented config surface, per its own
  header) has no way to discover this flag exists, so a production deploy silently ships with
  linear video export permanently off unless someone happens to know the undocumented name.
  Given this is a currently-active feature area (Linear Video Export capture pipeline), that is
  either an intentional kill-switch state that should say so in `.env.example`, or a
  deploy-readiness gap.
- evidence: `grep -rn LINEAR_EXPORT_ENABLED podcast-saas` matches only export.controller.ts:33,74
  and its own test file; confirmed absent from `.env.example` and `docker-compose.yml`'s
  `environment:` blocks by full read of both files.
- fix: Add `LINEAR_EXPORT_ENABLED` to `.env.example` with a comment on what it gates, and add it
  (with the intended production value) to `docker-compose.yml`'s backend/worker `environment:`
  blocks the same way `STORAGE_BACKEND` is pinned there.
- effort: S

---

### [P2] CI (`ci.yml`) never runs Playwright; 8 of the 9 client-web Playwright configs never run in any GitHub workflow
- id: config-005
- location: .github/workflows/ci.yml:1-169
- category: test
- confidence: high
- status: confirmed
- what: `ci.yml` has two jobs, `release-verify` (runs `pnpm release:verify`, which is frozen
  install → typecheck → lint → `pnpm -r test` (vitest only) → prod builds → bundle-localhost
  scan — see `deploy/scripts/release-verify.sh:87-122`) and `static-audits` (secret scan,
  migration audit, Dockerfile lint, two incident-regression greps). Neither invokes `playwright`
  anywhere. Of client-web's 9 Playwright configs (`playwright.{config,canary,leak,production,
  protocol,rebuilt,sim,transport,viewer}.config.ts`), only `playwright.production.config.ts` is
  ever invoked by any workflow, and only against a live deployed site inside
  `release.yml:416-436`, `rollback.yml:160-166`, and `production-audit.yml:164-256` — i.e. after
  a deploy has already happened, not as a PR gate.
- why: A suite that exists but never runs in CI provides no signal, per this fleet's own review
  standard. The other 8 configs (canary/leak/protocol/rebuilt/sim/transport/viewer + the plain
  local `playwright.config.ts` behind `client-web`'s `test:smoke` script) can silently bit-rot —
  a regression in, say, the sim-pool or transport suites would not be caught by any PR or `main`
  push, only ever surfaced if someone runs them by hand.
- evidence: `grep -n playwright .github/workflows/ci.yml` returns nothing; `grep -rn playwright
  .github/workflows/*.yml` shows only production.config.ts references in release/rollback/
  production-audit; `find client-web -maxdepth 1 -iname "playwright*.config.ts"` lists 9 files;
  `deploy/scripts/release-verify.sh` step 5/9 is `pnpm -r test` (vitest), not Playwright.
- fix: Either add a CI job that runs the non-production Playwright configs (against a local/dev
  stack) on PRs, or, if some of the 8 are intentionally hand-run diagnostic tools rather than
  regression suites, say so in each config's header comment so the gap is a documented decision
  rather than an accidental one.
- cross: test-quality
- effort: M

---

### [P3] AVATAR_MEMORY_SECRET is undocumented and falls back to DATABASE_URL, then to a hardcoded dev string, with no production fail-fast
- id: config-006
- location: podcast-saas/backend-api/src/services/avatar/memoryToken.ts:20
- category: security
- confidence: medium
- status: confirmed
- what: `return process.env.AVATAR_MEMORY_SECRET || process.env.DATABASE_URL || 'insecure-dev-only-secret';`
  is the HMAC key for avatar memory tokens. `AVATAR_MEMORY_SECRET` does not appear in
  `.env.example` at all, and there is no `NODE_ENV === 'production'` guard analogous to the
  `ENCRYPTION_KEY` check at server.ts:609.
- why: Reusing `DATABASE_URL` as an HMAC key is unusual (a connection string is not a secret
  chosen for keying strength, and it's shared with a different security boundary), and the final
  fallback is a literal string checked into source. If `AVATAR_MEMORY_SECRET` is simply never
  set — plausible, since it's not in `.env.example` for an operator to discover — production
  runs on the `DATABASE_URL`-derived key, silently, forever. Confidence is medium because I did
  not trace what the token actually authorizes/how exploitable a forged token is (that call is
  `security-reviewer`'s column); the config-contract gap itself (undocumented, no fail-fast) is
  confirmed.
- evidence: Read memoryToken.ts:1-25 in full; `grep -n AVATAR_MEMORY_SECRET podcast-saas/.env.example`
  returns nothing.
- fix: Add `AVATAR_MEMORY_SECRET` to `.env.example`, and add a production fail-fast next to the
  `ENCRYPTION_KEY` check at server.ts:609 rather than silently keying off `DATABASE_URL`.
- cross: security
- effort: S

---

### [P3] .env.example documents `ADMIN_API_URL`, which nothing reads; the var actually consumed is `ADMIN_ORIGIN`, which .env.example never mentions
- id: config-007
- location: podcast-saas/.env.example
- category: maintainability
- confidence: high
- status: confirmed
- what: `.env.example`'s "App URLs" section documents `ADMIN_API_URL=http://localhost:8080`.
  `grep -rn "process\.env\.ADMIN_API_URL"` across all four packages returns zero matches — dead
  documentation. The var `publicOrigins.ts` actually reads for the admin origin is
  `ADMIN_ORIGIN` (publicOrigins.ts:14,70,110-111), which is not in `.env.example` at all (it is
  set only inside docker-compose.yml:46 as `ADMIN_ORIGIN: https://${DOMAIN_ADMIN}`, which is why
  the compose path itself is unaffected).
  Also confirmed `TRIGGER_SECRET_KEY` / `TRIGGER_API_URL` in the same file are dead in the same
  way — the `@trigger.dev/sdk` dependency is present (backend-api/package.json:38) but nothing
  reads either env var.
- why: An operator reading `.env.example` (the only documented config surface) to run the
  backend outside the provided compose file (e.g. bare-process debugging, a different
  orchestrator, or simply trying to understand what controls the admin origin) would set the
  wrong name and get no effect, while the real name is nowhere to be found. This is exactly the
  "both directions" env-contract drift the review flagged as the highest-yield check.
- evidence: `grep -n "ADMIN_API_URL"` in publicOrigins.ts / server.ts / any controller: no
  matches. `grep -n "ADMIN_ORIGIN"` in .env.example: no matches. `grep -n
  "process\.env\.TRIGGER_(SECRET_KEY|API_URL)"` across backend-api/client-web/admin-web/shared:
  no matches.
- fix: Delete the dead `ADMIN_API_URL`, `TRIGGER_SECRET_KEY`, `TRIGGER_API_URL` lines from
  `.env.example` (or wire them up if they were meant to do something), and add `ADMIN_ORIGIN`
  with the same doc comment publicOrigins.ts:14 already has.
- effort: S

---

### [P2] Root package.json's "generate" script calls a script backend-api does not define
- id: config-008
- location: podcast-saas/package.json:15
- category: bug
- confidence: high
- status: confirmed
- what: `"generate": "pnpm --filter backend-api generate && pnpm --filter shared build"`.
  `backend-api/package.json`'s `scripts` block (dev, dev:worker, build, start, worker, db:migrate,
  db:check, verify:storage, backfill:storage, backfill:urls, videos:audit, sims:reinject-gates,
  sims:backfill-ack, duplication:diagnose, db:studio, typecheck, test, test:watch, test:coverage,
  lint) contains no `generate` entry.
- why: `pnpm run generate` from the repo root cannot succeed — pnpm exits non-zero immediately
  because `backend-api` has no matching script. This is dead/broken tooling that anyone
  discovering it from `package.json` will hit on the first try.
- evidence: Read backend-api/package.json's full `scripts` block; no `generate` key present.
- fix: Remove the root `"generate"` script, or replace it with whatever it was meant to invoke
  (there is no `tsoa`/codegen pipeline in this repo per stack.md — `shared/src/generated/*` is
  hand-maintained — so the honest fix is likely deletion).
- effort: S

---

### [P3] Root package.json still carries GoDaddy-era `main`/`start` and a duplicate `workspaces` array beside `pnpm-workspace.yaml`; `build` mixes npm workspace syntax into a pnpm-pinned repo
- id: config-009
- location: podcast-saas/package.json:4-13
- category: maintainability
- confidence: high
- status: confirmed
- what: `package.json:4` sets `"main": "backend-api/dist/server.js"`, `:6-11` declares a
  `"workspaces": ["shared","backend-api","client-web","admin-web"]` array (missing `ops/release`
  and `ops/ship`, which the real `pnpm-workspace.yaml` at the repo root includes), `:13` runs
  `"start": "node backend-api/dist/server.js"`, and `:14` defines `"build": "npm run build -w
  shared && npm run build -w backend-api && ..."` using `npm`'s `-w` workspace flag even though
  `packageManager: "pnpm@11.4.0"` (line 26) pins pnpm and the lockfile is `pnpm-lock.yaml`.
- why: This is the exact leftover stack.md calls out as a known trap from the prior single-app
  GoDaddy Node.js Hosting deployment model — none of it is used by the real Docker/pnpm build
  path (`deploy/docker/backend.Dockerfile` runs `pnpm --filter backend-api build`, not
  `npm run build -w backend-api`), so it actively misleads anyone reading `package.json` as the
  source of truth for how this repo builds/starts, and the `workspaces` array can drift out of
  sync with `pnpm-workspace.yaml` (it already has, missing the two `ops/*` packages) without any
  build breaking, since pnpm never reads it.
- evidence: Read package.json in full; compared `workspaces` to `pnpm-workspace.yaml`'s package
  list (stack.md:49) — `ops/release`/`ops/ship` present in the pnpm file, absent from the npm
  array. Confirmed backend.Dockerfile and web.Dockerfile invoke `pnpm --filter … build`
  exclusively, never `npm run … -w …`.
- fix: Delete `main`, `start`, and the `workspaces` array; rewrite `build` as
  `pnpm --filter shared build && pnpm --filter backend-api build && pnpm --filter client-web
  build && pnpm --filter admin-web build` (or `pnpm -r build`) to match how the repo is actually
  built and match `stack.md`'s documented commands.
- effort: S

---

### [P3] backend-api/tsoa.json still exists; nothing imports tsoa
- id: config-010
- location: podcast-saas/backend-api/tsoa.json:1
- category: maintainability
- confidence: high
- status: confirmed
- what: The file exists at `backend-api/tsoa.json`. `grep -rn "from 'tsoa'|require('tsoa')|@tsoa"`
  across `backend-api/src` returns no imports, and routes are hand-registered
  `register*Routes(app)` functions per stack.md, not TSOA-decorated controllers.
- why: Confirms stack.md's documented trap is still present in the tree — dead config plus (per
  `dependency-auditor`'s column) presumably a dead dependency, left over from a codegen approach
  this repo does not use. Anyone inferring an OpenAPI/TSOA pipeline from this file's presence
  will be wrong.
- evidence: `find podcast-saas/backend-api -maxdepth 2 -iname tsoa.json` → exists;
  `grep -rln "tsoa" podcast-saas/backend-api/src` → no matches outside the config file itself.
- fix: Delete `backend-api/tsoa.json` (and the `tsoa` dependency, if present — flagged to
  `dependency-auditor`) unless a TSOA migration is actually planned, in which case say so in a
  comment.
- cross: dependency-auditor
- effort: S

---

### [P3] podcast-saas/CLAUDE.md still describes GoDaddy Node.js Hosting + managed MySQL — confirmed still contradicts the real deploy
- id: config-011
- location: podcast-saas/CLAUDE.md:1
- category: fleet
- confidence: high
- status: confirmed
- what: The file's entire content (read in full) describes deploying to "Node.js Hosting, a
  managed Node.js PaaS", a required root `package.json` `"start"` script, `PORT`-based binding,
  no Docker/CI, and a "Database (Managed MySQL)" section with `DB_HOST`/`DB_PORT`/`DB_USER` env
  vars and `mysql2` examples. The real deploy is Docker Compose + nginx + systemd on a VM
  (`podcast-saas/deploy/**`, this review's own scope), and the real database is PostgreSQL via
  `drizzle-orm/postgres-js` (`DATABASE_URL`, no `DB_HOST`/`DB_PORT`/`DB_USER`/`mysql2` anywhere
  in the codebase).
- why: `.claude/reference/stack.md:74-76` already names this file as a known-stale trap that
  produced wrong findings under the v1 fleet. I re-read the file in full for this run (rather
  than trusting the reference doc's earlier snapshot) and confirm it is unchanged — still 100%
  GoDaddy/MySQL content, zero mention of Docker/nginx/Postgres/systemd. It remains live in the
  repo at the path Claude Code auto-loads as project context, so any assistant session that
  reads it without also reading stack.md will reason about the wrong deployment target and the
  wrong database engine.
- evidence: Full read of podcast-saas/CLAUDE.md (all sections: Platform Overview, Deployment
  Flow, package.json requirements, Port Binding, Database (Managed MySQL) with `mysql2` code
  sample, Pre-Upload Checklist). Cross-checked against deploy/docker-compose.yml (Docker Compose
  + nginx, no PaaS) and backend-api's Postgres/drizzle stack (stack.md:60-61, confirmed via
  `db/index.ts`'s `drizzle-orm/postgres-js` import).
- fix: Replace podcast-saas/CLAUDE.md with content describing the actual stack (Fastify/Postgres/
  Docker Compose/nginx/systemd), or delete it and rely on `.claude/reference/stack.md` as the
  single source of truth, with a short pointer file if Claude Code's project-context convention
  requires something at that path.
- cross: fleet-maintainer
- effort: S

---

### [P2] Production CSP unconditionally allows 'unsafe-inline' and 'unsafe-eval' in script-src, plus a broad "https: wss:" connect-src
- id: config-012
- location: podcast-saas/shared/src/csp.ts:109
- category: security
- confidence: medium
- status: confirmed
- what: `buildFrontendCsp` emits
  `"script-src 'self' 'unsafe-inline' 'unsafe-eval' https:" + (dev ? ' http:' : '')` (csp.ts:109)
  — `'unsafe-inline'` and `'unsafe-eval'` are present regardless of the `dev` flag, i.e. also in
  the production policy served by both `client-web/next.config.ts` and
  `admin-web/next.config.ts` (both call `buildFrontendCsp` with `dev: !IS_PROD`, which only
  toggles the `http:`/localhost additions, not the unsafe-* tokens). `connect-src` (csp.ts:114)
  is `'self' https: wss:` in production — any HTTPS/WSS origin, not an allow-list.
- why: `'unsafe-inline'` on script-src defeats CSP's core script-injection mitigation (it's
  equivalent to no script-src restriction for inline `<script>`/event-handler payloads), and
  `'unsafe-eval'` additionally permits `eval()`/`new Function()`-based execution. Combined with a
  `connect-src` that allows fetch/XHR/WebSocket to any HTTPS or WSS origin, a successful XSS in
  either frontend would be able to both execute arbitrary injected script and exfiltrate data to
  an attacker-controlled HTTPS endpoint — the CSP provides frame/object/base-uri hardening but
  very little script-injection mitigation in production. Confidence is medium because I did not
  verify whether removing `'unsafe-inline'`/`'unsafe-eval'` is currently blocked by a genuine
  Next.js/third-party-SDK requirement (nonce-based CSP is the standard fix but requires wiring
  through `next.config.ts`/middleware that isn't present here) — that verification belongs with
  whoever owns the frontend bundle.
- evidence: Read shared/src/csp.ts:82-116 in full; confirmed `dev` only gates the `http:`/
  localhost additions on lines 85,97,109,113,114, never the `'unsafe-inline'`/`'unsafe-eval'`
  tokens themselves; confirmed both next.config.ts files pass `dev: !IS_PROD` and no other
  script-src override.
- fix: Investigate whether Next.js's built-in nonce/strict-dynamic CSP support
  (`experimental.strictNextHead` / manual nonce middleware) can replace `'unsafe-inline'` for
  script-src; short of that, at minimum narrow `connect-src` from `https: wss:` to the specific
  origins the app actually calls (API origin, Firebase, Stripe, Anam, Supabase) the way
  `frame-src` already does.
- cross: security
- effort: L

---

## Scope covered, no defect found

- **Trust proxy** (`backend-api/src/config/trustProxy.ts`): `TRUST_PROXY_HOPS = 1` matches the
  actual topology — nginx is the only container binding host ports in
  `deploy/docker-compose.yml` (`ports: ['80:80','443:443']` on `nginx` only; backend/worker/
  client-web/admin-web are unpublished on the `edge`/`internal` networks), and nginx's
  `X-Forwarded-For: $proxy_add_x_forwarded_for` (nginx.conf:50) appends rather than trusts the
  caller's header, so `trustProxy: 1` (server.ts:182) correctly selects the entry nginx appended.
  No CDN/ALB is in front per the compose topology as written.
- **CSP frame-src vs frame-ancestors**: correctly kept separate (csp.ts:5-7,92-100,107) —
  `frame-ancestors 'none'` is unconditional and never widened; `frame-src` is built from the
  validated API origin + optional Stripe/Firebase-auth origins only, no wildcards.
- **Firebase auth CSP incident class**: `firebaseAuthFrameOrigin` and `authEmulatorOrigin`
  (csp.ts:44-79) both parse-then-rebuild from `URL`, rejecting userinfo/credential injection —
  this is the exact bug class (naive `.split(':')` on an authority string) the header comment
  warns about, and it's handled correctly.
- **Browser-visible localhost incident class**: `publicOrigins.ts` (`assertPublicOriginsForProd`,
  called from server.ts:616 and worker.ts:21) and both `next.config.ts` files
  (`resolvePublicUrl`, fail-closed on missing/localhost/non-https in a production build) both
  correctly fail closed. `.dockerignore` (podcast-saas/.dockerignore) excludes `.env`/`.env.*`/
  `.local-storage` from every image build context, and `deploy/scripts/release-verify.sh`
  explicitly moves `.env.local` files aside before a release build.
- **STORAGE_BACKEND=local in production**: explicitly refused (`getStorageAdapter.ts`), a past
  incident already fixed and regression-guarded.
- **ffmpeg version pin**: `backend.Dockerfile:45-62` pins a static ffmpeg ≥8 build with an
  explicit comment about the ffmpeg-5.1-vs-`/filter_complex` incident; already fixed, not
  re-filed.
- **Certbot one-off vs renewal-loop entrypoint**: `init-ssl.sh` already uses
  `compose run --rm --entrypoint certbot certbot certonly …` (the correct form); CI
  (`ci.yml:154-160`) has a regression grep for this. Not re-filed.
- **nginx timeouts vs SSE**: `SSEEmitter.keepAlive()` (backend-api/src/lib/sse.ts:15-21) writes
  every 15s, well inside nginx's 300s `proxy_read_timeout` (nginx.conf:34), which resets on any
  byte received — no timeout mismatch found for the SSE paths (`sections.controller.ts`,
  `simulations.controller.ts`).
