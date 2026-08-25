-- Rollback 079.
--
-- Saved bridges reference nothing and nothing references them: the table is a leaf, so unlike 078
-- there is no ordering to respect here. Dropping it destroys the presets themselves — they exist
-- ONLY in this table, having been copied out of storage on purpose so they could outlive the
-- revisions and sections they came from. A rollback is therefore data loss, not merely a schema
-- reversal, and should be preceded by a dump if any preset has been saved.
--
-- What it does NOT touch: nothing in storage, and no timeline_sections row. A section that had a
-- preset applied keeps its script and its sim_meta exactly as they are — the preset was the
-- source of that content, not its owner.
DROP INDEX IF EXISTS saved_bridges_owner_idx;
DROP INDEX IF EXISTS saved_bridges_owner_label_idx;
DROP TABLE IF EXISTS saved_bridges;
