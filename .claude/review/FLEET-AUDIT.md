# Fleet Audit — v2 (24 agents)

**Auditor:** `fleet-maintainer`
**Date:** 2026-08-14
**Repo:** `/Users/ofeklevy/cebu` @ `fix/export-prod-assembly-and-consent-ui` (HEAD `ae4b65b`)
**Subject:** `.claude/**` — audited adversarially against the real repository.

> `reference/stack.md` was treated as the **subject**, not the source. Every factual claim below
> was re-derived from the repository.

**Verdict:** the fleet **loads correctly and its stack facts are ~90% right** — the Express/MySQL
class of error is genuinely gone. But the enforcement layer does **not** deliver the guarantee
PROTOCOL.md advertises, one agent cannot write its own output, six counts are wrong, and nine
service directories have no owner.

| | Count |
|---|---|
| Blocking | 2 |
| Drift (false claims) | 11 |
| Coverage gaps | 9 |
| Guard bypasses | 13 |

---

## 1. Discoverability — PASS

| Check | Result |
|---|---|
| `.claude/agents/` at repo root | **PASS** — `/Users/ofeklevy/cebu/.claude/agents/` |
| No second `.claude/` deeper in tree | **PASS** — `find . -type d -name .claude` returns only `./.claude`. `podcast-saas/.claude` does not exist. The v1 shadowing bug is fixed. |
| 24 agent files | **PASS** — core 8, domain 8, meta 5, release 3 |
| `name:` unique across tree | **PASS** — 24 files, 24 distinct names |
| Names match orchestrator/README references | **PASS** — every name in `review-orchestrator.md`, `review/README.md`, `commands/review-fleet.md`, `PROTOCOL.md` and `stack.md` resolves to a real agent; every agent is referenced at least once |

**Note (not blocking):** there is **no `.claude/settings.json`**. The guard is wired *only* through
per-agent `hooks:` frontmatter. Any agent added without that block, and the main session itself, run
with no enforcement at all. There is no fleet-wide backstop.

---

## 2. Frontmatter validity — PASS with notes

All 24 files: `name` + `description` present, `name` lowercase-hyphen, no `:`.

| Field | Result |
|---|---|
| `tools` entries real | **PASS** — only `Read, Grep, Glob, Bash, Write, Edit, TodoWrite, WebFetch, WebSearch, Agent` appear. **No file declares `Task`.** The v1 launch failure is fixed. |
| `disallowedTools` entries real | **PASS** |
| `model` ∈ {sonnet,opus,haiku,fable,inherit,claude-*} | **PASS** — 13 `opus`, 11 `sonnet` |
| `effort` ∈ {low,medium,high,xhigh,max} | **PASS** — 19 `high`, 5 `medium` |
| `color` ∈ allowed set | **PASS** — all 8 valid values used |
| `memory` ∈ {user,project,local} | **PASS** — 21 × `project`; 3 omit the key (allowed) |
| Reviewers do **not** carry `Agent` | **PASS** — only `review-orchestrator` has `Agent`, correctly |
| Reviewers carry `disallowedTools: Edit, NotebookEdit` | **PASS** — all 21 reviewers/advisors |
| `hooks` command path exists | **PASS** — `.claude/hooks/fleet-guard.mjs` exists, mode `-rwxr-xr-x` |
| Hook mode argument | **PASS** — 23 × `readonly`, `review-fixer` × `writer` |
| `skills:` targets resolve | **PASS** — `release-audit` → `.claude/skills/release-audit/SKILL.md` exists; `claude-api` is built-in |

### Hygiene notes
- **H1** — `finding-verifier`, `review-fixer`, `review-orchestrator` omit `memory:`; the other 21 set
  `memory: project`. Harmless but inconsistent; these three lose cross-run memory.
- **H2** — `review-fixer` has `disallowedTools: Agent` only. `NotebookEdit` is absent from both
  `tools` and `disallowedTools`. Unreachable in practice, but state it explicitly for symmetry.
- **H3** — the hook `matcher` is `"Bash|Read|Write|Edit|NotebookEdit"` in all 24 files. It omits
  **`Grep`, `Glob`, `WebFetch`, `WebSearch`** — all of which can read or exfiltrate file content.
  See bypasses B5 and B12.

---

## 3. BLOCKING

### BLOCK-1 — `fleet-maintainer` is forbidden from writing its own mandated output

`agents/meta/fleet-maintainer.md:78`:
> `Write `.claude/review/FLEET-AUDIT.md`:`

`hooks/fleet-guard.mjs:126-134` — the `readonly` Write allowlist:
```js
const allowed =
  /\/\.claude\/review\/runs\//.test(filePath) ||
  /\/\.claude\/reference\/solutions\//.test(filePath) ||
  /\/\.claude\/agent-memory(-local)?\//.test(filePath);
```
`.claude/review/FLEET-AUDIT.md` matches none of them. Verified:
```
Write /Users/ofeklevy/cebu/.claude/review/FLEET-AUDIT.md   [readonly] DENY
```
The agent is structurally unable to produce its deliverable.

