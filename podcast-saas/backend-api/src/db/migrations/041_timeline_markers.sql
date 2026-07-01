-- 041_timeline_markers.sql
-- Editor timeline markers (Focus 5b). Premiere-style flags the editor drops at a point on the
-- timeline (Flag button or "m" hotkey) to leave a note while cutting. Positioned by absolute
-- seconds on the global main timeline; rendered as a red vertical line + note popover.
CREATE TABLE IF NOT EXISTS timeline_markers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at_sec     real NOT NULL,
  label      text,
  notes      text,
  color      text NOT NULL DEFAULT '#ef4444',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timeline_markers_project_idx ON timeline_markers (project_id);
