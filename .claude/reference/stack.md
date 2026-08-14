# FlowVid — Stack Ground Truth (SSOT)

> **Every agent in the fleet reads this file first.** It is the single source of truth for what
> this repo actually is. When an agent's own prompt disagrees with this file, **this file wins**
> and the agent must report the contradiction as a `fleet` finding.
>
> Why this file exists: the v1 fleet told its agents the backend was **Express over MySQL**. It is
> **Fastify over Postgres**. Every database and backend finding produced under that belief was
> reasoning about the wrong engine. Drift in the knowledge base is a *bug class*, so it gets a
> single owner file and an auditor (`fleet-maintainer`).
>
> **Last verified:** 2026-08-14 against `feat/agent-fleet-upgrade`.
> **How to re-verify:** run `fleet-maintainer`. Do not hand-edit facts without re-checking them.

---

## 1. Repository shape

Repo root is **`/Users/ofeklevy/cebu`** (git remote `github.com/0feklevy/cebu`). The application
is one directory below it.

```
cebu/                        ← repo root, and the cwd Claude Code runs in
├── .claude/                 ← the agent fleet (agents, review protocol, reference, hooks)
└── podcast-saas/            ← the actual application (pnpm workspace root)
    ├── backend-api/         ← Fastify API + queue worker
    ├── client-web/          ← Next.js viewer/editor
    ├── admin-web/           ← Next.js admin
    ├── shared/              ← shared types + hand-written API clients
    ├── ops/release/         ← release autopilot (deterministic audits)
    └── deploy/              ← Docker Compose + nginx + systemd
```

**Path rule for every agent:** all paths you cite are **relative to the repo root**, i.e.
`podcast-saas/backend-api/src/server.ts`, never `backend-api/src/server.ts`. A finding whose path
does not resolve from the repo root is an invalid finding.

**Command rule:** the pnpm workspace root is `podcast-saas/`, not the repo root. Always use `-C`:

```bash
pnpm -C podcast-saas --filter backend-api typecheck
pnpm -C podcast-saas --filter backend-api test        # vitest, single run
pnpm -C podcast-saas --filter client-web typecheck
pnpm -C podcast-saas --filter admin-web  typecheck
pnpm -C podcast-saas --filter shared     build
```

Workspace packages (`podcast-saas/pnpm-workspace.yaml`): `backend-api`, `client-web`, `admin-web`,
`shared`, `ops/release`. Package manager **pnpm@11.4.0**, Node **>=22** (local: v22.23.2).

---

## 2. The stack, as it actually is

| Layer | Reality | Common wrong belief |
|---|---|---|
| HTTP server | **Fastify 4** (`@fastify/cors`, `helmet`, `multipart`, `compress`) | ~~Express~~ |
| Routes | **Hand-registered `register*Routes(app)` functions**, not decorators | ~~TSOA controllers~~ |
| Database | **PostgreSQL** via `drizzle-orm/postgres-js` + `postgres` driver | ~~MySQL / mysql2~~ |
| Schema | `pg-core`: `pgTable`, `uuid`, `jsonb` (**52** tables, 145 uuid columns) | ~~utf8mb4, AUTO_INCREMENT~~ |
| Migrations | 58 forward `.sql` + 12 `.rollback.sql` + a commented-out `phase2-schema.sql` (71 files), **hardcoded ordered list** in `db/migrate.ts` | ~~drizzle-kit auto-apply~~ |
| Background jobs | **pg-boss 12** (`queue/pgBossDriver.ts`) + an inline driver for dev | ~~Trigger.dev~~ (dep present, check before asserting) |
| Auth | **Firebase Admin** (`middleware/firebase-auth.ts`) | — |
| Storage | R2 / Supabase-S3 adapters **plus a local-disk fallback** | — |
| Frontends | **Next.js 15.1 App Router**, React, Tailwind | — |
| API client | **Hand-written** `shared/src/generated/client-v1.ts` (dir is named `generated`, nothing generates it) | ~~codegen output~~ |
| Tests | **Vitest** (128 `*.test.ts` under `backend-api/src`, excluding `_archive/`) + **Playwright** (9 configs in client-web) | — |
| Deploy | **Docker Compose + nginx + systemd** on a VM (`podcast-saas/deploy/`) | ~~GoDaddy Node.js Hosting~~ |
| LLM providers | **Three**: Anthropic, OpenAI, Google GenAI (`services/llm/*Provider.ts`) | ~~Groq is a fourth LLM provider~~ |
| Speech-to-text | **Groq** (`groq-sdk`) — used only for transcription in `services/captions/CaptionService.ts` and `services/ingestion/AudioIngester.ts`. There is no `GroqProvider`; it is **not** part of the LLM abstraction. | — |

