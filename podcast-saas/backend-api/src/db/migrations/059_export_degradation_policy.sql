-- The export's degradation policy, frozen at creation.
--
-- Consent was previously a request-body boolean the controller checked and then THREW AWAY: nothing
-- persisted it, so the worker degraded every failed simulation window to a poster whether or not the
-- user had agreed to that. A retry, a restart, or a duplicate delivery had no way to know what was
-- agreed either. The policy is therefore a column on the row, written once when the job is created.
--
-- 'forbid' is the default and the product's real contract: a capture failure fails the export rather
-- than quietly shipping a slideshow. 'allow_poster' is only ever set from explicit informed consent.
--
-- BACKFILL, and why it is inside the "was the column just added?" branch rather than a bare UPDATE.
-- Rows that already exist predate the strict contract and were produced under the old always-degrade
-- behaviour, so they are marked 'allow_poster' — describing what actually happened to them rather
-- than retroactively claiming a guarantee they never had. But a bare `UPDATE … WHERE created_at <
-- now()` is only idempotent by accident: run a second time, on a table that has since collected real
-- strict exports, it would relabel every one of them as permitted to degrade. Scoping the backfill
-- to the moment the column is created makes re-application a genuine no-op, which is what a
-- migration runner that retries after a partial failure requires.
DO $$
DECLARE
  column_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_exports' AND column_name = 'degradation_policy'
  ) INTO column_existed;

  IF NOT column_existed THEN
    ALTER TABLE project_exports
      ADD COLUMN degradation_policy text NOT NULL DEFAULT 'forbid';

    -- Every row visible here predates the column, and therefore the contract.
    UPDATE project_exports SET degradation_policy = 'allow_poster';
  END IF;
END
$$;

ALTER TABLE project_exports
  DROP CONSTRAINT IF EXISTS project_exports_degradation_policy_check;
ALTER TABLE project_exports
  ADD CONSTRAINT project_exports_degradation_policy_check
  CHECK (degradation_policy IN ('forbid', 'allow_poster'));
