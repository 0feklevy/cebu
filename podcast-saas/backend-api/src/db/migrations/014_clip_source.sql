-- Migration 014: clip_source_video_id + clip_in_sec on timeline_sections
-- Supports the new "clip" section type where a section references a library
-- video at a specific in-point rather than the main recording.

ALTER TABLE timeline_sections
  ADD COLUMN clip_source_video_id UUID REFERENCES video_files(id) ON DELETE SET NULL,
  ADD COLUMN clip_in_sec REAL DEFAULT 0;
