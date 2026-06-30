-- Branching Interactive Videos — Phase 1 data model.
--
-- A project's linear timeline becomes a graph of "sequences" (sub-timelines). Each
-- sequence is a run of main video segments that plays start-to-finish, then optionally
-- presents a choice point whose edges route the viewer to a destination.
--
-- IMPORTANT: sequence membership lives on `video_files` (the main playback segments in
-- buildPlayerConfig), NOT on `timeline_sections`. Overlays (broll/clip/image/audio/sim)
-- inherit their sequence via their `video_file_id`.
--
-- Backward-compat: a project with NO branch_sequences rows behaves exactly as today —
-- one implicit sequence = all its main videos in created_at order. The player config
-- only emits a `branching` block when branch_sequences rows exist.

-- ── Sequences (graph nodes) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branch_sequences (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label        TEXT         NOT NULL DEFAULT 'Sequence',
  is_entry     BOOLEAN      NOT NULL DEFAULT false,   -- the start node of the graph
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  -- React-Flow canvas position (editor-only; ignored by the player)
  graph_x      REAL         NOT NULL DEFAULT 0,
  graph_y      REAL         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_sequences_project ON branch_sequences(project_id);
-- At most one entry sequence per project.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_branch_entry
  ON branch_sequences(project_id) WHERE is_entry;

-- ── Assign main video segments to a sequence ───────────────────────────────────
-- Only main videos (is_broll = false) participate; broll source files stay null.
ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS sequence_id UUID REFERENCES branch_sequences(id) ON DELETE SET NULL;
ALTER TABLE video_files
  ADD COLUMN IF NOT EXISTS sequence_order INTEGER;  -- order of segments within the sequence

-- ── Choice points (the decision overlay at the end of a sequence) ──────────────
CREATE TABLE IF NOT EXISTS branch_choice_points (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_id     UUID         NOT NULL REFERENCES branch_sequences(id) ON DELETE CASCADE,
  -- How early (sec before the sequence's final segment ends) the overlay appears.
  lead_in_sec     REAL         NOT NULL DEFAULT 10,
  -- Countdown length for default-on-timeout; null = wait indefinitely for a pick.
  timeout_sec     REAL,
  -- What the video does while waiting for a choice (creator-configurable):
  --   continue = keep playing under the overlay (Bandersnatch); on end use default
  --   pause    = freeze and wait
  --   loop     = loop the trailing region until a pick
  behavior        TEXT         NOT NULL DEFAULT 'continue'
                  CHECK (behavior IN ('continue', 'pause', 'loop')),
  prompt          TEXT,                                      -- "What do you do next?"
  layout          TEXT         NOT NULL DEFAULT 'cards',      -- cards | buttons | quiz
  default_edge_id UUID,                                       -- FK added after branch_edges
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_cp_sequence ON branch_choice_points(sequence_id);
CREATE INDEX IF NOT EXISTS idx_branch_cp_project  ON branch_choice_points(project_id);

-- ── Edges (one choice button/card → a destination) ─────────────────────────────
CREATE TABLE IF NOT EXISTS branch_edges (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- null choice_point_id = an auto edge (no overlay): the sequence flows straight to
  -- the destination, or a sim-triggered edge (Phase 4).
  choice_point_id    UUID        REFERENCES branch_choice_points(id) ON DELETE CASCADE,
  label              TEXT,                                   -- button text / card title
  description        TEXT,                                   -- card subtitle
  thumbnail_url      TEXT,
  sort_order         INTEGER     NOT NULL DEFAULT 0,

  destination_type   TEXT        NOT NULL
                     CHECK (destination_type IN
                       ('sequence', 'project', 'playlist', 'external_url',
                        'simulation_full', 'quiz', 'back', 'restart', 'end')),
  -- Polymorphic destination refs — exactly one set is meaningful per destination_type.
  dest_sequence_id   UUID        REFERENCES branch_sequences(id) ON DELETE CASCADE,   -- 'sequence'
  dest_project_id    UUID        REFERENCES projects(id)         ON DELETE SET NULL,  -- 'project'
  dest_playlist_id   UUID        REFERENCES playlists(id)        ON DELETE SET NULL,  -- 'playlist'
  dest_url           TEXT,                                                            -- 'external_url'
  dest_simulation_id UUID        REFERENCES simulations(id)      ON DELETE SET NULL,  -- 'simulation_full'
  dest_quiz_id       UUID,                                                            -- 'quiz' (table in Phase 4)

  -- Simulation-triggered condition (Phase 4). When set, this edge is auto-selected when
  -- the sequence's trailing simulation reports a matching event/result via postMessage.
  trigger_event      TEXT,                                   -- e.g. 'userInteraction' | 'result'
  trigger_match      JSONB,                                  -- e.g. {"key":"score","op":"gte","value":0.8}

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_edges_cp      ON branch_edges(choice_point_id);
CREATE INDEX IF NOT EXISTS idx_branch_edges_project ON branch_edges(project_id);

-- default_edge_id closes the cycle between choice points and edges.
DO $$ BEGIN
  ALTER TABLE branch_choice_points
    ADD CONSTRAINT fk_cp_default_edge
    FOREIGN KEY (default_edge_id) REFERENCES branch_edges(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
