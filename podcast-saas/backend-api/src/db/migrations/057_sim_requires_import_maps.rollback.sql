-- Rollback for migration 057. Run manually — the migrate runner is forward-only.
--
-- DEPLOY FIRST, THEN DROP, for the same reason as 051/052/054/055: `buildPlayerConfig` names this
-- column in an explicit `columns` list, so dropping it under an image that still declares it raises
-- 42703 on the player-config route — and that route's degraded-read catch turns the failure into
-- EVERY simulation in the project silently losing its revision pointer, which is an incident rather
-- than a degradation. The editor's section reads name it in the same way, with the same catch.
--
-- Safe in the other direction at any time: a NULL (or absent) requirement reads as UNKNOWN, and
-- unknown is never treated as "requires" — so every package renders exactly as it did before 057.

ALTER TABLE simulations DROP COLUMN IF EXISTS requires_import_maps;
