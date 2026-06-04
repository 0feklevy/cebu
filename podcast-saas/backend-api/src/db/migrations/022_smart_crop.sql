-- Smart portrait-crop metadata, computed in the background per video file.
-- The viewer reads the crop-metadata JSON (crop_key) to apply dynamic 9:16
-- cropping that keeps the active speaker centred on portrait devices.
ALTER TABLE video_files
  ADD COLUMN crop_status      TEXT NOT NULL DEFAULT 'none',  -- none | processing | ready | failed
  ADD COLUMN crop_key         TEXT,
  ADD COLUMN crop_source_hash TEXT,
  ADD COLUMN crop_error       TEXT;
