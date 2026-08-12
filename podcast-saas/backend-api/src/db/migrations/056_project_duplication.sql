-- 056: Duplicate project — the job row the copy runs under.
--
-- WHY A JOB ROW AND NOT A `duplicating` PROJECT STATE
-- The obvious shape is to insert the destination project immediately in some 'duplicating' status
-- and fill it in as bytes land. That shape cannot satisfy the one property the feature has to have:
-- a failed copy must leave NO half-built project. Storage is not transactional, so the byte copy
-- runs for minutes with no rollback; if the project row exists for that whole window, then every
-- crash, deploy, or 500 leaves a project in the owner's list that references objects that may or
-- may not exist, and the recovery path is a bespoke reaper that has to decide which of ~20 child
-- tables were reached.
--
-- Tracking the WORK instead of the RESULT removes the problem by construction: bytes are copied
-- into keys derived from ids that are allocated up front but not yet written anywhere, and the
-- entire row graph is inserted in a single transaction at the end. Before that commit there is
-- nothing to clean up but orphan objects, which are reapable and harmless. After it, the copy is
-- complete. There is no third state.
--
-- The UI cost is one indirection: POST returns this row's id, the client polls it, and navigates
-- when `target_project_id` appears. That is the same poll-a-job-row shape the b-roll generator and
-- the podcast renderer already use.

CREATE TABLE IF NOT EXISTS project_duplications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: this is bookkeeping about a project, and it dies with it. The COPY is not affected —
  -- it is an independent project referenced by target_project_id, which is SET NULL precisely so
  -- deleting either side leaves the other's history readable.
  source_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  requested_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  -- queued | copying | committing | ready | failed
  status            TEXT NOT NULL DEFAULT 'queued',
  -- Progress is object counts, not a percentage: the runner knows exactly how many objects the
  -- plan named, and a count cannot drift the way a synthesised percentage does.
  objects_total     INTEGER NOT NULL DEFAULT 0,
  objects_copied    INTEGER NOT NULL DEFAULT 0,
  bytes_total       BIGINT  NOT NULL DEFAULT 0,
  -- The dry-run plan: per-table row counts, the storage copies, and what was deliberately skipped.
  -- Stored so a completed duplication can still answer "what did this actually copy?" months later.
  plan              JSONB,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

-- At most one duplication of a given source may be in flight. Enforced by the database rather than
-- by a read-then-insert in the handler, because the failure mode of a double-click is two full HLS
-- ladder copies running concurrently against the same source — expensive, and racy in the storage
-- layer where both write to different keys but read the same objects.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_duplications_inflight
  ON project_duplications (source_project_id)
  WHERE status IN ('queued', 'copying', 'committing');

-- The status poll.
CREATE INDEX IF NOT EXISTS idx_project_duplications_source
  ON project_duplications (source_project_id, created_at DESC);

ALTER TABLE project_duplications
  DROP CONSTRAINT IF EXISTS project_duplications_status_chk;
ALTER TABLE project_duplications
  ADD CONSTRAINT project_duplications_status_chk
  CHECK (status IN ('queued', 'copying', 'committing', 'ready', 'failed'));

-- NO "ready implies a target" CHECK, deliberately.
--
-- It was the obvious invariant to add, and it is wrong here for the same reason migration 050
-- documents for simulations.active_revision_id: a CHECK that a nullable FK column must be non-null
-- turns ON DELETE SET NULL into a constraint violation. Deleting the COPY — an ordinary, fully
-- independent project the owner is entitled to delete — would raise 23514 from a table it has no
-- other relationship with, and the delete endpoint has no reason to know this table exists.
--
-- So `ready` with a null target is a representable and meaningful state: the copy was made, and has
-- since been deleted. The poll endpoint reports exactly that, and the client treats a ready row with
-- no target as finished-with-nothing-to-open rather than as a contradiction.
ALTER TABLE project_duplications
  DROP CONSTRAINT IF EXISTS project_duplications_ready_has_target_chk;
