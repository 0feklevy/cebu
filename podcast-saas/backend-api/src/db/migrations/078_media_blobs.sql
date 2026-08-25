-- 078: one copy of the bytes, however many projects point at them.
--
-- ── THE PROBLEM ───────────────────────────────────────────────────────────────────────────────
-- Every media row today is `project_id NOT NULL … ON DELETE CASCADE` carrying its OWN
-- `storage_key`. Two projects holding the same file therefore hold two uploads, two keys and two
-- copies of the bytes — and the only thing that ever notices is the storage bill.
--
-- ── WHY THERE IS NO ref_count COLUMN ──────────────────────────────────────────────────────────
-- The obvious design is a counter incremented on reference and decremented on release. It is the
-- wrong one HERE, and specifically because of the cascade above: deleting a project removes its
-- media rows without a single line of application code running, so a maintained counter would
-- silently drift every time an owner deleted a project — and a drifted counter deletes bytes that
-- are still in use, which is the one failure this table exists to prevent.
--
-- So the reference is not counted, it is DERIVED: `blob_id` is a plain foreign key with NO cascade
-- and NO set-null, which means Postgres itself REFUSES to delete a blob while any row still points
-- at it. The invariant is enforced by the database rather than maintained by us, so there is no
-- state to get out of step with reality. The sweeper's job shrinks to "try the delete; a foreign
-- key violation means it is still in use", which cannot be wrong.
--
-- ── IDENTITY IS THE PAIR, NOT THE HASH ────────────────────────────────────────────────────────
-- UNIQUE (sha256, byte_size), not UNIQUE (sha256). Size is then a constraint the database enforces
-- rather than a comment in a code path: two rows agreeing on hash but not on length are kept apart
-- instead of silently merged, which is the shape a crafted-collision attempt would take in a
-- multi-tenant store.

CREATE TABLE IF NOT EXISTS media_blobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercase hex SHA-256 of the COMPLETE object.
  sha256       text NOT NULL,
  byte_size    bigint NOT NULL,
  -- Where the bytes live. Exactly once, for every project that references this row.
  storage_key  text NOT NULL,
  content_type text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Last time the object was confirmed to EXIST in storage at the recorded size. A blob whose
  -- bytes were deleted underneath us (the writer/deleter asymmetry this repo has been bitten by)
  -- must not be handed to a new reference as if it were there.
  last_verified_at timestamptz,
  -- Set when the sweeper first observes the blob unreferenced. Deletion happens on a LATER pass,
  -- after a grace period: a blob can be unreferenced for the few seconds between "row deleted" and
  -- "row re-created by an import in flight", and deleting inline would race that window.
  orphaned_at  timestamptz,
  CONSTRAINT media_blobs_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_blobs_size_nonneg  CHECK (byte_size >= 0)
);

-- The identity itself.
CREATE UNIQUE INDEX IF NOT EXISTS media_blobs_identity_idx ON media_blobs (sha256, byte_size);
-- Two blob rows naming the same object would make deleting either one destroy the other's bytes.
CREATE UNIQUE INDEX IF NOT EXISTS media_blobs_storage_key_idx ON media_blobs (storage_key);
-- The sweeper's scan: unreferenced blobs, oldest first.
CREATE INDEX IF NOT EXISTS media_blobs_orphaned_idx ON media_blobs (orphaned_at) WHERE orphaned_at IS NOT NULL;

-- ── THE POINTERS ──────────────────────────────────────────────────────────────────────────────
-- Nullable and additive. `storage_key` stays exactly as it is on every existing row, so every
-- reader keeps working unchanged and nothing needs backfilling before this ships. A row with
-- blob_id IS NULL is simply a row that predates dedup, or one whose bytes are not shared.
--
-- No ON DELETE clause anywhere below, deliberately: the default (NO ACTION) is what makes the
-- database refuse to drop a referenced blob. Adding CASCADE or SET NULL here would hand that
-- refusal back to application code and reintroduce exactly the drift this design removes.

ALTER TABLE video_files ADD COLUMN IF NOT EXISTS blob_id uuid REFERENCES media_blobs(id);
ALTER TABLE image_files ADD COLUMN IF NOT EXISTS blob_id uuid REFERENCES media_blobs(id);
ALTER TABLE audio_files ADD COLUMN IF NOT EXISTS blob_id uuid REFERENCES media_blobs(id);

-- Partial indexes: the sweeper asks "does anything still reference this blob?" once per candidate,
-- and without these that is three sequential scans over the media tables per blob.
CREATE INDEX IF NOT EXISTS video_files_blob_idx ON video_files (blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_files_blob_idx ON image_files (blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audio_files_blob_idx ON audio_files (blob_id) WHERE blob_id IS NOT NULL;
