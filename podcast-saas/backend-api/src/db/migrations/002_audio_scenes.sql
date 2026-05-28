-- Phase 2 migration: audio renders, scenes, camera plans
-- Extends the Phase 1 schema with post-approval pipeline tables.

-- ── Extend enums ──────────────────────────────────────────────────────────────
ALTER TYPE provider ADD VALUE IF NOT EXISTS 'elevenlabs';

-- ── New enums ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE tts_provider AS ENUM ('elevenlabs', 'gemini');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE shot_type AS ENUM ('wide', 'closeup_a', 'closeup_b', 'reaction_a', 'reaction_b');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE audio_render_status AS ENUM ('pending', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Extend admin_settings ────────────────────────────────────────────────────
ALTER TABLE admin_settings
  ADD COLUMN IF NOT EXISTS tts_provider       TEXT    NOT NULL DEFAULT 'elevenlabs',
  ADD COLUMN IF NOT EXISTS elevenlabs_model   TEXT    NOT NULL DEFAULT 'eleven_v3',
  ADD COLUMN IF NOT EXISTS default_voice_id_a TEXT,
  ADD COLUMN IF NOT EXISTS default_voice_id_b TEXT;

-- ── audio_renders ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audio_renders (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID           NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version    INTEGER        NOT NULL,
  status            audio_render_status NOT NULL DEFAULT 'pending',
  provider          tts_provider,
  master_audio_url  TEXT,
  duration_ms       INTEGER,
  alignment_json_url TEXT,
  cost_cents        INTEGER        NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audio_renders_project ON audio_renders(project_id, script_version);

-- ── scenes ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenes (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID           NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version    INTEGER        NOT NULL,
  idx               INTEGER        NOT NULL,
  speaker           TEXT           NOT NULL CHECK (speaker IN ('host_a','host_b')),
  start_ms          INTEGER        NOT NULL,
  end_ms            INTEGER        NOT NULL,
  transcript        TEXT           NOT NULL,
  aligned_words     JSONB,
  emotion           TEXT           NOT NULL DEFAULT 'neutral',
  audio_tags        TEXT[]         NOT NULL DEFAULT '{}',
  is_hook           BOOLEAN        NOT NULL DEFAULT false,
  audio_chunk_url   TEXT,
  shot              shot_type,
  active_version    INTEGER        NOT NULL DEFAULT 1,
  UNIQUE (project_id, script_version, idx)
);

CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id, script_version, idx);

-- ── camera_plans ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS camera_plans (
  id             UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version INTEGER  NOT NULL,
  cuts_json      JSONB    NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, script_version)
);
