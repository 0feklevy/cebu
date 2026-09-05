-- 085 — the welcome-project seeding (dark by construction).
--
-- Every new user receives a personal, editable clone of the shared "Welcome to Flow Video"
-- template (rows per user; heavy bytes shared — see tutorial-kit/seeding/DESIGN.md). This
-- migration adds only the bookkeeping; the feature stays off until BOTH the env override and
-- the admin flag say otherwise, and the template project id is configured.

-- Idempotency layer 1: the pointer, set in the same transaction as the clone's project insert.
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_playlist_id uuid REFERENCES playlists(id) ON DELETE SET NULL;

-- Idempotency layer 2: at most one seeded project per user, enforced where it cannot race.
-- (Partial index — drizzle's builder has no WHERE, so this lives in SQL only.)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_welcome_seed boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_welcome_project_per_user
  ON projects (created_by) WHERE is_welcome_seed;

-- The admin half of the two-layer gate (env WELCOME_SEED_ENABLED overrides when set).
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS welcome_seed_enabled boolean NOT NULL DEFAULT false;
