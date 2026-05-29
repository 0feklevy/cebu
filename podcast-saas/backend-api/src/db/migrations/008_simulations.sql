-- Migration 008: Simulations library
CREATE TABLE IF NOT EXISTS simulations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  storage_prefix   TEXT NOT NULL,
  entry_file       TEXT NOT NULL,
  bridge_functions JSONB DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'processing',
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_simulations_project ON simulations(project_id);
