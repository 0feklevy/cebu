-- Migration 077: vendor configuration becomes admin-manageable (owner directive 2026-08-23:
-- "כמה שיותר להקל על env" — after an outage where the one screen that looked like the source of
-- truth was not).
--
-- 1) 'groq' joins the provider enum: the STT key was the last vendor secret readable only from
--    the container env.
ALTER TYPE provider ADD VALUE IF NOT EXISTS 'groq';

-- 2) The Anam DEFAULT look/brain pins move into admin_settings (env stays the fallback). These
--    were env-only module-load captures; the 'guide' outage showed how invisible they are.
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS avatar_default_avatar_id text;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS avatar_default_voice_id text;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS avatar_default_llm_id text;
