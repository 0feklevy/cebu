---
name: checklist-recovery-when-baseline-not-reattached
description: how to re-verdict a numbered checklist (e.g. S1-13/R1-33/...) when only the baseline's narrative summary persisted and the literal item list wasn't re-pasted into the completion-check prompt
metadata:
  type: feedback
---

When a completion-check prompt says "re-verdict every item against baseline X" but only gives
category letters + counts (e.g. "S1-S13, R1-R33... 97 items total"), the literal per-item wording
usually is NOT recoverable from disk — a baseline task-tracker run correctly saves a narrative
summary (facts, ambiguities, gotchas) to memory, not the itemized checklist itself, because a
mid-build checklist is "ephemeral task state" under this memory system's own exclusion rule. Don't
waste time hunting for a file that isn't there (I checked CHECKLIST.md, the plan doc, git log, and
the scratchpad before concluding this — worth ~2 tool calls of confirmation, not more).

**What worked**: reconstruct the full item set using (1) the exact category letters/counts given
(they're a hard constraint — sum them and confirm the total matches, e.g. 13+33+8+7+11+10+14+1=97,
which is a real consistency check that you've got the right partition), (2) every concrete fact
named anywhere in the completion prompt and the baseline memory (deviations, wiring traps, smoke
assertions, ambiguity notes — these usually pin down 15-30% of items exactly), (3) the actual spec
artifacts in the repo (a sibling sim's CSS for "matches design language," the plan doc's steering
notes), (4) standard competent-engineer inference for the rest, verified against code regardless of
whether the wording is exact. Then audit substance against the code as normal — the item's SUBSTANCE
being checked against real source is what matters, not verbatim fidelity to text nobody can produce.

**Why this is trustworthy despite not being verbatim**: every wiring trap and deviation the
completion prompt explicitly named (e.g. "F11 gate resolves only after X AND Y", "R24 visibility
floor is 0.42") maps to one specific, checkable line of code — those anchor the reconstruction and
get verified with full rigor regardless of how the surrounding items are numbered.

**How to apply**: state the recovery gap plainly in the audit output (don't silently present a
reconstructed list as if it were the original), but don't let the gap block delivering a real,
evidence-backed audit — the reconstruction-then-verify approach is not a lesser audit, just an
honestly-labeled one. See [[flowvid-2026-09-05-solar-system-sim-completion-audit]] for a worked
example (97/97 items, all resolved to DONE with file:line evidence).

**Addendum, 2026-09-05 (welcome-playlist completion pass):** this time the checklist baseline
*was* recoverable from disk — `CHECKLIST.md` itself existed in the repo, no reconstruction needed.
But the task also named a specific "agent memory" file that wasn't in this canonical directory
either. It turned up committed at `podcast-saas/backend-api/.claude/agent-memory/task-tracker/
welcome-tutorial-kit-master-checklist.md` — a SECOND, non-canonical `.claude/agent-memory/` tree,
one workspace package deep, almost certainly created because a memory-writing tool call ran with
its cwd inside `backend-api/` instead of the git root, and then got committed into product source
alongside real code. **Lesson: before concluding a named memory file "doesn't exist," search for
stray `.claude/agent-memory` trees nested under workspace packages, not just the git-root one** —
`find <repo-root> -path '*/.claude/agent-memory/*' -not -path '<repo-root>/.claude/*'` would have
found it in one call instead of several. Report the stray tree as a hygiene finding (it's committed
into a real package, so it's not neutral) but its CONTENT is still legitimate, recoverable baseline
— read it. See [[flowvid-2026-09-05-welcome-playlist-completion-audit]] for the full case.
