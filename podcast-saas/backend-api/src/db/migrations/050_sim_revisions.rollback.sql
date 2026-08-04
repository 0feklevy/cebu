-- Rollback for migration 050. Run manually (the migrate runner is forward-only):
--   psql "$DATABASE_URL" -f src/db/migrations/050_sim_revisions.rollback.sql
--   DELETE FROM schema_migrations WHERE filename = '050_sim_revisions.sql';
--
-- WHAT IS LOST AND WHAT IS NOT
-- Dropping simulation_revisions loses the publication history and the pointer, but NOT a single
-- published byte: revision files live under each simulation's own storage prefix at paths that
-- contain the revision id, and are reachable by listing that prefix. Every package whose pointer
-- disappears falls back to the legacy mutable path, which is exactly what it used before 050 — so
-- this rollback degrades serving to the pre-revision behaviour rather than breaking it.
--
-- The FK constraint is dropped before the column so that re-running this file after a partial
-- failure still completes.

ALTER TABLE simulations DROP CONSTRAINT IF EXISTS simulations_active_revision_fk;
ALTER TABLE simulations DROP COLUMN IF EXISTS active_revision_id;

DROP TABLE IF EXISTS simulation_revisions;
