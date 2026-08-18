# LLM pipeline — findings

Domain: `llm-pipeline-reviewer`. Commit under review: `2d187e3` (main). Whole-codebase pass.

Scope swept: `podcast-saas/backend-api/src/services/llm/**` (all 6 files + `__tests__`),
`podcast-saas/backend-api/src/services/podcast/{prompts,schemas,scriptLint,ScriptRoom,runPodcastScript,PodcastMemory,regenerateTurn}.ts`,
`podcast-saas/shared/src/prompts/**`, `services/generateVideoMetadata.ts`, `services/generateAiThumbnail.ts`,
`services/seo/**`, `services/simulation/GuidanceService.ts` (LLM half),
`controllers/admin/v1/{system-prompts,llm-config}.controller.ts`, `db/schema.ts` (`system_prompts`,
`token_usage`, `admin_settings`) and the migrations that seed them.

Model ids, prices and parameter rules below were checked against the `claude-api` skill, not from memory.

---

### [P1] Tier model ids and `default_provider` are configured independently — no shipped default is self-consistent
- id: llm-pipeline-001
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:289
- category: bug
- confidence: high
- status: confirmed
- what: `resolveProviderAndModel` picks **one** provider from `admin_settings.default_provider` and then
  picks the model from a *separate*, free-text per-tier column. The two are never cross-checked. With the
  values the app actually ships, at least one tier always sends a model id belonging to a different vendor.
