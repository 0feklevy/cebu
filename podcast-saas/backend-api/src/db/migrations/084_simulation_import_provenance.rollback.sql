-- 084 rollback: drop the import provenance. Safe at any time — the previous image never selected
-- the column, and nothing else references the index.
DROP INDEX IF EXISTS idx_simulations_imported_from;
ALTER TABLE simulations DROP COLUMN IF EXISTS imported_from_simulation_id;
