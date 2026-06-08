-- Store the generated caption WebVTT directly in the database so captions do not
-- depend on object-storage write access (the managed/dev R2 token may be
-- read-only) and survive redeploys. The DB is the source of truth; captions_vtt_key
-- (object storage) becomes an optional/legacy backup.
ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS captions_vtt TEXT;