- why: `admin_settings` defaults (`db/schema.ts:270-277`, and the SQL that created them,
  `db/migrations/001_initial.sql:146-152`) are `default_provider = 'gemini'`, `utility_model =
  'claude-haiku-4-5'`, `generation_model = 'gemini-2.5-pro'`, and `complex_model` is force-set to
  `'claude-opus-4-8'` by `047_complex_model_opus.sql`. So on an untouched install the **utility** tier
  (`content_moderation`, `prompt_enhance`) and the **complex** tier (`bridge_plan`, `guidance_plan`,
  `structural_analysis`, plus every retry-escalated generation call) construct a `GeminiProvider` and ask
  Google for `models/claude-haiku-4-5` / `models/claude-opus-4-8` → 404. Flip `default_provider` to
  `'claude'` and the generation tier breaks the other way (`gemini-2.5-pro` to the Anthropic API).
  There is **no value of `default_provider` for which all three shipped tier defaults resolve**, which is
  what makes this a defect rather than a misconfiguration. Two independent places in the repo already
  assume the Claude branch: `controllers/v1/sections.controller.ts:55` ("bridge_plan runs on
  claude-opus-4-8 with adaptive thinking … + effort:'high'") and the admin UI, which lists *only* Claude
  ids as supported for all three tiers (`admin-web/app/llm-config/page.tsx:140-142`). Downstream this also
  makes `ADAPTIVE_MODELS.has(model)` true for a Gemini call (`LLMService.ts:171`), so `effort`/
  `adaptiveThinking` are computed and then silently dropped by `GeminiProvider`.
- evidence: Read `LLMService.ts:263-305` in full — the provider comes from `settings.default_provider`
  (line 289) and the model from `settings.utility_model|complex_model|generation_model` (293-302); nothing
  validates the pair. `grep -rn "startsWith('claude|startsWith('gemini|providerForModel"` over
  `backend-api/src` returns nothing, so no model→provider inference exists anywhere. Confirmed the seed
  values in `db/migrations/001_initial.sql:146,151,152` and `047_complex_model_opus.sql` (unconditional
  `UPDATE admin_settings SET complex_model='claude-opus-4-8'`). The `creative` tier is the only one that
  is safe — it hardcodes `getProvider('claude')` at `LLMService.ts:277`.
- fix: derive the provider from the model id instead of from a separate column. Add a
  `providerForModel(model)` helper (prefix match: `claude-*` → claude, `gpt-*`/`o*` → openai, `gemini-*` →
  gemini) and use it in `resolveProviderAndModel` for all three non-creative tiers, keeping
  `default_provider` only as the tiebreaker for an unrecognised prefix. Then add a startup assertion (or a
  `GET /api/admin/v1/llm-config` warning field) that each configured tier model resolves to a provider with
  a configured key, and fix the three defaults in a migration so they agree.
- verify: unit test `resolveProviderAndModel` with `{default_provider:'gemini', utility_model:'claude-haiku-4-5'}`
  and assert `provider.providerName === 'claude'`; `pnpm -C podcast-saas --filter backend-api test` green.
- cross: @backend, @database
- effort: M

---

### [P1] Content moderation always fails open: the seeded prompt asks for a different JSON shape than the validator accepts
- id: llm-pipeline-002
- location: podcast-saas/backend-api/src/services/llm/ContentModerationService.ts:52
- category: bug
- confidence: high
- status: confirmed
- what: `moderateGenerationInput` loads the `content_moderation` row and uses `row?.content?.trim() ||
  DEFAULT_MODERATION_PROMPT` — it **ignores `is_customized`**, unlike every other prompt loader in the repo.
  Migration `001_initial.sql:199` seeds that row with real (non-placeholder) text instructing the model to
  reply `{"flagged": boolean, "reason": string | null}`. The verdict schema at
  `ContentModerationService.ts:18-21` is `{ allowed?: boolean, reason?: string }` — both optional. A
  well-behaved model returns `{"flagged": true, "reason": "hate speech"}`, `VerdictSchema.safeParse`
  *succeeds* with `allowed: undefined`, and the gate `verdict.allowed === false` (line 76) is never true.
- why: the pre-screen that guards podcast scripts, b-roll prompts, playlist banners and AI thumbnails
  (`podcast-script.controller.ts:135`, `broll.controller.ts:58`, `projects.controller.ts:268,327`,
  `playlists.controller.ts:416`) can never reject anything on any install seeded by migration 001 — i.e.
  every install. The service is fail-open by design, but this makes it fail-open *unconditionally*, which
  is not what the design says. Note this compounds with llm-pipeline-001: the utility tier also routes to
  the wrong provider, so the call usually errors and hits the fail-open `catch` at line 68 first.
- evidence: Read `ContentModerationService.ts:47-85` in full — line 52 has no `is_customized` check;
  compare `prompts.ts:471` (`row?.is_customized ? row.content : fallback`) and
  `GuidanceService.ts:446` (same correct shape). Read `001_initial.sql:195-201`: `content_moderation` is the
  only seeded row with real content — every other prompt row (015, 019, 044) is the literal string
  `'PLACEHOLDER - code falls back to …'`. `grep -rn "content_moderation" backend-api/src/db/migrations/*.sql`
  shows no later migration corrects it. `__tests__/contentModeration.test.ts:49` pins
  `findFirst.mockResolvedValue(undefined)`, so the suite only ever exercises the fallback-prompt branch and
  never the DB-row branch where the bug lives.
- fix: two lines. (1) In `ContentModerationService.ts:52` use `row?.is_customized ? row.content :
  DEFAULT_MODERATION_PROMPT` to match every other loader. (2) Add a migration that resets the seeded row to
  the placeholder convention (`UPDATE system_prompts SET content='PLACEHOLDER - code falls back to
  DEFAULT_MODERATION_PROMPT when not customized', is_customized=false WHERE key='content_moderation' AND
  is_customized=false`). Then add a test that stubs `findFirst` with the 001-seeded `flagged`-shaped prompt
  and asserts the call still rejects on `{"allowed": false}` output.
- verify: new test red before the change, green after; `pnpm -C podcast-saas --filter backend-api test`.
- cross: @security, @test-quality
- effort: S

---

### [P1] Writers'-room intermediate schemas accept `{}` — an empty story plan is persisted and drives eight more creative-tier passes
- id: llm-pipeline-003
- location: podcast-saas/backend-api/src/services/podcast/schemas.ts:29
- category: data-integrity
- confidence: high
- status: confirmed
- what: `StoryPlanSchema`, `MaterialsSchema`, `FactAuditSchema`, `EarEditSchema`, `NarrativeJudgeSchema` and
  `MemorySummarySchema` put `.catch(...)` on **every** field, including the load-bearing ones. In Zod a
  `.catch()` also swallows "Required", so `StoryPlanSchema.safeParse({})` succeeds and yields
  `{episode_title:'Untitled Episode', focus_sentence:'', story_world:'', beats:[], …}`. `parseAndRepair`
  therefore reports success, `sendStructured` never retries, and `ScriptRoom` persists the empty object to
  `podcast_scripts.story_json` and forwards `JSON.stringify(story)` into the materials, playwright, review
  and rewrite prompts.
- why: any response that is valid JSON but not a story plan — `{}`, `{"error":"I can't help with that"}`,
  a refusal wrapped in JSON, a truncated-then-salvaged object — produces a *silently empty* beat sheet with
  no retry, no warning log and no floor check. The run then spends the remaining ~8 creative-tier calls
  (Opus 4.8 / Fable 5, `effort: 'max'`, `max_tokens` 64000) writing an episode against a void plan, and
  stores the result as `status: 'ready'`. `story.beats.length` is never checked anywhere in `ScriptRoom.ts`;
  the only downstream signal is a `logger.warn` about a missing story-world keyword (`ScriptRoom.ts:400`).
- evidence: `__tests__/schemas.test.ts:29-37` already proves it — `StoryPlanSchema.safeParse({episode_title:123,
  beats:'nope', uses_user_analogy:'yes'})` succeeds with `beats: []`, and every other field is omitted from
  that input, so omitted fields demonstrably default. The same file's line 44-50 shows the team *did* apply
  a floor to `PlaywrightDraftSchema`/`CompiledBodySchema` (`turns` has `.min(1)` and no `.catch()`) — the
  intermediate passes just never got one. Read `ScriptRoom.ts:128-150`: `story` and `materials` are written
  straight to the DB with no viability check.
- fix: add a Zod `.superRefine` (or a plain guard in `ScriptRoom.call`) asserting the minimum a pass must
  produce, and throw `AppError(LLMErrorType.PARSING_ERROR, …)` so the existing 3-attempt retry fires. For
  `StoryPlanSchema`: `beats.length >= 3 && focus_sentence.trim() && story_world.trim()`. For
  `MaterialsSchema`: `spine.mapping.length >= 1`. For the three review schemas: keep them permissive (they
  are advisory) but log at `warn` when `verdict` came from `.catch()`.
- verify: new test asserting `StoryPlanSchema.safeParse({})` fails; run one ScriptRoom pass with a stubbed
  `{}` response and assert `sendStructured` was called 3 times and the job failed rather than reaching `ready`.
- cross: @test-quality
- effort: M

---

### [P1] `stop_reason: "max_tokens"` is never detected — truncated model output is stored as if complete
- id: llm-pipeline-004
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:243
- category: data-integrity
- confidence: high
- status: confirmed
- what: `LLMResponse.stopReason` is populated by all three providers, but `LLMService` branches on exactly
  one value — `'refusal'` (line 243). `'max_tokens'` (Anthropic) / `'length'` (OpenAI) /
  `'MAX_TOKENS'` (Gemini) is never inspected on either path.
- why: two distinct failures. (1) `sendText` (line 396) returns the truncated string as a normal success —
  `GuidanceService.analyzeAndDraft` then uploads a half-written `understanding.md` to storage
  (`GuidanceService.ts:477-480`) and feeds it back as the assistant turn for pass 2
  (`GuidanceService.ts:491`), so a truncated analysis becomes the grounding for the cue plan.
  `VideoGenerationService.enhancePrompt` likewise ships a half-sentence prompt to Kling/Seedance.
  (2) `sendStructured` gets a parse failure it cannot diagnose: `parseAndRepair` fails, the retry loop at
  `LLMService.ts:90` fires two more full-price calls **without raising `max_tokens`**, so an output that
  genuinely does not fit truncates three times and costs 3× for a deterministic failure. Creative-tier
  calls run at `max_tokens` 64000 on Opus 4.8/Fable 5 — this is the expensive case.
- evidence: Read `_sendStructuredOnce` lines 206-261 and `sendText` lines 361-397 in full. The only
  `response.stopReason` reference in the file is line 243. `ClaudeProvider.ts:126` sets it from
  `event.delta.stop_reason`; `OpenAIProvider.ts:63` from `finish_reason`; `GeminiProvider.ts:69` from
  `finishReason`. `grep -rn "max_tokens'" backend-api/src/services` finds no consumer.
- fix: in `_sendStructuredOnce`, immediately after the refusal branch, add
  `if (['max_tokens','length','MAX_TOKENS'].includes(response.stopReason ?? '')) throw new
  AppError(LLMErrorType.PARSING_ERROR, 'Model output was truncated at max_tokens', 422, {truncated:true})`
  and, in the `sendStructured` retry loop, raise `maxTokens` by 1.5× when `err.details?.truncated` before
  re-attempting. In `sendText`, surface it: return `{ text, truncated: boolean, … }` and have
  `GuidanceService` refuse to upload/forward a truncated `understanding.md`.
- verify: unit test with a stubbed provider returning `stopReason:'max_tokens'`; assert `sendStructured`
  throws with `details.truncated` and `sendText` reports `truncated: true`.
- cross: @simulation, @media-pipeline
- effort: M

---

### [P1] Failed and aborted provider calls are never metered — the ledger under-reports and the daily cap is bypassable
- id: llm-pipeline-005
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:224
- category: data-integrity
- confidence: high
- status: confirmed
- what: `usageTracking.record(...)` is only reached after `provider.sendMessage()` *resolves*. Every path
  where the provider throws — network error, 429, 5xx, a 400 from a bad model id (llm-pipeline-001), an
  `AbortError` mid-stream — returns before any `token_usage` row is written, even though the provider has
  already streamed (and billed for) input and output tokens.
- why: two consequences. (a) The cost ledger silently under-reports: on a provider that is 5xx-ing, the
  Anthropic/OpenAI SDKs retry twice by default before surfacing the error, so up to three billed attempts
  produce zero rows. (b) The rolling-24h generation cap (`LLMService.ts:137-159`) counts `token_usage`
  rows, so a client that starts an expensive creative/complex generation and disconnects — or an attacker
  that does so in a loop — consumes provider spend that never increments the counter. The comment at line
  220-222 explicitly reasons about billing a *refused* call, so the intent to meter everything billable is
  there; the aborted/errored case just isn't covered.
- evidence: Read `_sendStructuredOnce` lines 206-238 — `record` is called on line 224, after the `await` on
  line 206, with no `catch`-side recording. `ClaudeProvider.ts:152-158` converts any throw into `AppError`
  and discards the partial `inputTokens`/`outputTokens` accumulated in the closure. Same shape in
  `OpenAIProvider.ts:85-91` and `GeminiProvider.ts:84-90`. `sendText` (lines 368-394) has the identical gap.
- fix: hoist the token counters out of the try in each provider and return them on the error path (attach
  a `usage` field to the thrown `AppError`), then in `LLMService` wrap the `sendMessage` call so both the
  success and failure branches call `usageTracking.record` with whatever tokens were observed, tagging the
  row (`task: opts.task`, plus a new `outcome` column: `ok | error | aborted`). Even recording input tokens
  only, with `output_tokens: 0`, closes the quota-bypass hole.
- verify: unit test — stub a provider that emits `message_start` (input_tokens: 500) then throws; assert a
  `token_usage` row is still written and the rolling-24h count increments.
- cross: @billing-integrity, @security
- effort: M

---

### [P2] Three LLM entry points pass a never-aborting signal, so a stalled provider stream has no deadline
- id: llm-pipeline-006
- location: podcast-saas/backend-api/src/services/podcast/regenerateTurn.ts:48
- category: bug
- confidence: high
- status: confirmed
- what: `abortSignal: new AbortController().signal` — a controller that is created, never referenced again,
  and therefore never aborted. Three call sites do this: `regenerateTurn.ts:48` (creative tier, in the HTTP
  request path), `PodcastMemory.ts:41` (creative tier, on episode approval), and
  `VideoGenerationService.ts:76` (utility tier). None of the three SDK clients is constructed with a
  `timeout` option either (`ClaudeProvider.ts:12`, `OpenAIProvider.ts:12`, `GeminiProvider.ts:12` all pass
  `{apiKey}` only), so the only bound is the SDK default.
- why: a stalled stream on those paths occupies a Fastify handler (or a queue worker slot) for the whole
  SDK default window with nothing the app can do about it. `ScriptRoom` already solved this correctly —
  `ScriptRoom.ts:96-97` builds a real controller per pass and arms a `setTimeout` — and
  `ContentModerationService.ts:60` uses `AbortSignal.timeout(20_000)`. The three sites above are the ones
  that were missed, and two of them are the most expensive tier in the app.
- evidence: `grep -rn "new AbortController().signal" backend-api/src` returns exactly these three
  non-test call sites plus `GuidanceService.ts:456` (which is a legitimate `opts.signal ?? …` fallback).
  Read each call site in full to confirm no `.abort()` is scheduled.
- fix: replace each with `AbortSignal.timeout(N)` — 120_000 for `regenerateTurn` (single short turn),
  600_000 for `writeEpisodeMemory` (creative tier), 60_000 for `enhancePrompt` (utility). Separately, set
  an explicit `timeout` on the three SDK clients so a provider that stops sending bytes mid-stream is torn
  down rather than inherited from the SDK default.
- verify: unit test with a provider stub that never resolves; assert the call rejects with
  `LLMErrorType.ABORTED` within the budget using vitest fake timers.
- cross: @job-queue
- effort: S

---

### [P2] Every Claude call marks a per-call-unique system prompt as an ephemeral cache write, paying the 1.25× premium for a cache that is never read
- id: llm-pipeline-007
- location: podcast-saas/backend-api/src/services/llm/ClaudeProvider.ts:103
- category: perf
- confidence: high
- status: confirmed
- what: `ClaudeProvider` unconditionally attaches `cache_control: {type:'ephemeral'}` to the system block
  (line 98-105). Prompt caching is a **prefix match**, so it only pays when the same prefix recurs. In the
  writers' room the system prompt is where all the volatile content lives: `ScriptRoom` builds each pass's
  system prompt with `fillPrompt(template, {...vars, STORY_JSON: JSON.stringify(story), MATERIALS_JSON:
  …, DRAFT_TURNS: draftTurnsJson, REVIEW_JSON: …})` (`ScriptRoom.ts:141-160, 176-188, 215-221, 261-277`),
  so every pass — and every episode — has a byte-unique prefix.
- why: a cache *write* is billed at 1.25× input; a write that is never read is a pure 25% surcharge on the
  input tokens of essentially every creative- and complex-tier call. The prompts are large (`prompts.ts` is
  43 kB of craft fragments, plus the serialised story/materials/draft), so this is the dominant input cost
  in the app. Second-order: `ClaudeProvider.ts:130-132` reads only `cache_read_input_tokens` and never
  `cache_creation_input_tokens`, and `estimateCostCents` has no write-price term at all
  (`LLMProvider.ts:97`), so the surcharge is also invisible in `token_usage` — the ledger reports the
  1.0× figure for a 1.25× charge.
- evidence: Read `ClaudeProvider.ts:94-114` — `cache_control` is not conditional on anything. Read
  `ScriptRoom.ts:89-122` and the eight `fillPrompt(...)` call sites: `STORY_JSON`, `MATERIALS_JSON`,
  `DRAFT_TURNS`, `REVIEW_JSON` are all interpolated into the **system** string, never the user turn.
  `estimateCostCents` (`LLMProvider.ts:68-99`) takes only `inputTokens`, `outputTokens`,
  `cachedInputTokens` — there is no cache-creation parameter.
- fix: (1) split the system block in two — a stable first block (the craft fragments: `PILLARS`,
  `STORY_ENGINE`, `TRANSITIONS`, `CONVERSATION_PHYSICS`, `HOST_DYNAMICS`) carrying the single
  `cache_control` breakpoint, and a second, uncached block for the per-episode variables; move
  `STORY_JSON`/`MATERIALS_JSON`/`DRAFT_TURNS` into the **user** message where they belong. That turns the
  ~30 kB craft preamble into a real cross-pass, cross-episode cache hit. (2) Read
  `cache_creation_input_tokens` from `message_start`, add it to `TokenUsage`, and price it at 1.25× input
  in `estimateCostCents`.
- verify: add a `cacheCreation` field to the provider's return and assert in a unit test that the stable
  block is byte-identical across two different episodes; in staging, check
  `usage.cache_read_input_tokens > 0` on the second pass of a run.
- cross: @performance, @billing-integrity
- effort: M

---

### [P2] Cost table: Haiku 4.5 is priced at Haiku 3.5's rates, and any unlisted model silently falls back to an invented price
- id: llm-pipeline-008
- location: podcast-saas/backend-api/src/services/llm/LLMProvider.ts:76
- category: data-integrity
- confidence: high
- status: confirmed
- what: `estimateCostCents` prices `claude-haiku-4-5` (and the dated `claude-haiku-4-5-20251001`) at
  `input 0.00008 / output 0.0004` cents-per-token. The file's own comment on line 75 states the conversion:
  cents-per-token = `$/1M ÷ 10,000`. Claude Haiku 4.5 is $1.00 / $5.00 per MTok, i.e. `0.0001 / 0.0005`.
  The stored values correspond to $0.80 / $4.00 — the previous-generation Haiku price. Every Haiku row in
  `token_usage` is therefore **20% under actual**. The Opus 4.7/4.8 ($5/$25 → 0.0005/0.0025), Sonnet
  4.5/4.6 ($3/$15 → 0.0003/0.0015) and Fable 5 ($10/$50 → 0.001/0.005) rows are correct.
- why: Haiku is the utility tier — moderation and prompt-enhance — so it is the highest-volume model in
  the app, and its per-call cost is exactly what the fractional-cents work in migration 046 was added to
  make visible. Separately, line 93's fallback `{input: 0.0001, output: 0.0001, cached: 0.00001}` is
  applied silently to any model not in the table: `gpt-4.1` is in `OpenAIProvider.getAvailableModels()`
  (`OpenAIProvider.ts:21`) but has no pricing row, and `claude-opus-4-6` / `claude-opus-5` /
  `claude-sonnet-5` would hit it too. A wrong price with no log is worse than no price.
- evidence: Prices cross-checked against the `claude-api` skill's Current Models table (Haiku 4.5:
  $1.00 in / $5.00 out; Opus 4.8/4.7: $5/$25; Sonnet 4.6: $3/$15; Fable 5: $10/$50). The internal
  consistency of the table confirms the intended units — the cached column is exactly 0.1× the input
  column for every Claude row, matching Anthropic's cache-read multiplier. `LLMProvider.ts:85-90` has no
  `gpt-4.1` entry while `OpenAIProvider.ts:21` offers it.
