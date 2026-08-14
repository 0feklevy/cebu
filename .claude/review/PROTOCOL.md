# Review Fleet — Shared Protocol (v2)

The contract every agent in `.claude/agents/` follows. It defines how agents coordinate **without
talking to each other**: each writes structured findings into a shared run directory; the
orchestrator merges, verifies, deduplicates, and routes them.

> **Read `.claude/reference/stack.md` before anything else.** It is the ground truth for what this
> repo is. If your own prompt contradicts it, `stack.md` wins and the contradiction is itself a
> finding (`category: fleet`, route to `fleet-maintainer`).

## What changed in v2 (why you should not reuse v1 habits)

1. **Paths are repo-root-relative.** `podcast-saas/backend-api/src/server.ts`, never
   `backend-api/src/server.ts`. Commands use `pnpm -C podcast-saas --filter <pkg> …`.
2. **Every finding carries evidence.** A claim you did not verify is labelled `suspected`, and
   suspected P0/P1s do not survive the verification stage.
3. **Findings are machine-readable.** Markdown for humans **and** one JSON line per finding, so
   merging and deduplication are deterministic instead of vibes.
4. **Ownership is exclusive.** Each concern has exactly one owning agent. You do not report another
   agent's concern — you signal it.
5. **The safety rules are enforced**, not requested (`.claude/hooks/fleet-guard.mjs`).

---

## 1. Run directory

The orchestrator creates one directory per run and hands every agent its exact paths:

```
.claude/review/runs/<run-id>/          # run-id = UTC timestamp, e.g. 2026-08-14T0930
├── MANIFEST.md                        # scope, agents dispatched, commit under review, status
├── findings/
│   ├── <domain>.md                    # human-readable findings, one file per agent
│   └── <domain>.jsonl                 # same findings, one JSON object per line
├── signals.md                         # cross-agent handoffs (append-only)
├── VERIFIED.jsonl                     # verification verdicts (written by finding-verifier)
├── REPORT.md                          # merged, ranked, deduplicated report
└── FIX_PLAN.md                        # ordered, safe-to-apply fixes
```

**Never guess the run-id.** Use the `OUTPUT_DIR` you were handed. If you were not handed one, stop
and say so rather than inventing a path.

---

## 2. Finding format

Append to `findings/<domain>.md`:

```
### [P1] Fallback storage write is not awaited, so uploads can be lost
- id: backend-007
- location: podcast-saas/backend-api/src/services/storage/uploadStreamWithFallback.ts:42
- category: bug            # bug | security | perf | ux | a11y | types | test | data-integrity | maintainability | fleet
- confidence: high         # high | medium | low
- status: confirmed        # confirmed | suspected
- what: The promise from adapter.put() is not awaited inside the fallback branch.
- why: On R2 failure the local write races the HTTP response, so the client sees 200 before the
  bytes are durable. A crash in that window loses the upload with no error surfaced.
- evidence: Read lines 38-51; the branch calls adapter.put(...) as a statement with no await and
  no .catch. `pnpm -C podcast-saas --filter backend-api test` shows no test covering this path.
- fix: await the fallback write, propagate failures to the caller, and add a unit test that makes
  the R2 adapter reject and asserts a 5xx rather than a 200.
- verify: new test red before the change, green after; `pnpm -C podcast-saas --filter backend-api typecheck` stays clean.
- cross: @test-quality    # omit if none
- effort: S               # S <15m | M <2h | L >2h
```

And append **the same finding** as one line to `findings/<domain>.jsonl`:

```json
{"id":"backend-007","severity":"P1","category":"bug","confidence":"high","status":"confirmed","file":"podcast-saas/backend-api/src/services/storage/uploadStreamWithFallback.ts","line":42,"title":"Fallback storage write is not awaited, so uploads can be lost","effort":"S","cross":["test-quality"]}
```

`id` is `<domain>-NNN`, numbered from 001 within your own file. It must be stable — the verifier
and the fix plan reference it.

### Severity rubric — apply the test, do not eyeball it

