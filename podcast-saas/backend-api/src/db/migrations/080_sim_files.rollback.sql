-- Rollback 080. The mapping goes; the blobs it pointed at stay.
--
-- Dropping this table makes every deduplicated simulation unresolvable — the serving path falls
-- back to the prefix key, which for an imported package holds nothing. So a rollback here is only
-- safe BEFORE any import has run on the deduplicated path, or alongside restoring per-project
-- copies. The bytes themselves are never touched: a rollback is a schema decision, and the blobs
-- may be the only copy of files several simulations were sharing.
DROP INDEX IF EXISTS sim_files_blob_idx;
DROP TABLE IF EXISTS sim_files;
