-- Branching analytics (Phase 5) — viewer path tracking.
-- One row per branching event: entering a sequence, making a choice, or finishing.
-- sequence_id / edge_id are SOFT references (no FK) so deleting a sequence or edge later
-- doesn't erase historical analytics.

CREATE TABLE IF NOT EXISTS branch_path_events (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT         NOT NULL,                 -- per-view anonymous session id
  event_type       TEXT         NOT NULL,                 -- sequence_enter | choice | complete
  sequence_id      UUID,                                  -- soft ref
  edge_id          UUID,                                  -- soft ref
  destination_type TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_events_project ON branch_path_events(project_id);
CREATE INDEX IF NOT EXISTS idx_branch_events_edge    ON branch_path_events(edge_id);
