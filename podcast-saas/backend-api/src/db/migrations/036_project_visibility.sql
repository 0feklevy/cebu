-- Per-project visibility (review fiji-contracts-002): private / unlisted / public.
-- Existing projects are backfilled to 'public' so current by-id access keeps working
-- (no retroactive lock-out of already-shared content); NEW projects default to 'private'
-- (drafts are not world-readable by id). Access is enforced by requireProjectAccess.

DO $$ BEGIN
  CREATE TYPE project_visibility AS ENUM ('private', 'unlisted', 'public');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility project_visibility;
UPDATE projects SET visibility = 'public' WHERE visibility IS NULL;
ALTER TABLE projects ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE projects ALTER COLUMN visibility SET NOT NULL;
