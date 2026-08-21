-- 069: the impact-review queue, and a host that cannot be deleted out from under its anchors (D-01b).
--
-- NUMBERING: 068 is claimed by feat/project-source-language, in flight at the time this was
-- written. 069 is the first genuinely free number.
--
-- 063 gave a b-roll a stable anchor — a main segment plus a time inside it — so that re-transcoding
-- a video moves the overlay WITH its content. That closed the drift. It did not answer the three
-- questions D-01b asks next, and this file is those answers.
--
-- ── 1. A DURATION CORRECTION MUST REWRITE NOTHING ───────────────────────────────────────────────
-- No schema is needed for that one; it is a deletion in the transcode job, recorded here because
-- this file is where the reasoning lives. The job used to run
--
--     UPDATE timeline_sections SET end_sec = LEAST(end_sec, $new), start_sec = LEAST(start_sec, $new)
--      WHERE video_file_id = $video AND end_sec > $new AND track IN ('main','broll')
--
-- on EVERY duration change, including the probe merely correcting a client-measured guess. That is
-- a destructive rewrite of authored placement data, fired by a background job, with no record of
-- the previous value and nothing shown to the author. It had already destroyed one class of row
-- (a 60-second music bed truncated to the length of the video under it — the `track` predicate
-- above is the scar) and the remaining classes were the same defect waiting for a shorter replace.
--
-- ── 2. A REPLACE RAISES A REVIEW INSTEAD OF CLAMPING ────────────────────────────────────────────
-- `placement_impact_reviews` is that list. When the probe lands a duration that leaves an anchor
-- outside its host, or a window outside its media, the row is KEPT EXACTLY AS AUTHORED and a review
-- is opened. The ruling is explicit that the alternatives are all worse than a queue: clamping
-- destroys the value, zeroing moves the clip to the top of the video, and attaching it to the
-- neighbouring segment invents an intent the author never expressed.
--
-- ── 3. A DELETE REQUIRES AN EXPLICIT CHOICE ─────────────────────────────────────────────────────
-- The anchor FK moves from ON DELETE SET NULL to NO ACTION, which makes deleting an anchored host
-- an error the API must handle rather than a silent orphaning. See the ALTER below for why NO
-- ACTION and not RESTRICT.

SET LOCAL lock_timeout = '3s';

