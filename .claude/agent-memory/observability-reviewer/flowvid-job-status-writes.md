---
name: flowvid-job-status-writes
description: FlowVid's background job status handling is unusually well engineered (terminal failed-status writes + reaper sweeps on nearly every pipeline) — the interesting findings are the ONE pipeline that lacks it and the missing correlation-id layer, not "job throws and status never updates" in general.
metadata:
  type: project
---

As of the 2026-08-15 observability review (run `2026-08-15T2109`, commit `2d187e3`), every one of
the 11 job types in `backend-api/src/queue/types.ts` (transcode, captions, crop, metadata,
podcast_script, podcast_render, podcast_clips, podcast_mix_export, video_generate,
project_duplicate, project_export) reliably writes a terminal `failed`/`cancelled` status with a
user-showable reason on throw, and most have a startup or timer-based reaper
(`recoverStuckTranscodes`, `recoverStuckCrops`, `recoverStuckSimulations`,
`recoverStuckPodcastScripts/Renders/Mixes`, `recoverStuckVideoGenerations`,
`sweepAbandonedExports`, `sweepAbandonedDuplications`) for the crash-mid-flight case. `server.ts`'s
startup block (~line 642) is the canonical list of these sweeps.

**The one gap found:** corpus ingestion (`services/ingestion/CorpusBuilder.ts`) runs fire-and-forget
in the web process itself (not through the queue at all — `corpus.controller.ts` calls
`builder.ingest(...)` directly), sets `ingestion_status: 'processing'`, and has no equivalent
`recoverStuckCorpusIngestion()` sweep — a crash mid-ingest orphans the row forever. This looks like
an oversight (every sibling pipeline got the treatment) rather than a design choice, since the
codebase's own comments describe each new reaper as mirroring the previous one's shape
(`recoverStuckSimulations`'s comment literally says "mirrors recoverStuckCrops"). Check whether this
has since been fixed before re-filing it.

**Where the real gaps are instead:** (1) no request/job correlation id threaded through logs at all
— `request.id` is never read or logged anywhere in the tree, and `lib/logger.ts` has no
`mixin`/child-binding convention, so cross-referencing one user's incident across log lines is
timestamp-matching, not grep; (2) `pipeline-stats.controller.ts` surfaces project/user/revenue/video/
sim counts but nothing for `project_exports`/`podcast_renders`/`video_generation_jobs`/queue depth —
the pipelines with the most sophisticated failure-classification code (`ProjectExportService.ts`'s
`classifyExportFailure`) are invisible in the one dashboard meant to catch systemic failure rates.

**How to apply:** don't spend review time re-verifying "does job X write a failed status" from
scratch each run — it does, almost everywhere, and the fix for corpus is small (mirror
`recoverStuckCrops`). Spend the time on correlation-id plumbing and metrics gaps instead, and on
re-checking this list is still accurate (jobs get added; check `queue/types.ts`'s `JobName` union
for new entries not covered by the list above).
