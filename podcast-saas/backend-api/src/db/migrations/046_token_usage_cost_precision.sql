-- 046_token_usage_cost_precision.sql
-- 1. cost_cents integer -> double precision (backend-006/database-006): sub-cent calls
--    (Haiku moderation, mini-model utility passes, per-image estimates) rounded to 0 and
--    read as free in every $-based report. Existing integer values remain valid doubles;
--    all readers already treat the column as a number.
ALTER TABLE token_usage ALTER COLUMN cost_cents TYPE double precision USING cost_cents::double precision;

-- 2. The rolling-24h generation-cap check counts token_usage by (user_id, occurred_at)
--    on every gated call (LLMService + systemAi) — give it a matching composite index
--    so the hot-path count stays cheap as the ledger grows (database-004).
CREATE INDEX IF NOT EXISTS idx_token_usage_user_occurred ON token_usage (user_id, occurred_at);
