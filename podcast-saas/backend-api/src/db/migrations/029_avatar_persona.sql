-- Migration 029: per-video avatar persona config + BYOK Anam keys.
--   • projects.avatar_config         — per-video persona settings (greeting,
--                                       system prompt, knowledge, language,
--                                       avatarId/voiceId/llmId, advanced flags).
--   • users.anam_api_key_encrypted   — the user's own Anam API key (encrypted).
--   • admin_settings.avatar_byok_enabled — when true, a video uses its owner's
--                                       Anam key (bring-your-own-key); otherwise
--                                       the shared server ANAM_API_KEY is used.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS avatar_config JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anam_api_key_encrypted TEXT;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS avatar_byok_enabled BOOLEAN NOT NULL DEFAULT false;
