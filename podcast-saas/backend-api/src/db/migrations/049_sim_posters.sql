-- 049: Simulation posters (Priority 5.5) + last-canary verdict on the package row.
--
-- A poster stands in for a live simulation frame during the window where showing the real frame
-- would be wrong (not yet acknowledged) or pointless (too little section time left). That only
-- works if the poster shows what the live frame WOULD have shown, so a poster is keyed by the FULL
-- presentation identity, not by the package:
--
--   package_revision + variant_key + config_hash + aspect_profile + quality_profile
--
-- `identity` is the joined form of exactly those five (shared/src/sim/posterIdentity.ts) and is what
-- both the storage path and the uniqueness constraint are built on. It is stored denormalised
-- alongside its components because it is the ONLY value a storage-path parse can recover, and the
-- orphan sweep has to compare what exists in the bucket against what exists here.
--
-- Rows are per-simulation and cascade with it: poster objects live under the simulation's own
-- storage prefix, so deleting the simulation deletes both its bytes and these rows together and
-- neither can outlive the other.

CREATE TABLE IF NOT EXISTS sim_posters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  simulation_id    UUID NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  package_revision TEXT NOT NULL,
  variant_key      TEXT NOT NULL,
  config_hash      TEXT NOT NULL,
  aspect_profile   TEXT NOT NULL CHECK (aspect_profile IN ('wide', 'standard', 'portrait', 'native')),
  quality_profile  TEXT NOT NULL CHECK (quality_profile IN ('high', 'balanced', 'low')),
  -- posterIdentityString(key): the five fields above joined with '__'.
  identity         TEXT NOT NULL,
  -- PosterVariantRecord[]: one entry per stored size/format, each with its sha256 checksum.
  -- A poster with no renditions is not a poster (a reader would resolve it to "has a poster" and
  -- then find nothing to show), hence the non-empty check below and no default.
  variants         JSONB NOT NULL,
  transparent      BOOLEAN NOT NULL DEFAULT false,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_sim_posters_sim_identity UNIQUE (simulation_id, identity)
);

DO $$ BEGIN
  ALTER TABLE sim_posters ADD CONSTRAINT sim_posters_variants_array_chk
    CHECK (jsonb_typeof(variants) = 'array' AND jsonb_array_length(variants) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The revision-change sweep deletes every poster of a simulation whose revision is not the current
-- one; that predicate is (simulation_id, package_revision) and runs on every republish.
CREATE INDEX IF NOT EXISTS idx_sim_posters_revision ON sim_posters(simulation_id, package_revision);

-- ── Last canary verdict on the package itself ────────────────────────────────────────────────
-- package_class is the SimPackageClass the most recent canary run assigned (see
-- shared/src/sim/simFailurePolicy.ts). It stays NULL for every package that has never been run,
-- which is what keeps this strictly additive: a NULL class means "unclassified", and every legacy
-- (v2) package keeps its existing behaviour because nothing reads a class it does not have.
-- bridge_hash is the hash of the CURRENT combined bridge.js, written whenever it is regenerated.
--
-- It exists because the package revision must be PACKAGE-scoped. Deriving it from each section's
-- own `?v=` parameter looked equivalent but is not: regenerating one section rewrites the shared
-- bridge and stamps the new hash onto ONLY that section's URL, so two sections of one package —
-- which share a single pooled document and a single runtime client — computed DIFFERENT revisions.
-- That silently re-opened the transport mid-session on every section change (wedging the modern
-- path for the rest of it) and made every poster lookup miss.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS bridge_hash TEXT;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS package_class TEXT;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS canary_report JSONB;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS canary_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE simulations ADD CONSTRAINT simulations_package_class_chk
    CHECK (package_class IS NULL OR package_class IN (
      'managed-presentable', 'managed-partial', 'legacy-cooperative', 'legacy-opaque', 'failed'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