**Fix:** add `|| /\/\.claude\/review\/[A-Z-]+\.md$/.test(filePath)` to the allowlist in
`hooks/fleet-guard.mjs:127`, or narrowly `|| filePath.endsWith('/.claude/review/FLEET-AUDIT.md')`.

### BLOCK-2 — the `readonly` guard does not make reviewers read-only

`review/PROTOCOL.md:178-179` promises:
> "Reviewers are **structurally incapable** of editing source."

They are not. Verified against the live guard, all in `readonly` mode:
```
>>ALLOW  Bash: sed -i '' s/a/b/ podcast-saas/backend-api/src/server.ts
>>ALLOW  Bash: echo owned | tee podcast-saas/backend-api/src/server.ts
>>ALLOW  Bash: cat > podcast-saas/backend-api/src/server.ts <<EOF ... EOF
>>ALLOW  Bash: > podcast-saas/backend-api/src/server.ts
>>ALLOW  Write /Users/ofeklevy/cebu/.claude/review/runs/x/../../../podcast-saas/backend-api/src/server.ts
```
The guard blocks the `Edit` **tool** and constrains the `Write` **tool**, then leaves `Bash` as a
fully open write channel, and its `Write` allowlist is a naive substring test that `..` walks
straight out of. The headline guarantee of the fleet is false as written.

**Fix:** in `hooks/fleet-guard.mjs`
1. `path.resolve()` `filePath` **before** the allowlist test, and compare against a resolved
   prefix rather than a substring (`resolved.startsWith(path.resolve(PROJECT_DIR, '.claude/review/runs') + '/')`).
2. Add a readonly-mode Bash write-channel denylist: `sed -i`, `tee`, `dd of=`, `>`/`>>` redirection
   into a tracked path, `cat >`, `cp`/`mv` into the repo, `patch`, `git apply`.
3. Either accept relative paths in the allowlist or state in `PROTOCOL.md` that `OUTPUT_DIR` must
   be absolutised — today `review-orchestrator.md:38` hands out a **relative** `OUTPUT_DIR`
   (`.claude/review/runs/<run-id>`) and the leading-slash-anchored regex denies it:
   `Write .claude/review/runs/R/findings/backend.md [readonly] DENY`.

---

## 4. Stack drift

Confirmed **correct** first, so the report is calibrated: Fastify 4 (`fastify ^4.28.0`), hand-registered
`register*Routes(app)` (`server.ts:26-41`), PostgreSQL via `drizzle-orm ^0.31.4` + `postgres ^3.4.4`,
pg-boss 12 (`^12.23.0`), Firebase Admin, Next.js **15.1.0** in both frontends, React 19, Tailwind 3.4,
Vitest 4.1.7, Playwright 1.60 with **9** configs, `pnpm@11.4.0`, Node `>=22.0.0` (local v22.23.2),
workspace list exactly `backend-api, client-web, admin-web, shared, ops/release`, Docker Compose +
nginx + systemd, **27** v1 controllers, **7** admin controllers, **145** `uuid(` columns, **11** job
names, and all four "traps" in §2 (dead `tsoa.json`, missing `generate` script, GoDaddy-era `start`,
duplicate `workspaces` array) — every one verified true.

Now the misses.

### D1 — table count off by one
- **Claim** `stack.md:60`: "`pg-core`: `pgTable`, `uuid`, `jsonb` (**53 tables**, 145 uuid columns)"
- **Truth** `podcast-saas/backend-api/src/db/schema.ts`: **52** `pgTable(` calls, 52 unique names, no duplicates. (145 uuid columns is correct.)
- **Fix:** `53` → `52`.

### D2 — backend test-file count wrong, and propagated into an agent
- **Claim** `stack.md:67`: "**Vitest** (**128** backend test files)"
- **Claim** `core/test-quality-reviewer.md:21`: "**Vitest** (128 backend test files)"
- **Claim** `core/test-quality-reviewer.md:70`: "**128 files** can still leave the export path untested."
- **Truth** `find podcast-saas/backend-api -name '*.test.ts' -o -name '*.spec.ts'` (excl. `node_modules`) = **131**
- **Fix:** `128` → `131` in all three places.

### D3 — "71-file migration runner" is wrong; the runner has 58
- **Claim** `stack.md:61`: "**71 raw `.sql` files, hardcoded ordered list** in `db/migrate.ts`"
- **Claim** `core/database-reviewer.md:3`: "the **71-file migration runner**"
- **Truth** `podcast-saas/backend-api/src/db/migrations/` holds **71** `.sql` files, but the hardcoded
  array in `db/migrate.ts:25` has **58** entries (`001_initial.sql` … `058_project_exports.sql`).
  The other 13 are **12 `*.rollback.sql` files** plus `phase2-schema.sql` — never applied by design.
  Missing-file count: **0**.
