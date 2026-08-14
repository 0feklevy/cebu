# FlowVid Review Fleet (v2)

A coordinated multi-agent review system for the FlowVid monorepo. It finds bugs, security issues,
performance problems, UX and a11y gaps, contract drift, and pipeline defects across the whole
stack, then produces **one** ranked report and an optional, safe auto-fix pass.

**Design principle: optimise and improve, do no damage.** Reviewers are structurally incapable of
editing source — `.claude/hooks/fleet-guard.mjs` denies it at the tool layer, not in a prompt. See
*Hard rules* in [PROTOCOL.md](PROTOCOL.md).

---

## Start here

```
> Use the review-orchestrator agent to review the whole codebase.
```

Scoped variants:

```
> review-orchestrator: review just my current branch diff (main...HEAD)
> review-orchestrator: review the export/capture pipeline
> review-orchestrator: security + performance pass on backend-api only
```

Output lands in `.claude/review/runs/<timestamp>/`:

| File | What it is |
|---|---|
| `REPORT.md` | ranked, deduplicated, **verified** findings with file:line and fixes |
| `FIX_PLAN.md` | ordered, safe-to-apply fixes; ambiguous ones marked *needs human decision* |
| `findings/*.md` + `*.jsonl` | each reviewer's raw output, human and machine readable |
| `VERIFIED.jsonl` | one adversarial verdict per P0/P1 |
| `signals.md` | cross-agent handoffs |

Then, only if you approve:

```
> Apply the P0/P1 and low-risk fixes from the latest run with review-fixer.
```

---

## The fleet — 24 agents

### Orchestration & meta (`agents/meta/`)
| Agent | Role |
|---|---|
| `review-orchestrator` | Plans scope, dispatches specialists in parallel, runs the verification pass, merges and ranks. **This is what you launch.** |
| `finding-verifier` | Adversary. Given one P0/P1, tries to **refute** it. Returns CONFIRMED / REFUTED / UNCERTAIN. |
| `review-fixer` | The only agent that may edit source. Post-approval, on a branch, one verified change at a time. |
| `fleet-maintainer` | Audits the fleet against the repo. Catches knowledge-base drift before it poisons a review. |
| `fiji-advisor` | Ports architecture patterns from the **fiji** reference platform. Labels itself verified/unverified based on whether the fiji source is present. |

### Core reviewers (`agents/core/`)
`backend-reviewer` · `frontend-reviewer` · `ui-ux-reviewer` · `database-reviewer` ·
`security-reviewer` · `performance-reviewer` · `types-contracts-reviewer` · `test-quality-reviewer`

### Domain specialists (`agents/domain/`)
| Agent | Owns |
|---|---|
| `media-pipeline-reviewer` | ffmpeg graphs, linear export, headless capture, HLS, captions, crop, audio |
| `job-queue-reviewer` | pg-boss vs inline driver, retries, idempotency, worker lifecycle |
| `llm-pipeline-reviewer` | provider fan-out, structured-output parsing, timeouts, cost, model routing |
| `simulation-reviewer` | sim bridge contract, revision identity, RUM, public sim exposure |
| `billing-integrity-reviewer` | Stripe webhook authenticity and idempotency, metering, entitlements |
| `observability-reviewer` | silent failures, log correlation, SSE lifecycle, honest health checks |
| `config-deploy-reviewer` | compose/nginx/systemd, CSP, public origins, env-var contract |
| `dependency-auditor` | vulnerable and unused packages, lockfile integrity, postinstall surface |

### Release advisors (`agents/release/`)
`release-auditor` · `migration-auditor` · `incident-reporter` — read-only explainers for the
release autopilot's deterministic JSON artefacts. They never deploy, approve, or bypass anything.

---

## How they coordinate

Reviewers **never talk to each other**. They write structured findings into a shared run directory
and drop one-line cross-domain handoffs into `signals.md`. The orchestrator reads everything,
routes the signals, sends every P0/P1 to an adversarial verifier, deduplicates by root cause, and
synthesises. See [PROTOCOL.md](PROTOCOL.md) for the finding format, severity rubric, and the
ownership matrix that keeps agents out of each other's lanes.

**Ground truth lives in [`../reference/stack.md`](../reference/stack.md).** Every agent reads it
first. If an agent's own prompt contradicts it, `stack.md` wins and the contradiction is filed as a
`fleet` finding. This exists because v1 believed the backend was Express over MySQL when it is
Fastify over Postgres.

---

## What is enforced, not merely requested

`.claude/hooks/fleet-guard.mjs` runs as a `PreToolUse` hook on every fleet agent and **denies**:

- reading, writing, or shelling out to `.env`/`.env.*` and credential files (`.env.example` is allowed);
- printing environment or secret values;
- `git commit`/`push`/`tag`/`reset --hard`/`clean -f`/`rebase`;
- `db:migrate`, `db:studio`, `drizzle-kit`, `psql`, `pg_dump`, `DROP TABLE`, `TRUNCATE`;
- `rm -rf`, `rmdir`, `shred`;
- `pnpm/npm/yarn install|add|remove|update` and `pnpm generate`;
- `kill`/`pkill`, `docker compose up|down|restart`, `systemctl`, `ssh`;
- **`Edit` and `NotebookEdit` for every reviewer**, and `Write` anywhere outside the run directory.

`review-fixer` runs the same guard in `writer` mode: it may edit source, but every other
prohibition still applies — including no commits.

Verify it yourself at any time:

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"/x/.env"}}' | node .claude/hooks/fleet-guard.mjs readonly
```

Frontmatter hooks require workspace trust. If the folder is untrusted the agents still run, but
the guard is skipped — so trust the workspace, or treat the prompt-level rules as the only defence.

---

## The fiji reference

`fiji-advisor` treats the **fiji** platform as the gold-standard architecture and ports its
patterns. It is grounded in [`../reference/fiji.md`](../reference/fiji.md) and, when the source is
available, reads the real code before recommending.

The repository is **not currently checked out on this machine.** Until it is, the advisor runs in
`mode: unverified` and labels every fiji-specific claim as coming from the knowledge base. To give
it real ground truth:

```bash
git clone https://gitlab.com/lliansky-group/fiji.git ~/cebu/fiji
```

It needs your GitLab credentials. Nothing else changes — the advisor detects the checkout and
switches to `mode: verified` on its next run. Never commit fiji into this repo.

---

## Notes

- **Location matters.** The fleet lives in `.claude/` at the **repo root** because Claude Code
  discovers project agents by walking *up* from the working directory. In v1 it lived in
  `podcast-saas/.claude/agents/` and therefore never loaded from the repo root at all.
- Runs are disposable — delete a folder under `runs/` to discard it. To undo a fixer run, switch
  off its branch and delete it; nothing is committed by default.
- **Models:** deep domains (backend, security, database, media, queue, llm, simulation, billing,
  orchestrator, verifier, fixer, fiji, fleet) default to Opus; broad scanners (frontend, ui-ux,
  performance, types, tests, deps, observability, config) default to Sonnet. Override per run.
- After a significant refactor, run `fleet-maintainer` before trusting a review.
