-- 063: segment-relative placement for overlays — the expand half of D-01.
--
-- WHAT IS WRONG TODAY
-- A b-roll overlay is positioned by `timeline_sections.global_offset_sec`, an ABSOLUTE second on
-- the concatenated main timeline. That timeline is not stable: re-transcode a main video to a
-- slightly different length and every frame after it slides, while the overlay does not. The clip
-- still fires at second 47 — but second 47 is now a different moment. The stored number was never
-- wrong; it stopped meaning what the author intended.
--
-- Clip overlays drift the other way, by a different mechanism: they store no absolute at all and
-- are re-derived every read from a cumulative sum of `video_files.duration_sec`, so they follow
-- their host — and also follow any change to a duration BEFORE them, including one that is merely
-- stale or still NULL while the transcode worker catches up. Two representations of one authored
-- moment, and a re-transcode pulls them apart.
--
-- WHAT THIS ADDS
-- An anchor: a MAIN VIDEO SEGMENT plus a time inside that segment. Absolute time is then derived on
-- every read (`resolveSectionPlacement`, in shared/timeline/placement.ts — ONE resolver for the
-- editor, the viewer, the export planner and the prewarm/marker maths, because the bug class is
-- that each surface answers differently and a second resolver recreates it).
--
-- WHY NOT A `timeline_sections.section_id` ANCHOR
-- Sections are SPARSE annotations. A project can run for minutes with no section row, so a
-- section-relative anchor cannot express every point on the timeline. Video segments tile it
-- completely: the main track is a concatenation with no representable interior gap, since there is
-- no per-video start column anywhere in this schema and every layout in the codebase is the same
-- `offset = running total; running total += duration`.
--
-- WHY ITS OWN COLUMN PAIR AND NOT `video_file_id`
-- On a b-roll row `video_file_id` already means the b-roll SOURCE asset — a video with no position
-- on the main timeline at all. Overloading it would make one column mean two different things
-- depending on `track`, which is how this table got into trouble in the first place.

-- Fail fast rather than queue behind a long transaction: a deploy that cannot get the lock promptly
-- should abort and leave the previous version serving, not hold the table hostage. LOCAL, never
-- bare — the runner reuses one connection for every file, so a session-level SET leaks into the
-- migrations that follow (the lesson of 062).
SET LOCAL lock_timeout = '3s';

-- ── timeline_sections: the anchor pair and the mode ──────────────────────────────────────────
--
-- NULLABLE, and `placement_mode` defaults to 'legacy_absolute'. This is EXPAND/CONTRACT: after this
-- migration every existing row still reads exactly as it did, because the resolver's dual read
-- takes the anchor first and falls back to `global_offset_sec`. A rollback of the application code
-- needs no schema change at all — the columns are simply ignored.
--
-- NOTHING IS BACKFILLED HERE, and that is the ruling rather than laziness. Converting a row means
-- reading its absolute second, asking TODAY's timeline which segment that lands in, and writing
-- that down as the author's intent. If the row has already drifted — which is the entire premise of
-- D-01 — then what gets written down is the drifted position, permanently, and the original intent
-- becomes unrecoverable. A migration that "fixed" every row would in fact FREEZE every row's
-- current mistake. `planAnchorBackfill` produces a dry-run report instead; conversion happens on
-- explicit review, or on an author drag, which is the author asserting the position themselves.
--
-- ON DELETE SET NULL, not CASCADE: deleting a main video must not delete the overlays an author
-- placed over it. A row then sits at `placement_mode='segment'` with a NULL anchor, and that state
-- is exactly why the mode is a stored column rather than a computed `anchor_video_file_id IS NOT
-- NULL` — it distinguishes "was anchored, lost its host" from "was never anchored", and the
-- resolver reports the first as a degradation instead of silently treating it as the second.
--
-- The inline REFERENCES matches migrations 014 and 020, which added `clip_source_video_id` and
-- `clip_source_audio_id` to this same table the same way. Its validation pass is a scan of
-- timeline_sections, which is bounded above by the lock_timeout set here and is trivially satisfied
-- (every value is NULL). If this table ever grows to where that scan matters, the escape hatch is
-- to split it: ADD COLUMN, then ADD CONSTRAINT ... NOT VALID, then VALIDATE CONSTRAINT in a
-- separate file — deliberately NOT done now, because an unvalidated constraint is a state someone
-- has to remember to finish and this table is nowhere near that size.
ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS anchor_video_file_id UUID REFERENCES video_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anchor_offset_sec    REAL,
  ADD COLUMN IF NOT EXISTS placement_mode       TEXT NOT NULL DEFAULT 'legacy_absolute';

