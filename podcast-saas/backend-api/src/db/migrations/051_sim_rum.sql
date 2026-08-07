-- 051: Real-user measurement for the simulation pipeline (Priority 8.9).
--
-- WHY THIS TABLE EXISTS
-- Nothing about simulation performance has ever been measured in the field. The publish-time canary
-- records per-step `ms` for a package in a lab (migration 050, sim_revisions.canary_report), but a
-- lab number on one machine cannot answer how much lead time preparation needs on a real phone, or
-- whether moving the section clock to requestVideoFrameCallback is worth its risk. Those decisions
-- are currently guesses. This table is the smallest thing that makes them measurements.
--
-- DEFAULT OFF
-- `rum_sample_rate` defaults to 0. A viewer sends nothing until an operator deliberately turns it
-- on, and turning it back off is a single UPDATE with no deploy. That is the kill switch as much as
-- the privacy posture: a measurement system that cannot be disabled without shipping code is a
-- liability the first time it misbehaves.
--
-- WHAT IS DELIBERATELY NOT STORED
-- No URL, no project or section title, no user id, no IP, no free text. `session_id` is random per
-- page load and never persisted client-side, so it cannot link two visits by one person. Device
-- fields are coarse buckets, and `failure_code` is length-bounded precisely so it cannot become a
-- free-text sink on an endpoint that must accept anonymous callers.
--
-- RETENTION IS PART OF THE SCHEMA, NOT AN INTENTION
-- `created_at` carries an index specifically so the reaper is cheap, and the reaper is part of this
-- change rather than a follow-up. An events table with no enforced retention grows without bound
-- and quietly becomes the largest thing in the database.

CREATE TABLE IF NOT EXISTS sim_rum_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Random per page load, client-generated, bounded by the validator. NOT a user identifier.
  session_id        TEXT NOT NULL,
  -- The package these numbers describe. Not a FK: a revision may be garbage-collected while its
  -- measurements remain useful, and a FK would either block that collection or delete the history
  -- that explains why the package was withdrawn.
  package_revision  TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('transition', 'residency', 'failure')),
  -- Milliseconds since the session started. Never a wall-clock time, so two events cannot be
  -- correlated against an external log to re-identify a viewer.
  t_ms              INTEGER NOT NULL CHECK (t_ms >= 0),

  -- Durations. NULL means "not observed" and never "zero": a missing stage is not a fast stage, and
  -- conflating them is how a broken measurement passes for a good one.
  total_ms          INTEGER CHECK (total_ms IS NULL OR total_ms >= 0),
  prepare_ms        INTEGER CHECK (prepare_ms IS NULL OR prepare_ms >= 0),
  present_ms        INTEGER CHECK (present_ms IS NULL OR present_ms >= 0),
  apply_ms          INTEGER CHECK (apply_ms IS NULL OR apply_ms >= 0),
  -- Where an abandoned transition stopped. A package that always dies at one stage is failing
  -- differently from one that dies at another, and counting only completions would hide both.
  furthest_stage    TEXT,
  failure_code      TEXT,

  -- Coarse device buckets. Every duration has to be read against these — comparing a transition on
  -- a 2 GB phone at 'window' tier with one on a desktop at 'all' tier is meaningless.
  device_memory_gb  INTEGER,
  device_cores      INTEGER,
  coarse_pointer    BOOLEAN,
  save_data         BOOLEAN,
  dpr               REAL,
  pool_tier         TEXT CHECK (pool_tier IS NULL OR pool_tier IN ('single', 'window', 'all')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The reaper's predicate. Retention is enforced, so this index is not optional.
CREATE INDEX IF NOT EXISTS idx_sim_rum_created ON sim_rum_events(created_at);
-- The analysis predicate: percentiles for one package, optionally split by tier.
CREATE INDEX IF NOT EXISTS idx_sim_rum_package ON sim_rum_events(package_revision, kind, created_at);

-- Bound the free-ish text columns at the DDL level too, not only in the validator. The endpoint is
-- unauthenticated by necessity — anonymous viewers are most of the traffic — so the last line of
-- defence belongs where a code change cannot accidentally remove it.
DO $$ BEGIN
  ALTER TABLE sim_rum_events ADD CONSTRAINT sim_rum_events_len_chk CHECK (
    length(session_id) BETWEEN 8 AND 128
    AND length(package_revision) BETWEEN 1 AND 64
    AND (failure_code IS NULL OR length(failure_code) <= 64)
    AND (furthest_stage IS NULL OR length(furthest_stage) <= 32)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── The kill switch ──────────────────────────────────────────────────────────────────────────────
-- 0 = collect nothing. Flippable at runtime with no deploy, following the sim_pool_mode precedent
-- exactly (env override → this column → safe default, with the read wrapped so a missing column can
-- never break the player).
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS rum_sample_rate REAL NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE admin_settings ADD CONSTRAINT admin_settings_rum_sample_rate_chk
    CHECK (rum_sample_rate >= 0 AND rum_sample_rate <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- How long measurements are kept. Bounded in BOTH directions: zero would silently disable retention
-- and let the table grow forever, and an unbounded upper value would let one careless UPDATE turn a
-- 30-day dataset into a permanent one.
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS rum_retention_days INTEGER NOT NULL DEFAULT 30;

DO $$ BEGIN
  ALTER TABLE admin_settings ADD CONSTRAINT admin_settings_rum_retention_chk
    CHECK (rum_retention_days >= 1 AND rum_retention_days <= 365);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Derived preparation budget (Priority 8.7) ────────────────────────────────────────────────────
-- The package's own publish-time preparation cost, in ms, derived from its canary report when the
-- verdict is recorded.
--
-- Stored as a SCALAR rather than recomputed from canary_report on read. buildPlayerConfig is the
-- hottest read path in the product and selects an explicit `columns` list precisely to avoid
-- pulling JSONB — and canary_report is large (per-case steps, errors, capabilities, resource
-- counts). Deriving once at publication and reading one integer keeps that property.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS prepare_budget_ms INTEGER;

DO $$ BEGIN
  ALTER TABLE simulations ADD CONSTRAINT simulations_prepare_budget_chk
    CHECK (prepare_budget_ms IS NULL OR prepare_budget_ms >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
