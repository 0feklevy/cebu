-- Rollback for migration 062. Run manually — the migrate runner is forward-only.
--
-- Safe in either order relative to a deploy, with one caveat worth stating plainly: rolling this
-- back removes the guarantee, not the data. Sections already generated keep their rows; they simply
-- stop carrying their provenance, and a b-roll job that retries after the rollback can once again
-- append a second section. The old code's behaviour, restored exactly.
--
-- Dropped in reverse dependency order: the index before the column it is built on, and the lease
-- columns before nothing in particular — they are additive and referenced by no constraint.

DROP INDEX IF EXISTS idx_vgj_inflight;

ALTER TABLE video_generation_jobs DROP COLUMN IF EXISTS attempts;
ALTER TABLE video_generation_jobs DROP COLUMN IF EXISTS claimed_by;
ALTER TABLE video_generation_jobs DROP COLUMN IF EXISTS updated_at;

DROP INDEX IF EXISTS uniq_timeline_sections_generation_job;
ALTER TABLE timeline_sections DROP COLUMN IF EXISTS generation_job_id;
