-- 058: Linear video export — the job row one export runs under.
--
-- WHY A JOB ROW AND NOT A COLUMN ON projects
-- An export is minutes of ffmpeg against a timeline that keeps being edited while it runs. The row
-- tracks the WORK — which plan was frozen, how far it got, why it stopped — not the project's
-- state; a project can accumulate many exports over its life and each one must stay answerable
-- ("what did THIS export contain?") after the work directory is gone. That is the same argument
-- migration 056 makes for project_duplications, and this table is deliberately its sibling.
--
-- WHY `plan` IS WRITTEN BEFORE ANY WORK
-- The plan jsonb is the frozen resolution of the timeline: every window with absolute times, what
-- was excluded (RAW simulations, out-of-scope layers) and WHY, as `warnings`. It is the only way to
-- answer "why does the master look like that?" months later — the timeline it was built from has
-- moved on, and the temp directory is deleted in a finally block.
--
-- WHY `cancel_requested` EXISTS HERE AND NOT ON project_duplications
-- A byte copy is not worth interrupting; an encode is. The flag is a REQUEST, checked by the runner
-- between phases and honoured by aborting the assembler — the row is flipped to a terminal status
-- by the RUNNER (fenced), never by the endpoint, so the poll cannot observe a terminal state while
-- ffmpeg still holds the work directory.
--
-- WHY `cancelled` IS ITS OWN TERMINAL STATUS, NOT A FLAVOUR OF `failed`
-- A honoured cancellation is the system doing exactly what the user asked; `failed` is the system
-- not doing what it promised. Folding the first into the second makes every cancel look like a
-- defect in the UI, in the logs, and in any future error-rate metric — three misreadings from one
-- saved enum value.
--
-- WHY `quality_state` IS A COLUMN AND NOT DERIVED FROM `plan`
-- "Is this master the full composition, or degraded?" is the one fact every poll and every list
-- view needs, and deriving it means parsing the plan jsonb on every read. `degraded` is set by the
-- runner whenever ANY sim window resolved to its poster fallback or any planned layer was skipped
-- — a Phase 1 export with simulations is ALWAYS degraded, and saying so cheaply is the point.
--
-- WHY `output_key` IS A COLUMN
-- The master lands at a versioned, write-once key (`exports/{projectId}/{exportId}/master.mp4`)
-- and is never overwritten across exports; the download endpoint presigns whatever this column
-- names. NULL until `ready` — a cancelled or failed encode leaves a well-formed, playable partial
-- MP4 on disk (SIGTERM finalises the container), so the pointer is written only after the
-- exit-code and duration gates pass. Publishing is flipping this pointer, nothing else.

CREATE TABLE IF NOT EXISTS project_exports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: bookkeeping about a project dies with it. The output objects are reaped by the
  -- project-delete storage GC (exports/{projectId}/ is project-scoped by construction).
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  -- queued | planning | capturing | assembling | uploading | ready | failed | cancelled
  status            TEXT NOT NULL DEFAULT 'queued',
  -- full | degraded — see the header. Defaults to 'full'; the runner downgrades, never the reverse.
  quality_state     TEXT NOT NULL DEFAULT 'full',
  -- Progress is window counts, not a percentage: the runner knows exactly how many timeline
  -- windows the plan named, and a count cannot drift the way a synthesised percentage does.
  objects_total     INTEGER NOT NULL DEFAULT 0,
  objects_done      INTEGER NOT NULL DEFAULT 0,
  -- The frozen export plan (grid, windows, audio, warnings, failure) — see the header.
  plan              JSONB,
  error             TEXT,
  -- Set by the cancel endpoint, honoured by the runner between phases. Never flips status itself.
  cancel_requested  BOOLEAN NOT NULL DEFAULT false,
  -- The finished master's storage key. NULL until the exit-0 + duration gates pass.
  output_key        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

-- At most one export of a given project may be in flight. Enforced by the database rather than by
-- a read-then-insert in the handler, because the failure mode of a double-click is two multi-minute
-- ffmpeg encodes of the same timeline running concurrently — pure waste, and a race on the
-- progress row the client polls.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_exports_inflight
  ON project_exports (project_id)
  WHERE status IN ('queued', 'planning', 'capturing', 'assembling', 'uploading');

-- The status poll.
CREATE INDEX IF NOT EXISTS idx_project_exports_project
  ON project_exports (project_id, created_at DESC);

ALTER TABLE project_exports
  DROP CONSTRAINT IF EXISTS project_exports_status_chk;
ALTER TABLE project_exports
  ADD CONSTRAINT project_exports_status_chk
  CHECK (status IN ('queued', 'planning', 'capturing', 'assembling', 'uploading', 'ready', 'failed', 'cancelled'));

ALTER TABLE project_exports
  DROP CONSTRAINT IF EXISTS project_exports_quality_state_chk;
ALTER TABLE project_exports
  ADD CONSTRAINT project_exports_quality_state_chk
  CHECK (quality_state IN ('full', 'degraded'));

-- NO "ready implies an output_key" CHECK, for the reason migration 056 documents at length for its
-- own would-be invariant: a constraint of that shape turns a legitimate later NULLing (a retention
-- sweep of old masters, say) into a 23514 from a table the sweep has no other relationship with.
-- `ready` with a NULL output_key is representable and means "the master existed and has since been
-- reaped"; the download endpoint answers it honestly with no URL.
