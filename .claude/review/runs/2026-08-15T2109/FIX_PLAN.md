# Fix plan — what shipped, what is blocked, and on what

Branch `fix/night-audit-2026-08-15`, based on `30c0a4b`. **Status: NOT READY.** The blockers are
named at the bottom; nothing here is hidden behind a summary.

## Shipped and gated

Every commit below passed, on an idle machine: `pnpm -r typecheck` exit 0, the affected suites
green, and where relevant `pnpm release:verify` all nine steps.

| Commit | What | Finding |
|---|---|---|
| `f8e8748` | CLAUDE.md rewritten from source — it described GoDaddy/MySQL/`npm start` and was auto-loaded into the reviewing session's own context | fleet |
| `a2478cf` | Next 15.1.0 → 15.5.23 (both apps, both eslint plugins), `websocket-driver >=0.7.5` override, adm-zip → ^0.6.0. **0 production criticals** | dependency-001/002 |
| `3144cdc` | Next 15.5 typed routes on two server-chosen redirects | — |
| `bb90573` | ZIP upload limits from headers only — entry count, declared-uncompressed bytes, ratio, path and symlink validation. 43 tests on real archives | dependency-001 |
| `ddbad77` | Migration runner: one transaction per file plus its tracker row, advisory lock, checksums | database-001 |
| `a63aa4e` | `email_verified` gates admin bootstrap and invite claiming | security-003 |
| `e4146a7` | fleet-guard rewritten around a POSIX lexer. Six reported bypasses were **35** on inspection; 44 → 102 regression cases | fleet-003..007 |
| `cac5066` | Avatar client: explicit audible playback with a temporary muted fallback, spinner on frame evidence not a 2s timer, SDK code-split (−86,578 B raw per viewer route), the 150 ms "OPUS pre-warm" measured and removed | anam-frontend-001/003 |
| `0e72506` | Collaborator authorization is `user_id`-only; invites stay pending; integration test drives the real path | security-003 follow-up |
| `d3200f3` | Avatar backend: semantic persona fingerprint baked only after a successful vendor upsert, phase telemetry, per-call deadlines, display identity off the response path | anam-backend-001/002/003, anam-latency-001/003 |
| `9a79c56` | Revisioned sims refuse a write to an unserved prefix — 409 before any mutation, SSE established before the named error | simulation-001/003 |
| `5fedd4e` | B-roll lanes made disjoint, deterministic total ordering, runtime schemas, `MIGRATION_DATABASE_URL` | broll-data-002/003 |
| `ef651a9` | Migration 062 reworked: the job row is the serialisation point, not a unique index on a hot table | job-queue-001 |
| `f975c23` | Adoption path must END the job; `SET LOCAL lock_timeout` | job-queue-001 |
| `d0e7f74` | Ledger synced to what the code shows | — |

## Two fixes that were wrong, and how they were caught

Recorded because the pattern matters more than the individual bugs.

**`a63aa4e` did not close its own finding.** It gated the middleware's invite-claim UPDATE and had a
unit test proving the UPDATE did not run. But `collabAccess.ts` authorized on a raw `invited_email`
match at two sites, so authorization never consulted the gate — an unverified account still received
broad edit authority. Closed by `0e72506` with an integration test that drives `editableProject`.

**`ef651a9`'s adoption path never terminated the job.** When the locked row already had a
`section_id`, the code returned from inside the transaction before the terminal UPDATE. The function
reported `ready` in memory while the row stayed in-flight, so startup recovery could reclaim it
forever. The tests asserted *linkage* — true of the broken code — and never the row's terminal
state. Closed by `f975c23`, mutation-verified.

Both are the same failure: **asserting the visible half of an invariant is not asserting the
invariant.**

## Blocked, with the blocker named

| Item | Blocked on |
|---|---|
| **B-roll anchoring** (`broll-data-001`) — a placement is an absolute second while the content under it moves | Nothing any more. D-01 is ruled: ripple, anchored to a main segment id + local offset, expand/contract rollout, **no silent backfill**. Zero implementation exists. This is the largest remaining piece. |
| **Avatar capability / cost abuse** (D-03) | Ruled. `/avatar/start` still takes an optional `projectId`, there is no capability minting, and the only limiter is per-process. Not started. |
| **Full revision-aware sim replace/guidance** (D-04) | Ruled and independent of D-01. Depends on PR #31's `RevisionService.validate`. Not started. |
| **Historical remediation** for admin/invite grants made under the old rule (D-02) | Read-only report first, and it needs Firebase Admin joined against the DB — SQL alone cannot answer it. Not run. |
| **Cross-session locking proof** | EXTERNAL VALIDATION REQUIRED. A single PGlite instance cannot demonstrate that one connection waits on another's row lock. Needs real PostgreSQL, two connections, barriers. |
| **`pnpm audit --prod` = 0 criticals** | Verified once by the implementer; not independently re-run. |
| **Billing, paywalls, entitlements** (18 findings) | OUT OF SCOPE this session by owner instruction. Tagged, not deleted. |

## Not ready, precisely

1. 301 of 330 findings never received an adversarial verdict, including **5 P0 and 33 P1**.
2. The D-08 clustering pass has not started — `rootCauseId` is empty on every row, so the 263
   P2/P3 findings are a flat list with known duplicates.
3. Cross-session locking, the production-like migration rehearsal, and a real-browser pass are all
   unproven.
4. Audit-tooling findings remain open: `fleet-001` (an agent claims a fourth LLM provider that does
   not exist), `fleet-002` (task-tracker runs with no readonly guard), `fleet-014/015/016`, and
   `fleet-019` (per-agent hooks inactive without workspace trust).

Anyone reading this should treat "shipped and gated" as *tested on this branch*, not as *proven in
production*. Nothing here has been deployed.