| | Test it must pass | Examples |
|---|---|---|
| **P0** | Reachable in production **today** and causes auth bypass, data loss, secret exposure, or a hard outage. You can name the request that triggers it. | unauthenticated write endpoint; path traversal reaching arbitrary files; webhook accepting unsigned payloads |
| **P1** | A real defect that will produce wrong behaviour or a crash on a realistic input. Not merely "risky". | unawaited write losing data; contract drift that throws at runtime; missing `where` on an update |
| **P2** | Correct today, but it will cost you: maintainability, perf under load, missing test on a risky path, fragile pattern. | N+1 on a list endpoint; no test on the transcode error path |
| **P3** | Nit, style, polish. | naming, dead code, comment drift |

Down-rank anything you cannot reach from a real entry point. "An attacker with database access
could…" is not P0 — it is a note.

### Quality bar

- **A wrong P0 costs more than ten missed P3s.** The fleet's value is trust.
- **No location, no finding.** Always `file:line`, always resolvable from the repo root.
- **No fix, no finding.** "Consider improving X" is not a fix. Name the change.
- **Verify before asserting.** If a grep, a read, a typecheck, or a test run can settle it, do it
  and put the result in `evidence`. Otherwise mark `status: suspected` and say what would confirm it.
- **Read the whole function before judging it.** Most false positives are guards that exist three
  lines above or below the cited line.
- **Prefer 15 findings that are all true to 60 that are mostly true.**

---

## 3. Ownership matrix — do not report another agent's concern

| Concern | Owner |
|---|---|
| Fastify routes, async/error correctness, services wiring | `backend-reviewer` |
| React/Next correctness: hooks, fetching, state, App Router | `frontend-reviewer` |
| UX states, a11y, focus, responsive, copy | `ui-ux-reviewer` |
| Postgres schema, migrations, query correctness, transactions | `database-reviewer` |
| authn/authz, injection, traversal, SSRF, secrets, prompt injection | `security-reviewer` |
| Event-loop blocking, buffering, caching, N+1 cost, bundle size | `performance-reviewer` |
| TS strictness, shared types, backend↔frontend contract drift | `types-contracts-reviewer` |
| Test health, coverage of risky paths, Playwright suites | `test-quality-reviewer` |
| ffmpeg graphs, export/capture, transcode, audio, captions, crop | `media-pipeline-reviewer` |
| pg-boss, job registry, retries, idempotency, worker lifecycle | `job-queue-reviewer` |
| LLM providers, prompt assembly, JSON parsing, cost/timeouts | `llm-pipeline-reviewer` |
| Simulation runtime, revisions, bridge contract, RUM | `simulation-reviewer` |
| Stripe, metering, entitlements, webhook idempotency | `billing-integrity-reviewer` |
| Dependencies, lockfile, licences, supply chain | `dependency-auditor` |
| Logging, SSE, metrics, error surfacing, debuggability | `observability-reviewer` |
| docker-compose, nginx, CSP, origins, env contract | `config-deploy-reviewer` |
| Release-run artefacts, gate decisions, rollback state | `release-auditor` |
| New SQL migrations, expand/contract safety, `migration-audit.json` | `migration-auditor` (release runs) / `database-reviewer` (code review) |
| Failed release or red production audit → incident write-up | `incident-reporter` |
| Cross-cutting architecture where a reference design exists | `fiji-advisor` |
| Agent/knowledge-base drift, guard integrity | `fleet-maintainer` |

If you find something outside your column: **one line in `signals.md`, then move on.**

```
[from:backend → to:security] podcast-saas/backend-api/src/server.ts:187 joins a client key onto a
local path; please confirm containment. (ref backend-007)
```

Keep signals short and always reference your finding id. The orchestrator routes them.

---

## 4. Verification stage (new in v2)

After reviewers finish, the orchestrator dispatches `finding-verifier` against every **P0 and P1**.
The verifier's job is to **refute**, not to agree. Each verdict lands in `VERIFIED.jsonl`:

```json
{"id":"backend-007","verdict":"CONFIRMED","reason":"Read lines 38-51; no await, no catch. No test covers the reject path.","severityAdjust":null}
```

`verdict` is `CONFIRMED`, `REFUTED`, or `UNCERTAIN`. Rules the orchestrator applies:

