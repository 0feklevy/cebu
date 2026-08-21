---
name: stale-worktree-trap
description: The checked-out FlowVid tree at /Users/ofeklevy/cebu is routinely far behind origin/main — verify before assessing any code, and read current code from a live worktree instead
metadata:
  type: project
---

**Always run `git rev-list --left-right --count main...origin/main` before assessing FlowVid code.**

**Why:** on 2026-08-19 the checked-out tree was at `2d187e3` (2026-08-14) while `origin/main` was at
`ca0f00b` — **114 commits ahead**, spanning PRs #31–#44. The 2026-08-16 novelty dossier assessed the
stale tree and therefore missed four of the six mechanisms that ended up surviving the 2026-08-19
sweep (offline dependency closure, frozen export plan + fingerprint, GPU capture grant, revision
derivation). Two subsystem specialists dispatched in that run also read the stale tree and had to be
re-checked claim by claim.

The root worktree is **dirty by design** (docs only) and must never be stashed, reset, cleaned or
switched — that constraint is recorded in `.claude/review/HANDOFF-2026-08-18.md`.

**How to apply:** do not `git checkout`/`fetch` (read-only rule). Instead:
1. `git worktree list` — feature branches are usually checked out under
   `/private/tmp/claude-501/-Users-ofeklevy-cebu/<session>/scratchpad/<name>`, and one of them is
   normally at or one commit behind `origin/main`. Read from there.
2. Failing that, `git show origin/main:<path>` and `git diff --stat main...origin/main -- <dir>`.

Also worth knowing: the substantive work lands on long feature branches (`fix/night-audit-*`,
`feat/gpu-capture-grant`) before merging, so `git log --oneline main..<branch>` is a good early map
of what is new — the commit subjects in this repo are unusually descriptive and name the defect.

Related: [[flowvid-novelty-map]]
