-- Rollback for migration 058. Run manually — the migrate runner is forward-only.
--
-- Safe in either order relative to a deploy: the export endpoints are the only reader/writer of
-- this table, and they return a clean 503-shaped failure rather than corrupting anything if the
-- table is gone (the same promise 056's rollback makes, kept the same way). Masters already
-- exported are unaffected — they are ordinary storage objects under exports/{projectId}/…; only
-- the record of HOW they came to exist (and the presign route to them) is dropped.

DROP INDEX IF EXISTS idx_project_exports_project;
DROP INDEX IF EXISTS uniq_project_exports_inflight;
DROP TABLE IF EXISTS project_exports;
