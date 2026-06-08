-- Migration 032 — Course publishing hardening (Phase 1 review follow-up).
--
-- Migration 030 was already applied to environments before this hardening pass,
-- so its DDL must NOT be edited in place. This migration upgrades an existing 030
-- schema (and runs right after 030 on fresh installs) to:
--   1. Tighten the archive state machine on `courses`.
--   2. Add a composite UNIQUE (id, project_id) on `course_lessons` so a redirect
--      target can be proven to belong to its project via a composite FK.
--   3. Add `project_redirect_targets` — the canonical lesson a legacy project's
--      /v/<shareToken> link resolves to (one project can live in many courses).
--
-- Rerunnable: drops are IF EXISTS; ADD CONSTRAINT is wrapped to ignore an already
-- existing constraint; tables/indexes use IF NOT EXISTS.

-- ── 1. Tighten the courses archive state machine ─────────────────────────────
-- Replace the two original 030 archive checks with the full set.
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_archive_redirect_chk;
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_archive_disposition_state_chk;

DO $$ BEGIN
  -- archived requires a disposition
  ALTER TABLE courses ADD CONSTRAINT courses_archived_requires_disposition_chk
    CHECK (publish_state <> 'archived' OR archive_disposition IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- archived requires an archived_at timestamp
  ALTER TABLE courses ADD CONSTRAINT courses_archived_requires_timestamp_chk
    CHECK (publish_state <> 'archived' OR archived_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- 'redirect' requires a non-empty replacement URL
  ALTER TABLE courses ADD CONSTRAINT courses_redirect_requires_url_chk
    CHECK (archive_disposition <> 'redirect'
           OR (archived_replacement_url IS NOT NULL AND length(btrim(archived_replacement_url)) > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- a replacement URL may only exist for the 'redirect' disposition
  ALTER TABLE courses ADD CONSTRAINT courses_replacement_url_only_redirect_chk
    CHECK (archived_replacement_url IS NULL OR archive_disposition = 'redirect');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- a non-archived course must not retain ANY archive fields. The future service
  -- layer must clear archive_disposition/url/archived_at when leaving 'archived'.
  ALTER TABLE courses ADD CONSTRAINT courses_non_archived_clean_chk
    CHECK (publish_state = 'archived'
           OR (archive_disposition IS NULL AND archived_replacement_url IS NULL AND archived_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Composite unique on course_lessons for the redirect FK ────────────────
DO $$ BEGIN
  ALTER TABLE course_lessons ADD CONSTRAINT uniq_lesson_id_project UNIQUE (id, project_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. project_redirect_targets ──────────────────────────────────────────────
-- One canonical target per project. The composite FK (course_lesson_id,
-- project_id) → course_lessons(id, project_id) guarantees the target lesson
-- belongs to THIS project. The backfill picks a deterministic candidate and
-- flags ambiguity; the Phase-2 redirect resolver still verifies the target
-- course+lesson are published and indexable before issuing a permanent (301).
CREATE TABLE IF NOT EXISTS project_redirect_targets (
  project_id       UUID         PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  course_lesson_id UUID         NOT NULL,
  is_ambiguous     BOOLEAN      NOT NULL DEFAULT false,  -- backfill found >1 published candidate
  candidate_count  INTEGER      NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT fk_redirect_lesson_same_project
    FOREIGN KEY (course_lesson_id, project_id)
    REFERENCES course_lessons (id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_redirect_candidate_count_chk CHECK (candidate_count >= 1)
);

CREATE INDEX IF NOT EXISTS idx_project_redirect_lesson ON project_redirect_targets (course_lesson_id);
