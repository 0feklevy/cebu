-- ============================================================================================
-- D-04 RECONCILIATION — READ ONLY. NOT A MIGRATION. NOT RUN BY ANYTHING.
--
-- This file is deliberately NOT under `src/db/migrations/`: nothing in this repository scans this
-- path for SQL, so it cannot be picked up by `migrate.ts` or by the release conductor. It is a
-- report an operator runs by hand, against a READ REPLICA, to size two historical populations that
-- blocking new bad writes does not repair.
--
-- Every statement here is a SELECT. There is no UPDATE, no INSERT, no DELETE and no DDL, and there
-- is deliberately no "fix" query to copy out of. See the WHY-NOT-AUTO-PROMOTE note at the bottom.
--
-- WHAT SQL CAN AND CANNOT SEE
-- The evidence that settles both populations lives in OBJECT STORAGE — a revision's `manifest.json`
-- and the `LastModified` of the mutable-prefix objects. The database records neither. So these
-- queries produce CANDIDATES plus the exact storage key and timestamp to check each candidate
-- against; they do not, and cannot, produce a verdict on their own. Any column below named
-- `*_to_check` is an instruction to a human, not a finding.
-- ============================================================================================


-- ────────────────────────────────────────────────────────────────────────────────────────────
-- POPULATION A — revisioned simulations marked guidance-ready whose ACTIVE MANIFEST lacks guidance
--
-- HOW THEY GOT THERE
-- `publishGuidance` wrote `guidance.js`, the cue audio and the re-injected entry HTML into the
-- MUTABLE prefix. For a simulation with an `active_revision_id` nothing serves that prefix, so the
-- run finished, the row was marked `guidance_status = 'ready'`, and the guidance never played.
--
-- THE SQL-VISIBLE SIGNATURE
-- Before this change no publication path ever recorded a guidance hash on a revision. So: the row
-- claims a published `guidanceHash`, and NO revision of that simulation carries that hash in its
-- metadata. That single predicate covers the whole historical population and — by construction —
-- excludes every simulation published through the derivation path introduced here, because that
-- path writes `metadata.guidanceHash` on the revision it activates.
--
-- THE ONE FALSE POSITIVE TO EXPECT, AND HOW THE REPORT SEPARATES IT
-- A simulation that published guidance while it was still LEGACY, and was migrated to revisions
-- afterwards, is fine: `RevisionMigration` copies the whole mutable prefix, guidance.js and the
-- injected entry included. Those rows also carry no guidance hash on any revision, so they match
-- the predicate. They are separated by `verdict` below, on the timestamps, and the storage check in
-- `manifest_to_check` settles it either way.
-- ────────────────────────────────────────────────────────────────────────────────────────────

