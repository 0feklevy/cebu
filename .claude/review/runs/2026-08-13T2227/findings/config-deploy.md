# config-deploy findings

Scope: `podcast-saas/deploy/**`, `backend-api/src/config/**`, `shared/src/csp.ts`,
`client-web/next.config.ts`, `admin-web/next.config.ts`, `client-web/middleware.ts`,
`podcast-saas/.env.example` (names only), `.github/workflows/**`, root + per-package
`package.json` scripts.

Method: mechanical `process.env.X` grep across `backend-api/src`, `client-web`, `admin-web`,
`shared/src` (production code only, `__tests__`/e2e/playwright-config directories excluded),
diffed against `podcast-saas/.env.example` names in both directions. Then read
`docker-compose.yml`, `nginx/nginx.conf`, `nginx/templates/app.conf.template`, `shared/src/csp.ts`,
`backend-api/src/config/{publicOrigins,trustProxy}.ts`, the three `next.config.ts`/`middleware.ts`
files, `.github/workflows/*.yml`, and `podcast-saas/package.json` end to end.

Verified clean (no finding filed): `TRUST_PROXY_HOPS` is a hardcoded `1` in
`backend-api/src/config/trustProxy.ts:28`, matching the documented single-nginx-hop topology in
`deploy/docker-compose.yml` — not an env var, so it cannot drift. `NEXT_PUBLIC_ADMIN_BYPASS` in
`admin-web/components/AdminGate.tsx:41-42` is correctly fail-closed (`NODE_ENV !== 'production'`
gates it unconditionally). `podcast-saas/.dockerignore` correctly excludes `.env`/`.env.*` (keeping
only `.env.example`) and all build output dirs — no build-contamination path found.
`shared/src/csp.ts` keeps `frame-src` and `frame-ancestors` correctly separated (the historical
bug class), and `backend-api/src/config/publicOrigins.ts` / `client-web/next.config.ts` /
`admin-web/next.config.ts` fail closed on missing/localhost/non-https `NEXT_PUBLIC_APP_URL` /
`NEXT_PUBLIC_API_URL` / `PUBLIC_SITE_URL` / `ADMIN_ORIGIN` in production.

---

### [P1] client-web's own BACKEND_API_URL resolution bypasses the fail-closed origin guard the codebase already built for this exact incident
- id: config-deploy-001
- location: podcast-saas/client-web/middleware.ts:16
- category: bug
- confidence: high
- status: confirmed
- what: `middleware.ts:16`, `app/[slug]/page.tsx:12`, and `lib/courseApi.ts:12-13` each
  independently compute `const BACKEND = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080')`.
  This is a hand-rolled duplicate of the origin-resolution problem that `next.config.ts`'s
  `resolvePublicUrl()` (lines 12-21) already solves with a fail-closed check (throws in production
  on missing/localhost/non-https). `BACKEND_API_URL` is not in `next.config.ts`'s `env: {}` block
  (only `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `PUBLIC_SITE_URL` are), so it is read raw
  from the container's runtime env in all three files with zero validation.
- why: If `BACKEND_API_URL` is ever set to a bad value in the client-web container (e.g. a stale
  `http://localhost:8080` copied from a dev `.env`, or simply left unset while `NEXT_PUBLIC_API_URL`
  is empty for some reason), none of the three call sites throw a clear config error the way
  `publicOrigins.ts`'s `assertPublicOriginsForProd()` or `next.config.ts` do. `lib/courseApi.ts`'s
  `getPage()` (line 24) has no try/catch around its `fetch()`, so an empty-string `BACKEND` — the
  literal production fallback when both vars are unset — produces `fetch('/api/v1/public/courses/...')`,
  which Node's fetch rejects with "Failed to parse URL", an uncaught exception that surfaces as a
  500 on every `/c/*` page. `middleware.ts` and `app/[slug]/page.tsx` do catch the fetch, so they
  degrade silently instead (course/lesson redirects and permalinks just stop resolving, with no
  error surfaced anywhere) — the "silently misbehaves" half of the same bug.
- evidence: Read `podcast-saas/client-web/next.config.ts:12-27` (the validated pattern) against
  `podcast-saas/client-web/middleware.ts:16`, `podcast-saas/client-web/app/[slug]/page.tsx:12,26`,
  `podcast-saas/client-web/lib/courseApi.ts:12-13,24` (the three bypasses). `BACKEND_API_URL` does
  not appear in `next.config.ts`'s `env:` block (lines 63-67) or in `podcast-saas/.env.example`.
- fix: Export a validated `BACKEND_ORIGIN` from `next.config.ts` (or a small shared module) using
  the same `resolvePublicUrl`-style fail-closed check, and import it in all three files instead of
  re-deriving `process.env.BACKEND_API_URL` locally. At minimum, wrap `courseApi.ts`'s `getPage()`
  fetch in the same try/catch pattern already used in `middleware.ts` and `app/[slug]/page.tsx`.
