-- Migration 030 — Course publishing + SEO data model (Phase 1, data model only)
--
-- Introduces a dedicated publishing layer on top of the reusable `projects`
-- entity, WITHOUT a polymorphic source_type/source_id pointer:
--
--   courses              — owns the public URL, publication state, canonical
--                          host, course-level SEO and (future) custom-domain
--                          configuration. A course has one OR many lessons.
--   course_lessons       — owns the lesson slug, ordering and optional
--                          lesson-specific SEO. References a reusable project.
--   course_custom_domains — future custom-domain → course mapping. Architected
--                          now so custom domains can be added later without
--                          changing the course/lesson data model.
--
-- This migration does NOT touch projects, playlists, playlist_items or the
-- share-token columns/routes. It does NOT add SEO columns to projects or
-- playlists. The backfill that populates courses from playlists/projects is a
-- separate, idempotent, dry-runnable script (not run by this migration).
--
-- Rollback: see 030_course_publishing.rollback.sql

-- ── Enums ──────────────────────────────────────────────────────────────────
-- CREATE TYPE has no IF NOT EXISTS; guard so the migration is rerunnable.
DO $$ BEGIN
  CREATE TYPE publish_state AS ENUM ('draft', 'unlisted', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE course_kind AS ENUM ('single', 'playlist');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Disposition of an archived course — drives later HTTP behaviour:
--   temporary → temporarily unpublished (later renders 404, may return)
--   permanent → permanently removed     (later renders 410 Gone)
--   redirect  → archived with a valid replacement (later renders 301)
DO $$ BEGIN
  CREATE TYPE archive_disposition AS ENUM ('temporary', 'permanent', 'redirect');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── courses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS courses (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID          NOT NULL REFERENCES orgs(id),
  created_by               UUID          REFERENCES users(id) ON DELETE SET NULL,
  kind                     course_kind   NOT NULL DEFAULT 'single',

  -- Source content (server-rendered landing page text)
  title                    TEXT,
  subtitle                 TEXT,
  description              TEXT,
  learning_outcomes        JSONB,                       -- string[]
  instructor_name          TEXT,
  instructor_bio           TEXT,
  instructor_avatar_url    TEXT,
  cover_image_url          TEXT,
  cover_image_key          TEXT,

  -- Publication state machine
  publish_state            publish_state NOT NULL DEFAULT 'draft',
  published_at             TIMESTAMPTZ,                 -- first transition to 'published' (stable; kept if later unpublished)
  archived_at              TIMESTAMPTZ,                 -- when moved to 'archived'
  archive_disposition      archive_disposition,         -- only meaningful while archived
  archived_replacement_url TEXT,                        -- required when disposition = 'redirect'

  -- Routing / SEO. SEO columns are OVERRIDES ONLY (nullable). Effective values
  -- are resolved at render time (override → content → branded fallback). We
  -- never persist generated/placeholder metadata here.
  slug                     TEXT          NOT NULL,
  canonical_host           TEXT,                        -- NULL = platform default host; future custom primary host
  canonical_url            TEXT,                        -- explicit full canonical override (rare)
  seo_title                TEXT,
  seo_description          TEXT,
  og_title                 TEXT,
  og_description           TEXT,
  og_image_url             TEXT,
  og_image_key             TEXT,
  language                 TEXT          NOT NULL DEFAULT 'en',
  indexable                BOOLEAN       NOT NULL DEFAULT true,

  -- Backfill provenance (one course per legacy source → idempotency at the DB level)
  legacy_playlist_id       UUID          REFERENCES playlists(id) ON DELETE SET NULL,
  legacy_project_id        UUID          REFERENCES projects(id)  ON DELETE SET NULL,

  view_count               INTEGER       NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Slug must be a clean kebab token (stable; generated once on create)
  CONSTRAINT courses_slug_format_chk
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  -- BCP-47-ish language tag
  CONSTRAINT courses_language_format_chk
    CHECK (language ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'),
  -- learning_outcomes, if present, must be a JSON array
  CONSTRAINT courses_outcomes_array_chk
    CHECK (learning_outcomes IS NULL OR jsonb_typeof(learning_outcomes) = 'array'),
  -- A 'redirect' archive disposition requires a replacement URL
  -- NOTE: migration 032 tightens the whole archive state machine (this and the
  -- next constraint are dropped and replaced there). Kept here as originally
  -- shipped so this file matches what is already deployed.
  CONSTRAINT courses_archive_redirect_chk
    CHECK (archive_disposition IS DISTINCT FROM 'redirect' OR archived_replacement_url IS NOT NULL),
  -- archive_disposition only set when actually archived
  CONSTRAINT courses_archive_disposition_state_chk
    CHECK (publish_state = 'archived' OR archive_disposition IS NULL)
);

-- Unique course slug under the current canonical-host strategy. NULL host means
-- the platform default; COALESCE to a sentinel so default-host slugs collide
-- (plain UNIQUE would let NULL-host duplicates through).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_courses_host_slug
  ON courses (COALESCE(canonical_host, '@platform'), slug);

-- One course per legacy source — makes the backfill rerunnable without dupes.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_courses_legacy_playlist
  ON courses (legacy_playlist_id) WHERE legacy_playlist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_courses_legacy_project
  ON courses (legacy_project_id) WHERE legacy_project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_courses_org          ON courses (org_id);
CREATE INDEX IF NOT EXISTS idx_courses_publish_state ON courses (publish_state);

-- ── course_lessons ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS course_lessons (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       UUID         NOT NULL REFERENCES courses(id)  ON DELETE CASCADE,
  -- RESTRICT: a project that backs a lesson cannot be deleted out from under a
  -- course. Deleting the project requires removing the lesson first. Deleting a
  -- course cascades to its lessons but never to the underlying projects.
  project_id      UUID         NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  position        INTEGER      NOT NULL,

  -- Lesson routing + optional SEO overrides (NULL = inherit course)
  slug            TEXT         NOT NULL,
  title           TEXT,
  summary         TEXT,
  seo_title       TEXT,
  seo_description TEXT,
  og_title        TEXT,
  og_description  TEXT,
  og_image_url    TEXT,
  language        TEXT,                       -- NULL = inherit course.language
  indexable       BOOLEAN,                    -- NULL = inherit course.indexable

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT course_lessons_slug_format_chk
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT course_lessons_position_chk
    CHECK (position >= 0),
  CONSTRAINT course_lessons_language_format_chk
    CHECK (language IS NULL OR language ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'),

  -- Lesson slug unique within its course
  CONSTRAINT uniq_lesson_course_slug UNIQUE (course_id, slug),
  -- No duplicate project within the same course (Phase 1: repetition unsupported by design)
  CONSTRAINT uniq_lesson_course_project UNIQUE (course_id, project_id),
  -- Ordering integrity: no two lessons share a position in a course. DEFERRABLE
  -- so a single transaction can swap/reorder positions without tripping mid-update.
  CONSTRAINT uniq_lesson_course_position UNIQUE (course_id, position) DEFERRABLE INITIALLY IMMEDIATE
  -- NOTE: migration 032 adds UNIQUE (id, project_id) here for the redirect FK.
);

CREATE INDEX IF NOT EXISTS idx_course_lessons_course  ON course_lessons (course_id);
CREATE INDEX IF NOT EXISTS idx_course_lessons_project ON course_lessons (project_id);

-- ── course_custom_domains (future custom-domain mapping) ─────────────────────
CREATE TABLE IF NOT EXISTS course_custom_domains (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   UUID         NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  hostname    TEXT         NOT NULL,
  is_primary  BOOLEAN      NOT NULL DEFAULT false,
  verified    BOOLEAN      NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- A hostname maps to exactly one course
  CONSTRAINT uniq_custom_domain_hostname UNIQUE (hostname),
  CONSTRAINT custom_domain_hostname_lower_chk CHECK (hostname = lower(hostname))
);

-- At most one primary hostname per course
CREATE UNIQUE INDEX IF NOT EXISTS uniq_custom_domain_primary
  ON course_custom_domains (course_id) WHERE is_primary;
