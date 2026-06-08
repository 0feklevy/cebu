-- Migration 028: Ask-the-Avatar feature (ported from darwin-avatar)
-- Adds the interactive avatar's visual Library (basic + extended) and cross-session memory.
--
--   • avatar_visuals      — the visual Library. scope='basic' are assets the editor put
--                            in the project; scope='extended' are visuals the avatar
--                            generated on the fly and stored for reuse.
--   • avatar_conversations — per-session conversation turns (memory).
--   • avatar_profiles      — extracted personal facts per session.

CREATE TABLE IF NOT EXISTS avatar_visuals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = global library
  scope              TEXT NOT NULL DEFAULT 'extended',                 -- basic | extended
  source             TEXT NOT NULL DEFAULT 'generated',                -- editor | generated | uploaded
  character_id       TEXT NOT NULL DEFAULT 'einstein',
  visual_type        TEXT NOT NULL,                                    -- image | equation | chart | diagram | simulation
  lookup_key         TEXT,                                             -- normalized text for dedup / retrieval
  caption            TEXT,
  alt_text           TEXT,
  image_url          TEXT,
  image_key          TEXT,                                             -- storage key (for deletion)
  dalle_prompt       TEXT,
  visual_spec        JSONB,                                            -- full VisualResult / sim spec
  sim_storage_prefix TEXT,                                             -- storage prefix for tier-2 sims
  sim_entry_url      TEXT,                                             -- public URL of a stored simulation
  use_count          INTEGER NOT NULL DEFAULT 0,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avatar_visuals_project   ON avatar_visuals(project_id);
CREATE INDEX IF NOT EXISTS idx_avatar_visuals_type       ON avatar_visuals(visual_type);
CREATE INDEX IF NOT EXISTS idx_avatar_visuals_character  ON avatar_visuals(character_id);
CREATE INDEX IF NOT EXISTS idx_avatar_visuals_lookup     ON avatar_visuals(lookup_key);
CREATE INDEX IF NOT EXISTS idx_avatar_visuals_scope      ON avatar_visuals(scope);

CREATE TABLE IF NOT EXISTS avatar_conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key  TEXT NOT NULL,                 -- `${userKey}:${projectId}:${characterId}`
  character_id TEXT NOT NULL,
  project_id   UUID REFERENCES projects(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,                 -- user | persona
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avatar_conversations_session ON avatar_conversations(session_key, created_at);

CREATE TABLE IF NOT EXISTS avatar_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT NOT NULL UNIQUE,
  facts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