- verify: set `BACKEND_API_URL=http://localhost:9`(unreachable) with `NODE_ENV=production` locally
  and confirm `getPage()` degrades instead of throwing; `pnpm -C podcast-saas --filter client-web typecheck`
  stays clean.
- cross: none
- effort: S

### [P1] nginx's upload ceiling and the backend's upload ceiling are two different env vars, in two different units, never cross-checked, and nginx's default is smaller
- id: config-deploy-002
- location: podcast-saas/deploy/nginx/templates/app.conf.template:47
- category: bug
- confidence: high
- status: confirmed
- what: The backend gates video uploads on `MAX_UPLOAD_BYTES` (`backend-api/src/controllers/v1/video.controller.ts:39`, `Number(process.env.MAX_UPLOAD_BYTES) || TEN_GB` — defaults to 10 GB,
  `video.controller.ts:27`), and its own user-facing error message advertises "the maximum is 10 GB"
  when unset. nginx gates the same request on a completely different variable, `MAX_UPLOAD_SIZE`
  (a size string like `2g`, not bytes), templated into every vhost's `client_max_body_size` at
  `deploy/nginx/templates/app.conf.template:47,69,91`, defaulting to `2g` both at
  `deploy/docker-compose.yml:176` (`MAX_UPLOAD_SIZE:-2g`) and `deploy/.env.example:72`
  (`MAX_UPLOAD_SIZE=2g`). Neither `MAX_UPLOAD_BYTES` nor `MAX_UPLOAD_SIZE` appears in
  `podcast-saas/.env.example`; there is no assertion anywhere that the two agree.
- why: With both left at their defaults (the common case — neither is documented in the main
  `.env.example` a deploy operator reads), any upload between 2 GB and 10 GB is rejected by nginx
  with a bare 413 before the request ever reaches the backend, even though the backend's own logic
  and its error copy both say 10 GB is fine. This is exactly the class of "config says X, nginx
  enforces Y" drift the brief calls out, just on upload size instead of body/proxy timeouts.
- evidence: Read `video.controller.ts:27,39,213,215,286,288` for the 10 GB backend ceiling; read
  `deploy/nginx/nginx.conf:26-28` (2g safety default, comment confirms the real limit comes from
  envsubst), `deploy/nginx/templates/app.conf.template:47,69,91`, `deploy/docker-compose.yml:176`,
  `deploy/.env.example:72`. Confirmed `MAX_UPLOAD_BYTES` has zero occurrences in either
  `podcast-saas/.env.example` or `deploy/.env.example`.