- fix: set `claude-haiku-4-5` and `claude-haiku-4-5-20251001` to `{input: 0.0001, output: 0.0005, cached:
  0.00001}`. Add a `gpt-4.1` row. Replace the silent `??` on line 93 with a `logger.warn({model},
  'no pricing entry — using fallback')` so an unpriced model is visible in logs instead of quietly
  producing fiction. Add a unit test that asserts every id returned by each provider's
  `getAvailableModels()` has a pricing row.
- verify: new test iterating `[...claude, ...openai, ...gemini].getAvailableModels()` and asserting
  membership in the pricing map; red before, green after.
- cross: @billing-integrity
- effort: S

---

### [P2] `isAdaptiveOnly()` is a hardcoded three-model allowlist, so the current flagship Claude models cannot be configured without a 400
- id: llm-pipeline-009
- location: podcast-saas/backend-api/src/services/llm/ClaudeProvider.ts:37
- category: maintainability
- confidence: high
- status: confirmed
- what: `isAdaptiveOnly(model)` returns true only for the literals `'claude-opus-4-7'`,
  `'claude-opus-4-8'`, `'claude-fable-5'`, and the same triple is duplicated as `ADAPTIVE_MODELS` in
  `LLMService.ts:40`. Any other model id takes the `else` branch at `ClaudeProvider.ts:76` and is sent
  `temperature`. `getAvailableModels()` (line 20-30) and the admin UI's "Supported" list
  (`admin-web/app/llm-config/page.tsx:141`) both omit `claude-opus-5` and `claude-sonnet-5`.
