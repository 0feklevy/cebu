-- 047_complex_model_opus.sql
-- The 'complex' tier (simulation bridge_plan + guidance_plan) reads admin_settings.complex_model.
-- Existing installs were seeded with a weaker default (gemini-*/sonnet), so AI Script Generation
-- ran on Sonnet and produced lower-quality bridge scripts. Bump the live setting to Opus 4.8 to
-- match the schema default — but never downgrade an admin who deliberately chose a premium model
-- (Opus 4.7 / Fable 5). Pairs with LLMService setting effort='high' for the complex tier.
UPDATE admin_settings
SET complex_model = 'claude-opus-4-8'
WHERE complex_model NOT IN ('claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5');
