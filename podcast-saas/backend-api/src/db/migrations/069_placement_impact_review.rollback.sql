-- Manual rollback helper for 069. Not run by the migration runner.
--
-- A CODE rollback needs neither statement. The review queue is written by the transcode job and
-- read by one editor endpoint; a previous build simply never asks for it, and the rows sit there
-- harmlessly. The FK is the one thing worth thinking about: reverting it re-arms the SILENT
-- orphaning 069 removed, so a build that still deletes videos without a preflight will detach
-- anchors again without saying so. Revert it only if you are also reverting the delete route.
--
-- Dropping the table discards every OPEN review — each one a decision an author was owed and has
-- not made. They are not recoverable: the numbers were captured at detection precisely because the
-- timeline has moved since. Export them before running this if anyone is mid-review.

ALTER TABLE timeline_sections
  DROP CONSTRAINT IF EXISTS timeline_sections_anchor_video_file_id_fkey;

ALTER TABLE timeline_sections
  ADD CONSTRAINT timeline_sections_anchor_video_file_id_fkey
  FOREIGN KEY (anchor_video_file_id) REFERENCES video_files(id) ON DELETE SET NULL;

DROP TABLE IF EXISTS placement_impact_reviews;
