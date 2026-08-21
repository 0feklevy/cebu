---
name: broll-placement-incident
description: Open production complaint "b-rolls jump in the wrong place" (raised 2026-08-16) — the ranked root-cause conclusion from the data-path trace, so it is not re-derived from scratch
metadata:
  type: project
---

A high-priority production complaint — "b-rolls jump in the wrong place" — was traced on
2026-08-16 in review run `.claude/review/runs/2026-08-15T2109`. Full findings with fixes,
backfill SQL and regression tests are in `findings/broll-data.md` (ids `broll-data-001`..`010`).

Ranked conclusion, best explanation first:

1. `timeline_sections.global_offset_sec` is an **absolute** coordinate whose origin is a cumulative
   sum of `video_files.duration_sec`, and that column is overwritten after the offsets are stored
   (client-reported seed on upload → ffprobe value after transcode; also on video replace and
   delete). Nothing re-anchors the stored offsets. This is the only cause that displaces a b-roll
   deterministically with no second actor.
2. A section with `track='broll'` + `type='clip'` + `clip_source_video_id` is emitted into BOTH
   `broll_clips` and `clip_overlays` at two different offsets; the player concatenates them.
3. The player-config section query has no deterministic order and no tie-break, which is what makes
   the symptom intermittent.

**Why:** the user reported it as a live customer-facing bug, not a code-review nit, so the deliverable
was cause-ranking plus repair SQL rather than a finding list.

**How to apply:** if b-roll placement comes up again, start from cause (1) and check whether the
anchor-column fix (`anchor_video_file_id` + `anchor_offset_sec`) ever shipped before re-tracing.
Two claims in the original brief were wrong and were corrected in the findings file: `video.generate.ts`
CANNOT write a NULL offset, and `transcriptPropagation.ts` does not touch b-roll placement.
Related: [[fleet-brief-claims-need-reverification]].