- **Why it matters:** `database-reviewer.md:52,74` is told to "diff the `migrations/` directory
  listing against the hardcoded list in `migrate.ts`. Report any divergence." Believing the runner
  is 71-wide, it will report **13 false `migrations.not-in-runner` findings** on its first run.
- **Fix:** `stack.md:61` → "**58 forward migrations** in a hardcoded ordered list in `db/migrate.ts`,
  alongside 12 `*.rollback.sql` and `phase2-schema.sql` which are intentionally excluded";
  `database-reviewer.md:3` → "58-file migration runner"; add to `database-reviewer.md:74` "`.rollback.sql`
  and `phase2-schema.sql` are excluded by design — do not report them as runner drift."

### D4 — the domain-table list miscounts itself and omits 20 real tables
- **Claim** `stack.md:127`: "**31 domain tables** include: `orgs users api_keys …`"
- **Truth** the backtick list that follows contains **32** names, and the schema has **52** tables.
  Every listed name is real (no phantoms), but **20 tables are absent**:
  `branch_choice_points branch_edges branch_path_events branch_sequences camera_plans collaborators
  course_custom_domains course_lessons courses hls_retired_runs playlist_items project_duplications
  project_exports project_redirect_targets scenes scripts sim_posters sim_revisions sim_rum_events
  user_purchases`
- **Why it matters:** the omissions are exactly the newest and least-reviewed subsystems — branching
  (4 tables), courses (3), sim revisions/posters/RUM (3), and `project_exports`/`project_duplications`
  (the feature on the current branch).
- **Fix:** replace with "**52 tables**; the domain tables are: …" and list all 52, or drop the count
  and say "including".

### D5 — `corpus.ingest` is not a job
- **Claim** `stack.md:94`: "`.../src/jobs/**` | `corpus.ingest`, `video.generate`, `video.transcode` | `job-queue-reviewer`"
- **Truth** those are three **filenames** in `backend-api/src/jobs/`, not job names. The canonical
  registry is `backend-api/src/queue/types.ts:14-24` — 11 names: `transcode, captions, crop, metadata,
  podcast_script, podcast_render, podcast_clips, podcast_mix_export, video_generate, project_duplicate,
  project_export`. **No `corpus*` job is registered anywhere in `queue/`**; `jobs/corpus.ingest.ts` is
  invoked directly from `controllers/v1/corpus.controller.ts`.
- **Fix:** state the 11 registry names in `stack.md` §3 and note that `jobs/corpus.ingest.ts` is a
  direct-call module, not a queued job. (`job-queue-reviewer.md:48` and `observability-reviewer.md:43,68`
  already say "11 job names" correctly — only `stack.md` is wrong.)

### D6 — Groq is a captions/ASR engine, not an LLM provider
- **Claim** `domain/llm-pipeline-reviewer.md:3`: "provider abstraction and fallback across
  **Anthropic/OpenAI/Gemini/Groq**"
- **Truth** `backend-api/src/services/llm/` contains `ClaudeProvider.ts`, `GeminiProvider.ts`,
  `OpenAIProvider.ts` — **there is no Groq provider**. Groq is used for transcription in
  `services/captions/CaptionService.ts` and `services/ingestion/AudioIngester.ts`
  (`GROQ_API_KEY` selects the `groq` captions engine).
- **Consequence:** `llm-pipeline-reviewer` hunts for a fan-out branch that does not exist, and Groq's
  real failure modes sit unreviewed in `media-pipeline-reviewer`'s column.
- **Fix:** drop Groq from `llm-pipeline-reviewer.md:3`; add "Groq (captions ASR engine selection and
  fallback in `services/captions/CaptionService.ts`)" to `media-pipeline-reviewer`'s scope, and
  qualify `stack.md:69`.

### D7 — ~27 cited paths violate the fleet's own path rule
`stack.md:34-36` states the rule and its penalty:
> "all paths you cite are **relative to the repo root** … A finding whose path does not resolve from
> the repo root is an **invalid finding**."

**20 citations in agent prompts break it**, and `stack.md` breaks it 7 times itself. All resolve once
`podcast-saas/` is prepended — none are dead files, but agents primed with these will emit
rule-violating findings.

