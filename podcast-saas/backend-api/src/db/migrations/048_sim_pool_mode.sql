-- Kill switch for the adaptive simulation pool (feat/sim-pool-adaptive).
-- 'adaptive' (default): package-identity resident pool with tiered residency.
-- 'single':  conservative fallback approximating the pre-pool viewer — one sim frame,
--            mounted only at section activation, per-URL navigation, no background warm.
-- Flippable at runtime through admin_settings (no deploy); the SIM_POOL_MODE env var
-- overrides it per-process for staging experiments.
ALTER TABLE admin_settings
  ADD COLUMN IF NOT EXISTS sim_pool_mode TEXT NOT NULL DEFAULT 'adaptive'
  CHECK (sim_pool_mode IN ('adaptive', 'single'));
