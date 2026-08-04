-- 050: Immutable package revisions (Priority 7.1/7.2).
--
-- WHAT THIS REPLACES
-- Until now a simulation package lived at ONE mutable storage prefix and every regeneration
-- overwrote it in place. The entry HTML and the bridge are separate objects written one after the
-- other, so a request that landed between the two writes received the old HTML with the new bridge
-- (or the reverse) and there was no way to tell it had happened. A revision fixes that structurally:
-- every published file lives under a path containing the revision id, revision bytes are never
-- rewritten, and switching which revision is live is a single pointer update
-- (simulations.active_revision_id). See shared/src/sim/simRevision.ts for the layout and the
-- publication state machine this table stores.
--
-- THE ONE CONSTRAINT THAT MATTERS
-- `uniq_sim_revisions_one_active` — a PARTIAL unique index on (simulation_id) WHERE status='active'.
-- The pointer switch is only safe under concurrency because the DATABASE refuses a second active
-- revision. Application code cannot provide that guarantee: two activations that both read "the
-- current active is R1" and both write "R2/R3 is active" would each believe they succeeded, and the
-- losing one would leave simulations.active_revision_id pointing at a revision whose row says it is
-- not active. RevisionService takes a row lock on top of this, but the lock is an optimisation for
-- error quality — this index is the correctness argument.

CREATE TABLE IF NOT EXISTS simulation_revisions (
  -- Opaque, URL-safe and NOT sequential, because it appears in immutable storage paths: a
  -- renumbering must never be able to change a path that is already cached as immutable. The regex
  -- is isValidRevisionId (shared/src/sim/simRevision.ts) enforced at the only level that cannot be
  -- bypassed by a second writer.
  id                       TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  simulation_id            UUID NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  -- For humans and for ordering the publication history. Deliberately not the identity.
  revision_number          INTEGER NOT NULL CHECK (revision_number > 0),
  status                   TEXT NOT NULL CHECK (status IN (
                             'draft', 'uploading', 'validating', 'canary_passed',
                             'active', 'retired', 'failed', 'rolled_back'
                           )),
  -- computeManifestHash of the revision's canonical manifest. NULL until the manifest is written.
  manifest_hash            TEXT,
  bridge_protocol_version  INTEGER,
  runtime_protocol_version INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at             TIMESTAMPTZ,
  retired_at               TIMESTAMPTZ,
  -- Set when this revision was CREATED BY a rollback, naming the revision whose bytes it restored.
  -- ON DELETE SET NULL rather than CASCADE: losing the revision that was rolled back to must not
  -- delete the revision that replaced it — that would erase the newer half of the incident record.
  rollback_of_revision_id  TEXT REFERENCES simulation_revisions(id) ON DELETE SET NULL,
  metadata                 JSONB,
  CONSTRAINT uniq_sim_revisions_number UNIQUE (simulation_id, revision_number)
);

DO $$ BEGIN
  ALTER TABLE simulation_revisions ADD CONSTRAINT sim_revisions_metadata_object_chk
    CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every status that means "these bytes were served at some point" must carry the instant it went
-- live. rollbackTargetFor() picks the most recently ACTIVATED revision, so a retired revision with a
-- NULL activated_at would be invisible to rollback while looking like a perfectly good target in the
-- table — the failure would only appear during an incident, which is the worst time to find it.
DO $$ BEGIN
  ALTER TABLE simulation_revisions ADD CONSTRAINT sim_revisions_served_has_activated_at_chk
    CHECK (status NOT IN ('active', 'retired', 'rolled_back') OR activated_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The active revision is by definition not retired. Without this, a rollback that re-activated a
-- retired revision but forgot to clear retired_at would produce a row that is simultaneously live
-- and withdrawn, and no reader could decide which field to believe.
DO $$ BEGIN
  ALTER TABLE simulation_revisions ADD CONSTRAINT sim_revisions_active_not_retired_chk
    CHECK (status <> 'active' OR retired_at IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AT MOST ONE ACTIVE REVISION PER SIMULATION. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sim_revisions_one_active
  ON simulation_revisions (simulation_id) WHERE status = 'active';

-- listRevisions() reads a simulation's whole history newest-number-first.
CREATE INDEX IF NOT EXISTS idx_sim_revisions_sim_number
  ON simulation_revisions (simulation_id, revision_number DESC);

-- rollbackTargetFor() orders by activated_at, never by revision_number: a rollback re-activates an
-- OLDER number, so after one rollback the highest number is no longer the most recent thing served.
CREATE INDEX IF NOT EXISTS idx_sim_revisions_activated
  ON simulation_revisions (simulation_id, activated_at DESC);

-- ── The pointer ──────────────────────────────────────────────────────────────────────────────
-- NULLABLE, and that is load-bearing, not laziness: every simulation that exists today has no
-- revision at all and must keep being served from its legacy mutable prefix. A NULL pointer means
-- "this package has never been published as a revision", and the serving path treats that as the v2
-- legacy case. Making it NOT NULL (or defaulting it) would silently claim a revision exists for
-- every package in the product.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS active_revision_id TEXT;

-- ON DELETE SET NULL, not CASCADE: deleting a revision row must never delete the simulation. The
-- pointer going NULL degrades that package to the legacy path, which still serves.
DO $$ BEGIN
  ALTER TABLE simulations ADD CONSTRAINT simulations_active_revision_fk
    FOREIGN KEY (active_revision_id) REFERENCES simulation_revisions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
