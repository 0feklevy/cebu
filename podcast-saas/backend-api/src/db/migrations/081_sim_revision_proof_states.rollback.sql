-- 081 rollback. NARROWS the CHECK, so it FAILS LOUDLY if any row still holds a proof status.
--
-- That is the design, not an oversight. Silently rewriting those rows to 'failed' would destroy
-- the record of why bytes were staged and leave a candidate's bytes in storage with nothing
-- explaining them. Drain first, deliberately:
--
--   SELECT id, simulation_id, created_at FROM sim_revisions
--    WHERE status IN ('proof_pending', 'proof_passed');
--
-- and decide per row whether it becomes 'failed' (abandoned) or is allowed to finish.

ALTER TABLE sim_revisions DROP CONSTRAINT IF EXISTS sim_revisions_status_check;
ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_status_check CHECK (status IN (
  'draft', 'uploading', 'validating', 'canary_passed',
  'active', 'retired', 'failed', 'rolled_back'
));

COMMENT ON COLUMN sim_revisions.status IS NULL;
