-- 062: B-roll generation idempotency — one generation, one section, however many times it runs.
--
-- WHAT WAS WRONG
-- `video_generate` is a durable pg-boss queue with retries (PGBOSS_JOB_NAMES), and it is re-driven
-- by `recoverStuckVideoGenerations` on every boot. Its body is submit → poll → download →
-- transcode → INSERT a b-roll timeline section, and that insert had no key. A retry, a recovery
-- delivery, or a second worker simply APPENDED A SECOND section at the same global offset. The
-- player resolves an overlay with a first-match `.find()` over one concatenated array, so two rows
-- for one generation is a clip playing where the user never put one — intermittently, because
-- which of the two wins depends on row order.
--
-- WHY A CONSTRAINT AND NOT A GUARD IN THE HANDLER
-- A read-then-insert cannot fix it: the two deliveries can be in different processes, and the
-- window between the SELECT and the INSERT is exactly where the bug lives. The fix has to be a key
-- the engine enforces — which is what 056 and 058 already do for the other "this work happens
-- once" surfaces (`uniq_project_duplications_inflight`, `uniq_project_exports_inflight`). This is
-- the same idiom one level down: not "at most one run in flight" but "at most one ROW per run,
-- forever". A queue-level singleton key is NOT a substitute and is not treated as one: pg-boss
-- dedupes only jobs still waiting to start, and it has nothing at all to say about a RETRY of a job
-- that already ran, which is the delivery that produced the duplicate.
--
-- WHY THE KEY LIVES ON timeline_sections
-- `video_generation_jobs.section_id` already exists, and a UNIQUE on it would only say "two jobs
-- may not share a section" — which was never the failure. What must be unique is the SECTION's
-- provenance, so the column carrying it belongs on the section: the second INSERT has to be refused
-- by the engine at the moment it is attempted, before anyone reads the job row.
--
-- PARTIAL, because every section that did NOT come from a generation has a NULL here and a TOTAL
-- unique index would permit exactly one of those per database. Same reason 056 and 058 spell their
-- indexes out in SQL rather than in the Drizzle table builder, which has no WHERE clause.
--
-- ON DELETE SET NULL, not CASCADE: deleting the bookkeeping row for a finished generation must not
-- delete the b-roll the user is now editing. The section outlives the job that made it.

ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS generation_job_id UUID REFERENCES video_generation_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_timeline_sections_generation_job
  ON timeline_sections (generation_job_id)
  WHERE generation_job_id IS NOT NULL;

-- The provenance lookup the runner makes on every resume ("did a previous attempt already insert
-- my section?"). Served by the unique index above — no second index is needed, and adding one
-- would only cost writes.

-- ── The lease ────────────────────────────────────────────────────────────────────────────────
--
-- The constraint above makes a duplicate section impossible. It does not stop two workers from
-- each spending twenty minutes polling the same provider task, and it does not make a run that
-- died mid-flight reclaimable — a row stuck in `generating` forever looks exactly like one that is
-- progressing. Both need the discipline ProjectExportService already documents at length: a CAS
-- claim, a heartbeat that makes staleness a sound death test, and fenced writes so a superseded run
-- cannot drag a terminal row back to life.
--
--   • `updated_at` is the heartbeat. Twenty missed beats and the row is declared dead, exactly as
--     for exports and duplications — the number is theirs because the argument is theirs.
--   • `claimed_by` is a FENCING TOKEN, one value per RUN (not per process). That makes the fence
--     "this exact run still owns the row", which is strictly stronger than the export's
--     status-set fence: the moment a successor claims, every write from the reclaimed run becomes
--     a no-op instead of a race.
--   • `attempts` is what makes the one un-resumable step safe. See below.

ALTER TABLE video_generation_jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0;

-- WHY `attempts` EXISTS
-- Every stage of the job resumes from what the row already holds — except one. Between `submit()`
-- returning a provider task id and that id reaching the row there is a window where a crash leaves
-- a PAID generation nobody can find again. Re-submitting bills it twice. The old code guarded that
-- only on the startup path, so a pg-boss RETRY of a row sitting in `submitting` re-submitted and
-- double-billed. `attempts` is incremented BY THE CLAIM ITSELF, in the same UPDATE, so the runner
-- can tell a first attempt from a re-drive with no race and refuse the re-submit. That case
-- converges to zero sections and one honest `failed` row — never to two sections, and never to a
-- second charge.
--
-- NOT a retry budget: pg-boss owns retry limits. This column answers one question ("has anyone run
-- this row before?") and nothing else.

-- BACKFILL, and it is load-bearing rather than cosmetic.
--
-- Every row already in flight when this migration runs HAS been attempted — that is what "in
-- flight" means — but the column defaults to 0, which reads as "never run". Without this, the first
-- boot after the deploy re-drives a row stranded in `submitting`, the runner sees attempts=1 (its
-- own first claim), concludes nobody has been here before, and RE-SUBMITS the very generation the
-- check exists to protect. The deploy window is exactly when stranded rows are most likely, so
-- leaving the default in place would aim the bug at its most probable moment.
--
-- `queued` is deliberately excluded: a queued row has been created, not attempted, and starting it
-- for the first time must not be mistaken for a resume.
UPDATE video_generation_jobs
   SET attempts = 1
 WHERE attempts = 0
   AND status IN ('enhancing', 'submitting', 'generating', 'downloading', 'transcoding');

-- The scan the startup re-drive makes: in-flight rows, ordered by how long they have been quiet.
CREATE INDEX IF NOT EXISTS idx_vgj_inflight
  ON video_generation_jobs (updated_at)
  WHERE status IN ('queued', 'enhancing', 'submitting', 'generating', 'downloading', 'transcoding');

-- NO status CHECK constraint, deliberately. `video_generation_jobs` has never had one, rows
-- predating this migration were written by code that has changed several times, and a CHECK added
-- now would turn any legacy status nobody remembers into a hard failure of an UPDATE issued from a
-- code path that has no idea this constraint exists. The status vocabulary is asserted in the
-- runner's tests, where being wrong costs a red test instead of a stuck job.
