-- 081: two NON-PUBLIC statuses between byte-verification and activation.
--
-- WHY A NEW STATUS AND NOT A BOOLEAN. `canary_passed` is reached by validate() on byte
-- verification alone, and the legacy migration publishes straight into it — so a migrated package
-- can sit in `canary_passed` having never been canaried. The doc comment on SimRevisionStatus in
-- shared/src/sim/simRevision.ts already says exactly that ("NOT proof that a canary ran… the name
-- is historical"). Overloading it to also mean "replay-proven" would change what it means for
-- every existing row, retroactively and silently.
--
-- ORDERING PREREQUISITE, AND IT IS NOT OPTIONAL. The image serving /sim-public/* must ALREADY be
-- running the ALLOW-LIST form of isRevisionStatusPublic. The previous DENY-LIST form returned true
-- for any status it did not recognise ("Unknown status ⇒ yes (legacy)"), so introducing
-- proof_pending against such an image would make an unproven candidate world-readable for the
-- duration of the deploy window — serving precisely the bytes the status exists to withhold.
-- The allow-list shipped in v0.2.7 (PR #142). This migration is therefore a LATER release, by
-- construction rather than by convention.
--
-- The status column is TEXT + CHECK, not a Postgres enum, which is what makes this widening
-- possible inside the runner's single transaction at all: ALTER TYPE … ADD VALUE cannot run in a
-- transaction block. Do not write BEGIN/COMMIT here — migrate.ts wraps the file.

ALTER TABLE sim_revisions DROP CONSTRAINT IF EXISTS sim_revisions_status_check;
ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_status_check CHECK (status IN (
  'draft', 'uploading', 'validating', 'canary_passed',
  'proof_pending', 'proof_passed',
  'active', 'retired', 'failed', 'rolled_back'
));

-- sim_revisions_activated_at_chk (050) needs NO edit: it constrains only
-- ('active','retired','rolled_back'), and neither new status is in that set — a revision sitting
-- in a proof state correctly has a NULL activated_at, and the constraint keeps saying so.

-- No new index. idx_sim_revisions_status_created (050) already covers (status, created_at), which
-- is what both the stale-row scan and the gc age-scan filter on.

COMMENT ON COLUMN sim_revisions.status IS
  'SimRevisionStatus. proof_pending/proof_passed are NON-PUBLIC: isRevisionStatusPublic allows only active/retired/rolled_back.';
