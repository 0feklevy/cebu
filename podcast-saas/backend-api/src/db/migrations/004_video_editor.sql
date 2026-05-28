-- Migration 004: Video editor tables
-- Adds video_files and timeline_sections for the interactive video editor

-- Add title column to projects (new editor uses this instead of topic)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS title TEXT;

-- Enum for video file upload status
DO $$ BEGIN
  CREATE TYPE video_file_status AS ENUM ('uploading', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Video files uploaded to a project
CREATE TABLE IF NOT EXISTS video_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  file_size    BIGINT,
  storage_key  TEXT,
  status       video_file_status NOT NULL DEFAULT 'uploading',
  duration_sec REAL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_files_project ON video_files(project_id);

-- Timeline sections flagged by the editor
CREATE TABLE IF NOT EXISTS timeline_sections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_file_id  UUID NOT NULL REFERENCES video_files(id) ON DELETE CASCADE,
  start_sec      REAL NOT NULL,
  end_sec        REAL NOT NULL,
  type           TEXT NOT NULL,
  label          TEXT,
  notes          TEXT,
  sort_order     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timeline_sections_project ON timeline_sections(project_id);
CREATE INDEX IF NOT EXISTS idx_timeline_sections_video   ON timeline_sections(video_file_id);