- why: `temperature`, `top_p`, `top_k` are **rejected with a 400** on Claude Opus 5, Sonnet 5, Opus 4.8,
  Opus 4.7 and Fable 5 (they remain valid on Opus 4.6 / Sonnet 4.6 and older). So an admin who types
  `claude-opus-5` into the free-text `podcast_model` box — the current Opus, a drop-in for Opus 4.8 at
  the same $5/$25 pricing — gets a hard 400 on every writers'-room pass, and the failure mode is a
  provider error with no hint that the model string is the cause. The same applies to `claude-sonnet-5`
  in the generation tier. Because the list is a literal allowlist duplicated in two files, this recurs on
  every model launch.
- evidence: Read `ClaudeProvider.ts:32-77`. The parameter rules were checked against the `claude-api`
  skill's Thinking & Effort table (Claude Opus 5 / Sonnet 5 / Opus 4.8 / 4.7 / Fable 5: sampling params
  "Removed — 400"; Opus 4.6 / Sonnet 4.6: "Allowed"). `grep -n "claude-opus-4-7\|claude-opus-4-8"`
  finds the triple in both `ClaudeProvider.ts:38` and `LLMService.ts:40`.
- fix: invert the predicate to a *legacy* allowlist — `const LEGACY_SAMPLING = new Set(['claude-haiku-4-5',
  'claude-haiku-4-5-20251001','claude-sonnet-4-5','claude-sonnet-4-6','claude-opus-4-6'])` and treat
  everything else as adaptive-only. New models then default to the safe (no-`temperature`) path instead of
  the 400 path. Collapse the duplicate in `LLMService.ts:40` to import the single source of truth, and add
  `claude-opus-5` / `claude-sonnet-5` to `getAvailableModels()` and the admin hint text.
