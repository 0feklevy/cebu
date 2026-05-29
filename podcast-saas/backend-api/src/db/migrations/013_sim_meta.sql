ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS sim_meta JSONB;
