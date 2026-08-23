---
name: review-the-pr-sha-not-the-worktree
description: The working tree can switch branches mid-review in this repo (night-run agents check out other branches) — pin every citation and every test run to the PR sha, and re-verify HEAD before trusting a run
metadata:
  type: feedback
---

Pin a PR review to the PR's commit sha, never to whatever is currently checked out in
`/Users/ofeklevy/cebu`. Read blobs with `git show <sha>:<path>`; resolve every `file:line` against
that blob.

**Why:** during the PR #127 review the checkout changed underneath me from
`fix/avatar-config-poison` (e577e28) to `chore/llm-config-last-warnings` (93e480c) between two
tool calls — other agents/night runs share this one worktree. The symptom was silent and looked
like a real finding: a `vitest` run reported 29 tests where the baseline had reported 35, and the
obvious reading ("the new tests never execute") was wrong — the file had simply been swapped for a
version without them. A `git rev-parse HEAD` would have caught it in one second; nothing else did.

**How to apply:**
- Start with `git rev-parse HEAD` and `gh pr view N --json headRefOid`; if they differ, say so and
  work from blobs.
- Before quoting the result of any `vitest`/`typecheck` run, re-check `git rev-parse HEAD` — a run
  is only evidence about the tree it ran on.
- A branch swap is not always a loss: the non-PR checkout **is** the pre-fix tree, which makes it a
  free mutant for a mutation check (that is how [[avatar-spendguard-suite-mock-ceiling]] was
  proven). Use it deliberately rather than being surprised by it.
- Never `git checkout`/`stash`/`worktree add` to fix this — reviewers do not mutate git state. Read
  blobs, and run out-of-tree copies with an external vitest config.
