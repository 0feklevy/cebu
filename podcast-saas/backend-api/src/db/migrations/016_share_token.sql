-- Add share token to projects for publicly shareable video links
ALTER TABLE projects
  ADD COLUMN share_token TEXT UNIQUE DEFAULT NULL,
  ADD COLUMN share_enabled_at TIMESTAMPTZ DEFAULT NULL;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