- fix: Either drive both limits from one source (have the backend read `MAX_UPLOAD_SIZE` and parse
  the size string, or have the deploy env set `MAX_UPLOAD_SIZE` to a value that is provably ≥ the
  backend's `MAX_UPLOAD_BYTES` default), and document both names — with a note that they must stay
  in sync — in the relevant `.env.example` file(s).
- verify: attempt a 3 GB upload against a build with both defaults active; confirm today it 413s at
  nginx, then confirm it succeeds after the fix.
- cross: none
- effort: S

### [P1] AVATAR_MEMORY_SECRET is undocumented and its absence silently reuses DATABASE_URL as an HMAC signing key
- id: config-deploy-003
- location: podcast-saas/backend-api/src/services/avatar/memoryToken.ts:20
- category: bug
- confidence: high
- status: confirmed
- what: `return process.env.AVATAR_MEMORY_SECRET || process.env.DATABASE_URL || 'insecure-dev-only-secret';`
  — the HMAC key for avatar memory tokens has a three-step fallback: a dedicated secret, then the
  database connection string, then a hardcoded literal. `AVATAR_MEMORY_SECRET` appears nowhere in
  `podcast-saas/.env.example`, so there is nothing prompting an operator to set it.
- why: If `AVATAR_MEMORY_SECRET` is never set (the likely case, since it is undocumented), every
  avatar-memory token in production is HMAC-signed with the Postgres connection string — a value
  with a different rotation policy, different exposure surface (connection strings show up in
  logs, monitoring dashboards, orchestration tooling) than a value chosen to be a signing key. This
  is a silent, no-error-message fallback to the wrong thing in production, precisely the pattern
  the brief asks to check for.
- evidence: Read `memoryToken.ts:15-20`; grepped `podcast-saas/.env.example` for
  `AVATAR_MEMORY_SECRET` — no match.
- fix: Document `AVATAR_MEMORY_SECRET` in `podcast-saas/.env.example` as required, and add a
  `isProd()` fail-fast assertion (mirroring `publicOrigins.ts`'s `assertPublicOriginsForProd`) so a
  production boot without it fails loudly instead of quietly deriving a key from the DB URL.
- verify: unset `AVATAR_MEMORY_SECRET` with `NODE_ENV=production` and confirm boot now throws
  instead of falling through.
- cross: @security (secret-reuse / weak key derivation is their column; filed here because the
  fix is an env-contract + fail-fast change)
- effort: S

### [P1] podcast-saas/CLAUDE.md still documents a GoDaddy Node.js Hosting / managed-MySQL deployment that does not exist
- id: config-deploy-004
- location: podcast-saas/CLAUDE.md:1
- category: maintainability
- confidence: high
- status: confirmed
- what: The entire file describes deploying to "Node.js Hosting" (GoDaddy) with `npm start`,
  automatic SSL/CDN, and a managed MySQL database read via `DB_HOST`/`DB_PORT`/`DB_USER`/
  `DB_PASSWORD`/`DB_NAME` and the `mysql2` driver. Re-verified against the real deploy surface:
  `deploy/docker-compose.yml` (Docker Compose + nginx + systemd, 5 services), `deploy/systemd/podcast-saas.service`
  (`docker compose ... up -d`), and `deploy/docker-compose.yml:19-21` explicitly documenting an
  external Supabase Postgres via `DATABASE_URL` — no MySQL, no GoDaddy, no `npm start` boot path
  anywhere in the real deploy.
- why: This file is read as project context by every human and every agent (including this fleet)
  working on the repo. Its instructions are actively wrong for this deployment — e.g. "the platform
  handles SSL/CDN automatically" (false; `certbot` + nginx TLS termination is hand-rolled in
  `deploy/`), "managed MySQL... `mysql2` driver" (false; Postgres via `drizzle-orm/postgres-js`),
  "single application per upload, monorepos not supported" (false; this is a 4-package pnpm
  monorepo deployed as one stack). An agent trusting this file will reason about the wrong
  database engine and the wrong deploy mechanism, which `.claude/reference/stack.md` calls out by
  name as the exact failure mode a prior fleet run produced.
- evidence: Read the full `podcast-saas/CLAUDE.md`; cross-read `deploy/docker-compose.yml`,
  `deploy/systemd/podcast-saas.service`, `deploy/nginx/nginx.conf`, `.claude/reference/stack.md:68,72-74`.
  All confirm the same contradiction independently.
- fix: Replace `podcast-saas/CLAUDE.md` with a short, accurate description of the Docker
  Compose + nginx + systemd + Postgres/Supabase deployment (or point it at `.claude/reference/stack.md`
  and `deploy/README.md` instead of duplicating stale platform docs).
- verify: none needed beyond the read above — this is a documentation-only fix; confirm the
  replacement text matches `deploy/docker-compose.yml` service names and `DATABASE_URL` usage.
- cross: @fleet-maintainer (agent/knowledge-base drift is their column; flagging here per this
  agent's explicit brief to re-confirm and file it)
- effort: S

### [P2] Production CSP allows 'unsafe-inline' and 'unsafe-eval' in script-src unconditionally
- id: config-deploy-005
- location: podcast-saas/shared/src/csp.ts:109
- category: security
- confidence: high
- status: confirmed
- what: `"script-src 'self' 'unsafe-inline' 'unsafe-eval' https:" + (dev ? ' http:' : '')` — the
  `dev` ternary only adds `http:` in development; `'unsafe-inline'` and `'unsafe-eval'` are present
  in every environment, including the production policy served by both `client-web/next.config.ts`
  and `admin-web/next.config.ts` (`dev: !IS_PROD`).
- why: `'unsafe-inline'` and `'unsafe-eval'` in `script-src` remove most of CSP's XSS
  defense-in-depth value — any injected inline `<script>` or `eval()`'d string runs regardless of
  origin allow-listing. Unlike `style-src` (where `'unsafe-inline'` is a common, often-necessary
  Next.js/Tailwind concession, also present here), `script-src` is the directive this defense
  exists to protect. There is no comment in `csp.ts` explaining why `'unsafe-eval'` specifically is
  required in production (Next.js hydration typically needs `'unsafe-inline'` without a nonce
  setup, but not `'unsafe-eval'`).
- evidence: Read `shared/src/csp.ts:82-116` in full; the `dev` flag is threaded through `img-src`,
  `media-src`, `connect-src` for the localhost-only additions but is not used to gate
  `'unsafe-eval'`/`'unsafe-inline'` in `script-src`.
- fix: Determine whether any dependency (Firebase SDK, Stripe.js, Anam SDK) actually requires
  `'unsafe-eval'` in production; if not, drop it from the production policy. If `'unsafe-inline'`
  is required for Next.js's inline hydration script, consider a nonce-based CSP instead (Next.js
  supports this via middleware) to keep script-src meaningfully restrictive.
- verify: remove `'unsafe-eval'` from a local production build and confirm no console CSP
  violations on the core auth/checkout/sim-embed flows before shipping the change.
- cross: @security
- effort: M

### [P2] Two-thirds of client-web's Playwright suites are never invoked by anything
- id: config-deploy-006
- location: .github/workflows/ci.yml:1
- category: test
- confidence: high
- status: confirmed
- what: `client-web` has 9 Playwright configs: `playwright.config.ts`,
  `playwright.{canary,leak,production,protocol,rebuilt,sim,transport,viewer}.config.ts`. Grepped
  every workflow under `.github/workflows/` and every script in `podcast-saas/package.json` /
  `podcast-saas/client-web/package.json` for references to the 7 non-production, non-default
  configs (`canary`, `leak`, `protocol`, `rebuilt`, `sim`, `transport`, `viewer`) — zero matches
  anywhere. `client-web`'s `test` script (`vitest run`) never touches Playwright at all;
  `test:smoke` (`playwright test`, the bare default config) is likewise never invoked by any
  workflow. The only config ever run is `playwright.production.config.ts`, and only in
  `release.yml:436`, `rollback.yml:166`, and `production-audit.yml:170,229` — all post-deploy
  smoke checks against the live site.
- why: `ci.yml`'s `release-verify` job runs `pnpm release:verify`, whose test step
  (`deploy/scripts/release-verify.sh:105`) is `pnpm -r test` — vitest only. So on every PR, none
  of canary/leak/protocol/rebuilt/sim/transport/viewer ever execute. Whatever these suites test
  (adversarial variant rollout, cross-cycle leak detection, protocol conformance, foreign-transport
  handling, sim-pool behavior, viewer e2e) currently provides zero signal to anyone, on any event —
  they are indistinguishable from deleted files as far as the pipeline is concerned.
- evidence: `grep -rl` for each config name across `.github/workflows/*.yml`,
  `podcast-saas/package.json`, `podcast-saas/deploy/**` returned no matches. Read
  `podcast-saas/client-web/package.json`'s `scripts` block (`test: vitest run`,
  `test:smoke: playwright test`) and `deploy/scripts/release-verify.sh:104-105`
  (`pnpm -r test`) directly.