| File:line | Cited as | Should be |
|---|---|---|
| `core/database-reviewer.md:38` | `backend-api/src/services/**` and `controllers/**` | `podcast-saas/backend-api/src/…` |
| `core/database-reviewer.md:45` | `ops/release/src/migration-audit.ts` | `podcast-saas/ops/release/…` |
| `core/types-contracts-reviewer.md:21,23,36,37,38` | `shared/src/generated/`, `backend-api/tsoa.json`, `backend-api/src/controllers/**`, `shared/src/generated/client-v1.ts`, `client-web/**`, `admin-web/**` | prefix all |
| `core/security-reviewer.md:37,38,68,72` | `client-web/**`, `admin-web/**`, `shared/src/csp.ts`, `shared/src/prompts/**` | prefix all |
| `core/performance-reviewer.md:36` | `client-web/**`, `admin-web/**` | prefix |
| `domain/config-deploy-reviewer.md:36,37,57` | `client-web/next.config.ts`, `admin-web/next.config.ts`, `client-web/middleware.ts`, `shared/src/csp.ts` | prefix |
| `domain/simulation-reviewer.md:3,21,59,76` | `shared/sim`, `shared/src/sim`, `ops/release/PLAN.md` | prefix (note `:3` also drops `src/`) |
| `domain/observability-reviewer.md:30,66` | `backend-api/src/**`, `backend-api/src` | prefix |
| `domain/dependency-auditor.md:33` | `backend-api/`, `client-web/`, `admin-web/`, `shared/`, `ops/release/` | prefix |
| `meta/fiji-advisor.md:80`, `meta/review-fixer.md:50` | `shared/src/generated/client-v1.ts` | prefix |
| `release/incident-reporter.md:36` | `ops/release/PLAN.md` | prefix |
| `stack.md:66,75,97,98,122,166,167` | `shared/src/generated/client-v1.ts`, `backend-api/tsoa.json`, `shared/src/sim/**`, `shared/src/prompts/**`, `ops/release/src/migration-audit.ts`, `shared/src/sim` | prefix — the §3 table header explicitly says "Path (from repo root)" |

*(`PROTOCOL.md:14` and `stack.md:35` also contain bare paths, but as deliberate **negative examples** —
correct as written. `stack.md:26-31` is a tree diagram — correct. `stack.md:79` quotes
`backend-api/dist/server.js` from `package.json` — correct.)*

### D8 — `fiji.md` points at another user's home directory
- **Claim** `reference/fiji.md:8`: "**Location:** `/Users/admin/cebu/fiji`"
- **Claim** `reference/fiji.md:9`: "`/Users/admin/cebu/fiji/.claude/docs/`"
- **Truth** this machine's home is `/Users/ofeklevy`. Neither `/Users/admin/cebu/fiji`, `~/fiji`, nor
  `../fiji` exists. `agents/meta/fiji-advisor.md:33` cites `<fiji>/.claude/docs/` relative to that root.
- **Mitigation present:** `review/README.md:126` already says the repo "is **not currently checked out
  on this machine**", and the agent self-labels `unverified`, so it degrades safely. Still a dead
  absolute path with a hardcoded foreign username.
