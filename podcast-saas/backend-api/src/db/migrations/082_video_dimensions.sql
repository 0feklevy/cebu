-- 082: the source video's DISPLAYED geometry, so a project can know it is portrait.
--
-- Until now nothing in the schema recorded a video's width or height. The only probe that read
-- them lived inside the smart-crop job and its answer never left the crop JSON, so the HLS ladder,
-- the export grid, the editor preview and the crop itself all assumed 16:9 — a 1080×1920 upload
-- was pillarboxed into a 1920×1080 stream and then cropped as if it were landscape.
--
-- Both columns hold the DISPLAYED size: rotation tags applied, anamorphic sample aspect applied
-- (shared/src/video/orientation.ts, displayedGeometry). NULL means "not probed yet" and every
-- reader treats NULL as landscape, which is exactly what every existing row was treated as before
-- this migration — nothing already published changes shape until the transcode probe (or the
-- operator backfill, scripts/backfill-video-dimensions.ts) fills the columns in.
--
-- Expand-only: the previous image ignores the columns. Do not write BEGIN/COMMIT — migrate.ts
-- wraps the file.

ALTER TABLE video_files ADD COLUMN IF NOT EXISTS width  integer CHECK (width  IS NULL OR width  > 0);
ALTER TABLE video_files ADD COLUMN IF NOT EXISTS height integer CHECK (height IS NULL OR height > 0);

COMMENT ON COLUMN video_files.width  IS 'Displayed width in px (rotation + SAR applied); NULL = not probed, read as landscape';
COMMENT ON COLUMN video_files.height IS 'Displayed height in px (rotation + SAR applied); NULL = not probed, read as landscape';
