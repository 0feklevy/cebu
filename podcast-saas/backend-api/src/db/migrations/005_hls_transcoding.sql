-- Migration 005: HLS transcoding columns + simulation_url on sections

DO $$ BEGIN
  CREATE TYPE hls_transcode_status AS ENUM ('pending', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS hls_status      hls_transcode_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS hls_master_key  TEXT,
  ADD COLUMN IF NOT EXISTS hls_started_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hls_finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hls_error       TEXT;

ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS simulation_url TEXT;

CREATE INDEX IF NOT EXISTS idx_video_files_hls_status ON video_files(hls_status);
