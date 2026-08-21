---
name: llm-config-provider-model-split
description: FlowVid picks the LLM provider and the per-tier model from two independent admin_settings columns, so shipped defaults route Claude model ids to the Gemini client
metadata:
  type: project
---

In `podcast-saas/backend-api/src/services/llm/LLMService.ts`, `resolveProviderAndModel` reads the
provider from `admin_settings.default_provider` and the model from a *separate* free-text per-tier
column (`utility_model` / `generation_model` / `complex_model`). Nothing cross-checks the pair, and
no `model → provider` inference exists anywhere in the repo.

**Why it matters:** the shipped defaults are mutually inconsistent — `default_provider='gemini'`
with `utility_model='claude-haiku-4-5'` and `complex_model='claude-opus-4-8'` (the latter forced by
migration `047_complex_model_opus.sql`). There is no value of `default_provider` for which all three
defaults resolve, so at least one tier always 404s at the vendor. Filed as `llm-pipeline-001` (P1) in
run `2026-08-15T2109`. Two other places already *assume* the Claude branch:
`controllers/v1/sections.controller.ts:55` and the admin UI's "Supported:" list, which is Claude-only.

**How to apply:** before reasoning about which model a task actually runs on, check
`default_provider` — do not trust the tier column or the code comments. The `creative` tier is the
one exception: it hardcodes `getProvider('claude')`. If this gets fixed, the fix is a
`providerForModel()` prefix helper plus a defaults migration; re-read the file rather than assuming
this memory still describes the code.
