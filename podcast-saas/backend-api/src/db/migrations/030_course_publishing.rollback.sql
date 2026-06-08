-- Rollback for migration 030 — Course publishing data model.
--
-- The migrate runner is forward-only; run this manually to reverse 030:
--   psql "$DATABASE_URL" -f src/db/migrations/030_course_publishing.rollback.sql
--   DELETE FROM schema_migrations WHERE filename = '030_course_publishing.sql';
--
-- SAFETY: this drops only the publishing layer (courses, course_lessons,
-- course_custom_domains) and its enums. It does NOT touch projects, playlists,
-- playlist_items or share tokens, so the legacy public surface keeps working.
-- All course/lesson data is destroyed — back up `courses` and `course_lessons`
-- first if a re-backfill would not reproduce author edits (SEO overrides, slugs).
--
-- Drop order respects FKs: dependents (which reference courses) before courses,
-- then the enums (no type can be dropped while a column still uses it).

-- (project_redirect_targets is created by migration 032; roll that back first.)
DROP TABLE IF EXISTS course_custom_domains;
DROP TABLE IF EXISTS course_lessons;
DROP TABLE IF EXISTS courses;

DROP TYPE IF EXISTS archive_disposition;
DROP TYPE IF EXISTS course_kind;
DROP TYPE IF EXISTS publish_state;
