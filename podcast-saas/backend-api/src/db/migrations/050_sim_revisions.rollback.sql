-- Rollback for migration 050. Run manually — the migrate runner is forward-only:
--   psql "$DATABASE_URL" -f src/db/migrations/050_sim_revisions.rollback.sql
--   DELETE FROM schema_migrations WHERE filename = '050_sim_revisions.sql';
--
-- WHAT IS LOST AND WHAT IS NOT
-- Dropping sim_revisions loses the record of which revisions exist, but NOT their bytes: those live
-- under each simulation's storage prefix at /revisions/<id>/ and remain reachable by re-listing it.
-- What IS lost is which one was live.
--
-- That is safe because every simulation reverts to the pre-revision mutable path —
-- packageRevisionFor falls back to derivePackageRevision when active_revision_id is NULL — and the
-- mutable prefix still holds a servable package. Migration 050 never deletes the pre-revision
-- objects, and RevisionService.gc refuses to touch anything outside /revisions/, precisely so this
-- rollback stays available.
--
-- ONE CONSEQUENCE WORTH STATING: any simulation that had been activated onto a revision reverts to
-- whatever bytes its mutable prefix last held. If a newer package was only ever published as a
-- revision, rolling back 050 serves the OLDER package. That is a data-visible regression, not a
-- crash, so verify which simulations have a non-NULL active_revision_id before running this:
--   SELECT id, name, active_revision_id FROM simulations WHERE active_revision_id IS NOT NULL;
--
-- ORDER MATTERS. simulations.active_revision_id references sim_revisions(id), so the FK and the
-- column must go before the table; the reverse order fails with
--   "cannot drop table sim_revisions because other objects depend on it".

ALTER TABLE simulations DROP CONSTRAINT IF EXISTS simulations_active_revision_fk;
ALTER TABLE simulations DROP CONSTRAINT IF EXISTS simulations_active_revision_pair_chk;
ALTER TABLE simulations DROP COLUMN IF EXISTS revision_counter;
ALTER TABLE simulations DROP COLUMN IF EXISTS active_revision_entry_key;
ALTER TABLE simulations DROP COLUMN IF EXISTS active_revision_id;

DROP INDEX IF EXISTS idx_sim_revisions_status_created;
DROP INDEX IF EXISTS idx_sim_revisions_sim_activated;
DROP INDEX IF EXISTS uniq_sim_revisions_active;
DROP TABLE IF EXISTS sim_revisions;
