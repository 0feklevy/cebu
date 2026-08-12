-- Rollback for migration 053. Run manually — the migrate runner is forward-only.
--
-- DEPLOY FIRST, THEN DROP (same reason as 051/052): an image that still calls retireHlsRun or
-- the sweep against a dropped table degrades to the pre-053 behaviour only because both writer
-- and sweeper tolerate a missing table — but the retirement INSERT failing means old trees leak
-- until manually purged. Safe in the other direction at any time.

DROP INDEX IF EXISTS idx_hls_retired_runs_video;
DROP INDEX IF EXISTS idx_hls_retired_runs_due;
DROP TABLE IF EXISTS hls_retired_runs;
