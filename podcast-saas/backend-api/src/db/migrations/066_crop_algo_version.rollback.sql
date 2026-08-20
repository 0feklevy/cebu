-- Manual rollback helper for 066. Not run by the migration runner.
--
-- A code rollback needs nothing here: the column is written on success and read only by the
-- backfill tooling, so an older image simply ignores it. Drop it only when the versioning scheme is
-- being abandoned — doing so loses the record of which videos have been re-analysed under which
-- algorithm, which nothing can reconstruct.
DROP INDEX IF EXISTS video_files_crop_algo_version_idx;
ALTER TABLE video_files DROP COLUMN IF EXISTS crop_algo_version;
