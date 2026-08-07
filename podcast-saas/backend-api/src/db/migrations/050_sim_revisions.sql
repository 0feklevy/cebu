-- 050: Immutable simulation package revisions (Priority 7.1 / 7.2).
--
-- Until now a package lived at ONE mutable prefix and every regeneration overwrote it in place:
-- bridge.js and the entry HTML are two separate writes, ~40 lines and one network round trip apart
-- (SimulationService.ts). A viewer landing between them received new bridge bytes under the old
-- cache key — a half-updated package, and durable on failure because neither write rolls the other
-- back.
--
-- A revision fixes that by construction rather than by timing: every published file lives under a
-- path containing the revision id, revision bytes are never rewritten, and switching which revision
-- is live is a single row update. A viewer holding the old pointer keeps receiving a complete,
-- self-consistent old package.
--
-- THE POINTER IS THE ONLY MUTABLE THING: simulations.active_revision_id, plus the entry key it
-- resolves to (denormalised so the hot read path needs no join). They are written in one UPDATE and
-- a CHECK forbids them from disagreeing.
--
-- WHY THE CANARY VERDICT MOVES ONTO THE REVISION
-- Today the verdict is cleared only when bridge_hash changes. Activation and rollback change WHICH
-- BYTES ARE SERVED without touching bridge_hash, so a row-level verdict would survive a rollback
-- and grant the modern runtime path to bytes no canary ever ran against. Per-revision columns make
-- the verdict a statement about specific bytes, which is what it always claimed to be. The columns
-- on `simulations` become a projection of the ACTIVE revision's, rewritten inside the activation
-- transaction. Rows with active_revision_id IS NULL keep the 049 semantics exactly.
--
-- THIS MIGRATION IS STRICTLY ADDITIVE. Every existing simulation gets active_revision_id = NULL,
-- and shared/src/sim/simRevision.ts packageRevisionFor() falls back to the pre-revision derivation
-- for exactly that case — so identity, posters and canary verdicts are unchanged for every row that
-- has no revision. No backfill is required for correctness.

CREATE TABLE IF NOT EXISTS sim_revisions (
  -- The PK IS the revision id that appears in storage paths. A UUID's text form already satisfies
  -- isValidRevisionId (/^[A-Za-z0-9_-]{8,64}$/), so no second opaque column is needed — and one id
  -- means a storage path can never be built from the wrong one.
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  simulation_id             UUID NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  -- For humans and ordering ONLY. Never appears in a path, so a renumbering can never change a URL
  -- already cached as immutable. Allocated from simulations.revision_counter under the row lock,
  -- never from max()+1 — see the column comment below.
  revision_number           INTEGER NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                              'draft', 'uploading', 'validating', 'canary_passed',
                              'active', 'retired', 'failed', 'rolled_back'
                            )),
  -- computeManifestHash(manifest): sha256 of the canonical manifest form. NULL until validation
  -- completes; the activation CAS refuses a NULL, so an unvalidated revision cannot be promoted.
  manifest_hash             TEXT,
  -- Prefix-relative path of the entry document INSIDE the revision, e.g. 'package/index.html'.
  -- Stored so the pointer flip can denormalise a full key onto the simulation row without
  -- re-deriving an entry path at read time — deriveEntryRelPath exists precisely because that
  -- derivation has two historical shapes (bare key vs full URL) and is not free.
  entry_path                TEXT,
  bridge_protocol_version   INTEGER,
  runtime_protocol_version  INTEGER,
  -- The verdict for THESE bytes. Vocabulary identical to simulations_package_class_chk (049): two
  -- spellings of one enum is the same class of mistake as two derivations of one revision.
  package_class             TEXT CHECK (package_class IS NULL OR package_class IN (
                              'managed-presentable', 'managed-partial',
                              'legacy-cooperative', 'legacy-opaque', 'failed'
                            )),
  canary_report             JSONB,
  canary_at                 TIMESTAMPTZ,
  -- Set when this revision row was created BY a rollback, naming what it restored. SET NULL rather
  -- than CASCADE: losing the target must not delete the audit record of the rollback itself.
  rollback_of_revision_id   UUID REFERENCES sim_revisions(id) ON DELETE SET NULL,
  -- SimManifest.createdBy. TEXT with no FK: the actor may be a script rather than a user row, and a
  -- FK would make an operator action fail whenever the actor is not a user.
  created_by                TEXT,
  metadata                  JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at              TIMESTAMPTZ,
  retired_at                TIMESTAMPTZ,
  CONSTRAINT uniq_sim_revisions_sim_number UNIQUE (simulation_id, revision_number)
);

