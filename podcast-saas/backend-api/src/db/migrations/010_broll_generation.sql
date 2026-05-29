-- Migration 010: B-roll track support + AI video generation jobs

-- Extend timeline_sections with track info and global positioning for B-roll clips
ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS track TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS global_offset_sec REAL;

-- track = 'main'  → classic section, position derived from clip order (global_offset_sec unused)
-- track = 'broll' → B-roll overlay; global_offset_sec is the absolute start time on the main timeline

CREATE INDEX IF NOT EXISTS idx_sections_track ON timeline_sections(project_id, track);

-- AI video generation jobs table
CREATE TABLE IF NOT EXISTS video_generation_jobs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section_id               UUID REFERENCES timeline_sections(id) ON DELETE SET NULL,
  video_file_id            UUID REFERENCES video_files(id) ON DELETE SET NULL,
  model                    TEXT NOT NULL,
  original_prompt          TEXT NOT NULL,
  enhanced_prompt          TEXT,
  enhance_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  target_duration_sec      REAL NOT NULL,
  target_global_offset_sec REAL NOT NULL,
  external_task_id         TEXT,
  status                   TEXT NOT NULL DEFAULT 'queued',
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vgj_project ON video_generation_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_vgj_status  ON video_generation_jobs(project_id, status);