- `REFUTED` → the finding is dropped from `REPORT.md` and listed in a "Rejected claims" appendix
  with the refutation. It is not silently deleted — a rejected claim is evidence the fleet works.
- `UNCERTAIN` → demoted one severity level and marked `confidence: low`.
- A P0 that no verifier could confirm **never ships as a P0.**

Write findings expecting an adversary to read them. That is the point.

---

## 5. Hard rules (enforced by `.claude/hooks/fleet-guard.mjs`)

1. **Never open `.env` or `.env.*`.** `.env.example` only. This is blocked at the tool layer for
   Read, Write, Edit, and for shelling out (`cat .env`, `grep … .env`). Never print an environment
   value; reference secrets by `file:line`.
2. **Reviewers cannot edit source.** `Edit` and `NotebookEdit` are denied outright; `Write` is
   restricted to your run directory (and `.claude/reference/solutions/` for advisors). The only
   agent that edits source is `review-fixer`, and only after the user approves a fix plan.
3. **No state mutation, ever.** No commit/push/tag/reset/rebase. No `db:migrate`, `db:studio`,
   `psql`, `drizzle-kit`. No `rm -rf`. No `pnpm install`/`add`/`generate`. No starting, stopping,
   or killing servers, containers, or systemd units. No SSH.
4. **Scope discipline.** Stay in your column of the ownership matrix and inside your assigned
   paths. Always skip `_archive/`, `node_modules/`, `dist/`, `.next/`, `test-results/`, `e2e-results/`.
5. **Be concrete to this repo.** Real files, real line numbers, real commands from `stack.md`.
   Generic best-practice advice with no call site is noise, and noise is a defect.
6. **Time-box.** Aim for ~15 high-value findings. When you have swept your scope, stop; do not pad.

If the guard blocks you, it is telling you the approach is wrong — **do not look for a way around
it.** Record what you wanted and why, and move on.

### What the fleet guarantees to the user — stated precisely
The first version of this section claimed reviewers were "structurally incapable of editing
source". `fleet-maintainer` proved that false in its first run: the guard was a denylist of command
spellings, and `sed -i`, `tee`, `>` redirection, and a `..` walk through the Write allowlist all
sailed past it. The honest statement is narrower, and it is what the guard now actually enforces:

- **Secrets.** `.env`/`.env.*` and credential files are denied to Read, Write, Edit, Grep, Glob,
  WebFetch, and Bash — including by another name (`.ENV`), by another reader (`dd`, `node -e`,
  `curl file://`), by redirection (`< .env`), and by expansion (`echo $DATABASE_URL`). This one
  also runs project-wide from `.claude/settings.json`, so an agent that forgets to opt in is still
  covered.
- **Source edits.** In `readonly` mode `Edit`/`NotebookEdit` are denied outright; `Write` targets
  are `path.resolve()`d and must land inside the run directory, `.claude/review/`,
  `.claude/reference/solutions/`, or agent memory; and **Bash is an allowlist** — a reviewer may
  run only read-only inspection, so shell write channels are closed by default rather than
  enumerated.
- **State.** No commit/push/tag/reset/stash/restore, no migrations (including `tsx migrate.ts`, not
  just the `db:migrate` alias), no installs (including `pnpm -C … add`), no deletion, no
  process/container/remote control — in **both** modes.

What it does not guarantee: frontmatter hooks are skipped until you accept the workspace trust
dialog, and a determined agent with a novel technique may still find a gap. Treat the guard as
defence in depth over the prompt-level rules, not as a substitute for them. Every run stays
disposable: delete the run directory, or `git restore` the fixer's branch.

Run `fleet-maintainer` after changing the guard; its job includes trying to break it.

---

## 6. Read-only verification commands

```bash
pnpm -C podcast-saas --filter backend-api typecheck    # also: client-web | admin-web | shared
pnpm -C podcast-saas --filter backend-api test         # vitest, single run
pnpm -C podcast-saas --filter backend-api lint
git diff main...HEAD --stat && git status --short
git log --oneline -20
```

Prefer the `Grep`/`Glob`/`Read` tools over shelling out — they are faster and produce cleaner
evidence. Note pre-existing failures as context; you are not responsible for them, but the report
must distinguish "this run broke it" from "it was already red".
