---
name: flowvid-release-tag-vs-main-gap
description: "In FlowVid, `origin/main` HEAD can be several commits ahead of the latest published release even within one session — always resolve the release's actual target commit before claiming something is live"
metadata:
  type: project
---

Verified 2026-08-25: at the end of a release-heavy session, `git log origin/main` HEAD was
`d46fa02` (a guidance spend-ceiling fix + its test), but the latest published release (v0.2.2)
targeted `be74bc4` — three commits earlier. The ceiling fix was real, correct, and merged, but
**not in the running production containers** at audit time.

**How to check, reliably:**
```
gh release view <tag> --json targetCommitish,body -q .targetCommitish   # or read the "Commit" field in body
gh run view <run-id> --json headSha                                     # the run that built the images
git log <that-sha>..origin/main --oneline                               # what shipped AFTER
```
Do not infer "shipped" from `git log origin/main` alone, and do not infer it from a ledger doc
commit either — `DECISIONS.md` entries describing a release can themselves be committed, then
followed by more commits, before the *next* release tag is cut.

**Why it matters:** this repo publishes multiple patch releases per session (v0.2.0 → v0.2.1 →
v0.2.2 all in about 90 minutes on 2026-08-25), each a `workflow_dispatch` of `release.yml`. The
gap between "on main" and "in the release that's actually deployed" is real and routinely
non-zero. Cross-reference with [[flowvid-sweeper-wiring-pattern]] for the same
"exists-in-source-but-not-reachable" shape at the code level rather than the release level.