- fix: Either wire the remaining 7 configs into `ci.yml` (or a scheduled workflow, if they need
  real infra) or delete them if they are superseded — a suite nobody runs is worse than no suite,
  because it looks like coverage that does not exist.
- verify: n/a (informational; the fix is a CI/ownership decision for test-quality-reviewer).
- cross: @test-quality (Playwright suite health/coverage is their column; filed here because the
  underlying fact — what CI actually invokes — is `.github/workflows/**`, this agent's scope)
- effort: M

### [P2] Root "generate" script cannot succeed
- id: config-deploy-007
- location: podcast-saas/package.json:19
- category: maintainability
- confidence: high
- status: confirmed
- what: `"generate": "pnpm --filter backend-api generate && pnpm --filter shared build"`.
  `backend-api/package.json`'s `scripts` object has no `generate` entry (confirmed by reading it in
  full: dev, dev:worker, build, start, worker, db:migrate, db:check, verify:storage,
  backfill:storage, backfill:urls, videos:audit, sims:reinject-gates, sims:backfill-ack,
  duplication:diagnose, db:studio, typecheck, test, test:watch, test:coverage, lint — no `generate`).
- why: `pnpm --filter backend-api generate` fails with "Missing script: generate" before the
  `&&` ever reaches the `shared` build. Anyone (human or agent) running `pnpm generate` from the
  workspace root gets an immediate, confusing failure. This is `.claude/reference/stack.md`'s
  known trap, re-confirmed live in this run rather than taken on faith.
- evidence: Read `podcast-saas/package.json:19` and the full `scripts` block of
  `podcast-saas/backend-api/package.json`.
- fix: Either add a `generate` script to `backend-api/package.json` (if something real used to
  live there — check `tsoa.json`, also flagged as dead config in `stack.md`) or delete the root
  `generate` script entirely.
- verify: `pnpm -C podcast-saas generate` should exit non-zero today; re-run after the fix to
  confirm it either succeeds or the dead script is gone.
- cross: none
- effort: S

