-- Rollback for 073. The index goes first: dropping the columns it does not cover is independent,
-- and leaving a stray index behind is the kind of residue that makes the next rollback ambiguous.
DROP INDEX IF EXISTS idx_token_usage_provider_occurred;
ALTER TABLE token_usage
  DROP COLUMN IF EXISTS quantity,
  DROP COLUMN IF EXISTS unit;