- **Fix:** replace with a discovery instruction ("look for a `fiji/` sibling of the repo root or
  `$FIJI_ROOT`; if absent, run in unverified mode").

### D9 — SSOT verified against a branch that is no longer HEAD
- **Claim** `stack.md:12`: "**Last verified:** 2026-08-14 against `feat/agent-fleet-upgrade`."
- **Truth** HEAD is `fix/export-prod-assembly-and-consent-ui` @ `ae4b65b`, and the working tree has
  **uncommitted changes the fleet cannot see**: `backend-api/src/queue/registry.ts` is modified, and
  `backend-api/src/services/export/capture/localCaptureProvider.ts` is **untracked** while
  `registry.ts` imports it (`resolveLocalCaptureProvider`). A reviewer reading `registry.ts` from
  HEAD and the provider from disk will see an inconsistent pair.
- **Fix:** update the stamp on every `fleet-maintainer` run, and have `review-orchestrator` record
  `git status --short` in `MANIFEST.md` so untracked-but-imported files are visible.

### D10 — one dead path in a reference doc
- `reference/solutions/sim-iframe-raw-text-render.md:12` cites
  `client-web/components/viewer/SimOverlayDynamic.tsx` — **does not exist** at that path (with or
  without the `podcast-saas/` prefix). Every other path in `reference/solutions/**` resolves once
  prefixed.

### D11 — `.claude/docs/` is described as if local
- `agents/meta/fiji-advisor.md:33` and `reference/fiji.md:9` reference a `.claude/docs/` directory.
  **No `.claude/docs/` exists in this repo** — it belongs to the (absent) fiji checkout. The phrasing
  in `fiji-advisor.md:33` (`<fiji>/.claude/docs/`) is unambiguous; `fiji.md:9` is not. Low severity,
  but it reads as a local path.

---

## 5. Coverage and ownership

### C1 — nine backend service directories have **no owning agent** (78 `.ts` files)
`stack.md` §3 maps `services/{export,video,audio,captions,crop,avatarCircles,simulation,llm,billing,usage,storage}`.
Present in the repo and **unmapped**:

| Directory | Files | Why it matters |
|---|---|---|
| `services/podcast/**` | 27 | The product's namesake subsystem. Owns **4 of 11 jobs** (`podcast_script`, `podcast_render`, `podcast_clips`, `podcast_mix_export`) |
| `services/course/**` | 18 | Course publishing + custom domains (3 tables, all also missing from D4) |
| `services/avatar/**` | 15 | Distinct from the mapped `services/avatarCircles/` — easy to conflate, so it looks covered |
| `services/ingestion/**` | 8 | `CorpusBuilder`, `AudioIngester` (a Groq caller) |
| `services/project/**` | 5 | `ProjectDuplicationService` — the `project_duplicate` job |
| `services/seo/**` | 2 | — |
| `services/secrets/**` | 1 | `ApiKeyService.ts`. De-facto claimed by `security-reviewer.md:37`, but absent from the map |
| `services/security/**` | 1 | `assertPublicHost.ts` — SSRF containment, unmapped |
| `services/video-generation/**` | 1 | The `video_generate` job (external B-roll vendors) |

**6 of the 11 registered jobs execute in directories with no owner.**

### C2 — root-level controllers not in the map
`stack.md` §3 maps `controllers/v1/**` and `controllers/admin/v1/**` only. Also present:
`controllers/sim-public.controller.ts`, `controllers/sim-rum.controller.ts`, `controllers/stubs.ts`.
The first two are claimed in prose by `simulation-reviewer.md:60,63`; `stubs.ts` is unclaimed.

### C3 — `backend-api/src/scripts/**` (31 files) unowned
Includes `backfill-storage.ts`, `backfill-localhost-urls.ts`, `backfill-bridge-capabilities.ts`,
`reinject-sim-gates.ts`, `audit-videos.ts`. These mutate production data and are wired to
`package.json` scripts. No agent owns them.

### C4 — `backend-api/src/worker.ts` unowned
`job-queue-reviewer` owns `queue/**` and `jobs/**`; the worker entrypoint sits at `src/worker.ts`.

### C5 — `deploy/docker-compose.export-worker.yml` unmentioned
`stack.md:106` and `config-deploy-reviewer` describe "docker-compose, nginx, systemd" but neither
mentions this second compose file. (`deploy/docker-compose.yml` defines `backend, worker, client-web,
admin-web, nginx, certbot` — verified.)

### C6 — PROTOCOL.md has **no ownership row for the release domain**
The matrix at `PROTOCOL.md:105-123` has 17 rows and none covers `ops/release/**`, release-run
explanation, migration audits, or incidents — despite three release agents existing. `stack.md:105`
assigns `ops/release/**` to `release-auditor` + `migration-auditor`, so the two documents disagree.

### C7 — six rows dual-assign ownership, contradicting the exclusivity rule
`PROTOCOL.md:19` ("What changed in v2", item 4) states: **"Ownership is exclusive. Each concern has
exactly one owning agent."** `stack.md` §3 breaks it six times:

| `stack.md` line | Path | Owners listed |
|---|---|---|
| 90 | `controllers/admin/v1/**` | `backend-reviewer` **+** `security-reviewer` |
| 100 | `services/storage/**` | `security-reviewer` **+** `backend-reviewer` |
| 101 | `{lib,config}/**` | `observability-reviewer` **/** `config-deploy-reviewer` |
| 102 | `client-web/**` | `frontend-reviewer`, `ui-ux-reviewer` |
| 103 | `admin-web/**` | `frontend-reviewer`, `ui-ux-reviewer` |
| 105 | `ops/release/**` | `release-auditor`, `migration-auditor` |

Rows 102/103 are fine (different *concerns* in the same tree — PROTOCOL's matrix already splits
correctness from UX). Rows 90, 100, 101, 105 are genuinely ambiguous and will produce duplicates.
**Fix:** split each by concern the way the PROTOCOL matrix does, e.g. row 101 → "`lib/logger.ts`,
`lib/sse.ts` → `observability-reviewer`; `config/trustProxy.ts`, `config/publicOrigins.ts` →
`config-deploy-reviewer`".

### C8 — migrations are claimed by two agents with no tie-break
`PROTOCOL.md:110` gives "Postgres schema, **migrations**, query correctness, transactions" to
`database-reviewer`. `release/migration-auditor.md:3` says it "**reviews new SQL migrations** for
expand/contract safety". Nothing states which one owns a new `.sql` file in a review run.
**Fix:** one line in `PROTOCOL.md` — `database-reviewer` owns migrations during a code review;
`migration-auditor` owns them only when explaining a `migration-audit.json` from a release run.

### C9 — no agent points at a directory that no longer exists
Checked all 91 distinct path tokens across `.claude/**`. Apart from D10 and D11, every cited path
resolves (once the `podcast-saas/` prefix from D7 is applied). **No dead subsystem references.**

---

## 6. Enforcement health

### Mandated tests — all six correct

```
Read /x/.env                                      [readonly] DENY   ✓ expected deny
Read /x/.env.example                              [readonly] ALLOW  ✓ expected allow
Edit /x/a.ts                                      [readonly] DENY   ✓ expected deny
Edit /x/a.ts                                      [writer]   ALLOW  ✓ expected allow
Bash pnpm -C podcast-saas --filter backend-api test [readonly] ALLOW ✓ expected allow
Bash git push                                     [writer]   DENY   ✓ expected deny
```

Verbatim deny payloads:
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fleet-guard: '/x/.env' is secret material. The fleet never opens .env/.env.* or credential files — read .env.example instead (PROTOCOL.md rule 1)."}}
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fleet-guard: reviewers are read-only. Record the problem as a finding; review-fixer applies changes (PROTOCOL.md rule 2)."}}
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fleet-guard: no commit/push/reset --hard/clean/tag/rebase — the fleet leaves changes uncommitted for human review (PROTOCOL.md rule 3)."}}
```
Fail-open behaviour confirmed by inspection (`fleet-guard.mjs:85-86` exits 0 on `JSON.parse`
failure; `:141` catches all). Correct: a malformed payload cannot brick a run.

### 13 bypasses — all verified against the live guard, `readonly` mode

> These are the ones that matter. The guard is a **denylist of command spellings**, and denylists of
> shell syntax do not hold.

**B1 — `Write` allowlist is a substring test; `..` walks out of it.** *(→ arbitrary file write)*
```
>>ALLOW Write /Users/ofeklevy/cebu/.claude/review/runs/x/../../../podcast-saas/backend-api/src/server.ts
```
`fleet-guard.mjs:127` tests `/\/\.claude\/review\/runs\//` against the raw string. Any path
containing that substring passes, wherever it actually lands. **Highest severity.**

**B2 — `Bash` is an unguarded write channel.** *(→ reviewers can edit source)*
```
>>ALLOW  sed -i '' s/a/b/ podcast-saas/backend-api/src/server.ts
>>ALLOW  echo owned | tee podcast-saas/backend-api/src/server.ts
>>ALLOW  cat > podcast-saas/backend-api/src/server.ts <<EOF
>>ALLOW  > podcast-saas/backend-api/src/server.ts
```

**B3 — the `.env.example` exemption is tested against the whole command line.**
```
>>ALLOW  cat podcast-saas/.env.example podcast-saas/.env
```
`fleet-guard.mjs:102`: `SECRET_CMD.test(command) && !/\.env\.(example|sample|template)/.test(command)`.
Naming `.env.example` anywhere in the command whitelists reading the real `.env`. **One-token bypass.**

**B4 — `SECRET_CMD` lists 17 reader binaries; everything else reads freely.**
```
>>ALLOW  dd if=podcast-saas/.env
>>ALLOW  nl podcast-saas/.env
>>ALLOW  tac podcast-saas/.env
>>ALLOW  base64 podcast-saas/.env
>>ALLOW  xargs -a podcast-saas/.env echo
>>ALLOW  node -e "...readFileSync('podcast-saas/.env','utf8')..."
>>ALLOW  python3 -c "print(open(chr(46)+chr(101)+chr(110)+chr(118)).read())"
>>ALLOW  curl -s file:///Users/ofeklevy/cebu/podcast-saas/.env
>>ALLOW  < podcast-saas/.env cat
>>ALLOW  while read l; do echo $l; done < podcast-saas/.env
>>ALLOW  find podcast-saas -name ".env" -exec cat {} +
```
The regex requires the reader binary to appear **before** the filename, so redirection, `-exec`, and
any interpreter defeat it, and obfuscation defeats it absolutely.

**B5 — `Grep` and `Glob` are not in the hook matcher at all.** *(→ zero-effort secret read)*
```
>>ALLOW Grep {"pattern":".","path":"podcast-saas/.env","output_mode":"content"}
```
Every reviewer has `Grep`. The matcher `"Bash|Read|Write|Edit|NotebookEdit"` never fires, and even if
it did, the guard only inspects `file_path`/`notebook_path` (`:92`) — never `path`. **This is the
cheapest and most likely-to-be-hit bypass in the set.**

**B6 — macOS case-insensitive filesystem.**
```
>>ALLOW Read /Users/ofeklevy/cebu/podcast-saas/.ENV
```
`isSecretPath` (`:43-48`) is case-sensitive; APFS is not. `.ENV` opens `.env`. A trailing space
(`"/x/.env "`) also slips through.

**B7 — `echo $DATABASE_URL` is allowed.**
```
>>ALLOW  echo $DATABASE_URL
  DENY   echo $ANTHROPIC_API_KEY
>>ALLOW  printf "%s" "$STRIPE_SECRET_KEY"
>>ALLOW  node -e "console.log(process.env.STRIPE_SECRET_KEY)"
>>ALLOW  set | grep -i stripe
>>ALLOW  export -p
>>ALLOW  env -0
```
`PRINT_ENV` (`:53-54`) only matches `echo` + a var name containing `SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL`.
`DATABASE_URL` contains the DB password and matches none of them. `printf`, `set`, `export -p` and
`env -0` are not covered at all.

**B8 — git mutations behind a global flag or a different verb.**
```
>>ALLOW  git -C /Users/ofeklevy/cebu push origin main
>>ALLOW  git -c user.name=x commit -m wip
>>ALLOW  git stash
>>ALLOW  git checkout -- .
>>ALLOW  git restore .
>>ALLOW  git reset HEAD~3 --hard
>>ALLOW  git branch -D main
>>ALLOW  git worktree remove --force ../wt
```
The regex (`:59`) anchors on `git\s+<verb>`, so any global option defeats it. `stash`/`restore`/
`checkout -- .` destroy uncommitted work — which is precisely what the fleet promises to preserve
(`PROTOCOL.md:180`, "`git restore` the fixer's branch" assumes the working tree survives).

**B9 — `pnpm -C` defeats the install guard, using the fleet's own canonical prefix.**
```
  DENY   pnpm install
>>ALLOW  pnpm -C podcast-saas install
>>ALLOW  pnpm -C podcast-saas add left-pad
```
`stack.md:38-46` teaches **`pnpm -C podcast-saas …`** as *the* command form. The most-typed prefix in
the fleet is the one that disables the guard. Highest chance of an accidental trip.

**B10 — migrations can be run directly.** *(→ can reach a real database)*
```
  DENY   pnpm --filter backend-api db:migrate
>>ALLOW  pnpm -C podcast-saas exec tsx backend-api/src/db/migrate.ts
```
The guard blocks the **script alias**, not the underlying command. `migrate.ts:10-12` reads
`DATABASE_URL` and connects. Given the standing "never touch prod from local" rule, this is the
highest-consequence bypass after B1.

**B11 — filesystem destruction without a dash.**
```
  DENY   rm -rf podcast-saas
>>ALLOW  rm podcast-saas/backend-api/src/server.ts
>>ALLOW  unlink podcast-saas/backend-api/src/server.ts
>>ALLOW  find . -name "*.ts" -delete
>>ALLOW  mv podcast-saas /tmp/gone
```
`:67` requires `rm\s+-[a-zA-Z]*[rf]`. Deleting a single file takes no flags.

**B12 — service control and exfiltration.**
```
  DENY   docker compose down
>>ALLOW  docker-compose down          # hyphenated form
>>ALLOW  docker stop flowvid-api      # verb not in {up,down,restart,rm}
  DENY   ssh vm "ls"
>>ALLOW  scp podcast-saas/.env vm:/tmp/
```
`scp` of `.env` is secret **exfiltration** and is fully allowed. `WebFetch`/`WebSearch` are likewise
outside the matcher (`dependency-auditor` and `llm-pipeline-reviewer` both carry them).

**B13 — no `.claude/settings.json`, so there is no fleet-wide backstop.**
Enforcement exists only where an agent's frontmatter opts in. A new agent added without a `hooks:`
block, or the main session, runs completely unguarded.

### Recommended guard rewrite (priority order)
1. **Resolve paths before deciding.** `path.resolve()` + prefix comparison, not substring (fixes B1).
2. **Add `Grep`, `Glob`, `WebFetch`, `WebSearch` to every `matcher`**, and inspect `path`/`pattern`
   as well as `file_path` (fixes B5, part of B12).
3. **Case-fold and trim** in `isSecretPath` (fixes B6).
4. **Scope the `.env.example` exemption to the matched token**, not the whole command (fixes B3).
5. **Invert the Bash model in `readonly`: allowlist, don't denylist.** A reviewer legitimately needs
   `pnpm … typecheck|test|lint`, `git diff|log|status|show`, `rg`, `ls`, `find`, `node --version`.
   Deny by default; that single change closes B2, B4, B7, B8, B9, B10, B11, B12 at once, and is the
   only approach that survives an adversary who can spell.
6. If an allowlist is too strict, at minimum: strip global flags before verb-matching (`git -C`,
   `git -c`, `pnpm -C`, `pnpm --filter`), add `stash|restore|checkout\s+--|branch\s+-D|worktree`,
   add `dd|nl|tac|base64|xargs|node|python3?|ruby|perl|curl|wget|scp|rsync`, add bare `rm|unlink|
   -delete|mv`, add `sed\s+-i|tee|>\s*\S`, add `docker-compose|docker\s+(stop|kill|exec)`, add
   `printf|set\b|export\s+-p|env\b`, and match `migrate\.ts` as well as `db:migrate`.
7. **Add `.claude/settings.json`** wiring the same guard as a project-wide `PreToolUse` hook (B13).

---

## 7. Prompt quality

**Strong.** 19 of 24 agents carry a "How you will be wrong" section, concrete repo paths, and a
numbered method. `job-queue-reviewer`, `media-pipeline-reviewer`, `database-reviewer`,
`security-reviewer` and `simulation-reviewer` are specific enough that their findings will be
checkable — they cite real files (`capture/driver.ts`, `config/trustProxy.ts`, `queue/types.ts`,
`services/billing/__tests__`, `sim-rum.controller.ts` — all verified to exist).

**Q1 — five agents have no "How you will be wrong" section:**
`meta/fiji-advisor.md`, `meta/review-fixer.md`, `release/incident-reporter.md`,
`release/migration-auditor.md`, `release/release-auditor.md`.
`review-fixer` is the one agent that can edit source and it has no failure-mode section — the highest
priority of the five.

**Q2 — the release trio is the thinnest in the fleet** (46, 46, 50 lines vs a 85-line median). They
are structurally sound (they cite `release-report.json`, `gate.json`, `vm-audit.json`,
`migration-audit.json`, `ops/release/src/severity.ts` — all real), but they carry no failure-mode
section and no worked example, so they will drift toward generic incident-report prose.

**Q3 — scope overlaps** (see C7/C8): `llm-pipeline` vs `media-pipeline` on Groq (D6),
`database-reviewer` vs `migration-auditor` on migrations, `observability` vs `config-deploy` on
`lib/` + `config/`.

**Q4 — no agent has been given the `.rollback.sql` convention** (D3), so `database-reviewer` starts
with 13 guaranteed false positives.

---

## 8. Recommended edits, per file

| File | Edit |
|---|---|
| `.claude/hooks/fleet-guard.mjs` | Fix B1 (resolve paths), B3 (scope exemption), B6 (case-fold); allow `.claude/review/*.md` writes (BLOCK-1); switch `readonly` Bash to an allowlist (BLOCK-2, B2/B4/B7-B12) |
| all 24 `agents/**/*.md` | Extend `matcher` to `"Bash|Read|Write|Edit|NotebookEdit|Grep|Glob|WebFetch|WebSearch"` (B5) |
| `.claude/settings.json` *(new)* | Wire `fleet-guard.mjs readonly` as a project-wide `PreToolUse` hook (B13) |
| `reference/stack.md:60` | `53 tables` → `52 tables` |
| `reference/stack.md:61` | `71 raw .sql files` → `58 forward migrations in the runner; 12 *.rollback.sql + phase2-schema.sql excluded by design` |
| `reference/stack.md:67` | `128 backend test files` → `131` |
| `reference/stack.md:69` | Qualify Groq as an ASR/captions engine, not an LLM provider |
| `reference/stack.md:94` | Replace the three job *filenames* with the 11 registry names from `queue/types.ts`; note `corpus.ingest` is direct-call |
| `reference/stack.md:127-132` | `31 domain tables` → `52 tables`; add the 20 omitted names |
| `reference/stack.md:66,75,97,98,122,166,167` | Prefix `podcast-saas/` (its own §3 header demands it) |
| `reference/stack.md:90,100,101,105` | Split dual ownership by concern |
| `reference/stack.md:12` | Re-stamp to `fix/export-prod-assembly-and-consent-ui` @ `ae4b65b` |
| `reference/stack.md` §3 | Add rows for `services/{podcast,course,avatar,ingestion,project,seo,secrets,security,video-generation}/**`, `controllers/sim-*.controller.ts`, `backend-api/src/scripts/**`, `backend-api/src/worker.ts`, `deploy/docker-compose.export-worker.yml` |
| `review/PROTOCOL.md` §3 | Add a release-domain row; add the `database-reviewer` vs `migration-auditor` tie-break |
| `core/database-reviewer.md:3,74` | `71-file` → `58-file`; add the `.rollback.sql` exclusion note |
| `core/test-quality-reviewer.md:21,70` | `128` → `131` |
| `domain/llm-pipeline-reviewer.md:3` | Drop Groq |
| `domain/media-pipeline-reviewer.md` | Add Groq captions-engine selection to scope |
| 12 agent files (see D7 table) | Prefix all cited paths with `podcast-saas/` |
| `reference/fiji.md:8,9` | Replace `/Users/admin/cebu/fiji` with a discovery instruction |
| `meta/review-fixer.md`, `meta/fiji-advisor.md`, `release/*.md` | Add a "How you will be wrong" section |
| `reference/solutions/sim-iframe-raw-text-render.md:12` | Fix the dead `SimOverlayDynamic.tsx` path |

---

*Read-only audit. No file outside this one was modified.*