WITH active AS (
  SELECT
    s.id                          AS simulation_id,
    s.project_id,
    s.name,
    s.storage_prefix,
    s.guidance_status,
    s.guidance_meta ->> 'guidanceHash' AS published_guidance_hash,
    (s.guidance_meta ->> 'publishedAt')::timestamptz AS guidance_published_at,
    -- Guarded on the type: `guidance` is a JSONB column, and jsonb_array_length() ERRORS rather
    -- than returning NULL on anything that is not an array. One malformed row must not abort the
    -- whole report.
    CASE WHEN jsonb_typeof(s.guidance) = 'array' THEN jsonb_array_length(s.guidance) END AS cue_count,
    r.id                          AS active_revision_id,
    r.revision_number             AS active_revision_number,
    r.created_at                  AS active_revision_created_at,
    r.activated_at                AS active_revision_activated_at,
    r.created_by                  AS active_revision_created_by,
    (r.metadata ->> 'migratedFromLegacyPrefix') IS NOT NULL AS active_is_legacy_copy
  FROM simulations s
  JOIN sim_revisions r ON r.id = s.active_revision_id
  WHERE s.active_revision_id IS NOT NULL
    AND s.guidance_status = 'ready'
    AND s.guidance_meta ->> 'guidanceHash' IS NOT NULL
)
SELECT
  a.simulation_id,
  a.project_id,
  a.name,
  a.published_guidance_hash,
  a.guidance_published_at,
  a.cue_count,
  a.active_revision_id,
  a.active_revision_number,
  a.active_revision_created_by,
  a.active_revision_created_at,
  CASE
    -- The active revision is a full copy of the mutable prefix taken AFTER the guidance landed
    -- there, so it very likely carries that guidance. Lowest priority; verify and close.
    WHEN a.active_is_legacy_copy AND a.active_revision_created_at > a.guidance_published_at
      THEN 'likely-ok: legacy copy taken after the publish'
    -- The active revision existed before the guidance was published, and no revision records that
    -- publication. This is the defect: the bytes went to the unserved prefix.
    WHEN a.active_revision_created_at <= a.guidance_published_at
      THEN 'DEAD GUIDANCE: active revision predates the publish and no revision records it'
    ELSE 'INDETERMINATE: revision postdates the publish but is not a legacy copy — check the manifest'
  END AS verdict,
  -- The object that settles it. `files[]` containing a `guidance.js` (role `runtime`), and the
  -- entry document carrying `<!-- SIM_GUIDANCE_SCRIPT_START -->`, is what "has guidance" means.
  a.storage_prefix || '/revisions/' || a.active_revision_id || '/manifest.json' AS manifest_to_check,
  -- The bytes the publication actually wrote, still sitting where nobody reads them.
  a.storage_prefix || '/guidance.js' AS orphaned_guidance_js
FROM active a
WHERE NOT EXISTS (
  SELECT 1
  FROM sim_revisions r2
  WHERE r2.simulation_id = a.simulation_id
    AND r2.metadata ->> 'guidanceHash' = a.published_guidance_hash
)
ORDER BY
  CASE WHEN a.active_revision_created_at <= a.guidance_published_at THEN 0 ELSE 1 END,
  a.guidance_published_at DESC;


-- ────────────────────────────────────────────────────────────────────────────────────────────
-- POPULATION B — legacy sources replaced after the active revision forked
--
-- HOW THEY GOT THERE
-- `processReplace` overwrote the mutable prefix in place. Once a simulation has an
-- `active_revision_id`, the served package stopped being that prefix — so the customer's new files
-- landed somewhere nothing reads while the live revision kept serving the old ones. From the
-- customer's side the replace reported 202 and then `ready`.
--
-- WHAT THE DATABASE ACTUALLY RECORDS ABOUT THIS: ALMOST NOTHING.
-- A legacy in-place replace writes `entry_file`, `bridge_functions` and `status` — none of which
-- changes shape, and `simulations` has no `updated_at`. There is no row anywhere that says "a
-- replace ran at 14:02". Stating that plainly matters more than inventing a proxy: a report that
-- guessed here would send someone to promote bytes on the strength of a column that means
-- something else.
--
-- So this query does the two things SQL can honestly do:
--   1. it fixes the FORK MOMENT — the instant this simulation stopped serving its mutable prefix,
--      which is the earliest `activated_at` across its revisions. Any mutable-prefix object whose
--      `LastModified` is later than that has diverged, and that comparison is a storage operation
--      (`HEAD <key>`), not a query; and
--   2. it promotes to the top the ONE divergence the database can prove on its own — a guidance
--      publication recorded as completing AFTER the fork, which by construction wrote
--      `<prefix>/guidance.js` and `<prefix>/<entry>` into the unserved prefix.
-- ────────────────────────────────────────────────────────────────────────────────────────────