### [P3] podcast-saas/package.json still carries GoDaddy-era "start" and an npm "workspaces" array beside the pnpm workspace file, and the array is itself stale
- id: config-deploy-008
- location: podcast-saas/package.json:14
- category: maintainability
- confidence: high
- status: confirmed
- what: `"start": "node backend-api/dist/server.js"` at line 14 and `"workspaces": ["shared",
  "backend-api", "client-web", "admin-web"]` at line 6 both duplicate/predate
  `podcast-saas/pnpm-workspace.yaml` (pnpm ignores npm's `workspaces` field entirely). Neither is
  referenced by the real deploy: `deploy/docker/backend.Dockerfile`'s `CMD ["node", "dist/server.js"]`
  runs from its own `WORKDIR /app/backend-api` inside the image, never through this root script;
  `deploy/systemd/podcast-saas.service` invokes `docker compose ... up -d`, never `npm start`.
  Grepped every workflow and deploy script for `npm start`/`"start"` invocations at the root —
  none. The `workspaces` array is also out of date on its own terms: per
  `.claude/reference/stack.md:48`, the pnpm workspace now includes `ops/release` as a 5th member,
  which the leftover array does not list.
- why: Low risk (nothing invokes either), but it is exactly the kind of leftover
  `.claude/reference/stack.md` was written to warn agents about — a plausible-looking script that
  is not the real boot path, next to a workspace declaration nothing consults and that has already
  drifted from the file that actually governs the workspace.
- evidence: Read `podcast-saas/package.json:1-20`; `deploy/docker/backend.Dockerfile` (CMD line);
  `deploy/systemd/podcast-saas.service:18-19`; `podcast-saas/pnpm-workspace.yaml`.
- fix: Delete the `workspaces` array and the `start` script (or repoint `start` at something real,
  if a bare-metal fallback boot path is ever wanted).
- verify: n/a — deletion only; confirm `pnpm -C podcast-saas -r ...` commands are unaffected
  (they read `pnpm-workspace.yaml`, not this field).
- cross: none
- effort: S

### [P2] Stripe publishable-key env var has two different names on two sides of the same feature, and neither side is fully documented or consumed
- id: config-deploy-009
- location: podcast-saas/backend-api/src/controllers/v1/billing.controller.ts:24
- category: bug
- confidence: medium
- status: confirmed
- what: `podcast-saas/.env.example:103` documents `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — a name
  implying it is meant to be baked into the browser bundle at build time, the way every other
  `NEXT_PUBLIC_*` var in this repo is (via `next.config.ts`'s `env:` block). Nothing reads that
  exact name anywhere in `backend-api`, `client-web`, or `admin-web` (checked non-test source).
  The backend instead reads a differently-named, undocumented var, `STRIPE_PUBLISHABLE_KEY`
  (no `NEXT_PUBLIC_` prefix), and returns it as a JSON field from `GET /api/v1/billing/status`
  (`billing.controller.ts:24`). That `publishableKey` field, in turn, has zero matches anywhere in
  `client-web`'s app/lib/components — nothing consumes what the backend serves either.
- why: Both directions of the env-contract drift the brief asks for, on the same conceptual value:
  a documented var nothing reads (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`), and a var the code reads
  that is undocumented (`STRIPE_PUBLISHABLE_KEY`) whose only consumer is an API field nothing on
  the frontend appears to use. Either the checkout flow does not actually need a client-visible
  publishable key (plausible if it is a server-created Stripe Checkout redirect, which would make
  both vars vestigial) or the frontend integration reading it was never finished/was removed and
  left the backend field behind — worth a deliberate check by whoever owns billing, since right now
  this reads as dead config in both places rather than a working feature.
- evidence: `grep -rn 'STRIPE_PUBLISHABLE_KEY'` across `backend-api/src`, `client-web`,
  `admin-web`, `shared/src` (non-test) → only `billing.controller.ts:24`.
  `grep -rn 'publishableKey|loadStripe'` across `client-web/app`, `client-web/lib`,
  `client-web/components` (non-test) → zero matches.
- fix: Pick one name and one flow deliberately: if Checkout is server-redirect-only, delete both
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` from `.env.example` and the dead `publishableKey` field from
  the API response; if a client-side Stripe.js integration is intended, document
  `STRIPE_PUBLISHABLE_KEY` (or rename to match `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and bake it via
  `next.config.ts` like every other public var) and wire it into the frontend.
- verify: n/a — a product decision, not purely mechanical; @billing-integrity is better placed to
  confirm which checkout flow is actually live.
- cross: @billing-integrity
- effort: S

### [P2] nginx starts routing to backend/client-web/admin-web before they are health-checked healthy
- id: config-deploy-010
- location: podcast-saas/deploy/docker-compose.yml:184
- category: bug
- confidence: medium
- status: confirmed
- what: `client-web` and `admin-web` correctly use the long-form `depends_on: { backend: { condition: service_healthy } }`
  (lines 115-117, 151-153) so they wait for the backend's `/health` healthcheck. `nginx`'s
  `depends_on` (lines 184-187) uses the short array form — `[backend, client-web, admin-web]` —
  which Docker Compose treats as `condition: service_started` (the default), not
  `service_healthy`.
