# CLAUDE.md — FlowVid

> **This file was wrong for a long time.** It described GoDaddy Node.js Hosting with a managed
> **MySQL** database, `npm start`, and "monorepos are not supported" — none of which is true of this
> project. Because tooling loads `CLAUDE.md` by default, that boilerplate was fed to every assistant
> that opened the repo, and produced confident advice about the wrong database engine, the wrong
> package manager and the wrong deployment model. Every fact below was verified against the source
> on 2026-08-16. If you change the stack, change this file in the same commit.

FlowVid turns source material into narrated video: a Next.js viewer and editor, a Fastify API, a
background worker, and a pipeline that renders interactive WebGL simulations into linear video.

---

## 1. Shape of the repository

The git root is one level **above** the application.

```
cebu/                        ← git root
├── .claude/                 ← agent fleet, review protocol, reference docs
└── podcast-saas/            ← the application, and the pnpm workspace root
    ├── backend-api/         ← Fastify API + queue worker
    ├── client-web/          ← Next.js viewer/editor
    ├── admin-web/           ← Next.js admin console
    ├── shared/              ← shared types, sim runtime contract, hand-written API clients
    ├── ops/release/         ← deterministic release audits
    ├── ops/ship/            ← ship conductor (drives the release workflows)
    └── deploy/              ← Docker Compose, nginx, systemd
```

**The pnpm workspace root is `podcast-saas/`, not the git root.** Every command needs `-C`:

```bash
pnpm -C podcast-saas --filter backend-api typecheck
pnpm -C podcast-saas --filter client-web  test
pnpm -C podcast-saas -r lint
```

Workspace members (`pnpm-workspace.yaml`): `backend-api`, `client-web`, `admin-web`, `shared`,
`ops/release`, `ops/ship`.

## 2. The stack

| Layer | What it actually is |
|---|---|
| Package manager | **pnpm 11.4.0**, Node **>= 22** |
| HTTP server | **Fastify 4** — routes are hand-registered `register*Routes(app)` functions |
| Database | **PostgreSQL** via `drizzle-orm/postgres-js` and the `postgres` driver |
| Schema | `pg-core` — `pgTable`, `uuid`, `jsonb`. 52 tables |
| Migrations | Plain `.sql` files applied by `backend-api/src/db/migrate.ts` from a **hardcoded ordered list** |
| Background jobs | **pg-boss 12**, plus an in-process inline driver for development |
| Auth | **Firebase Admin** |
| Storage | Cloudflare R2 / Supabase S3 adapters, with a local-disk fallback that is **refused in production** |
| Frontends | **Next.js 15.1 App Router**, React 19, Tailwind |
| Deployment | **Docker Compose + nginx + systemd** on a VM |

Three LLM providers — Anthropic, OpenAI, Google GenAI. `groq-sdk` is present but is **speech-to-text
only**; it is not part of the LLM abstraction.

## 3. Running it

```bash
pnpm -C podcast-saas install --frozen-lockfile
pnpm -C podcast-saas --filter shared build     # ← required before backend tests
pnpm -C podcast-saas dev                        # all packages in parallel
```

**Build `shared` first.** The backend resolves `shared` through its `dist/`, so on a fresh checkout
the backend test suite fails with module-resolution errors until `shared` has been built once. This
is the single most common false alarm in this repo.

## 3b. The decision ledger — every piece of work has to be findable

