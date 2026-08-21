---
name: flowvid-host-and-fleet-context
description: FlowVid production is a single 2-vCPU Docker Compose VM, and the user runs a large parallel agent fleet — the advisor owns the structural layer, not defects
metadata:
  type: project
---

**Fact 1: production is one small VM.** FlowVid deploys via `podcast-saas/deploy/docker-compose.yml`
to a single **2-vCPU** VM running nginx + backend + worker + client-web + admin-web, with Postgres
external (Supabase). The capture compose overlay records a real OOM kill at 908 MB during plain
ffmpeg assembly.

**Why:** every "just run it in parallel" or "add a pool" recommendation is wrong by default here.
The host is already over-committed during an export: the capture container defaults to `--cpus 2`
(the whole machine) while ffmpeg and five other services keep running.

**How to apply:** size every concurrency recommendation against ~1.5 usable vCPU for background work.
Prefer levers that reduce work (fewer pixels, fewer readbacks, caching) over levers that add
parallelism. Say plainly when the fiji pattern (warm browser pool, multi-cloud, fairness dispatcher)
is more abstraction than this host or team should carry.

**Fact 2: the advisor is one of many agents, with a specific lane.** The user runs a large parallel
review fleet (16 agents hunting defects on one occasion). The `fiji-advisor` is asked for the
**structural/architectural** layer explicitly so as not to duplicate that work.

**Why:** duplicated defect lists waste the user's review budget and dilute the one thing this role
adds — a ranked, phased, cross-cutting plan.

**How to apply:** when a request overlaps the defect fleet, stay structural: cost models, target
states, phased and independently-revertible migrations, and an explicit value-per-effort ranking at
the end. Correct the brief when it is wrong (e.g. asserting a synchronous cap that does not exist) —
that correction is often worth more than the plan.

Related: [[reference-doc-staleness]].
