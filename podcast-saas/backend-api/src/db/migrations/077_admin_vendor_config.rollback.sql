-- Enum values cannot be removed in place (see 075); the columns can.
ALTER TABLE admin_settings DROP COLUMN IF EXISTS avatar_default_avatar_id;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS avatar_default_voice_id;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS avatar_default_llm_id;
