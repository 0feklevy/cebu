-- Rollback for migration 052. Run manually — the migrate runner is forward-only.
--
-- DEPLOY FIRST, THEN DROP, for the same reason as 051: several call sites read admin_settings with
-- no explicit `columns` list, so Drizzle selects every column declared in schema.ts. Dropping these
-- under an image that still declares them raises 42703 — including on a public route.
--
-- Safe in the other direction at any time: every resolver treats a missing column as the OFF value.

ALTER TABLE admin_settings DROP COLUMN IF EXISTS sim_boundary_sentinel;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS sim_adaptive_quality;
ALTER TABLE admin_settings DROP CONSTRAINT IF EXISTS admin_settings_sim_scheduler_mode_chk;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS sim_scheduler_mode;
