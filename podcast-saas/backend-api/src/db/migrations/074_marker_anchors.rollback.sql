-- Rollback for 074. Dropping the columns returns every marker to absolute placement, which is
-- exactly where they are today — no data is lost that was not derived.
ALTER TABLE timeline_markers
  DROP COLUMN IF EXISTS anchor_video_file_id,
  DROP COLUMN IF EXISTS anchor_offset_sec,
  DROP COLUMN IF EXISTS placement_mode;
