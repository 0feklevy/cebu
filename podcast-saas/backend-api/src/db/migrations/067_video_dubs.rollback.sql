-- Manual rollback helper for 067. Not run by the migration runner.
--
-- Dropping video_dubs discards every dubbed rendition's DB row. The storage objects those rows
-- point at (audio_key, muxed_video_key, and the per-language HLS tree under dubs/) are NOT removed
-- by this file and would be orphaned — after the DROP nothing knows those keys exist. Delete the
-- dubs through the API first if the bytes matter.
--
-- A CODE rollback needs neither drop: the player falls back to the source-language track whenever
-- a video has no completed dub, and nothing outside the dubbing feature reads these tables. Leaving
-- them in place is the safer revert.
DROP TABLE IF EXISTS dubbing_slots;
DROP TABLE IF EXISTS video_dubs;