- verify: unit test — `sendMessage({model:'claude-opus-5', temperature:0.7})` must not put `temperature`
  on the wire body (the existing `ClaudeProvider.test.ts` already asserts this shape for other models).
- effort: S

---

### [P2] Admin LLM config accepts any string as a model id and out-of-range sampling/thinking values
- id: llm-pipeline-010
- location: podcast-saas/backend-api/src/controllers/admin/v1/llm-config.controller.ts:21
- category: bug
- confidence: high
- status: confirmed
- what: `LlmConfigSchema` types `utility_model`, `generation_model`, `complex_model` and `podcast_model` as
  bare `z.string().optional()` (lines 21-23, 31), and the admin UI renders them as free-text inputs
  (`admin-web/app/llm-config/page.tsx:106-158`). `temperature` is bounded `0..2` (line 16) and
  `thinking_budget_tokens` only `min(1000)` (line 19).
- why: a typo, a stale id, or a cross-vendor id is accepted and persisted, and the first symptom is a 502
  in a user-facing generation an hour later — the exact class of failure llm-pipeline-001 already produces
  by default. The numeric bounds are also wrong for the provider: Anthropic's `temperature` maximum is
  1.0, so any value in `(1, 2]` is a 400 on the models that still accept the parameter; Anthropic's
  extended-thinking `budget_tokens` minimum is 1024, so the range `[1000, 1023]` that `min(1000)` permits
  is likewise a 400 (and `budget_tokens` is not accepted at all on Opus 4.7+/Fable 5, which the provider
  handles but the schema does not signal).
