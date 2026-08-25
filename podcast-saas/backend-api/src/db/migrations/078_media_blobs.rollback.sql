-- Rollback 078. Drops the pointers first: the table cannot go while anything references it, which
-- is the same refusal the forward migration relies on.
DROP INDEX IF EXISTS video_files_blob_idx;
DROP INDEX IF EXISTS image_files_blob_idx;
DROP INDEX IF EXISTS audio_files_blob_idx;

ALTER TABLE video_files DROP COLUMN IF EXISTS blob_id;
ALTER TABLE image_files DROP COLUMN IF EXISTS blob_id;
ALTER TABLE audio_files DROP COLUMN IF EXISTS blob_id;

DROP INDEX IF EXISTS media_blobs_orphaned_idx;
DROP INDEX IF EXISTS media_blobs_storage_key_idx;
DROP INDEX IF EXISTS media_blobs_identity_idx;
DROP TABLE IF EXISTS media_blobs;

-- NOTE: the bytes themselves are NOT touched. Rolling back the schema must never delete objects —
-- a rollback is a schema decision, and the storage it points at may be the only copy of a file
-- several projects were sharing.
