-- 074 — a marker remembers WHICH CONTENT it marks, not merely a number on the clock.
--
-- Migration 063 gave b-roll and audio cutaways a segment anchor and wrote the reason out in full:
-- an absolute second stops meaning what the author intended the moment anything before it changes
-- length. Its own header names "the prewarm/marker maths" among the surfaces that must agree —
-- and markers were then left on the absolute representation. This is that follow-up.
--
-- THE SAME DRIFT, ON A ROW A HUMAN AUTHORED BY HAND. A marker at 0:47 means "here, at this moment
-- in the lesson". Trim four seconds out of an earlier clip and second 47 is now somewhere else;
-- the marker still fires at 47 and now points at the wrong sentence. Nothing errors, nothing is
-- logged, and the author finds out by watching.
--
-- SAME SHAPE AS 063, DELIBERATELY. The columns are named identically and resolve through the same
-- function in shared/timeline/placement.ts. 063's header explains why that matters more than the
-- columns do: the bug class is that each surface answers "where is this row?" differently, and a
-- second resolver recreates it no matter how carefully the second one is written.
--
-- EXPAND ONLY. Every column is nullable and `placement_mode` defaults to the legacy value, so an
-- existing marker resolves exactly as it does today. Nothing is backfilled here: a backfill would
-- have to guess which segment an old marker MEANT, and a guess is indistinguishable from a
-- measurement once it is in the table. Rows gain an anchor when they are next moved.

ALTER TABLE timeline_markers
  ADD COLUMN IF NOT EXISTS anchor_video_file_id uuid REFERENCES video_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anchor_offset_sec real,
  ADD COLUMN IF NOT EXISTS placement_mode text NOT NULL DEFAULT 'legacy_absolute';

COMMENT ON COLUMN timeline_markers.anchor_video_file_id IS
  'Main segment this marker is anchored to. ON DELETE SET NULL — a deleted host leaves a row that KNOWS it was anchored and no longer knows to what, which placement_mode preserves.';
COMMENT ON COLUMN timeline_markers.anchor_offset_sec IS
  'Seconds into the anchor segment. Half a pair places nothing; the resolver reports that as anchor_offset_missing.';
COMMENT ON COLUMN timeline_markers.placement_mode IS
  'segment | legacy_absolute. A column rather than a computed anchor_video_file_id IS NOT NULL, so a row whose host was deleted stays distinguishable from one that was never anchored.';

-- Read path: markers are fetched per project, already covered by timeline_markers_project_idx.
