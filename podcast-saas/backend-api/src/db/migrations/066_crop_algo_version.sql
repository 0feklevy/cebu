-- 066: record which crop algorithm produced each video's keyframe track.
--
-- WHAT WAS WRONG
-- `video_files.crop_source_hash` was a hash of the SOURCE alone — storage key, file size,
-- duration. The source of a published episode never changes, so a `ready` row matched its stored
-- hash forever and every improvement to the crop pipeline was invisible to the entire existing
-- catalogue. The Recrop button recomputed the identical wrong answer, deterministically. There was
-- also no way to ask "which videos were analysed by the old algorithm", so there was nothing to
-- backfill against even if someone wanted to.
--
-- The hash input now includes the algorithm version (services/crop/algo.ts), which is what makes a
-- version bump invalidate existing rows on their next trigger. This column is the other half: the
-- hash says "stale or not" and is opaque, while this says WHICH version produced what is stored —
-- so a rate-limited backfill can select its work set and resume, and an operator can see how far a
-- rollout has reached without re-deriving anything.
--
-- Nullable, with no default and no backfill: NULL means "analysed before versions were recorded",
-- which is exactly what those rows are, and inventing a version for them would claim knowledge the
-- database does not have. The backfill selects on `IS NULL OR <> current`, so NULL is already the
-- correct answer for "needs recomputing".

-- Fail fast rather than queue behind a long transaction: a deploy that cannot get its locks
-- promptly should abort and leave the previous version serving. LOCAL so the setting dies with
-- this migration's transaction instead of leaking into the session that follows it.
SET LOCAL lock_timeout = '3s';

ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS crop_algo_version TEXT;

-- Serves the backfill's work-set query only. Partial, because the rows that matter are the ready
-- ones — a video that never got a crop at all is the transcode pipeline's problem, not this one's.
CREATE INDEX IF NOT EXISTS video_files_crop_algo_version_idx
  ON video_files (crop_algo_version)
  WHERE crop_status = 'ready';
