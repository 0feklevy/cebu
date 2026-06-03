-- Guided Simulation (mother-sim-level voice guidance) — migration 019
-- Adds guidance columns to simulations + seeds the two admin-editable system prompts.

ALTER TABLE simulations
  ADD COLUMN IF NOT EXISTS guidance        jsonb,
  ADD COLUMN IF NOT EXISTS guidance_status text NOT NULL DEFAULT 'none',  -- none|analyzing|draft|publishing|ready|error
  ADD COLUMN IF NOT EXISTS guidance_meta   jsonb,
  ADD COLUMN IF NOT EXISTS guidance_error  text;

-- Admin-editable system prompts (code provides the real fallback when is_customized = false)
INSERT INTO system_prompts (key, name, content) VALUES (
  'guidance_analyze',
  'Guidance — Deep Analysis',
  'PLACEHOLDER - code falls back to GUIDANCE_ANALYZE_SYSTEM_PROMPT when not customized'
) ON CONFLICT (key) DO NOTHING;

INSERT INTO system_prompts (key, name, content) VALUES (
  'guidance_plan',
  'Guidance — Structured Cues',
  'PLACEHOLDER - code falls back to GUIDANCE_PLAN_SYSTEM_PROMPT when not customized'
) ON CONFLICT (key) DO NOTHING;