`.claude/review/DECISIONS.md` is the index of what is open, what was ruled, and what shipped;
closed rounds live in git history (the ledger's own commits), and the two approved-pending
feature designs live in `PARKED-DESIGNS.md` beside it. **Work that is not in the ledger
is work the next session cannot find**, and the failure is silent — nothing breaks, a green build says
nothing, and the item simply stops existing until someone stumbles over it.

That is not hypothetical. A completeness audit on 2026-08-21 found three live examples at once: two
user-visible production defects the owner had seen in their own browser and reported, recorded nowhere;
an open PR with a migration in it, invisible to the ledger; and two substantial reference documents a
reader of the ledger alone would not have known existed.

So, when finishing any unit of work:

- **Opening a PR?** Add a line to `DECISIONS.md` — what it is, and which round it belongs to. A CI-green
  branch nobody has indexed is not progress.
- **Found a bug you are not fixing right now?** It becomes a 🔴 entry with its evidence, not a memory.
  A prediction inside a planning document is not an open item — that is precisely how the R2 `frame-src`
  failure reached production after being correctly foreseen.
- **Delivered a document?** One line saying it exists.
- **Closed something?** Say WHICH KIND of closure it is. "Owner-attested" and "verified in code" are
  different claims, and a ledger that blurs them is worth less than one that admits the difference.
- **Contradicted an earlier entry?** Fix the earlier one in the same pass. The same file said crop P0.1
  was "absent" sixty lines below a section describing the day it ran.

The discipline is cheap — one line per item — and it is the only thing standing between a long session
and quietly losing half of it.

## 4. Verification

`pnpm -C podcast-saas release:verify` is the real gate, and it is what CI runs. Nine steps: frozen
install → build shared → typecheck → non-interactive lint → tests → clean `.next` → production
builds of both frontends with explicit public URLs → scan the bundles for localhost references.

Individually:

```bash
pnpm -C podcast-saas -r typecheck
pnpm -C podcast-saas -r lint
pnpm -C podcast-saas -r test
```

### Browser tests — read this before running any

`client-web` has nine Playwright configs. **Never run the bare `playwright test` or the
`test:smoke` script.** The default config has no `testMatch` and its base URL defaults to the live
production site, so the bare command collects every spec in `e2e/` and aims 363 tests at
production. Always name a config explicitly:

```bash
cd podcast-saas/client-web
npx playwright test -c playwright.sim.config.ts       --project=chromium
npx playwright test -c playwright.transport.config.ts --project=chromium
npx playwright test -c playwright.protocol.config.ts  --project=chromium
```

`playwright.production.config.ts` is the only one CI invokes, and it targets the deployed site
deliberately.

## 5. Things that will mislead you

- **`backend-api/tsoa.json` exists and nothing imports `tsoa`.** There is no TSOA/OpenAPI pipeline.
- **`shared/src/generated/` is hand-maintained.** Nothing generates `client-v1.ts` or `admin-v1.ts`,
  so a backend route change does not break the build. Contract drift is silent — check both sides.
- **The root `generate` script points at a script `backend-api` does not define.** It cannot succeed.
- **`podcast-saas/package.json` still carries a `workspaces` array** alongside `pnpm-workspace.yaml`,
  left over from an earlier setup. pnpm uses the yaml file.
- **A new `.sql` file that is not added to the ordered list in `migrate.ts` silently never runs.**
  The release engine's migration audit is what catches that.

## 6. Configuration

`podcast-saas/.env.example` documents the variable names. **Never open or print `.env` itself.**
Groups: `DATABASE_URL`; `FIREBASE_*` and the `NEXT_PUBLIC_FIREBASE_*` browser keys; `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`; `ANAM_*`, `ELEVENLABS_API_KEY`;
`STORAGE_BACKEND`, `R2_*`, `SUPABASE_S3_*`; `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`PLATFORM_FEE_PERCENT`; `BACKEND_API_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`,
`PUBLIC_SITE_URL`; `ENCRYPTION_KEY`; `PORT`, `NODE_ENV`, `LOG_LEVEL`, `ADMIN_EMAILS`.

A server secret appearing under a `NEXT_PUBLIC_*` name is a leak — those are compiled into the
browser bundle.

## 7. Safety rules that are not negotiable

- `DATABASE_URL` stays local. **Never** run migrations, seeds or resets against production.
- Never commit `.env`, and never print an environment value.
- Do not start, stop or deploy anything from a development machine.
- Local-disk storage is refused in production by an explicit guard; do not try to work around it.

---

*Deeper detail — the subsystem map, review protocol and known-sensitive areas — lives in
`../.claude/reference/stack.md`.*
