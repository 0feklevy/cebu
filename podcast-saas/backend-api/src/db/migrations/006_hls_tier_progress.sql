-- Track which HLS tier is currently being transcoded, and when 360p is ready
ALTER TABLE video_files ADD COLUMN IF NOT EXISTS hls_current_tier text;
ALTER TABLE video_files ADD COLUMN IF NOT EXISTS hls_360p_key text;
