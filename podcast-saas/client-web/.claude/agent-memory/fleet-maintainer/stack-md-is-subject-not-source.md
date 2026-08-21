---
name: stack-md-is-subject-not-source
description: How to run a fleet audit here — what re-verifies cheaply, which claims have actually rotted historically, and which agent files are the usual offenders
metadata:
  type: project
---

`.claude/reference/stack.md` is the audit's **subject**, not its source. Two audits in, the pattern
of what rots is clear and worth targeting first.

**Rots reliably (re-derive every time, it is cheap):**
- Counts embedded in prose: backend `*.test.ts` count, `pgTable` count, script counts. These are
  duplicated across `stack.md` **and** individual agent files, and the copies drift apart — the
  agent file is usually the stale one because only `stack.md` gets fixed.
- The `Last verified:` stamp at `stack.md:12` and the migration-audit stamp around `:130`.

**Does not rot (verified true across both audits):** the framework/engine facts (Fastify 4,
Postgres via `drizzle-orm/postgres-js`, pg-boss 12, Next 15.1, pnpm workspace layout), the four
documented "traps" (stale `podcast-saas/CLAUDE.md`, dead `tsoa.json`, broken root `generate`
script), and **every file path cited by every agent** — the prompt corpus stays concrete.

**The dangerous drift class is a wrong *entity*, not a wrong number.** The v1 Express/MySQL failure
and the 2026-08-16 "Groq is a fourth LLM provider" failure are the same shape: an agent reasons
about a component that does not exist and produces confident fabricated findings. Grep agent
prompts for provider/engine/framework nouns and count the real implementations.

**Useful mechanical checks:** diff the 58 forward migration filenames on disk against the hardcoded
list in `db/migrate.ts` (silent failure if they diverge); resolve every backticked filename in
every agent prompt against a basename index of the repo; diff the `stack.md` §3 subsystem map
against the real directory tree for both directions.

**Coverage gaps recur where a matrix row exists but no agent's own Scope section names the path** —
a "default owner" row in `stack.md` is not coverage. `ops/ship/**` and `backend-api/src/scripts/**`
are both in this state.

Related: [[fleet-audit-recommendations-go-unapplied]]
