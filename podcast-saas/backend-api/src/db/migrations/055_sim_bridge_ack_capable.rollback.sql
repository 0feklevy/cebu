-- Rollback for migration 055. Run manually — the migrate runner is forward-only.
--
-- DEPLOY FIRST, THEN DROP, for the same reason as 051/052/054: `buildPlayerConfig` names this
-- column in an explicit `columns` list, so dropping it under an image that still declares it raises
-- 42703 on the player-config route — and that route's degraded-read catch turns the failure into
-- EVERY simulation in the project silently losing its revision pointer, which is an incident rather
-- than a degradation.
--
-- Safe in the other direction at any time: a NULL (or absent) capability reads as UNKNOWN, which is
-- exactly how every package published before 055 is already treated.

ALTER TABLE simulations DROP COLUMN IF EXISTS bridge_ack_capable;
