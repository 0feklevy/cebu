# Code Review Swarm

A coordinated, multi-agent review system for the `podcast-saas` monorepo. It finds bugs,
security issues, performance problems, UX/a11y gaps, and contract drift across the whole stack,
then produces one prioritized report and an optional, safe auto-fix pass.

**Design principle: optimize and improve, do no damage.** See the *Safety guarantees* section in
[PROTOCOL.md](PROTOCOL.md). In short: agents never read `.env`, never expose secrets, never touch
the environment or DB, reviewers can't edit code at all, and the one agent that can edit
(`review-fixer`) only runs after you approve, works on a branch, verifies every change, and never
commits or pushes on its own.

## The agents

| Agent | Role |
|---|---|
| `review-orchestrator` | Plans the review, dispatches reviewers in parallel, merges + dedupes findings, writes the final report and fix plan. **This is what you launch.** |
| `backend-reviewer` | Express/TS correctness: async/error handling, resource leaks, storage & HLS pipelines |
| `frontend-reviewer` | Next.js/React correctness: hooks, data fetching, state, error/loading handling |
| `ui-ux-reviewer` | UX + accessibility: loading/empty/error states, a11y, focus, responsive, consistency |
| `database-reviewer` | Drizzle/MySQL: schema, migrations, query correctness, indexes, transactions, integrity |
| `security-reviewer` | authn/authz, injection, SSRF, path traversal, uploads, secrets, LLM prompt-injection |
| `performance-reviewer` | blocking I/O, ffmpeg/HLS, streaming vs buffering, N+1, caching, bundle/render cost |
| `types-contracts-reviewer` | TS strictness + backend↔frontend contract drift (`client-v1.ts`) |
| `test-quality-reviewer` | runs the suites; failing/flaky/weak tests; missing tests on risky paths |
| `review-fixer` | applies approved fixes conservatively on a branch (opt-in, post-approval) |
| `fiji-advisor` | solves podcast-saas problems by porting patterns from the **fiji** reference project (storage/public-links, contract drift, scalability). Expert on `/Users/admin/cebu/fiji`; backed by `.claude/reference/fiji.md` |

How they "communicate": reviewers run in parallel and don't talk directly. They coordinate by
writing structured findings into a shared run directory and dropping cross-domain handoffs into
`signals.md`; the orchestrator reads everything, routes the signals, dedupes, and synthesizes.
See [PROTOCOL.md](PROTOCOL.md) for the finding format and the full contract.

## How to run it

Launch the orchestrator from the main conversation:

```
> Use the review-orchestrator agent to review the whole codebase.
```

Scoped variants:

```
> review-orchestrator: review just my current branch diff (main...HEAD)
> review-orchestrator: review only the avatar + storage features
> review-orchestrator: security + performance pass on backend-api only
```

Output lands in `.claude/review/runs/<timestamp>/`:
- `REPORT.md` — prioritized, deduplicated findings (P0→P3) with file:line and fixes
- `FIX_PLAN.md` — ordered, safe-to-apply fixes; ambiguous ones marked *needs human decision*
- `findings/*.md` — each reviewer's raw output
- `signals.md` — cross-agent handoffs

After you read the report, you can approve the fix pass:

```
> Apply the P0/P1 and low-risk fixes from the latest run with review-fixer.
```

The fixer creates `review/fixes-<run-id>`, applies changes one at a time with verification, and
writes `FIX_RESULTS.md`. Nothing is committed or pushed unless you say so.

## Using the fiji reference
`fiji-advisor` treats the **fiji** project (`/Users/admin/cebu/fiji`, separate repo, gitignored) as
the gold-standard architecture and ports its patterns to fix podcast-saas. It's grounded in
[`.claude/reference/fiji.md`](../reference/fiji.md) (a curated knowledge base) and reads real fiji
source before recommending. Launch it directly for a fiji-grounded solution:

```
> Use the fiji-advisor agent: how does fiji avoid the local-storage path-traversal / public-link
  problem, and give me a ported solution for podcast-saas?
> fiji-advisor: fix our backend↔frontend contract drift the way fiji does it.
```

It writes proposals to `.claude/reference/solutions/<slug>.md` and never edits source (the
`review-fixer` or you apply changes). It never modifies fiji.

## Notes
- If the harness can't spawn nested sub-agents from the orchestrator, just launch the individual
  reviewers from the main conversation — the run directory + protocol still apply.
- Runs are disposable: delete a folder under `runs/` to discard it. To undo a fixer run, switch
  off its branch and delete it (changes are uncommitted by default).
- Models: deep domains (backend, security, database, fixer, orchestrator) default to Opus; broad
  scanners (frontend, ui-ux, performance, types, tests) default to Sonnet. Override per run if
  you want.
