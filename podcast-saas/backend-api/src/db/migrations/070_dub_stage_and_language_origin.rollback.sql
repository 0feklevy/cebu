DROP INDEX IF EXISTS idx_video_dubs_video_status;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_source_language_origin_chk;
ALTER TABLE projects DROP COLUMN IF EXISTS source_language_origin;
ALTER TABLE video_dubs DROP COLUMN IF EXISTS stage_entered_at;
ALTER TABLE video_dubs DROP COLUMN IF EXISTS stage;
