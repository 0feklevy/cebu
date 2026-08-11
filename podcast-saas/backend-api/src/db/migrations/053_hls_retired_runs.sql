-- 053: Grace-period retention for retired HLS run trees (P0.3).
--
-- A re-transcode writes a fresh versioned tree (hls/{videoFileId}/{runId}/…) and flips the DB
-- pointer — but viewers mid-session still hold segment URLs into the OLD tree, and until now the
-- old tree was deleted on the very next microtask after the flip. Anyone who had buffered the old
-- master got 404s on the segments it references: a torn session, precisely what the versioned-tree
-- design exists to prevent.
--
-- This table is the fix: the transcode RECORDS the retired tree here instead of deleting it, and a
-- bounded hourly sweep (startHlsRetentionSweep) deletes trees only after their grace window
-- (HLS_RETIRE_GRACE_HOURS, default 24h, min 1h) has passed — long after any live session ended.
--
-- `prefix` is UNIQUE so a crash-and-retry of the same transcode run cannot queue the same tree
-- twice (the writer inserts with ON CONFLICT DO NOTHING).
--
-- No FK on video_file_id: the entity-delete endpoints purge the whole hls/{id}/ storage prefix
-- themselves and explicitly drop this bookkeeping (deleteHlsRetirementRowsForVideo), and a FK
-- would make that ordinary cleanup a constraint hazard rather than a plain delete.

CREATE TABLE IF NOT EXISTS hls_retired_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_file_id UUID NOT NULL,
  -- The retired run tree's storage prefix, e.g. 'hls/{videoFileId}/{runId}'.
  prefix        TEXT NOT NULL UNIQUE,
  retired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Do not delete the tree before this instant.
  retire_after  TIMESTAMPTZ NOT NULL,
  -- Set when the sweep has actually deleted the storage prefix; NULL = still pending.
  deleted_at    TIMESTAMPTZ
);

-- The sweep's predicate is "due and not yet deleted"; the partial index keeps it an index scan
-- no matter how much already-swept history the table accumulates.
CREATE INDEX IF NOT EXISTS idx_hls_retired_runs_due
  ON hls_retired_runs (retire_after) WHERE deleted_at IS NULL;

-- Entity deletion (video delete / project delete) drops this bookkeeping by video id.
CREATE INDEX IF NOT EXISTS idx_hls_retired_runs_video
  ON hls_retired_runs (video_file_id);
