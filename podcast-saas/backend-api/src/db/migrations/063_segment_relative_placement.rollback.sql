-- Manual rollback helper for 063. Not run by the migration runner.
--
-- YOU ALMOST CERTAINLY DO NOT WANT THIS. The change is additive and the dual read means the
-- previous application code ignores every column below: `global_offset_sec` was never stopped being
-- written, so a CODE rollback needs no schema change at all. Leave the columns in place.
--
-- Dropping them is only for abandoning D-01 entirely, and it is LOSSY in a way 062's rollback was
-- not. Anchors are written by author drags and by new placements — they are the only record of
-- which segment the author meant, and re-deriving them later would give a different answer, since
-- re-deriving from an absolute second is the exact operation the ruling forbids as a backfill.
-- Every row dropped here reverts to being pinned to a wall-clock second.
ALTER TABLE timeline_sections
  DROP CONSTRAINT IF EXISTS timeline_sections_placement_mode_check;

ALTER TABLE timeline_sections
  DROP COLUMN IF EXISTS placement_mode,
  DROP COLUMN IF EXISTS anchor_offset_sec,
  DROP COLUMN IF EXISTS anchor_video_file_id;

ALTER TABLE video_generation_jobs
  DROP COLUMN IF EXISTS target_anchor_offset_sec,
  DROP COLUMN IF EXISTS target_anchor_video_file_id;
