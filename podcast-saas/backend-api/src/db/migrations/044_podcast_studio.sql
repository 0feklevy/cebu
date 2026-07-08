-- 044: Podcast Studio — a standalone homepage product (Shows → Episodes).
--
-- NotebookLM-grade two-host generator: multi-agent writers' room → editable
-- per-turn script → ElevenLabs v3 export (dead-air removal + natural overlaps)
-- → single-channel MP4. Deliberately does NOT reuse the project-coupled `scripts`
-- table; podcasts are their own entity tree, unrelated to video projects.
--
-- Roles (owner spec, reversed vs the reference episode): teacher = Brittney,
-- learner = Titan. Voice ids are resolved + added to the ElevenLabs workspace at
-- seed time and stored per show.

-- ── Shows: the series (hosts, voices, personas, niche pack, style, memory) ────
CREATE TABLE IF NOT EXISTS podcast_shows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES orgs(id),
  created_by       UUID REFERENCES users(id),
  title            TEXT,
  description      TEXT,
  language         TEXT NOT NULL DEFAULT 'en',           -- per-episode override allowed
  teacher_name     TEXT NOT NULL DEFAULT 'Brittney',
  teacher_voice_id TEXT,
  learner_name     TEXT NOT NULL DEFAULT 'Titan',
  learner_voice_id TEXT,
  teacher_persona  TEXT,
  learner_persona  TEXT,
  niche_pack       TEXT NOT NULL DEFAULT 'general',      -- general | science | ...
  style_config     JSONB,                                -- humor level, analogy density, user_instructions
  memory_json      JSONB,                                -- rolling series memory (rebuilt from episode summaries)
  tts_seed         BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_podcast_shows_org     ON podcast_shows(org_id);
CREATE INDEX IF NOT EXISTS idx_podcast_shows_creator ON podcast_shows(created_by);

-- ── Episodes: a brief + sources → script versions → renders ───────────────────
CREATE TABLE IF NOT EXISTS podcast_episodes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id        UUID NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
  episode_number INTEGER,
  title          TEXT,
  brief          TEXT,
  target_minutes INTEGER NOT NULL DEFAULT 8,
  language       TEXT,                                   -- optional override of the show language
  status         TEXT NOT NULL DEFAULT 'draft',          -- draft|scripting|script_ready|approved|rendering|ready|failed
  tts_seed       BIGINT,                                 -- minted on first render, REUSED across renders
  memory_summary JSONB,                                  -- what THIS episode taught (upserted on approve)
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_show ON podcast_episodes(show_id);

-- ── Sources: the episode's brief material (files / urls / notes) ──────────────
CREATE TABLE IF NOT EXISTS podcast_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id   UUID NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('file', 'url', 'note')),
  storage_key  TEXT,
  source_url   TEXT,
  extracted_md TEXT,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',          -- pending|processing|ready|failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_podcast_sources_episode ON podcast_sources(episode_id);

-- ── Scripts: versioned output of the writers' room ────────────────────────────
CREATE TABLE IF NOT EXISTS podcast_scripts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     UUID NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'drafting',        -- drafting|reviewing|rewriting|compiling|ready|approved|failed
  claimed_at     TIMESTAMPTZ,                             -- job CAS claim (multi-stage status ⇒ dedicated claim column)
  story_json     JSONB,                                   -- Pass A: story world, focus sentence, beats+bridges, closing_return, curiosity ledger
  materials_json JSONB,                                   -- Pass B: analogy spine map, worked examples, grounding quotes
  review_json    JSONB,                                   -- Pass D: auditor / ear editor / narrative judge reports
  body_json      JSONB,                                   -- FINAL turns (tags INLINE in text)
  content_hash   TEXT,                                    -- "changed since render" banner
  telemetry      JSONB,                                   -- per-pass model / tokens / cost
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id, version)
);
CREATE INDEX IF NOT EXISTS idx_podcast_scripts_episode ON podcast_scripts(episode_id);

