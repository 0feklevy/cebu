---
name: ledger-memory-lives-at-repo-root
description: this session's memory dir is scoped to client-web, but the FlowVid decision ledger and its task-tracker memory live three levels up at the cebu repo root — read/update that location too
metadata:
  type: reference
---

The decision ledger this agent is usually asked to audit (`.claude/review/DECISIONS.md`,
`.claude/review/CODEX-DECISION-RESPONSE-*.md`) lives at the repo root, `/Users/ofeklevy/cebu`
(a separate git repo — `podcast-saas/`, including `client-web/`, is a subtree inside it, not its own
checkout). A parallel, actively-maintained task-tracker memory store already exists there:
`/Users/ofeklevy/cebu/.claude/agent-memory/task-tracker/`, with its own `MEMORY.md` index covering
the ledger's structure, the merge-authorization boundary, the audit-ledger jsonl schema, and a
feedback memory about this repo changing concurrently mid-audit.

**How to apply:** if a task names `/Users/ofeklevy/cebu` (or any `podcast-saas/...` path outside
`client-web`) as the audit target, read `/Users/ofeklevy/cebu/.claude/agent-memory/task-tracker/MEMORY.md`
first — it has the real context. Write updates there too when the finding is about the ledger/repo
itself rather than about client-web specifically; this directory is for client-web-scoped work.
See [[flowvid-ledger-where-truth-lives]] for a short standalone summary in case that other store is
ever unavailable.
