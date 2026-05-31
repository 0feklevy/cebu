-- Add broll_volume to timeline_sections for per-section audio gain control (0.0–1.0)
ALTER TABLE timeline_sections
  ADD COLUMN broll_volume REAL NOT NULL DEFAULT 1.0;