### Traps that have already produced wrong findings
- **`podcast-saas/CLAUDE.md` is stale boilerplate** describing GoDaddy Node.js Hosting with managed
  **MySQL** and `npm start`. It contradicts the real Docker/nginx/Postgres deployment. Treat it as
  untrusted; it is a known finding, not a source of truth.
- **`backend-api/tsoa.json` exists but nothing imports `tsoa`** — dead config plus a dead
  dependency. Do not infer a TSOA/OpenAPI pipeline from its presence.
- **Root `package.json` has `"generate": "pnpm --filter backend-api generate ..."` but
  `backend-api` defines no `generate` script** — the command cannot succeed.
- `podcast-saas/package.json` still carries the GoDaddy-era `"start": "node backend-api/dist/server.js"`
  and a `workspaces` array that duplicates the pnpm workspace file.

---

## 3. Subsystem map (and which agent owns each)

| Path (from repo root) | What it is | Owner agent |
|---|---|---|
| `podcast-saas/backend-api/src/server.ts` | Fastify bootstrap, route registration, local-storage serving | `backend-reviewer` |
| `.../src/controllers/v1/**` (27 files) | public API: projects, video, export, podcast*, simulations, share, billing, stripe-webhook … | `backend-reviewer` |
| `.../src/controllers/admin/v1/**` (7) | admin API: settings, system-prompts, llm-config, users, pipeline-stats | `backend-reviewer` + `security-reviewer` |
| `.../src/middleware/**` | `firebase-auth.ts`, `firebase-admin-required.ts`, `rate-limit.ts` | `security-reviewer` |
| `.../src/db/**` | `schema.ts`, `migrations/` (71 sql), `migrate.ts`, `backfill/`, `jsonb.ts` | `database-reviewer` |
| `.../src/queue/**` | pg-boss driver, inline driver, `registry.ts`, `startWorker.ts` | `job-queue-reviewer` |
| `.../src/jobs/**` | `corpus.ingest`, `video.generate`, `video.transcode` | `job-queue-reviewer` |
| `.../src/services/export/**` | `LinearAssembler`, `ffmpegGraph`, `exportPlan`, `capture/` | `media-pipeline-reviewer` |
| `.../src/services/{video,audio,captions,crop,avatarCircles}/**` | transcode, HLS, audio render, caption burn, crop, avatar circles | `media-pipeline-reviewer` |
| `.../src/services/simulation/**` + `shared/src/sim/**` | sim runtime, revisions, `SimBridgeContract`, RUM, guidance | `simulation-reviewer` |
| `.../src/services/llm/**` + `shared/src/prompts/**` | provider fan-out, prompt assembly, JSON repair | `llm-pipeline-reviewer` |
| `.../src/services/{billing,usage}/**` + `stripe-webhook.controller.ts` | Stripe, metering, entitlements | `billing-integrity-reviewer` |
| `.../src/services/storage/**` | R2 / Supabase adapters, `pathSafety.ts`, `serveFile.ts`, local fallback | `backend-reviewer` (correctness); `security-reviewer` owns containment/authz |
| `.../src/services/{project,course,avatar,ingestion,seo,secrets,security,video-generation}/**` | the remaining domain services — no specialist owns these, so they are **`backend-reviewer`**'s by default. Named explicitly because an unlisted directory is an unreviewed one. | `backend-reviewer` |
| `.../src/services/podcast/**` | split by concern: `prompts.ts`/`schemas.ts`/`scriptLint.ts`/`ScriptRoom.ts`/`runPodcastScript.ts` → `llm-pipeline-reviewer`; `audio/**` → `media-pipeline-reviewer`; everything else → `backend-reviewer` | (three-way, as listed) |
| `.../src/scripts/**` (31 backfill/audit scripts) | one-shot operational scripts; they touch production data, so they are reviewed for correctness and for destructive-by-default behaviour | `backend-reviewer` |
| `.../src/worker.ts` | dedicated worker entrypoint | `job-queue-reviewer` |
| `.../src/{lib,config}/**` | `logger` (pino), `sse.ts`, `fetchWithRetry` → `observability-reviewer`; `trustProxy.ts`, `publicOrigins.ts` → `config-deploy-reviewer` | (split, as listed) |
| `podcast-saas/client-web/**` | Next.js viewer/editor + 9 Playwright suites | `frontend-reviewer`, `ui-ux-reviewer` |
| `podcast-saas/admin-web/**` | Next.js admin | `frontend-reviewer`, `ui-ux-reviewer` |
| `podcast-saas/shared/**` | types, `csp.ts`, `generated/client-v1.ts`, `generated/admin-v1.ts` | `types-contracts-reviewer` |
| `podcast-saas/ops/release/**` | deterministic release audits + state machine | `release-auditor`, `migration-auditor` |
| `podcast-saas/deploy/**` | docker-compose, nginx, systemd | `config-deploy-reviewer` |
| `podcast-saas/**/package.json`, lockfile | dependencies, `allowBuilds` | `dependency-auditor` |

