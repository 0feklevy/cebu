-- 084: which simulation a copy was imported FROM (owner ruling 2026-09-03 — a saved setup must
-- carry its simulation between projects, "like duplicate but across projects").
--
-- The import (`POST /projects/:id/simulations/import`, migration 080's blob store underneath) has
-- always copied a package into another project without storing a byte twice. What it never
-- recorded is WHERE the copy came from, so nothing could answer "does this project already have
-- that simulation?" — and loading the same saved setup twice, or into a project that was already
-- given the package, minted another row and another file mapping every time.
--
-- One nullable, self-referencing column answers it. ON DELETE SET NULL: a copy outlives its
-- source, exactly as a saved setup does (saved_bridges.source_simulation_id has the same rule).
-- The partial index is the lookup the loader performs: "in THIS project, imported from THAT one".
--
-- Expand-only: the previous image never selects it. Do not write BEGIN/COMMIT — migrate.ts wraps.

ALTER TABLE simulations
  ADD COLUMN IF NOT EXISTS imported_from_simulation_id uuid REFERENCES simulations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_simulations_imported_from
  ON simulations (project_id, imported_from_simulation_id)
  WHERE imported_from_simulation_id IS NOT NULL;
