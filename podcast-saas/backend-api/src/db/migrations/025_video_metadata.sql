-- Auto-generated video metadata: thumbnail, name, description.
ALTER TABLE projects
  ADD COLUMN thumbnail_url    TEXT,        -- URL of the auto-generated thumbnail frame
  ADD COLUMN thumbnail_key    TEXT,        -- storage key for deletion
  ADD COLUMN metadata_status  TEXT NOT NULL DEFAULT 'none';  -- none | processing | ready | failed