-- A CHECK here, unlike on `video_generation_jobs.status` in 062, and the difference is the whole
-- argument: NO ROW PREDATES THIS COLUMN. Every value in it was written by the DEFAULT one statement
-- ago, so there is no legacy vocabulary nobody remembers that a constraint could turn into a hard
-- failure from a code path that has no idea it exists. This table's other string columns are the
-- cautionary tale — `track` is a bare TEXT whose three legal values live in a COMMENT, and `type`
-- has no enum at all, which is how the malformed shapes the section census counts got written.
DO $$
BEGIN
  ALTER TABLE timeline_sections
    ADD CONSTRAINT timeline_sections_placement_mode_check
    CHECK (placement_mode IN ('segment', 'legacy_absolute'));
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- re-run of an already-applied migration
END $$;

COMMENT ON COLUMN timeline_sections.anchor_video_file_id IS
  'D-01: the MAIN video segment this overlay is placed relative to. NULL = not anchored, or the host was deleted (see placement_mode).';
COMMENT ON COLUMN timeline_sections.anchor_offset_sec IS
  'D-01: seconds into anchor_video_file_id. Half-open: [0, duration) on any segment but the last, which has a bounded post-roll tail.';
COMMENT ON COLUMN timeline_sections.placement_mode IS
  'D-01: segment | legacy_absolute. Dual read — the resolver takes the anchor first and falls back to global_offset_sec.';

-- ── video_generation_jobs: the anchor captured AT ENQUEUE TIME ────────────────────────────────
--
-- This is not symmetry for its own sake, it is a race.
--
-- `target_global_offset_sec` is an absolute second, and a generation job runs for up to twenty-five
-- minutes. The timeline is editable that entire time. The obvious fix — work out the anchor when
-- the job FINISHES — reads a timeline that may have moved since the author pressed the button, and
-- so recreates precisely the drift the anchor exists to prevent, only with a wider window. The
-- anchor therefore has to be resolved ONCE, against the timeline the author was looking at, and
-- carried on the job row until the finaliser copies it onto the published section verbatim.
--
-- Nullable: a project with no main video has nothing to anchor to, and the job still runs. The
-- section it publishes then falls back to legacy_absolute, which is the pre-063 behaviour.
ALTER TABLE video_generation_jobs
  ADD COLUMN IF NOT EXISTS target_anchor_video_file_id UUID REFERENCES video_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_anchor_offset_sec    REAL;

COMMENT ON COLUMN video_generation_jobs.target_anchor_video_file_id IS
  'D-01: the main segment the author aimed at, resolved AT ENQUEUE. Inferring it at completion would re-run the race.';

-- NO INDEX, deliberately, on any of the four new columns.
--
-- None of them is ever a query predicate: the readers load a project's sections with
-- `WHERE project_id = $1` and place them in memory. The only scan they add is the referential
-- action behind each FK, fired when a video_file is deleted — and `clip_source_video_id` has been
-- an un-indexed FK on this same table since migration 014 with no measured problem, so the cost of
-- one more is the cost that is already being paid. Per 062: an index goes in only after EXPLAIN on
-- representative volume says it helps, and it goes in its own file as CREATE INDEX CONCURRENTLY,
-- never inside a transaction that is already holding a write lock on a hot table.