-- Every status mustRetainBytes() is true for is reachable ONLY from 'active', so all three imply
-- the revision was once activated. Enforcing it here makes rollbackTargetFor's
-- `activatedAt !== null` filter structurally guaranteed rather than defensively hoped for: a
-- retained revision with a NULL activated_at would be silently unreachable by rollback, and that is
-- a failure which only ever shows up during an incident.
DO $$ BEGIN
  ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_activated_at_chk
    CHECK (status NOT IN ('active', 'retired', 'rolled_back') OR activated_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_manifest_hash_chk
    CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A revision number is allocated, never guessed.
DO $$ BEGIN
  ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_number_positive_chk
    CHECK (revision_number > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── AT MOST ONE ACTIVE REVISION PER SIMULATION, STRUCTURALLY ─────────────────────────────────────
-- A partial unique index, the same shape as uniq_custom_domain_primary (030) and uniq_projects_slug
-- (043). This is what makes the activation transaction safe to write as demote-then-promote: a
-- concurrent activation that raced past the CAS predicates still cannot commit, because two
-- 'active' rows for one simulation cannot coexist.
--
-- Note it is an INDEX, not a CONSTRAINT, so it cannot be DEFERRABLE — the demote must therefore
-- come FIRST inside the transaction. Promote-then-demote would violate the index mid-transaction
-- and abort even when the operation is entirely legal.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sim_revisions_active
  ON sim_revisions(simulation_id) WHERE status = 'active';

-- rollbackTargetFor orders retained revisions by activated_at DESC for one simulation.
CREATE INDEX IF NOT EXISTS idx_sim_revisions_sim_activated
  ON sim_revisions(simulation_id, activated_at DESC);

-- Garbage collection reaps stale 'uploading'/'validating' rows by age. Reaping them at boot the way
-- server.ts sweeps simulations.status='processing' would kill OTHER instances' in-flight
-- publications, so this is an age-scan and the index is what makes it cheap.
CREATE INDEX IF NOT EXISTS idx_sim_revisions_status_created
  ON sim_revisions(status, created_at);

-- ── The pointer ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS active_revision_id UUID;

-- The FULL storage key of the active revision's entry document, e.g.
--   simulations/<projectId>/<simulationId>/revisions/<revisionId>/package/index.html
-- Denormalised deliberately: buildPlayerConfig is the hottest read path in the product and already
-- selects an explicit `columns` list to avoid pulling JSONB it does not need. Making it join
-- sim_revisions to learn one string would undo that. Written in the SAME UPDATE as
-- active_revision_id, so the two cannot disagree.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS active_revision_entry_key TEXT;

-- Monotonic allocator for revision_number. Incremented with
--   UPDATE simulations SET revision_counter = revision_counter + 1 ... RETURNING revision_counter
-- which takes the row lock. SELECT max()+1 races two concurrent drafts into one number and then
-- fails on uniq_sim_revisions_sim_number AFTER the caller has already begun writing bytes.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS revision_counter INTEGER NOT NULL DEFAULT 0;

-- Both-or-neither. A pointer with no entry key resolves to nothing; an entry key with no pointer
-- serves revision bytes while packageRevisionFor still reports the pre-revision derivation — a
-- package serving one thing and claiming another, which is the precise failure the identity axis
-- exists to prevent.
DO $$ BEGIN
  ALTER TABLE simulations ADD CONSTRAINT simulations_active_revision_pair_chk
    CHECK ((active_revision_id IS NULL) = (active_revision_entry_key IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ON DELETE SET NULL, not RESTRICT and not CASCADE. RESTRICT would deadlock a simulation delete
-- against its own cascade into sim_revisions (both rows are removed by the same statement, and FK
-- checks fire at end of statement).
--
-- IN PRACTICE THIS BEHAVES AS RESTRICT, and that is the intended outcome rather than a defect.
-- The action clears only active_revision_id, and it can only fire when that column was non-NULL —
-- which by simulations_active_revision_pair_chk above means active_revision_entry_key was too. So
-- the CHECK fails and the delete raises 23514. An earlier version of this comment claimed SET NULL
-- "degrades a dangling pointer to no revision, the safe direction"; that never happens, and the
-- claim is corrected here rather than left to mislead the next reader. Deleting a revision that a
-- simulation is actively serving is refused outright, which is the behaviour worth having — but a
-- caller sees a CHECK violation, not a foreign-key one, so error handling must not key on 23503.
DO $$ BEGIN
  ALTER TABLE simulations ADD CONSTRAINT simulations_active_revision_fk
    FOREIGN KEY (active_revision_id) REFERENCES sim_revisions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
