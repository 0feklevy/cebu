-- Add bridge_plan system prompt row (editable via Admin > System Prompts).
-- The DEFAULT prompt lives in the BRIDGE_GENERATION_SYSTEM_PROMPT constant in
-- backend-api/src/services/simulation/SimulationService.ts and is used unless this row is
-- admin-customized (is_customized = true). This placeholder is dormant until then.
INSERT INTO system_prompts (key, name, content) VALUES (
  'bridge_plan',
  'Bridge Plan Generation',
  'Default lives in the BRIDGE_GENERATION_SYSTEM_PROMPT constant (SimulationService.ts). Edit here only to override it.'
) ON CONFLICT (key) DO NOTHING;
