-- Rollback for migration 056. Run manually — the migrate runner is forward-only.
--
-- Safe in either order relative to a deploy: the duplication endpoint is the only reader/writer of
-- this table, and it returns a clean 503-shaped failure rather than corrupting anything if the
-- table is gone. Projects already duplicated are unaffected — they are ordinary, independent
-- projects; only the record of HOW they came to exist is dropped.

DROP INDEX IF EXISTS idx_project_duplications_source;
DROP INDEX IF EXISTS uniq_project_duplications_inflight;
DROP TABLE IF EXISTS project_duplications;
