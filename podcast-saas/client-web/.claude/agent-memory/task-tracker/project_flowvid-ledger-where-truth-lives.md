---
name: flowvid-ledger-where-truth-lives
description: brief standalone summary of how the FlowVid/cebu decision ledger works, in case the repo-root memory store is unavailable — DECISIONS.md is the live status, CODEX-DECISION-RESPONSE files are frozen rulings
metadata:
  type: project
---

`.claude/review/DECISIONS.md` (repo root `/Users/ofeklevy/cebu`) is the single current-status
ledger for the FlowVid/podcast-saas product — sections for blocked-on-owner, standing constraints,
backlog, parked features awaiting approval, and accepted risks. `CODEX-DECISION-RESPONSE-YYYY-MM-DD.md`
files are point-in-time rulings written once and referenced from `DECISIONS.md`; they are not kept
live afterward, so a later-dated `DECISIONS.md` line supersedes an earlier codex line, not the other
way round. Status updates land as small `docs(decisions):` PRs.

The full version of this memory, with more detail and cross-links, is at
`/Users/ofeklevy/cebu/.claude/agent-memory/task-tracker/project_flowvid-decisions-process.md` — see
[[ledger-memory-lives-at-repo-root]] for why it lives there instead of here.

**One completeness-auditing technique worth repeating:** `DECISIONS.md`'s "Last updated" line names
the PRs it accounts for. Run `gh pr list --state all` and diff anything numbered above that watermark
against the ledger's content by title — an open PR with no matching `docs(decisions):` follow-up is
invisible to the ledger no matter how carefully you re-read it.
