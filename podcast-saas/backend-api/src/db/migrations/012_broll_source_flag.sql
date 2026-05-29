ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS is_broll BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: mark any video_file that was created by AI generation as is_broll = true
UPDATE video_files
SET is_broll = TRUE
WHERE id IN (
  SELECT video_file_id
  FROM video_generation_jobs
  WHERE video_file_id IS NOT NULL
);
