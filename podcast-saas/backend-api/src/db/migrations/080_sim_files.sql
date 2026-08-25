-- 080: a simulation's files, stored ONCE however many simulations contain them.
--
-- ── THE PROBLEM THIS FIXES, WHICH 078 DID NOT ─────────────────────────────────────────────────
-- Migration 078 gave video, image and audio files a shared byte store. Simulations were left out,
-- and they are the largest single thing this product copies: a package runs 546 KB to 31 MB, and
-- the `+` import shipped in v0.2.0 duplicates EVERY byte of it into the destination's prefix.
-- Importing one simulation into five projects stored it five times. That is precisely the
-- duplication the dedup work existed to remove — the owner asked for it explicitly and the import
-- did the opposite.
--
-- ── HOW A SIMULATION STOPS OWNING ITS BYTES ───────────────────────────────────────────────────
-- A simulation's files are addressed by PATH today: `simulations/{projectId}/{simId}/index.html`.
-- The path encodes ownership, so two projects holding the same file must hold two objects.
--
-- This table breaks that link. A row says "for THIS simulation, the file at THIS relative path is
-- THAT blob" — and the blob lives at `blobs/<digest>`, owned by no project. The second import of
-- a package writes only rows: no upload, no copy, no bytes at all.
--
-- ── WHY IT IS A MAPPING TABLE AND NOT A COLUMN ON THE MANIFEST ────────────────────────────────
-- Revisions already carry a manifest with a sha256 per file, and folding the blob reference into
-- it would look tidier. It would also mean the serving path has to read and parse a JSON manifest
-- to resolve one asset, and that every legacy (pre-revision) simulation — which has no manifest at
-- all — could never be deduplicated. A row per file is resolvable with one indexed lookup and
-- works for both package generations.
--
-- ── THE TWO FOREIGN KEYS SAY DIFFERENT THINGS, DELIBERATELY ───────────────────────────────────
--   simulation_id  ON DELETE CASCADE — the mapping belongs to the simulation. Delete the
--                  simulation and its rows go, which is exactly how a blob stops being referenced.
--   blob_id        NO action — Postgres itself then refuses to delete a blob any simulation still
--                  points at, the same enforced-not-maintained invariant 078 relies on.

CREATE TABLE IF NOT EXISTS sim_files (
  simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  -- Bundle-relative, exactly as the serving path receives it: `index.html`, `assets/tex.png`.
  -- No leading slash; normalised by the writer so a lookup cannot miss on a formatting difference.
  rel_path      text NOT NULL,
  blob_id       uuid NOT NULL REFERENCES media_blobs(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (simulation_id, rel_path),
  CONSTRAINT sim_files_rel_path_shape CHECK (rel_path <> '' AND rel_path NOT LIKE '/%')
);

-- The sweeper's question — "does any simulation still reference this blob?" — and the reverse of
-- the primary key, which serves lookups by simulation only.
CREATE INDEX IF NOT EXISTS sim_files_blob_idx ON sim_files (blob_id);
