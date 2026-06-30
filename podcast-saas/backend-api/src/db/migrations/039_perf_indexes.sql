-- 039_perf_indexes.sql
-- Hot-path indexes that were missing. buildPlayerConfig (every player-config / share /
-- playlist-item / course render) queries image_files and audio_files by project_id, but neither
-- table had an index on it — so each call did a full Seq Scan whose cost grows with the total
-- number of uploaded images/audio across ALL tenants, not per project (review database-002).
CREATE INDEX IF NOT EXISTS idx_image_files_project ON image_files(project_id);
CREATE INDEX IF NOT EXISTS idx_audio_files_project ON audio_files(project_id);
