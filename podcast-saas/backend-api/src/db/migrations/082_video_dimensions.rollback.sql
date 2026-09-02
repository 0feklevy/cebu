-- 082 rollback: drop the geometry columns. Safe at any time — every reader treats a missing or
-- NULL geometry as landscape, and the previous image never selected these columns.

ALTER TABLE video_files DROP COLUMN IF EXISTS width;
ALTER TABLE video_files DROP COLUMN IF EXISTS height;
