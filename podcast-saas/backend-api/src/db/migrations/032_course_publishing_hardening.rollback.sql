-- Rollback for migration 032 — reverts the hardening, restoring the original 030
-- archive checks. Run manually (the migrate runner is forward-only):
--   psql "$DATABASE_URL" -f src/db/migrations/032_course_publishing_hardening.rollback.sql
--   DELETE FROM schema_migrations WHERE filename = '032_course_publishing_hardening.sql';

DROP TABLE IF EXISTS project_redirect_targets;

ALTER TABLE course_lessons DROP CONSTRAINT IF EXISTS uniq_lesson_id_project;

ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_archived_requires_disposition_chk;
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_archived_requires_timestamp_chk;
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_redirect_requires_url_chk;
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_replacement_url_only_redirect_chk;
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_non_archived_clean_chk;

-- Restore the original 030 archive checks.
DO $$ BEGIN
  ALTER TABLE courses ADD CONSTRAINT courses_archive_redirect_chk
    CHECK (archive_disposition IS DISTINCT FROM 'redirect' OR archived_replacement_url IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE courses ADD CONSTRAINT courses_archive_disposition_state_chk
    CHECK (publish_state = 'archived' OR archive_disposition IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
