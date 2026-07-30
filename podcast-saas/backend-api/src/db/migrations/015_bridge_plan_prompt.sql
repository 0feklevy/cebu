-- Add bridge_plan system prompt row (editable via Admin > System Prompts)
INSERT INTO system_prompts (key, name, content) VALUES (
  'bridge_plan',
  'Bridge Plan Generation',
  'PLACEHOLDER - loaded from shared/src/prompts/bridge-plan.txt at startup'
) ON CONFLICT (key) DO NOTHING;
