-- Creator-controlled permalinks (WordPress/base44-style): a public project or
-- playlist can be reached at {PUBLIC_SITE_URL}/{slug}. NULL slug = no permalink.
-- The random share_token links (/v/:token, /pl/:token) remain the unlisted links.
--
-- Slugs share ONE namespace across projects AND playlists (both resolve at the
-- site root). Cross-table uniqueness is enforced in the permalink service (it
-- checks both tables before writing); the partial unique indexes below guard
-- same-table races. The public resolver breaks a theoretical cross-table tie
-- deterministically (project wins).

ALTER TABLE projects  ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS slug TEXT;

-- Same kebab-token rule as courses (courses_slug_format_chk, migration 030).
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_slug_format_chk
    CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE playlists ADD CONSTRAINT playlists_slug_format_chk
    CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_projects_slug  ON projects (slug)  WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_playlists_slug ON playlists (slug) WHERE slug IS NOT NULL;
