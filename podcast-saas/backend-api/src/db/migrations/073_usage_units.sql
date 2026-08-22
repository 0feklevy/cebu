-- 073 — usage rows describe what was actually bought, not only tokens.
--
-- `token_usage` was shaped for LLM calls: input_tokens, cached_input_tokens, output_tokens. That is
-- the right shape for exactly one of the vendors this product pays.
--
--   ElevenLabs TTS  bills per CHARACTER
--   ElevenLabs dub  bills per SOURCE-MINUTE, per target language
--   Anam avatar     bills per SESSION-MINUTE
--   image gen       bills per IMAGE
--
-- Forcing those into `input_tokens` is not merely untidy — it makes the admin dashboard's own
-- arithmetic wrong in a way nobody can see. "1,400 tokens" and "1,400 characters" render
-- identically, sum together happily, and the total means nothing. The 22 August incident happened
-- because spend was invisible; a dashboard that shows a confident wrong number is a worse version
-- of the same failure, because a number gets believed.
--
-- So the unit rides on the row. `cost_cents` remains the one field every provider can be summed
-- on, and `quantity`/`unit` say what was counted to get there.
--
-- NULLABLE, and deliberately: every existing row is an LLM call whose quantity is already in the
-- token columns. Backfilling them would invent a unit for rows that never recorded one, and a
-- guessed value is indistinguishable from a measured one once it is in the table.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS quantity double precision,
  ADD COLUMN IF NOT EXISTS unit text;

COMMENT ON COLUMN token_usage.quantity IS
  'How much was bought, in `unit`. NULL for LLM rows, whose amount is in the token columns.';
COMMENT ON COLUMN token_usage.unit IS
  'characters | source_minutes | session_minutes | images | tokens. NULL means the token columns.';

-- The admin surface asks "what did each provider cost, per day". Without this it is a sequential
-- scan of every usage row ever written, on a page an operator refreshes.
CREATE INDEX IF NOT EXISTS idx_token_usage_provider_occurred
  ON token_usage (provider, occurred_at);