- why: `deploy/systemd/podcast-saas.service:18` runs `docker compose --env-file .env -f
  docker-compose.yml up -d` directly on every VM boot/reboot, with no external health-gating step
  (that only exists in `deploy-images.sh`'s release path per `podcast-saas/ops/release/PLAN.md`).
  On a bare reboot, nginx can render its config and start accepting traffic on 80/443 while
  backend/client-web/admin-web are still inside their `start_period` (40s/30s/30s) — real user
  requests during that window get a 502 from nginx rather than being held until upstreams are
  actually ready. This is a narrower instance of the "ordering" concern the brief names directly
  (hunt item 7: "a unit that starts before the database"), one hop further down the chain.
- evidence: Read `deploy/docker-compose.yml:115-117` and `:151-153` (the correct pattern) against
  `:184-187` (the gap); `deploy/systemd/podcast-saas.service:18` (the boot path with no external
  health gate).
- fix: Change nginx's `depends_on` to the long form with `condition: service_healthy` for all
  three upstreams, matching the pattern already used elsewhere in this same file.
- verify: `docker compose up -d` from a cold state and confirm (via `docker compose ps`) nginx
  waits for `healthy` status on backend/client-web/admin-web before it is created/started.
- cross: none
- effort: S

### [P2] LINEAR_EXPORT_ENABLED — the kill switch for the just-merged linear video export feature — is undocumented
- id: config-deploy-011
- location: podcast-saas/backend-api/src/controllers/v1/export.controller.ts:33
- category: bug
- confidence: high
- status: confirmed
- what: `const exportEnabled = (): boolean => process.env.LINEAR_EXPORT_ENABLED === 'true';` — any
  value other than the exact string `'true'` (including unset) makes `export.controller.ts:74`
  answer every export request with a 404 ("export: refused — LINEAR_EXPORT_ENABLED is off").
  `LINEAR_EXPORT_ENABLED` is not in `podcast-saas/.env.example` or `deploy/.env.example`.
- why: This is a deliberately fail-closed default (safe), but the git history on this branch shows
  the linear-video-export feature was merged recently (`cce4225 Merge pull request #20 from
  0feklevy/feat/linear-video-export`). Without this var documented anywhere an operator would
  read, a deploy of this code with no explicit action silently ships the entire export feature
  disabled, and the 404 gives no hint that a flag — not a bug — is the cause. This is the "silent
  misbehavior from an undocumented required var" pattern from hunt item 1, just presenting as a
  disabled feature rather than a crash.
- evidence: Read `export.controller.ts:33,74`; grepped `LINEAR_EXPORT_ENABLED` against both
  `.env.example` files — no match in either.
- fix: Add `LINEAR_EXPORT_ENABLED` to `podcast-saas/.env.example` with a comment stating it must be
  `true` for the export feature to serve any requests, and set it explicitly in
  `deploy/docker-compose.yml`'s `backend`/`worker` `environment:` blocks so it is not left to an
  operator to notice.
- verify: n/a — documentation/config change.
- cross: @media-pipeline (owns export correctness; filed here as an env-contract gap)
- effort: S

### [P2] Broad env-contract drift: ~35 vars the code reads that podcast-saas/.env.example never documents
- id: config-deploy-012
- location: podcast-saas/.env.example:1
- category: maintainability
- confidence: high
- status: confirmed
- what: Mechanical diff of every `process.env.X` in `backend-api/src`, `client-web`, `admin-web`,
  `shared/src` (production code, tests/e2e excluded) against `podcast-saas/.env.example`'s
  documented names. Beyond the vars already filed individually above
  (`AVATAR_MEMORY_SECRET`, `LINEAR_EXPORT_ENABLED`), the undocumented set includes, by theme:
  - **Storage/queue:** `LOCAL_STORAGE_DIR` (`services/storage/localStoragePaths.ts:18`),
    `QUEUE_DATABASE_URL` (`queue/pgBoss.ts:31`, falls back to `DATABASE_URL` — sensible default,
    lowest risk of this group), `QUEUE_DRIVER`, `QUEUE_PGBOSS_LISTEN/MAX/SCHEMA`.
  - **Concurrency knobs (all have safe numeric fallbacks, low risk but still undocumented):**
    `FFMPEG_CONCURRENCY` (`services/ffmpegLimit.ts:8`, default 2), `VIDEO_GEN_CONCURRENCY`
    (`jobs/video.generate.ts:184`, default 2), `QUEUE_CROP_CONCURRENCY`
    (`queue/pgBossDriver.ts:18`, default 2).
  - **Captions engine (fails fast, not silent — see CaptionService.ts:107-111 — but the whole
    engine-selection surface is undocumented):** `CAPTIONS_ENGINE`, `CAPTIONS_GROQ_MODEL`,
    `WHISPER_CPP_MODEL`, `WHISPER_MODEL_PATH`, `WHISPER_CPP_{BIN,LANGUAGE,THREADS}`,
    `WHISPER_{BIN,LANGUAGE}`.
  - **Feature/encode toggles:** `HLS_REAL_ENCODE`, `EXPORT_REAL_ENCODE`, `HLS_RETIRE_GRACE_HOURS`,
    `MAX_UPLOAD_BYTES` (see config-deploy-002).
  - **Model selection:** `GOOGLE_IMAGE_MODEL`, `OPENAI_IMAGE_MODEL`, `SEO_MODEL`.
  - **Simulation runtime tuning:** `SIM_ADAPTIVE_QUALITY`, `SIM_BOUNDARY_SENTINEL`,
    `SIM_POOL_MODE`, `SIM_RUM_SAMPLE_RATE`, `SIM_SCHEDULER_MODE`, `SIM_TRANSITION_COORDINATOR`.
  - **Origins:** `ADMIN_ORIGIN` (`publicOrigins.ts:70` — has a real production security role,
    validated for non-public-host if present, but nothing tells an operator it exists or that it
    is optional-but-recommended).
  - **Podcast pipeline:** `PODCAST_PASS_TIMEOUT_MS`, `PODCAST_TEMPO`, `PODCAST_TTS_FORMAT`.
  - **Misc:** `WORKER_INLINE` (set explicitly in `deploy/docker-compose.yml:39` for the `backend`
    service, so at least its production value is pinned even though it is undocumented),
    `PROJECT_DUPLICATE_MAX_BYTES`, `ALLOW_PRODUCTION_DATA_SEEDER` (a deliberately awkward
    fail-safe gate on a DO-NOT-USE script — low risk by design).
- why: Individually most of these are low-risk (sane numeric/off defaults, or fail fast like
  captions), but collectively `.env.example` is missing roughly a third of what the running system
  actually reads, which defeats its purpose as the "what do I need to set" reference for a new
  deploy or a new engineer, and makes it impossible to eyeball-audit the env contract the way this
  finding just had to do mechanically.
- evidence: Full diff performed via `comm -23` between a sorted set of every `process.env.X` name
  found by grep across the four packages' production source and the sorted set of names in
  `podcast-saas/.env.example`; file:line spot-checked for every var named above.
- fix: Add each var to `podcast-saas/.env.example` with its default and a one-line purpose comment,
  grouped by theme as above; this is a documentation change, not a behavior change, for every var
  in this finding except the three filed individually with their own fixes.
- verify: n/a — documentation completeness; re-run the same `comm -23` diff after the edit and
  confirm the "required but undocumented" side shrinks to the deliberately-excluded set (test/e2e
  vars, Next.js/Vercel internals).
- cross: none
- effort: M

### [P1] The pinned ffmpeg-8 base image deprecated an option the podcast audio mixer still uses — a self-documented, unactioned gap from the same incident this image pin exists to fix
- id: config-deploy-014
- location: podcast-saas/backend-api/src/services/podcast/audio/ffmpegAudio.ts:179
- category: bug
- confidence: high
- status: confirmed
- what: `deploy/docker/backend.Dockerfile:44-52` pins a static `ffmpeg-n8.1` build for every
  pipeline sharing this image (transcode, captions, crop, export, AND podcast audio) — the exact
  fix for the prior incident (`3631479 fix(deploy): pin static ffmpeg 8 in the backend image —
  bookworm's 5.1 broke export assembly`). The linear-export pipeline was built against that pinned
  8.1 binary and explicitly avoids `-filter_complex_script`, replacing it with `-/filter_complex`
  because (per `LinearAssembler.ts:8-10` and `md-files/LINEAR-VIDEO-EXPORT-PLAN.md:653-655`)
  `-filter_complex_script` is **[measured]** deprecated on ffmpeg 8 — measured against this same
  pinned build, not a theoretical concern. A source-scanning test
  (`export/__tests__/ffmpegGraph.test.ts:66-75`) bans that spelling from `ffmpegGraph.ts`,
  `LinearAssembler.ts`, and `resolvePlan.ts` specifically so it can never regress there. But the
  podcast audio mixer, `ffmpegAudio.ts:176-179` (`mixTimeline`, invoked by every
  `podcast_render`/`podcast_mix_export` job via `registry.ts`), still writes its filter graph with
  `-filter_complex_script` — the plan doc says so explicitly: "`ffmpegAudio.ts:179` uses the old
  spelling today" (`md-files/LINEAR-VIDEO-EXPORT-PLAN.md:654`). This is a task the team already
  wrote down and did not action, not a new discovery — surfacing it here because it is exactly
  this agent's territory (base-image ffmpeg version vs. what a pipeline actually invokes) and it
  sits right next to the fix for the closely-related prior incident.
- why: Every podcast render/mix-export job runs against the SAME pinned ffmpeg 8.1 build the export
  pipeline was rewritten to avoid this exact option on. If ffmpeg 8 actually rejects (rather than
  merely warns on) `-filter_complex_script`, every podcast render silently fails deep inside a
  multi-minute encode — the plan doc's own words for why the export pipeline was told to "probe
  filter availability at job start and fail fast — otherwise this fails late, inside a multi-minute
  encode." I could not execute ffmpeg in this review to confirm reject-vs-warn myself (no state
  mutation / no running builds is a hard rule for this review), so this is filed on the strength of
  the repository's own measured claim and its own unresolved TODO comment, not independent
  verification.
