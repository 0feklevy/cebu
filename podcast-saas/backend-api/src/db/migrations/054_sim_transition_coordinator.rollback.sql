-- Rollback for migration 054. Run manually — the migrate runner is forward-only.
--
-- DEPLOY FIRST, THEN DROP, for the same reason as 051/052: several call sites read admin_settings
-- with no explicit `columns` list, so Drizzle selects every column declared in schema.ts. Dropping
-- this under an image that still declares it raises 42703 — including on a public route.
--
-- Safe in the other direction at any time: `resolveSimRuntimeFlags` treats a missing column as OFF,
-- which is today's exit behaviour.

ALTER TABLE admin_settings DROP COLUMN IF EXISTS sim_transition_coordinator;