-- ── The review queue ────────────────────────────────────────────────────────────────────────────
--
-- WHY A TABLE AND NOT A FLAG ON THE SECTION. A flag answers "is this row broken?" and nothing else.
-- The review has to survive being read by a person hours later, so it carries the numbers as they
-- were AT DETECTION — the host's length before and after, the offset, the window — because by then
-- the timeline may have moved again and "60 s → 12 s" is the only form in which the finding is
-- still checkable. It is also a queue with a resolution, and a boolean cannot record who decided
-- what.
--
-- WHY IT IS NOT A LOG. Every row here is a decision an author still owes. The partial unique index
-- below keeps it to at most one OPEN item per (section, reason), so a job that is delivered twice —
-- pg-boss retries, startup re-drive — refreshes the numbers instead of appending a duplicate for a
-- person to wade through.
CREATE TABLE IF NOT EXISTS placement_impact_reviews (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- CASCADE: a review of a section that no longer exists is not a finding, it is noise. The author
  -- deleting the clip IS a resolution, and the least ambiguous one available.
  section_id               UUID        NOT NULL REFERENCES timeline_sections(id) ON DELETE CASCADE,

  -- The media whose change raised this. SET NULL rather than CASCADE, and the difference matters
  -- for exactly one reason code: `host_deleted_detached` is written in the same transaction that
  -- deletes the host, so CASCADE would delete the review as fast as it was created. The host's name
  -- is carried in `detail` for that case, since the id will not survive.
  host_video_file_id       UUID        REFERENCES video_files(id) ON DELETE SET NULL,

  -- anchor_out_of_range      — the row is anchored INSIDE this host, past where it now ends.
  -- source_window_out_of_range — the row's in/out window addresses media now shorter than it.
  -- host_deleted_detached    — the author chose to keep a row whose host they deleted.
  reason                   TEXT        NOT NULL,

  -- Which case produced it. Recorded rather than inferred later: by the time anyone reads this
  -- row, the difference between "the probe corrected 30.0 to 30.04" and "someone uploaded a
  -- different video" is not recoverable from the schema.
  --
  -- `generation_published` is the fourth case and the one that is easy to miss. A b-roll
  -- generation captures its anchor AT ENQUEUE and can finish twenty-five minutes later; if the
  -- host was replaced in between, the section is published — verbatim, never re-derived, because
  -- re-deriving is the race the anchor exists to end — onto a host it no longer fits. The detector
  -- that runs at transcode time cannot see that row: it did not exist yet.
  change_kind              TEXT        NOT NULL,

  host_duration_before_sec REAL,
  host_duration_after_sec  REAL,
  anchor_offset_sec        REAL,       -- as stored on the row. NOT a proposal, and never applied.
  window_start_sec         REAL,
  window_end_sec           REAL,
  absolute_sec             REAL,       -- where the row played at detection, in the author's units
  detail                   TEXT,       -- one sentence, already phrased for a person

  detected_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ,
  -- re_placed  — the author moved the row; the anchor is theirs again.
  -- accepted   — the author looked and decided the current position is fine.
  -- dismissed  — not worth acting on.
  -- There is deliberately no `auto_fixed`: nothing in this system may resolve one of these by
  -- changing a placement on the author's behalf, so the vocabulary does not offer the word.
  resolution               TEXT,

  CONSTRAINT placement_impact_reviews_reason_check
    CHECK (reason IN ('anchor_out_of_range', 'source_window_out_of_range', 'host_deleted_detached')),
  CONSTRAINT placement_impact_reviews_change_kind_check
    CHECK (change_kind IN ('duration_correction', 'media_replace', 'host_delete', 'generation_published')),
  CONSTRAINT placement_impact_reviews_resolution_check
    CHECK (resolution IS NULL OR resolution IN ('re_placed', 'accepted', 'dismissed')),
  -- The two halves of "resolved" move together or the queue lies about its own length.
  CONSTRAINT placement_impact_reviews_resolved_pair_check
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

-- AT MOST ONE OPEN ITEM PER (SECTION, REASON). This is the idempotency key of the detector, not a
-- tidiness rule: the transcode job that opens these is delivered at least once, and without it a
-- re-driven job would hand the author the same finding twice. Resolved rows are exempt, so the
-- history of a section that has been through two replaces is preserved.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_placement_impact_open
  ON placement_impact_reviews (section_id, reason)
  WHERE resolved_at IS NULL;

-- The ONLY read path is "the open reviews for this project", which is what the editor asks for on
-- load. Unlike the four columns 063 deliberately left unindexed — none of which is ever a predicate
-- — this one is the predicate of the single query the table exists to serve, and it is created here
-- rather than later because the table is empty and cannot be locked against anything.
CREATE INDEX IF NOT EXISTS idx_placement_impact_open_by_project
  ON placement_impact_reviews (project_id, detected_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE placement_impact_reviews IS
  'D-01b: placements a media change left outside their host. Kept as authored; a person decides. Never auto-clamped.';

-- ── The anchor FK: SET NULL → NO ACTION ─────────────────────────────────────────────────────────
--
-- 063 chose SET NULL to protect the CONTENT — deleting a main video must not delete the b-roll
-- placed over it — and that instinct was right. What it left is a silent orphaning: the author
-- deletes a video, every overlay anchored to it loses its anchor, and each one falls back to a
-- wall-clock second that is now wrong, with nothing said. The ruling asks for the opposite default:
-- deleting an anchored host is an event that REQUIRES AN EXPLICIT CHOICE, never an inference.
--
-- WHY NO ACTION AND NOT RESTRICT — measured, not assumed. Both refuse a direct
-- `DELETE FROM video_files`. They differ when the referencing rows are being deleted by ANOTHER
-- cascade in the same statement, which is exactly what `DELETE FROM projects` does: it cascades to
-- video_files and to timeline_sections at once. RESTRICT is checked immediately, so it survives
-- that only while the two cascades happen to fire in the helpful order — an ordering nothing in the
-- schema pins and no test would notice changing. NO ACTION is checked at the END of the statement,
-- by which time the sections are gone and the check passes on purpose rather than by luck. Project
-- deletion is asserted in migration069.test.ts for exactly this reason.
--
-- The API never relies on hitting this error: `DELETE /projects/:id/videos/:videoId` runs a
-- transactional preflight, returns 409 with the dependents, and applies the author's choice. The
-- constraint is the floor under that — the guarantee that a path which forgets to preflight fails
-- loudly instead of quietly detaching an author's work.
DO $$
BEGIN
  ALTER TABLE timeline_sections
    DROP CONSTRAINT IF EXISTS timeline_sections_anchor_video_file_id_fkey;
  ALTER TABLE timeline_sections
    ADD CONSTRAINT timeline_sections_anchor_video_file_id_fkey
    FOREIGN KEY (anchor_video_file_id) REFERENCES video_files(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- re-run of an already-applied migration
END $$;

COMMENT ON COLUMN timeline_sections.anchor_video_file_id IS
  'D-01: the MAIN video segment this overlay is placed relative to. NULL = not anchored, or an author explicitly detached it (see placement_mode). Deleting the host is refused (069) until that choice is made.';

-- `video_generation_jobs.target_anchor_video_file_id` KEEPS ON DELETE SET NULL, deliberately.
--
-- A queued generation is not authored content: it is a request whose destination may stop existing
-- while the vendor renders. Blocking a video delete on a job that will publish in twenty minutes
-- would make the queue a hostage-taker, and the honest failure there is the one 063 already
-- defined — the finished section falls back to its absolute second, exactly as it did before
-- anchors existed. The preflight still COUNTS such jobs so the author is told what is in flight.