- evidence: Read `deploy/docker/backend.Dockerfile:44-52` (the pin, shared by all pipelines);
  `backend-api/src/services/export/LinearAssembler.ts:8-10`; `backend-api/src/services/export/__tests__/ffmpegGraph.test.ts:61-75`
  (the ban, scoped to export modules only); `backend-api/src/services/podcast/audio/ffmpegAudio.ts:176-179`
  (the unconverted call site); `md-files/LINEAR-VIDEO-EXPORT-PLAN.md:652-655` (the team's own
  measurement and acknowledgment that `ffmpegAudio.ts:179` was not yet updated). Confirmed via
  `registry.ts:24-31` that `podcast_render`/`podcast_mix_export` jobs run on the same shared
  backend/worker image as the export pipeline.
- fix: Convert `ffmpegAudio.ts:179` from `-filter_complex_script <path>` to `-/filter_complex
  <path>` (mirroring `LinearAssembler.ts`'s resolved approach), and consider widening the
  `ffmpegGraph.test.ts` banned-spelling scan to include `podcast/audio/ffmpegAudio.ts` so this
  cannot silently reappear.
- verify: run a podcast render job against the actual pinned `ffmpeg-n8.1` binary (not covered by
  this review's constraints) and confirm `-filter_complex_script` succeeds vs. fails before
  deciding urgency; if it fails, this is P0, not P1.
- cross: @media-pipeline (responding to their signal in signals.md; ffmpeg graph correctness is
  their column — filed here because the root cause is the shared base-image pin, this agent's
  column, and the fix is one option-spelling change they are better placed to make safely)
- effort: S

### [P3] Documented-but-dead vars, including a Trigger.dev config surface for an integration that is not actually wired in
- id: config-deploy-013
- location: podcast-saas/.env.example:111
- category: maintainability
- confidence: high
- status: confirmed
- what: Four documented vars have zero readers anywhere in production source
  (`backend-api/src`, `client-web`, `admin-web`, `shared/src`, non-test): `ADMIN_API_URL`
  (`.env.example:136`, defaulted to `http://localhost:8080` in the example itself — a placeholder
  that would be actively wrong if anything ever did read it), `PROJECT_ID` (`.env.example:126`),
  `TRIGGER_SECRET_KEY` (`.env.example:111`), `TRIGGER_API_URL` (`.env.example:112`). For the
  Trigger.dev pair specifically: `@trigger.dev/sdk`'s `task()` is imported in
  `backend-api/src/jobs/{corpus.ingest,video.generate,video.transcode}.ts`, but
  `backend-api/src/queue/registry.ts` — the actual job dispatch table this run confirmed by
  reading it — wires `video_generate` to `runVideoGenerateLimited` (a plain exported function, not
  invoked through Trigger.dev's runtime) and every other job to a plain service function. Nothing
  in `server.ts`/`worker.ts`/`registry.ts` registers or boots a Trigger.dev client, and
  `TRIGGER_API_URL`/`TRIGGER_SECRET_KEY` are read nowhere. This confirms, rather than just
  flags, `.claude/reference/stack.md:62`'s open question ("Trigger.dev (dep present, check before
  asserting)") — the dependency and its env vars are leftover from a prior architecture; pg-boss is
  what actually runs jobs.
- why: Dead config misleads a deploy operator into thinking these are things to configure, and (for
  Trigger.dev specifically) misleads a future contributor into thinking there is a working
  Trigger.dev integration to build on.
- evidence: `grep -rn` for each name across all four packages' non-test source, zero matches beyond
  the `.env.example` line itself. Read `backend-api/src/queue/registry.ts:1-40` in full — no
  Trigger.dev client construction or `.trigger()` call anywhere in the dispatch path.
- fix: Remove `ADMIN_API_URL`, `PROJECT_ID`, `TRIGGER_SECRET_KEY`, `TRIGGER_API_URL` from
  `podcast-saas/.env.example`, and remove `@trigger.dev/sdk` from `backend-api/package.json` plus
  the `task()` wrappers in the three job files if pg-boss is the intended permanent architecture
  (or file a `job-queue-reviewer` finding if the intent is actually to finish the Trigger.dev
  migration).
- verify: n/a — deletion only; `pnpm -C podcast-saas --filter backend-api typecheck` should stay
  clean after removing the `@trigger.dev/sdk` imports if that path is taken.
- cross: @job-queue (registry/worker lifecycle is their column; the dead-dependency angle also
  applies to @dependency-auditor)
- effort: S
