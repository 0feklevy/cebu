ALTER TABLE project_exports DROP CONSTRAINT IF EXISTS project_exports_progress_nonneg_check;
ALTER TABLE project_exports
  DROP COLUMN IF EXISTS current_phase,
  DROP COLUMN IF EXISTS phase_done,
  DROP COLUMN IF EXISTS phase_total,
  DROP COLUMN IF EXISTS current_section_id,
  DROP COLUMN IF EXISTS current_section_label,
  DROP COLUMN IF EXISTS capture_stage,
  DROP COLUMN IF EXISTS frames_done,
  DROP COLUMN IF EXISTS frames_total,
  DROP COLUMN IF EXISTS degraded_windows;
