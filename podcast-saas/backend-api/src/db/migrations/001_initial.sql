-- Phase 1 migration: all Phase 1 tables + enums

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE project_tier AS ENUM ('standard', 'premium', 'hybrid');
CREATE TYPE project_status AS ENUM ('draft', 'ingesting', 'scripting', 'script_ready', 'approved', 'generating', 'ready', 'failed');
CREATE TYPE format AS ENUM ('16:9', '9:16', '1:1');
CREATE TYPE pacing AS ENUM ('relaxed', 'standard', 'energetic');
CREATE TYPE emotional_style AS ENUM ('analytical', 'warm', 'playful', 'serious');
CREATE TYPE corpus_source_type AS ENUM ('pdf', 'web', 'youtube', 'audio', 'image', 'text');
CREATE TYPE corpus_ingestion_status AS ENUM ('pending', 'processing', 'ready', 'failed');
CREATE TYPE script_status AS ENUM ('drafting', 'rewriting', 'validating', 'ready', 'approved', 'failed');
CREATE TYPE provider AS ENUM ('claude', 'openai', 'gemini');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- ── orgs ──────────────────────────────────────────────────────────────────
CREATE TABLE orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  owner_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT UNIQUE NOT NULL,
  email TEXT,
  display_name TEXT,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  default_org_id UUID REFERENCES orgs(id),
  weekly_token_limit INTEGER,
  monthly_token_limit INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

-- ── api_keys ──────────────────────────────────────────────────────────────
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  user_id UUID REFERENCES users(id),
  provider provider NOT NULL,
  encrypted_key TEXT NOT NULL,
  kms_key_id TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── hosts ──────────────────────────────────────────────────────────────────
CREATE TABLE hosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  persona_text TEXT NOT NULL,
  portrait_ref_urls TEXT[],
  voice_id TEXT,
  seed BIGINT,
  prompt_lock TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── projects ──────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  created_by UUID REFERENCES users(id),
  title TEXT,
  tier project_tier NOT NULL DEFAULT 'standard',
  topic TEXT,
  style_preset TEXT,
  host_a_id UUID REFERENCES hosts(id),
  host_b_id UUID REFERENCES hosts(id),
  format format NOT NULL DEFAULT '16:9',
  target_duration_min INTEGER,
  pacing pacing,
  emotional_style emotional_style,
  status project_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── corpora ──────────────────────────────────────────────────────────────
CREATE TABLE corpora (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type corpus_source_type NOT NULL,
  source_url TEXT,
  storage_url TEXT,
  extracted_md TEXT,
  hash TEXT,
  metadata JSONB,
  ingestion_status corpus_ingestion_status NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── scripts ──────────────────────────────────────────────────────────────
CREATE TABLE scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  structural_json JSONB,
  draft_body_json JSONB,
  body_json JSONB,
  validation_errors JSONB,
  pass0_model TEXT,
  pass0_input_tokens INTEGER,
  pass0_output_tokens INTEGER,
  pass0_cost_cents INTEGER,
  pass1_model TEXT,
  pass1_input_tokens INTEGER,
  pass1_output_tokens INTEGER,
  pass1_cost_cents INTEGER,
  pass2_model TEXT,
  pass2_input_tokens INTEGER,
  pass2_output_tokens INTEGER,
  pass2_cost_cents INTEGER,
  status script_status NOT NULL DEFAULT 'drafting',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, version)
);

-- ── system_prompts ────────────────────────────────────────────────────────
CREATE TABLE system_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_customized BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── admin_settings ────────────────────────────────────────────────────────
CREATE TABLE admin_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  billing_enabled BOOLEAN NOT NULL DEFAULT true,
  generation_paused BOOLEAN NOT NULL DEFAULT false,
  generation_paused_message TEXT,
  maintenance_mode BOOLEAN NOT NULL DEFAULT false,
  maintenance_message TEXT,
  anonymous_user_limit INTEGER NOT NULL DEFAULT 3,
  default_provider provider NOT NULL DEFAULT 'gemini',
  temperature REAL NOT NULL DEFAULT 0.7,
  max_tokens INTEGER NOT NULL DEFAULT 8192,
  extended_thinking_enabled BOOLEAN NOT NULL DEFAULT true,
  thinking_budget_tokens INTEGER NOT NULL DEFAULT 10000,
  utility_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
  generation_model TEXT NOT NULL DEFAULT 'gemini-2.5-pro',
  complex_model TEXT NOT NULL DEFAULT 'gemini-2.5-pro',
  complex_min_corpus_tokens INTEGER NOT NULL DEFAULT 50000,
  complex_min_retries INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_settings_singleton CHECK (id = 1)
);

-- ── token_usage ───────────────────────────────────────────────────────────
CREATE TABLE token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  project_id UUID REFERENCES projects(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  used_personal_key BOOLEAN NOT NULL DEFAULT false,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── jobs ─────────────────────────────────────────────────────────────────
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  project_id UUID REFERENCES projects(id),
  status job_status NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- ── Seed admin_settings singleton ─────────────────────────────────────────
INSERT INTO admin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Seed system_prompts ───────────────────────────────────────────────────
-- Contents are loaded from shared/src/prompts/*.txt at application startup
-- via the SystemPromptSeeder. Rows are inserted only if they don't exist.
INSERT INTO system_prompts (key, name, content) VALUES
  ('structural_analysis', 'Structural Analysis (Pass 0)', 'PLACEHOLDER - will be seeded by application startup'),
  ('script_draft', 'Script Draft (Pass 1)', 'PLACEHOLDER - will be seeded by application startup'),
  ('script_rewrite', 'Script Rewrite (Pass 2)', 'PLACEHOLDER - will be seeded by application startup'),
  ('content_moderation', 'Content Moderation', 'You are a content moderation system. Review the provided text and determine if it violates content policies. Check for: hate speech, explicit sexual content, graphic violence, illegal activity instructions, or harmful content targeting minors. Respond with JSON: {"flagged": boolean, "reason": string | null}')
ON CONFLICT (key) DO NOTHING;

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX idx_projects_org_id ON projects(org_id);
CREATE INDEX idx_projects_created_by ON projects(created_by);
CREATE INDEX idx_corpora_project_id ON corpora(project_id);
CREATE INDEX idx_scripts_project_id ON scripts(project_id);
CREATE INDEX idx_token_usage_user_id ON token_usage(user_id);
CREATE INDEX idx_token_usage_occurred_at ON token_usage(occurred_at);
CREATE INDEX idx_jobs_project_id ON jobs(project_id);
CREATE INDEX idx_jobs_status ON jobs(status);
