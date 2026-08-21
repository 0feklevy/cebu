---
name: dossier-conventions
description: How Ofek wants novelty sweeps run and delivered — full-system scope, negative results preserved, prior dossier treated as a baseline to re-verify rather than a source
metadata:
  type: feedback
---

When Ofek asks for a patent/novelty sweep of FlowVid, he wants: **the whole monorepo including
infrastructure** (release autopilot, ship conductor, and the agent-fleet tooling itself count as
candidates, not just product features); the **prior dossier re-verified claim by claim** against
current code rather than re-emitted; a **"killed candidates" appendix** so negative results are not
lost; and an explicit section on **what in the previous dossier no longer matches the code**.

**Why:** he has repeatedly paid for the same ground to be re-derived, and the 2026-08-16 pass produced
two survivors whose supporting claims had not been checked against a moving codebase. He values the
demotion of a previous survivor as much as a new one — the 2026-08-19 run refuted the central claim of
a prior entry, and that was a wanted outcome, not a failure.

**How to apply:** deliver the dossier as a **single Markdown file to the path he names** (2026-08-19:
`~/Desktop/flowvid-patent-dossier-<date>.md`), in English, with an executive summary and survivors
ranked by strength. Keep the `.jsonl` beside the repo copy in `.claude/review/patents/`. Read the
other agents' memory under `.claude/agent-memory/` first — it tells you where the hard-won mechanisms
live and saves a survey pass. Dispatch subsystem specialists with **narrow verification questions**
(numbered, with the prior claim quoted and a CONFIRMED/REFUTED/PARTIAL verdict demanded), not open
briefs; that format produced the highest-quality returns by a wide margin.

Standing constraint that is not negotiable: **never name a patent, number, assignee, inventor or claim
text**, anywhere, for any reason. Describe the field only in general terms.

Related: [[flowvid-novelty-map]], [[stale-worktree-trap]]
