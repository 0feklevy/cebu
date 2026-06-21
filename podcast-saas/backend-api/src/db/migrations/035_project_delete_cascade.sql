-- Fix project deletion. Three FKs to projects(id) lacked a delete rule that lets
-- a project be removed, so DELETE /projects/:id threw a foreign-key violation for
-- any project that had run the pipeline (jobs/token_usage) or was used as a course
-- lesson — which the UI swallowed as "delete does nothing".
--
--   jobs           NO ACTION → CASCADE   (ephemeral pipeline jobs go with the project)
--   token_usage    NO ACTION → SET NULL  (keep billing/usage history; just detach the project)
--   course_lessons RESTRICT  → CASCADE   (deleting the source video removes its lesson)

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_project_id_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE token_usage DROP CONSTRAINT IF EXISTS token_usage_project_id_fkey;
ALTER TABLE token_usage ADD CONSTRAINT token_usage_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE course_lessons DROP CONSTRAINT IF EXISTS course_lessons_project_id_fkey;
ALTER TABLE course_lessons ADD CONSTRAINT course_lessons_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
