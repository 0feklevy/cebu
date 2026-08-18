-- 062: B-roll generation idempotency — one automatic finalisation publishes at most one section.
--
-- WHAT WAS WRONG
-- `video_generate` is a durable pg-boss queue with retries, and it is re-driven by
-- `recoverStuckVideoGenerations` on every boot. Its body is submit → poll → download → transcode →
-- INSERT a b-roll timeline section, and that insert had no key. A retry, a recovery delivery, or a
-- second worker simply APPENDED A SECOND section. The player resolves an overlay with a first-match
-- `.find()` over one concatenated array, so two rows for one generation is a clip playing where the
-- user never put one — intermittently, because which of the two wins depends on row order.
--
-- WHERE THE FIX LIVES, AND WHY IT IS NOT HERE
-- An earlier draft of this migration added `timeline_sections.generation_job_id` with a partial
-- unique index. That is not shipped, for three reasons:
--
--   1. IT IS THE WRONG INVARIANT. The product lets a user manually re-insert a previously generated
--      asset. "This asset appears once in the timeline" is therefore false, and enforcing it would
--      break a supported action. The true invariant is narrower — one automatic finalisation
--      publishes at most one row — which is a property of the JOB, not of the section.
--   2. IT WOULD NOT HAVE FIXED ANY EXISTING ROW. Every section written before this migration gets
--      a NULL, and NULLs do not collide under a partial unique index. The constraint could only
--      ever have constrained rows written after it.
--   3. IT COSTS A WRITE LOCK ON A HOT TABLE. `ALTER TABLE` plus a non-concurrent index build on
--      `timeline_sections` blocks writers for the duration, and because the runner wraps each file
--      in one transaction, every lock in this file is held until COMMIT.
--
-- `video_generation_jobs.section_id` already exists. Finalisation now locks the job row with
-- SELECT … FOR UPDATE, re-checks the claim and `section_id` AFTER the wait, adopts an existing
-- section or creates exactly one, and commits behind a fence requiring both the claim and
-- `section_id IS NULL`. A second delivery blocks on the row lock and then observes the result
-- instead of racing it; a run that lost its lease rolls its INSERT back. That is a transaction
-- invariant rather than a constraint against arbitrary SQL — sufficient for the verified bug, and
-- it touches no hot table.
--
-- If a schema-level backstop is ever wanted, it belongs in its own file as a single
-- CREATE UNIQUE INDEX CONCURRENTLY statement, verified through the catalog (indisunique, indisready,
-- indisvalid) BEFORE any code depends on it — never code first, index second.

-- Fail fast rather than queue behind a long transaction: a deploy that cannot get the lock promptly
-- should abort and leave the previous version serving, not hold the table hostage.
SET LOCAL lock_timeout = '3s';

-- ── The lease ────────────────────────────────────────────────────────────────────────────────
--
-- Serialising finalisation does not stop two workers each spending twenty minutes polling the same
-- provider task, and does not make a run that died mid-flight reclaimable — a row stuck in
-- `generating` looks exactly like one that is progressing. Both need the discipline
-- ProjectExportService already documents: a CAS claim, a heartbeat that makes staleness a sound
-- death test, and fenced writes so a superseded run cannot drag a terminal row back to life.
--
--   • `updated_at` is the heartbeat. Twenty missed beats and the row is declared dead — the same
--     number exports and duplications use, because the argument is theirs.
--   • `claimed_by` is a FENCING TOKEN, one value per RUN rather than per process, so the fence
--     means "this exact run still owns the row".
--   • `attempts` is what makes the one un-resumable step safe. See below.

ALTER TABLE video_generation_jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0;

-- WHY `attempts` EXISTS
-- Every stage resumes from what the row already holds — except one. Between `submit()` returning a
-- provider task id and that id reaching the row there is a window where a crash leaves a PAID
-- generation nobody can find again, and re-submitting bills it twice. The old code guarded that
-- only on the startup path, so a pg-boss RETRY of a row sitting in `submitting` re-submitted and
-- double-billed. `attempts` is incremented BY THE CLAIM ITSELF, in the same UPDATE, so the runner
-- can distinguish a first attempt from a re-drive with no race. That case converges to zero
-- sections and one honest `failed` row — never to two sections, and never to a second charge.
--
-- NOT a retry budget: pg-boss owns retry limits. This column answers one question — has anyone run
-- this row before?

-- BACKFILL, and it is load-bearing rather than cosmetic.
--
-- Every row already in flight when this migration runs HAS been attempted — that is what "in
-- flight" means — but the column defaults to 0, which reads as "never run". Without this, the first
-- boot after the deploy re-drives a row stranded in `submitting`, the runner sees attempts=1 (its
-- own claim), concludes nobody has been here before, and RE-SUBMITS the very generation the check
-- exists to protect. The deploy window is when stranded rows are most likely, so leaving the
-- default would aim the bug at its most probable moment.
--
-- `queued` is deliberately excluded: a queued row has been created, not attempted.
UPDATE video_generation_jobs
   SET attempts = 1
 WHERE attempts = 0
   AND status IN ('enhancing', 'submitting', 'generating', 'downloading', 'transcoding');

-- NO index on the in-flight scan, deliberately. The startup re-drive filters on status alone and
-- has no ORDER BY, so an index on `updated_at` would not serve it — it is a performance index, not
-- a correctness condition, and it would add a second lock to this file for no measured benefit.
-- Add one only after EXPLAIN on representative volume says it helps.
--
-- NO status CHECK constraint, deliberately. This table has never had one, rows predating this
-- migration were written by code that has changed several times, and a CHECK added now would turn
-- any legacy status nobody remembers into a hard failure of an UPDATE issued from a code path that
-- has no idea the constraint exists. The status vocabulary is asserted in the runner's tests, where
-- being wrong costs a red test instead of a stuck job.
