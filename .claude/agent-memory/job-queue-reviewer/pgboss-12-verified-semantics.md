---
name: pgboss-12-verified-semantics
description: Non-obvious pg-boss 12.23.0 behaviours verified from installed source — re-verify here, do not quote defaults from memory
metadata:
  type: reference
---

Ground truth for pg-boss lives in the installed package, not in recollection. Re-read it at
`podcast-saas/node_modules/.pnpm/pg-boss@12.23.0/node_modules/pg-boss/dist/{types.d.ts,plans.js,manager.js}`
before asserting anything about queue behaviour.

Verified 2026-08-16 against 12.23.0 (three findings hinged on these, all counter-intuitive):

- **`singletonKey` only dedupes under a non-default policy.** `plans.js:605-631` — the unique
  indexes on `singleton_key` are policy-scoped (`short`, `singleton`, `stately`, `exclusive`,
  `key_strict_fifo`). `manager.createQueue` defaults to `policy: 'standard'`, under which
  `send(..., { singletonKey })` inserts every time and the "deduped" return of `null` never happens.
- **`createQueue` is `INSERT ... ON CONFLICT DO NOTHING`** (`plans.js:399-443`). Queue options
  (retryLimit / expireInSeconds / deadLetter / policy / heartbeatSeconds) are frozen at first
  creation; later code changes are silently discarded. Use `updateQueue` to reconcile.
- **`heartbeatSeconds` defaults to NULL = disabled** (`types.d.ts:180-184`). With no heartbeat, a
  killed worker's job stays `active` for the full `expireInSeconds` before redelivery.
- `batchSize` defaults to 1 (`types.d.ts:411`); `localConcurrency` is per-queue per-node
  (`types.d.ts:437`); queue-level `notify: true` is required for LISTEN/NOTIFY — instance-level
  `useListenNotify` alone emits nothing.

**How to apply:** in any FlowVid queue review, check `queue/pgBoss.ts`'s `ensureQueues` options
against these four, and cite the `dist/` line numbers as evidence — a verifier will ask.