-- ── Chunk audio cache: per-chunk synth keyed on the exact request payload ─────
CREATE TABLE IF NOT EXISTS podcast_chunk_audio (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    UUID NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  chunk_hash    TEXT NOT NULL,                            -- sha256 of the exact serialized ElevenLabs request payload
  storage_key   TEXT,
  duration_ms   INTEGER,
  segments_json JSONB,                                    -- voice_segments (per-line boundaries)
  kind          TEXT NOT NULL DEFAULT 'chunk',            -- chunk | backchannel
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id, chunk_hash)
);
CREATE INDEX IF NOT EXISTS idx_podcast_chunk_audio_episode ON podcast_chunk_audio(episode_id);

-- ── Renders: an export run → single-channel MP4 (+ MP3) ───────────────────────
CREATE TABLE IF NOT EXISTS podcast_renders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     UUID NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  script_version INTEGER,
  status         TEXT NOT NULL DEFAULT 'queued',          -- queued|synthesizing|stitching|encoding|ready|failed
  claimed_at     TIMESTAMPTZ,
  progress       JSONB,                                   -- {stage, chunksDone, chunksTotal}
  master_mp4_key TEXT,
  master_mp3_key TEXT,
  duration_ms    INTEGER,
  script_hash    TEXT,                                    -- content_hash of the rendered script version
  timeline_json  JSONB,                                   -- computed gap/overlap map (debuggable)
  cost_cents     INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_podcast_renders_episode ON podcast_renders(episode_id);

-- ── Admin settings: podcast writers'-room model + effort (admin-tunable) ──────
ALTER TABLE admin_settings
  ADD COLUMN IF NOT EXISTS podcast_model  TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  ADD COLUMN IF NOT EXISTS podcast_effort TEXT NOT NULL DEFAULT 'max';

-- ── Writers'-room system prompts (code provides the real fallback when not customized) ──
INSERT INTO system_prompts (key, name, content) VALUES
  ('podcast_architect',      'Podcast — Story Architect',      'PLACEHOLDER - code falls back to PODCAST_ARCHITECT_SYSTEM_PROMPT when not customized'),
  ('podcast_materials',      'Podcast — Materials Hunter',     'PLACEHOLDER - code falls back to PODCAST_MATERIALS_SYSTEM_PROMPT when not customized'),
  ('podcast_playwright',     'Podcast — Playwright',           'PLACEHOLDER - code falls back to PODCAST_PLAYWRIGHT_SYSTEM_PROMPT when not customized'),
  ('podcast_fact_auditor',   'Podcast — Fact/Logic Auditor',   'PLACEHOLDER - code falls back to PODCAST_FACT_AUDITOR_SYSTEM_PROMPT when not customized'),
  ('podcast_ear_editor',     'Podcast — Ear Editor',           'PLACEHOLDER - code falls back to PODCAST_EAR_EDITOR_SYSTEM_PROMPT when not customized'),
  ('podcast_narrative_judge','Podcast — Narrative Judge',      'PLACEHOLDER - code falls back to PODCAST_NARRATIVE_JUDGE_SYSTEM_PROMPT when not customized'),
  ('podcast_v3_compiler',    'Podcast — v3 Production Compiler','PLACEHOLDER - code falls back to PODCAST_V3_COMPILER_SYSTEM_PROMPT when not customized'),
  ('podcast_turn_regen',     'Podcast — Single-Turn Regenerate','PLACEHOLDER - code falls back to PODCAST_TURN_REGEN_SYSTEM_PROMPT when not customized'),
  ('podcast_memory_scribe',  'Podcast — Memory Scribe',        'PLACEHOLDER - code falls back to PODCAST_MEMORY_SCRIBE_SYSTEM_PROMPT when not customized'),
  ('podcast_niche_science',  'Podcast — Science Niche Pack',   'PLACEHOLDER - code falls back to PODCAST_NICHE_SCIENCE_PROMPT when not customized'),
  ('podcast_hosts_general',  'Podcast — General Host Cards',   'PLACEHOLDER - code falls back to PODCAST_HOSTS_GENERAL_PROMPT when not customized')
ON CONFLICT (key) DO NOTHING;
