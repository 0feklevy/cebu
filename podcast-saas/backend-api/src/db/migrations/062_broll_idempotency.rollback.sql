-- Manual rollback helper for 062. Not run by the migration runner.
--
-- The lease columns are ADDITIVE and the previous application code ignores them, so a code
-- rollback needs NO schema change — leave them in place. Dropping them is only for abandoning the
-- change entirely, and it discards the `attempts` backfill, which cannot be reconstructed.
ALTER TABLE video_generation_jobs
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS updated_at;