WITH fork AS (
  SELECT
    s.id                AS simulation_id,
    s.project_id,
    s.name,
    s.storage_prefix,
    s.entry_file,
    s.status            AS row_status,
    s.error             AS row_error,
    s.active_revision_id,
    s.active_revision_entry_key,
    (s.guidance_meta ->> 'publishedAt')::timestamptz AS guidance_published_at,
    -- THE FORK: the first time this simulation served a revision instead of its prefix.
    MIN(r.activated_at) FILTER (WHERE r.activated_at IS NOT NULL) AS forked_at,
    COUNT(*) FILTER (WHERE r.activated_at IS NOT NULL)            AS activations,
    MAX(r.revision_number)                                        AS highest_revision
  FROM simulations s
  JOIN sim_revisions r ON r.simulation_id = s.id
  WHERE s.active_revision_id IS NOT NULL
  GROUP BY s.id
)
SELECT
  f.simulation_id,
  f.project_id,
  f.name,
  f.storage_prefix,
  f.forked_at,
  f.activations,
  f.highest_revision,
  f.row_status,
  f.row_error,
  CASE
    WHEN f.guidance_published_at IS NOT NULL AND f.guidance_published_at > f.forked_at
      THEN 'PROVEN DIVERGENCE: a guidance publish completed after the fork, into the mutable prefix'
    ELSE 'CANDIDATE: compare the object mtimes below against forked_at'
  END AS verdict,
  -- The objects a replace always rewrites. `HEAD` each; a `LastModified` later than `forked_at` is
  -- a write to a prefix nobody has served since that instant. `entry_file` is printed raw because
  -- it has two historical shapes — a bare storage key on new rows, a full public URL on old ones —
  -- and normalising it here would be `deriveEntryRelPath` reimplemented in SQL, in a report, where
  -- nobody would ever notice it disagreeing with the TypeScript.
  f.entry_file                       AS legacy_entry_recorded,
  f.storage_prefix || '/bridge.js'   AS legacy_bridge_to_check,
  f.storage_prefix || '/guidance.js' AS legacy_guidance_to_check,
  -- What is actually being served, for the side-by-side.
  f.active_revision_entry_key        AS served_entry
FROM fork f
WHERE f.forked_at IS NOT NULL
ORDER BY
  CASE WHEN f.guidance_published_at > f.forked_at THEN 0 ELSE 1 END,
  f.forked_at DESC;


-- ────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THERE IS NO REPAIR QUERY HERE, AND WHY THE LEGACY BYTES MUST NOT BE AUTO-PROMOTED
--
-- The tempting fix is to take each diverged mutable prefix and publish it as a new revision. Do not.
--
--   1. THE ACTIVE BRIDGE MAY HAVE MOVED ON. `bridge.js` is system-owned and accumulates one section
--      body per generation. Live generation has been publishing it INTO revisions since P0.4, so
--      `<prefix>/bridge.js` is frozen at whatever was last written before the package forked, while
--      the active revision's `package/bridge.js` carries every section published since. Promoting
--      the legacy copy would silently delete section scripts that are working today.
--
--   2. THE CHECK THAT WOULD HAVE CAUGHT THAT WAS ITSELF READING THE WRONG SOURCE. Until
--      simulation-003 the replace-compatibility gate read `<prefix>/bridge.js` — the same stale copy
--      — so a green verdict recorded against any of these uploads is a verdict about bytes nobody
--      serves. There is no historical evidence to lean on: the gate must be re-run against the
--      ACTIVE revision (`readReplaceCompatibilitySource`) before any of these files is republished.
--
--   3. THE CUSTOMER'S INTENT IS UNRECOVERABLE FROM STORAGE ALONE. A diverged prefix is the result of
--      an unknown number of replaces, the last of which may have been abandoned mid-flight. Nothing
--      records which one was meant to be live.
--
-- The safe remediation is per-simulation and human-initiated: show the operator the two packages
-- side by side, and if the legacy files are still wanted, re-submit them through the normal replace
-- endpoint — which now derives a revision from the LIVE package, carries the LIVE bridge and
-- guidance forward, and runs the compatibility gate and the capture gate against what is actually
-- being served.
-- ============================================================================================
