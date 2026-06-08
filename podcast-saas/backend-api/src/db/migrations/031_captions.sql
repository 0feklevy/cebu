-- Auto captions generated from source video audio.
ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS captions_status      TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS captions_vtt_key     TEXT,
  ADD COLUMN IF NOT EXISTS captions_source_hash TEXT,
  ADD COLUMN IF NOT EXISTS captions_error       TEXT,
  ADD COLUMN IF NOT EXISTS captions_updated_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_video_files_captions_status ON video_files(captions_status);
