-- Migration 009: Link timeline_sections to simulations library
ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS simulation_id UUID REFERENCES simulations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sim_script    TEXT;
