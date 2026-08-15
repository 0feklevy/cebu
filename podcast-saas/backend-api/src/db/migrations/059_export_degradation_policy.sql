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
-- Backfill: rows that already exist predate the strict contract and were produced under the old
-- always-degrade behaviour, so they are marked 'allow_poster' — describing what actually happened to
-- them rather than retroactively claiming a guarantee they never had.
ALTER TABLE project_exports
  ADD COLUMN IF NOT EXISTS degradation_policy text NOT NULL DEFAULT 'forbid';

UPDATE project_exports SET degradation_policy = 'allow_poster' WHERE created_at < now();

ALTER TABLE project_exports
  DROP CONSTRAINT IF EXISTS project_exports_degradation_policy_check;
ALTER TABLE project_exports
  ADD CONSTRAINT project_exports_degradation_policy_check
  CHECK (degradation_policy IN ('forbid', 'allow_poster'));
