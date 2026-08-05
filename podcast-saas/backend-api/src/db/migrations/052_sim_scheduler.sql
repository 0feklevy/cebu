-- 052: Kill switches for the Priority 8 runtime features.
--
-- Every feature added here reaches a viewer, so every one gets a switch that turns it off without a
-- deploy — the same posture as sim_pool_mode (048) and rum_sample_rate (051), and for the same
-- reason: a runtime behaviour that cannot be disabled without shipping code is a liability the
-- first time it misbehaves.
--
-- ALL DEFAULT TO THE CURRENT BEHAVIOUR. Applying this migration changes nothing for any viewer;
-- each feature is opt-in, so the blast radius of the migration itself is zero and enabling is a
-- deliberate, reversible act.

-- 'off'        — residency exactly as it is today (window planner / all-tier mount at start).
-- 'predictive' — the occurrence planner additionally PREPARES the next package inside its measured
--                lead window. Residency eviction remains the existing planner's decision, so a bug
--                here can waste work but cannot drop a document the viewer needs.
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS sim_scheduler_mode TEXT NOT NULL DEFAULT 'off';

DO $$ BEGIN
  ALTER TABLE admin_settings ADD CONSTRAINT admin_settings_sim_scheduler_mode_chk
    CHECK (sim_scheduler_mode IN ('off', 'predictive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Adaptive quality changes what a viewer SEES, so it is off by default and stays off until someone
-- has field measurements to justify it. It can only ever affect the NEXT activation's identity —
-- never a live one — because quality is inside configHash and configHash is compared by the reveal
-- invariant.
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS sim_adaptive_quality BOOLEAN NOT NULL DEFAULT false;

-- The frame-accurate boundary sentinel. Separate from the scheduler because its risk profile is
-- different: it touches the section-transition clock, and requestVideoFrameCallback support varies
-- by engine. `timeupdate` remains the master clock and the safety net in both states.
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS sim_boundary_sentinel BOOLEAN NOT NULL DEFAULT false;
