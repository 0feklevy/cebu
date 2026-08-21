---
name: fleet-brief-claims-need-reverification
description: Orchestrator briefs in this fleet arrive with pre-formed "already established" suspects that are sometimes wrong — verify each against the code before building on it
metadata:
  type: feedback
---

When the orchestrator hands over a brief containing "WHAT I ALREADY ESTABLISHED", treat every item
as a hypothesis to verify, not a premise. Report the corrections explicitly in the findings file.

**Why:** on the 2026-08-16 b-roll investigation the brief named `jobs/video.generate.ts:150` as the
"prime candidate" for writing a NULL `global_offset_sec`; the column it reads is `notNull()` and
zod-validated, so it cannot. It also named `transcriptPropagation.ts` as touching b-roll, which it
does not. A third claim (`singletonKeyFor` dedupes `crop` only) was still true but its consequence
had moved, because `PGBOSS_JOB_NAMES` had grown since the claim was written. Building on any of
these would have produced confident, wrong findings — which the protocol says cost more than ten
missed nits.

**How to apply:** for each stated suspect, open the cited line AND the schema/validation behind it
before writing anything. Add a short "What the brief got wrong" section near the top of the findings
file so the orchestrator sees the correction rather than a silent omission. The same discipline
applies to older findings referenced as "already CONFIRMED" — re-read the cited line, since the code
moves between runs.
