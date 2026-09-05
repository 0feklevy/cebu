-- Rollback of 085 — drops only what 085 added.
DROP INDEX IF EXISTS uniq_welcome_project_per_user;
ALTER TABLE projects DROP COLUMN IF EXISTS is_welcome_seed;
ALTER TABLE users DROP COLUMN IF EXISTS welcome_playlist_id;
ALTER TABLE users DROP COLUMN IF EXISTS welcome_project_id;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS welcome_seed_enabled;