**Always excluded from every review:** `_archive/**`, `node_modules/**`, `dist/**`, `.next/**`,
`test-results/**`, `e2e-results/**`, `*.tsbuildinfo`.

---

## 4. Database facts

- Engine **PostgreSQL**. Reason in Postgres semantics: partial indexes **do exist**, `jsonb`
  operators and GIN indexes are available, `CHECK` constraints are enforced, `text` has no length
  penalty, and `CREATE INDEX CONCURRENTLY` **cannot run inside a transaction**.
- `db/migrate.ts` applies each `.sql` file as **one implicit transaction** and records the filename
  in `schema_migrations`. **The ordered file list is hardcoded in that file** — a new `.sql` that
  is not added to the list silently never runs. That divergence is what
  `ops/release/src/migration-audit.ts` reports as `migrations.not-in-runner` / `missing-file`.
  **Verified clean on 2026-08-14** (run `2026-08-13T2227`): all 58 forward migrations are present in
  the runner list, order matches filename sort, no drift in either direction. Re-check it anyway —
  it is cheap and the failure is silent.
- The runner records a migration as applied even when the file's transaction rolled back on a
  tolerated error code, so genuinely-new DDL in such a file is dropped and can never be retried
  (finding `database-003`, `migrate.ts:49`).
- Because each file is one transaction, `CREATE INDEX CONCURRENTLY` in a migration is a **CRITICAL**
  finding, not a nit.
- Policy is **expand/contract**: the previous app image must keep working after a migration, since
  it is the rollback target. There is **no automatic schema rollback**.
- 52 tables in total. These 32 are the ones most findings touch — the list is **not exhaustive**;
  branching, courses, sim revisions and `project_exports` are among the rest. Read `schema.ts`
  rather than trusting this list: `orgs users api_keys hosts projects corpora system_prompts
  admin_settings token_usage jobs audio_renders video_files simulations image_files audio_files
  timeline_sections timeline_markers video_generation_jobs playlists billing_transactions
  avatar_visuals avatar_conversations avatar_profiles podcast_shows podcast_episodes
  podcast_sources podcast_scripts podcast_chunk_audio podcast_renders podcast_clips podcast_mixes
  podcast_mix_snapshots`.

---

## 5. Configuration surface (names only — never open `.env`)

`podcast-saas/.env.example` is the only readable config file. Key groups, by name:

- **DB:** `DATABASE_URL`
- **Auth:** `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, and the
  `NEXT_PUBLIC_FIREBASE_*` browser keys
- **LLM:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`
- **Media/AI vendors:** `ANAM_*`, `ELEVENLABS_API_KEY`, `KLING_*`, `SEEDANCE_API_KEY`
- **Storage:** `STORAGE_BACKEND`, `SUPABASE_S3_*`, `SUPABASE_STORAGE_BUCKET`, `R2_*`
- **Billing:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_FEE_PERCENT`
- **Origins:** `BACKEND_API_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `PUBLIC_SITE_URL`
- **Crypto:** `ENCRYPTION_KEY`
- **Ops:** `PORT`, `NODE_ENV`, `LOG_LEVEL`, `ADMIN_EMAILS`, `NEXT_PUBLIC_ADMIN_BYPASS`

A **server** secret that appears under a `NEXT_PUBLIC_*` name is a P0 leak. `NEXT_PUBLIC_ADMIN_BYPASS`
is a browser-visible admin bypass flag — verify how production resolves it before assuming it is safe.

---

## 6. Known-sensitive areas (start here when scope is "the whole codebase")

1. **Local-storage serving** — `server.ts` serves media from disk; containment lives in
   `services/storage/pathSafety.ts` (`safeLocalPath`, `keyHasTraversal`). Any path that reaches the
   filesystem without passing through it is a traversal candidate.
2. **Export/capture pipeline** — `services/export/` spawns ffmpeg and drives a headless capture.
   Concurrency is bounded by `services/ffmpegLimit.ts`; verify every spawn path honours it.
3. **Stripe webhook** — `controllers/v1/stripe-webhook.controller.ts` must verify signatures on the
   **raw** body and be idempotent against replays.
4. **Simulation bridge** — `SimBridgeContract.ts` is a cross-boundary contract between backend,
   `shared/src/sim`, and sandboxed iframes; drift here fails silently at runtime.
5. **Contract drift** — `shared/src/generated/client-v1.ts` is hand-maintained; nothing regenerates
   it, so backend route changes do not break the build.
6. **LLM cost exposure** — unauthenticated or unmetered endpoints that reach a provider SDK.

---

## 7. What must never happen during a review

No `.env` reads. No commits, pushes, tags, or resets. No migrations, `psql`, or `db:studio`.
No dependency installs or codegen. No starting/stopping servers or containers. No remote/SSH.
These are enforced by `.claude/hooks/fleet-guard.mjs`, not merely requested.
