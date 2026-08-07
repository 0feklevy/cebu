-- Rollback for migration 049. Run manually (the migrate runner is forward-only):
--   psql "$DATABASE_URL" -f src/db/migrations/049_sim_posters.rollback.sql
--   DELETE FROM schema_migrations WHERE filename = '049_sim_posters.sql';
--
-- Dropping sim_posters loses the record of which poster objects exist, but NOT the objects
-- themselves: they live under each simulation's storage prefix and are reachable by re-listing it
-- (PosterService.cleanupOrphans). Re-applying 049 and re-running a canary regenerates the rows.

DROP TABLE IF EXISTS sim_posters;

ALTER TABLE simulations DROP CONSTRAINT IF EXISTS simulations_package_class_chk;
ALTER TABLE simulations DROP COLUMN IF EXISTS canary_at;
ALTER TABLE simulations DROP COLUMN IF EXISTS canary_report;
ALTER TABLE simulations DROP COLUMN IF EXISTS package_class;
ALTER TABLE simulations DROP COLUMN IF EXISTS bridge_hash;
