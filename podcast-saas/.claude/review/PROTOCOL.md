# Review Swarm — Shared Protocol

This file is the contract every review agent follows. It is how agents coordinate
**without talking directly**: each agent writes structured findings into a shared run
directory, and the orchestrator reads, merges, deduplicates, and routes them.

## Run directory layout

The orchestrator creates one run directory per review:

```
.claude/review/runs/<run-id>/          # run-id = UTC timestamp, e.g. 2026-06-26T1913
├── MANIFEST.md                         # orchestrator: scope, agents dispatched, status
├── findings/
│   ├── backend.md                      # one file per reviewer (domain name)
│   ├── frontend.md
│   ├── ui-ux.md
│   ├── database.md
│   ├── security.md
│   ├── performance.md
│   ├── types-contracts.md
│   └── test-quality.md
├── signals.md                          # cross-agent handoffs (append-only, see below)
├── REPORT.md                           # orchestrator: final merged + prioritized report
└── FIX_PLAN.md                         # orchestrator: ordered, safe-to-apply fixes
```

Every reviewer is **given its exact `OUTPUT_DIR` and `findings` file path** in its spawn
prompt. Do not guess the run-id — use the path you were handed.

## Finding format (strict)

Append each finding to your `findings/<domain>.md` file using exactly this block:

```
### [P1] Unawaited storage write can silently drop uploads
- id: backend-007
- location: backend-api/src/services/storage/uploadStreamWithFallback.ts:42
- category: bug            # bug | security | perf | ux | a11y | types | test | maintainability | data-integrity
- confidence: high         # high | medium | low
- what: Promise from adapter.put() is not awaited inside the fallback branch.
- why: On R2 failure the local write races the HTTP response; client gets 200 before bytes land.
- fix: `await` the fallback write and surface failures; add a unit test for the failure path.
- cross: @frontend @test-quality   # omit if none
- effort: S              # S (<15m) | M | L
```

### Severity scale
- **P0** — broken in production, data loss, auth bypass, or security-critical. Fix now.
- **P1** — real bug or vulnerability likely to bite; correctness/behavior wrong.
- **P2** — improvement: maintainability, perf, UX, missing tests, risky pattern.
- **P3** — nit / style / polish.

### Quality bar (read this twice)
- **High signal only.** A wrong P0 costs more than a missed P3. If confidence is `low`,
  say so and explain what would confirm it.
- **Always cite `file:line`.** No location → not a finding.
- **Always propose a concrete fix.** "Consider improving" is not a fix.
- **No duplicates within your own file.** Search before adding.
- **Verify before asserting.** If you can prove it with `typecheck`/`test`/grep, do so and
  note the evidence. Distinguish "confirmed" from "suspected".

## Cross-agent signals (`signals.md`)

When you find something that another domain owns or must verify, append one line to
`signals.md` (create it if missing). This is the only inter-agent channel.

```
[from:backend → to:security] uploadStreamWithFallback.ts:42 may write attacker-controlled path; please verify path traversal. (ref backend-007)
[from:frontend → to:types-contracts] client-web/components/VideoEditor.tsx:88 calls /v1/projects/:id/thumbnail but shared/client-v1.ts has no such method. (ref frontend-012)
```

Keep signals short and reference the finding id. The orchestrator routes them.

## Hard rules for every agent
1. **NEVER read, open, cat, or print `.env` or any `.env.*` file** except `.env.example`.
   If you need to know a config key, read `.env.example` only. This is a strict, repeated
   user requirement.
2. **Reviewers are read-only.** Do not Edit/Write source files. Only write into your run
   directory (`findings/`, `signals.md`). The `review-fixer` agent applies changes.
3. **Never run destructive or stateful commands**: no `db:migrate`, no `git commit/push/reset`,
   no `rm`, no killing servers, no network mutations. Read-only verification only
   (`typecheck`, `lint`, `test`, `grep`, `git diff`/`git log`).
4. **Scope discipline.** Stay in your assigned paths. Ignore `_archive/`, `node_modules/`,
   `dist/`, `.next/`, generated build caches.
5. **Be concrete to this repo.** Reference real files, real scripts (`pnpm --filter <pkg> typecheck`).
6. **Time-box.** Prefer the 15 highest-value findings over 60 shallow ones.

## Safety guarantees (the swarm must do no damage)
This system is built to **optimize and improve only** — never to break the codebase, leak
secrets, or alter the environment. These guarantees are non-negotiable:

- **Secrets stay sealed.** No agent ever opens `.env`/`.env.*` or any credential file, prints a
  secret value, or copies a server secret into client/`NEXT_PUBLIC_*` code. The security review
  flags committed/leaked secrets *by reference* (file:line), never by reproducing the value.
- **No environment mutation.** No agent edits `.env`, CI config, deploy config, package manager
  state, or installs/removes dependencies. No `npm/pnpm install`, no codegen that rewrites
  tracked files (`pnpm generate`), no migrations, no DB connections.
- **Reviewers cannot change code at all.** They have no Edit tool for source; the worst they can
  do is write a markdown file inside `.claude/review/runs/`.
- **The only writer is `review-fixer`, and only after explicit user approval**, on a dedicated
  `review/fixes-*` branch, applying one conservative change at a time, re-running typecheck/tests
  after each, reverting anything that regresses, and **never committing/pushing** unless told to.
- **Behavior is preserved.** Bug fixes change only what the finding describes; cleanups keep
  observable behavior identical; public signatures/routes/contracts stay stable (or all call
  sites + the generated client are updated and proven green by typecheck).
- **No future breakage.** Schema/migration changes are out of scope for the fixer — described and
  handed to a human. Ambiguous or behavior-changing items are deferred, never guessed.
- **Read-only verification only**, and everything is reversible: changes live unstaged on a
  branch for human review, so any run can be discarded with `git restore`/branch deletion.

## Useful repo commands (read-only)
- Typecheck one package: `pnpm --filter backend-api typecheck` (or client-web / admin-web / shared)
- Lint one package: `pnpm --filter backend-api lint`
- Tests: `pnpm --filter backend-api test` (vitest, runs once)
- Diff under review: `git diff main...HEAD` and `git status`
- Search: prefer `Grep`/`Glob` tools over shelling out.

## Project context (so findings are grounded)
- Monorepo (pnpm workspaces): `backend-api`, `client-web`, `admin-web`, `shared`. Plus
  `crop-processor` (not in workspaces).
- Backend: Express + TS, Drizzle ORM over **MySQL**, entry `backend-api/src/server.ts`.
  Services under `backend-api/src/services/*`. Migrations in `src/db/migrations`.
- Known sensitive areas: HLS transcoding pipeline (`services/video/HLSTranscoder.ts`),
  storage with R2→local durable fallback (`services/storage/*` — R2 token is read-only,
  PutObject is denied, media falls back to a persistent `LOCAL_STORAGE_DIR`), avatar/SEO/
  course publishing, LLM providers (`services/llm/*`).
- Frontends: Next.js App Router. `client-web` is the viewer/editor; `admin-web` is admin (port 3001).
- Contract surface: `shared/src/generated/client-v1.ts` is the generated API client shared by
  frontends — drift between it and backend routes is a high-value bug class.
- Operational rule: schema changes require running migrations before restart (do NOT run them
  during review — just flag if a migration looks missing for a schema change).
