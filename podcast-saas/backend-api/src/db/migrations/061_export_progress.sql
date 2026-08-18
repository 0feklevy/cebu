-- Authoritative progress, so a poll can say something true.
--
-- The row carried `objects_done / objects_total` and nothing else, which cannot express what an
-- export actually spends its time on. A simulation capture is minutes long; during it the counter
-- sat still, and the only honest thing the UI could show was a spinner. Worse, the counter was
-- incremented BEFORE each window rather than after, so a project reported "3 of 4 done" while the
-- third window had not started — and if the run then failed, the user had been told it was nearly
-- finished.
--
-- These columns hold what the run knows: which phase, which section, how far into that section's
-- frames. They are advisory to the USER but authoritative in the API — nothing branches on them, and
-- the capture child never writes them directly (its reports are validated first).
--
-- `degraded_windows` is a COUNT of real poster-fallback windows, not a count of warnings: warnings
-- include planning advisories that are not degradation at all, so counting them told users their
-- export was degraded when nothing had been substituted.
ALTER TABLE project_exports
  ADD COLUMN IF NOT EXISTS current_phase text,
  ADD COLUMN IF NOT EXISTS phase_done integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS phase_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_section_id uuid,
  ADD COLUMN IF NOT EXISTS current_section_label text,
  ADD COLUMN IF NOT EXISTS capture_stage text,
  ADD COLUMN IF NOT EXISTS frames_done integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frames_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS degraded_windows integer NOT NULL DEFAULT 0;

ALTER TABLE project_exports
  DROP CONSTRAINT IF EXISTS project_exports_progress_nonneg_check;
ALTER TABLE project_exports
  ADD CONSTRAINT project_exports_progress_nonneg_check
  CHECK (phase_done >= 0 AND phase_total >= 0 AND frames_done >= 0 AND frames_total >= 0
         AND degraded_windows >= 0);
