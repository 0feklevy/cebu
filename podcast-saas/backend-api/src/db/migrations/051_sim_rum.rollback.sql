-- Rollback for migration 051. Run manually — the migrate runner is forward-only:
--   psql "$DATABASE_URL" -f src/db/migrations/051_sim_rum.rollback.sql
--   DELETE FROM schema_migrations WHERE filename = '051_sim_rum.sql';
--
-- Dropping sim_rum_events destroys collected measurements permanently; there is no other copy. That
-- is acceptable by design — the data is a sampled aggregate, not a record of anything owed to
-- anyone — but export first if a percentile is about to be used to justify a decision.
--
-- Rolling back is SAFE at any time: the client sends nothing when rum_sample_rate is absent, because
-- resolveRumSampleRate treats a missing column as 0 rather than as a default-on value.

ALTER TABLE simulations DROP CONSTRAINT IF EXISTS simulations_prepare_budget_chk;
ALTER TABLE simulations DROP COLUMN IF EXISTS prepare_budget_ms;

ALTER TABLE admin_settings DROP CONSTRAINT IF EXISTS admin_settings_rum_retention_chk;
ALTER TABLE admin_settings DROP CONSTRAINT IF EXISTS admin_settings_rum_sample_rate_chk;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS rum_retention_days;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS rum_sample_rate;

DROP INDEX IF EXISTS idx_sim_rum_package;
DROP INDEX IF EXISTS idx_sim_rum_created;
DROP TABLE IF EXISTS sim_rum_events;