- evidence: Read the whole schema (lines 14-33) and the `PUT` handler (lines 45-60) — the parsed body is
  written straight to `admin_settings` with no cross-field or provider validation. Parameter limits checked
  against the `claude-api` skill (Thinking & Effort table: `budget_tokens` "must be less than `max_tokens`,
  minimum 1024"; sampling removed on 4.7+).
- fix: replace the four model fields with `z.enum([...ClaudeProvider models, ...OpenAI models,
  ...Gemini models])` built from the providers' `getAvailableModels()` so the list has one source of truth,
  and render them as `<select>` in the admin page. Tighten `temperature` to `.max(1)` and
  `thinking_budget_tokens` to `.min(1024)` with a `.refine(v => v < body.max_tokens)`. Return a
  400 with the offending field name rather than letting the provider surface it later.
- verify: `PUT /api/admin/v1/llm-config {"complex_model":"gemeni-2.5-pro"}` must 400; typecheck stays clean.
- cross: @backend
- effort: S

---

### [P2] `sendText` drops every reasoning control and skips the per-user quota check
- id: llm-pipeline-011
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:368
- category: bug
- confidence: high
- status: confirmed
- what: `sendText` forwards only `maxTokens`, `temperature`, `onTokenChunk` and `abortSignal` to the
  provider (lines 368-377). It never computes `wantThinking`, `thinkingBudgetTokens`, `adaptiveThinking`
  or `effort` — all of which `_sendStructuredOnce` computes at lines 178-193 for the same tiers. It also
  omits the `generation_limit_enabled` rolling-24h check that `_sendStructuredOnce` performs at lines
  137-159; only the pause switch is replicated (lines 353-359).
- why: `GuidanceService.analyzeAndDraft` runs its **pass 1 deep analysis** — the reasoning-heaviest step in
  the simulation-guidance flow, tier `complex` — through `sendText` (`GuidanceService.ts:473`). On an
  adaptive-only model such as `claude-opus-4-8`, omitting the `thinking` field means the model runs
  **without thinking at all**, while the immediately following pass 2 (`sendStructured`, line 489) runs the
  same task with adaptive thinking and `effort: 'high'`. The comment at `LLMService.ts:176-178` says complex
  work should "always think on Claude … independent of the global toggle"; the text path silently doesn't.
  The missing quota check means the expensive analysis pass is not counted against the cap before it runs.
- evidence: Diff `sendText` (342-397) against `_sendStructuredOnce` (116-261) — the tier/thinking/effort
  block (169-193) and the quota block (137-159) have no counterpart. Behaviour of an omitted `thinking`
  field on Opus 4.8/4.7 checked against the `claude-api` skill ("Runs **without** thinking — set
  `{type: "adaptive"}` explicitly").
- fix: extract the tier→(thinking, effort, maxTokens) computation from `_sendStructuredOnce` into a private
  `resolveModelParams(tier, model, settings)` and call it from both paths; likewise extract the quota check
  into `assertWithinQuota(userId, task, settings)` and call it from `sendText`. That removes the drift
  rather than patching one instance of it.
- verify: unit test — `sendText({task:'guidance_plan'})` against a stubbed Claude provider on
  `claude-opus-4-8` must pass `adaptiveThinking: true` and `effort: 'high'`.
- cross: @simulation
- effort: S

---

### [P2] Parse retries have no backoff and re-send the identical request; retry escalation swaps the model mid-task
- id: llm-pipeline-012
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:90
- category: perf
- confidence: high
- status: confirmed
- what: The `sendStructured` retry loop (lines 90-112) re-invokes `_sendStructuredOnce` immediately on
  `PARSING_ERROR`, with no delay, no jitter and no change other than appending a "output ONLY raw JSON"
  sentence to the user prompt (line 196-199). Independently, `resolveProviderAndModel` escalates the tier
  when `retryCount >= complex_min_retries` (line 286-287), so the third attempt of a *generation* task runs
  on `complex_model` — a different model, and under llm-pipeline-001 possibly a different vendor.
- why: (a) three back-to-back full-price calls in a few seconds is the worst pattern against a provider that
  is rate-limiting: it converts a transient 429 window into three billed failures. (b) The escalation makes
  the retry non-comparable to the original attempt — you cannot tell from `token_usage` whether the JSON
  failure was the model's or the schema's, and the model that finally succeeded is not the model the tier
  is configured for. (c) Nothing distinguishes "model emitted prose" (worth a retry with a stronger
  instruction) from "output was truncated" (worth a retry with a larger `max_tokens` — see
  llm-pipeline-004) from "schema is genuinely wrong" (worth zero retries).
- evidence: Read lines 86-114 and 263-305. `attempt` is passed through to `resolveProviderAndModel` as
  `(opts.retryCount ?? 0) + attempt` (line 165), and the escalation branch is at 286. There is no `sleep`
  anywhere in `LLMService.ts` (`grep -n "setTimeout\|sleep" services/llm/LLMService.ts` → no matches).
  `lib/fetchWithRetry.ts` has the right shape (exponential backoff) but is not used by any provider.
- fix: add `await sleep(300 * 2 ** attempt + Math.random() * 200)` before each retry; keep the model fixed
  across parse retries (pass `forceModel: model` from the first attempt) so escalation only applies to
  caller-supplied `retryCount`, not to the JSON-repair loop; and branch the retry strategy on the failure
  reason as described in llm-pipeline-004.
- verify: extend `LLMService.retry.test.ts` with fake timers to assert the delay grows, and assert the
  model passed to attempt 3 equals the model from attempt 1.
- effort: S

---

### [P2] Admin-editable prompts have no length bound, no version history, and stored artefacts cannot be traced to the prompt that produced them
- id: llm-pipeline-013
- location: podcast-saas/backend-api/src/controllers/admin/v1/system-prompts.controller.ts:24
- category: maintainability
- confidence: high
- status: confirmed
- what: `PUT /api/admin/v1/system-prompts/:key` validates only `z.object({ content: z.string().min(1) })`.
  There is no maximum length, no schema/placeholder validation, no history of the previous content, and no
  way to revert to the code fallback (nothing ever sets `is_customized` back to `false`). `token_usage`
  (`db/schema.ts:308-325`) records provider/model/task/tokens but no prompt identity or revision.
- why: (a) an admin can paste an arbitrarily large prompt and it will be sent — and, on Claude, cache-written
  at 1.25× (llm-pipeline-007) — on every subsequent call for that key, with the cost showing up only in the
  aggregate. (b) A customised prompt that drops a `{{PLACEHOLDER}}` the code fills silently changes
  behaviour: `fillPrompt` (`prompts.ts:476-480`) leaves unknown tokens as-is and substitutes `''` for known
  ones, so a missing `{{DRAFT_TURNS}}` in `podcast_v3_compiler` means the compiler pass receives no draft
  and the guard at `ScriptRoom.ts:388` quietly falls back to the raw draft turns. (c) Once a script is
  stored, there is no record of which prompt revision produced it, so a quality regression after a prompt
  edit is not attributable and not revertible.
- evidence: Read the whole controller (43 lines) — the `PUT` handler is the only mutation and it writes
  `content`, `is_customized: true`, `updated_by`, `updated_at`. `db/schema.ts:248-256` shows
  `system_prompts` has no revision column and no history table; `db/schema.ts:308-321` shows `token_usage`
  has no prompt reference. `grep -rn "is_customized" backend-api/src` shows only reads, never a write of
  `false`.
- fix: (1) bound the field: `z.string().min(1).max(60_000)`. (2) Validate that every `{{TOKEN}}` present in
  the code fallback for that key is still present in the submitted content, and 400 with the missing list.
  (3) Add `DELETE /api/admin/v1/system-prompts/:key` that sets `is_customized = false` (revert to code).
  (4) Add a `prompt_revision integer` to `system_prompts`, bump it on each PUT, and add
  `prompt_revision` to `token_usage` and to `podcast_scripts.telemetry` so an artefact names the prompt
  version that produced it.
- verify: PUT a prompt missing `{{DRAFT_TURNS}}` for `podcast_v3_compiler` → 400; PUT a 100 kB body → 400.
- cross: @database, @security
- effort: M

---

### [P2] An aborted Claude stream returns partial content as a success, and the partial is written to storage
- id: llm-pipeline-014
- location: podcast-saas/backend-api/src/services/llm/ClaudeProvider.ts:117
- category: bug
- confidence: high
- status: confirmed
- what: The stream loop begins with `if (opts.abortSignal?.aborted) break;`. Breaking exits the loop
  normally, so the method falls through to the `return` at line 141 and reports a **successful**
  `LLMResponse` containing whatever partial text had arrived — with `stopReason` still `'end_turn'` (the
  initialiser at line 84) unless a `message_delta` happened to arrive first.
- why: the caller cannot distinguish a cancelled generation from a complete one. On the `sendText` path
  this is user-visible: `GuidanceService.analyzeAndDraft` takes `pass1.text` and immediately
  `storage.uploadFile(mdKey, …)` at `GuidanceService.ts:477-480` with no abort check, so a cancelled
  analysis publishes a truncated `understanding.md` at the sim's public URL. On the `sendStructured` path
  it burns a parse-retry cycle before the next call rejects on the already-aborted signal.
- evidence: The provider's own test asserts this behaviour and documents it as intended —
  `__tests__/ClaudeProvider.test.ts:222-224`: *"Aborted streams return partial content, not an error
  (break in loop)"*. Read `ClaudeProvider.ts:116-151` to confirm no post-loop abort check. Read
  `GuidanceService.ts:473-482` to confirm the upload is unconditional.
- fix: after the loop, `if (opts.abortSignal?.aborted) throw new AppError(LLMErrorType.ABORTED, 'Request
  aborted', 499);` — matching the catch-branch behaviour at line 153-155 — and update the test to assert
  the rejection. In `GuidanceService.analyzeAndDraft`, guard the `uploadFile` with `if (signal.aborted)
  return`.
- verify: flip the assertion in `ClaudeProvider.test.ts` to `rejects.toMatchObject({error_type:
  LLMErrorType.ABORTED})`; red before, green after.
- cross: @simulation
- effort: S

---

### [P2] The quota-exemption list misses the automatic utility calls it was written to exempt
- id: llm-pipeline-015
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:46
- category: bug
- confidence: high
- status: confirmed
- what: `QUOTA_EXEMPT_TASKS` lists `content_moderation`, `prompt_enhance`, `video_metadata`,
  `seo_summary`, `image_caption`. Its own comment says the intent is that "cheap automatic background work
  … must not silently erode a user's interactive quota". But the actual task strings written to
  `token_usage` by the direct-SDK paths include several more automatic utility calls that are *not* in the
  list: `avatar_visual_classify`, `avatar_image_classify`, `avatar_image_prompt`, `avatar_memory`,
  `thumbnail_prompt`.
- why: the rolling-24h counter (`LLMService.ts:143-151` and the identical query in
  `systemAi.ts:75-82`) counts rows by `notInArray(task, QUOTA_EXEMPT_TASKS)`. `avatar_visual_classify` is a
  gpt-4.1-mini classification that runs per avatar conversation turn (`services/avatar/visualService.ts:220`,
  `230`), and `thumbnail_prompt` is the prompt-builder call that precedes every AI thumbnail
  (`generateAiThumbnail.ts:130-141`, plus the standalone enhancer at line 78-98). With
  `generation_daily_limit` defaulting to 50, a user who simply *chats with an avatar* burns the whole cap
  on background classification without ever making a deliberate generation — and then sees "You have
  reached the generation limit" on their first real request.
- evidence: `grep -rn "task: '" --exclude-dir=__tests__ backend-api/src | grep -oP "task: '[a-z_]+'" |
  sort | uniq -c` yields the full set of task strings written to the ledger; five of them are automatic
  utility work and absent from `QUOTA_EXEMPT_TASKS`. Read `LLMService.ts:42-52` for the stated intent and
  `systemAi.ts:72-90` for the second consumer of the list.
- fix: add `'avatar_visual_classify'`, `'avatar_image_classify'`, `'avatar_image_prompt'`,
  `'avatar_memory'`, `'thumbnail_prompt'` to `QUOTA_EXEMPT_TASKS`. Better: invert the rule — introduce a
  `BILLABLE_TASKS` allowlist (or a `counts_toward_quota boolean` column on `token_usage` set at write time)
  so a newly added background task defaults to exempt rather than to counted.
- verify: unit test asserting the rolling-24h count query excludes an `avatar_visual_classify` row.
- cross: @billing-integrity
- effort: S

---

### [P2] The compile pass has no turn-count floor, so a summarising compiler ships a mutilated script as `ready`
- id: llm-pipeline-016
- location: podcast-saas/backend-api/src/services/podcast/ScriptRoom.ts:265
- category: data-integrity
- confidence: medium
- status: confirmed
- what: Pass F (`podcast_compile`) is validated only by `CompiledBodySchema`, which requires
  `turns.min(1)`. Pass G (`podcast_delivery`) *is* guarded — line 285 falls back to `compiled` when
  `directed.turns.length < compiled.turns.length`. Pass F has no equivalent check against `draft.turns`,
  and `validate()` only falls back to the draft when `out.length === 0` (line 388).
- why: the compiler's job is a 1:1 transformation ("You do NOT change the content or the story — you
  compile it for the voice engine", `prompts.ts:349`). A model that instead summarises — returning, say,
  6 turns for an 80-turn draft — produces valid JSON that passes the schema, passes `validate()` (6 > 0),
  gets `content_hash`ed, is stored with `status: 'ready'`, and flips the episode to `script_ready`. The
  user's paid deliverable is a fragment, with no error anywhere. The delivery-pass guard shows the team
  already recognised this failure mode one pass later.
- evidence: Read `ScriptRoom.ts:258-302` end to end. Line 285 has the guard for pass G; lines 265-269 have
  none for pass F. `validate()` at 362-409 checks only `out.length === 0`.
- fix: after the compile call, add the same shape of guard:
  `if (compiled.turns.length < draft.turns.length * 0.8) { logger.warn(...); }` and re-run the pass once, or
  fall back to `draft.turns` mapped through the validator. Encode it once as a helper used by both passes.
- verify: unit test on `ScriptRoom.validate` / a stubbed `call()` returning 6 turns for an 80-turn draft;
  assert the run does not reach `status: 'ready'` with the truncated body.
- effort: S

---

### [P2] No golden-output or eval test exists for any prompt that gates a paid deliverable
- id: llm-pipeline-017
- location: podcast-saas/backend-api/src/services/llm/__tests__/contentModeration.test.ts:49
- category: test
- confidence: high
- status: confirmed
- what: The LLM path has five test files (`ClaudeProvider`, `LLMService.retry`, `parseAndRepair`,
  `contentModeration`, `systemAi.gate`) totalling 829 lines, and they cover request shaping, JSON repair
  and retry counting well. What is not covered anywhere: (a) the DB-row branch of prompt loading — the
  moderation test pins `findFirst.mockResolvedValue(undefined)` at line 49, which is exactly the branch
  where llm-pipeline-002 does not live; (b) `resolveProviderAndModel` (no test asserts which
  provider/model a tier resolves to — llm-pipeline-001 would have been caught by one assertion);
  (c) `stopReason` handling other than the happy path; (d) any end-to-end `ScriptRoom` pass against a
  recorded model response.
- why: the writers' room is a paid deliverable produced by nine chained model calls whose only
  correctness gate is a set of deliberately permissive schemas. Three of the P1s in this report
  (001, 002, 003) are single-assertion tests away from being caught in CI, and all three are silent in
  production.
- evidence: `ls services/llm/__tests__ services/podcast/__tests__` and `wc -l` on each (829 + 307 lines).
  `grep -rn "resolveProviderAndModel\|stopReason" backend-api/src/services/llm/__tests__` → no matches.
  `grep -rn "ScriptRoom" backend-api/src/services/podcast/__tests__` → no matches.
- fix: three targeted tests, in priority order. (1) `resolveProviderAndModel` table test: for each
  `(default_provider, tier)` pair assert the returned `provider.providerName` matches the vendor prefix of
  the returned model. (2) A prompt-loader test per loader (`loadPodcastPrompt`,
  `ContentModerationService`, `GuidanceService.loadBasePrompt`) asserting the `is_customized=false` row is
  ignored. (3) A `ScriptRoom` smoke test with a stubbed `LLMService` returning a recorded fixture per
  pass, asserting the job reaches `ready` with `turns.length` within 20% of the draft.
- verify: `pnpm -C podcast-saas --filter backend-api test` — new suites green, existing 128 unaffected.
- cross: @test-quality
- effort: M

---

### [P3] Dead prompt surface: three `system_prompts` rows still hold literal `PLACEHOLDER` text and the seeder named in the migration does not exist
- id: llm-pipeline-018
- location: podcast-saas/backend-api/src/db/migrations/001_initial.sql:194
- category: maintainability
- confidence: high
- status: confirmed
- what: Migration 001 comments *"Contents are loaded from `shared/src/prompts/*.txt` at application startup
  via the SystemPromptSeeder"* and seeds `structural_analysis`, `script_draft`, `script_rewrite` with the
  literal string `'PLACEHOLDER - will be seeded by application startup'`. There is no `SystemPromptSeeder`
  anywhere in the repo, nothing reads `shared/src/prompts/*.txt` (three files, 16 kB), and the three task
  types have `TaskType` entries and `TASK_TIER` entries (`LLMProvider.ts:4-6`, `LLMService.ts:57-59`) but
  **no call site**.
- why: mostly dormant, but it is a live trap in two ways: the placeholder rows are listed and editable in
  the admin System Prompts page as if they were real, and any future code that wires up `script_draft`
  would get a one-line placeholder as its system prompt (these three are also the *only* rows whose
  consumers do not exist, so no `is_customized` guard protects them).
- evidence: `grep -rn "SystemPromptSeeder|seedSystemPrompts" backend-api/src shared/src` → no matches.
  `grep -rn "script-draft|structural-analysis|script-rewrite" backend-api/src` → no matches.
  `grep -rn "'script_draft'|'structural_analysis'|'script_rewrite'" backend-api/src` → only the type union,
  the tier map, and a test fixture.
- fix: pick one. Either delete the three `TaskType`/`TASK_TIER` entries, the three `.txt` files, and add a
  migration that removes the three placeholder rows; or, if the tasks are planned, move the `.txt` contents
  into code fallbacks the way `prompts.ts` does and give them the `is_customized` guard.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` and `--filter shared build` stay clean.
- effort: S

---

### [P3] `PODCAST_PASS_TIMEOUT_MS` is unvalidated, so a malformed value aborts every pass instantly
- id: llm-pipeline-019
- location: podcast-saas/backend-api/src/services/podcast/ScriptRoom.ts:87
- category: bug
- confidence: high
- status: confirmed
- what: `const PASS_TIMEOUT_MS = Number(process.env.PODCAST_PASS_TIMEOUT_MS ?? 10 * 60_000);` — `Number('')`
  is `0` and `Number('10m')` is `NaN`. `setTimeout(fn, 0)` and `setTimeout(fn, NaN)` both fire on the next
  tick, so the controller aborts before the provider stream produces anything.
- why: every writers'-room pass would immediately reject with `ABORTED`, and the job would fail with a
  message that points at the provider rather than at the env var. The variable is not in
  `podcast-saas/.env.example`, so an operator adding it by hand is the likely path in.
- evidence: Read `ScriptRoom.ts:87-112`. `grep -n "PODCAST_PASS_TIMEOUT_MS" podcast-saas/.env.example` →
  no match.
- fix: `const parsed = Number(process.env.PODCAST_PASS_TIMEOUT_MS); const PASS_TIMEOUT_MS =
  Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 10 * 60_000;` and document the variable in
  `.env.example`.
- verify: unit test asserting the fallback for `''`, `'abc'`, `'0'`.
- cross: @config-deploy
- effort: S
