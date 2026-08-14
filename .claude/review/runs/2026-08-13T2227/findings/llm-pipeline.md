# LLM Pipeline — Findings

Reviewer: `llm-pipeline-reviewer`. Commit under review: `ae4b65b` (branch `fix/export-prod-assembly-and-consent-ui`).

**Model-id / pricing note:** every Claude model string pinned in this repo
(`claude-haiku-4-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-5`, `claude-sonnet-4-6`,
`claude-opus-4-7`, `claude-opus-4-8`, `claude-fable-5`) was checked against the `claude-api` skill
and is **currently valid — none are deprecated or retired.** There is therefore no "stale model id"
finding. The pricing *values* attached to them are a different matter — see llm-005 / llm-006.

**Not filed (verified sound):** `ContentModerationService` is invoked on all five user-content
entry points (`podcast-script`, `projects` ×2, `playlists`, `broll`), carries a real
`AbortSignal.timeout(20_000)`, and its fail-open behaviour is deliberate and documented.
`ScriptRoom` arms a real per-pass `AbortController` (`PASS_TIMEOUT_MS`, default 10 min).
`parseAndRepair` and the parse-retry loop have genuine unit coverage.

---

### [P1] Truncated model output is never detected, so it is stored as complete or retried three times at escalating cost
- id: llm-001
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:243
- category: data-integrity
- confidence: high
- status: confirmed
- what: `_sendStructuredOnce` branches on exactly one stop reason — `if (response.stopReason === 'refusal')`. `stop_reason: 'max_tokens'` is captured by both providers (`ClaudeProvider.ts:126`, `OpenAIProvider.ts:62`) and then discarded.
- why: Two distinct failures. (1) **`sendText` returns a truncated string as a successful, complete result.** `GuidanceService.analyzeAndDraft` (GuidanceService.ts:473) stores `pass1.text` straight to `understanding.md` in object storage and feeds it to the plan pass as `previousMessages` — a truncated analysis silently becomes the grounding document for every cue generated afterwards. (2) **`sendStructured` turns truncation into three paid calls for one failure.** Truncated JSON cannot be repaired (`extractObject` slices to the last `}`, leaving an unclosed array, so every repair in the ladder throws), so it surfaces as `PARSING_ERROR`, and the `MAX_PARSE_RETRIES = 2` loop re-runs the *whole* call twice more. Worse, `resolveProviderAndModel` escalates on retry (`retryCount >= settings.complex_min_retries ?? 2` → `complex` tier, default `claude-opus-4-8`), so attempt 3 of a cheap utility/generation task runs on Opus at $5/$25 per MTok — and truncates again, because `max_tokens` never changed. Retrying a `max_tokens` stop is the textbook "same failure at triple cost".
- evidence: Read LLMService.ts:86-114 (retry loop), 240-253 (only `refusal` handled), 285-302 (tier escalation); ClaudeProvider.ts:125-127 (`stopReason` captured from `message_delta`); LLMService.ts:407-460 (`extractObject` uses `lastIndexOf('}')`). `grep -rn "stopReason\|stop_reason" services/llm/` shows no consumer other than the refusal check. No test in `services/llm/__tests__/` exercises a `max_tokens` stop reason.
- fix: In `_sendStructuredOnce`, after the refusal branch, add `if (response.stopReason === 'max_tokens' || response.stopReason === 'length')` and throw a distinct non-`PARSING_ERROR` `AppError` (e.g. `LLM_ERROR` with `{ truncated: true }`) so the parse-retry loop does not consume attempts on it. In `sendText`, return `stopReason` in the result and have `GuidanceService` refuse to persist `understanding.md` when it is `max_tokens`. If a retry is wanted, raise `maxTokens` on the retry rather than escalating the model.
- verify: new unit test — stub a provider returning `{ stopReason: 'max_tokens', content: '{"turns":[' }` and assert `sendStructured` throws once (not three provider calls); `pnpm -C podcast-saas --filter backend-api test` green.
- cross: @test-quality
- effort: M

### [P1] `.catch()` on every schema field makes validation unable to reject a malformed script, so a one-turn "episode" is stored as `ready`
- id: llm-002
- location: podcast-saas/backend-api/src/services/podcast/schemas.ts:170
- category: data-integrity
- confidence: high
- status: confirmed
- what: Every field in `schemas.ts` is wrapped in `.catch(<default>)`. In zod, `.catch()` swallows the validation error and substitutes the default, so the field can never fail. `CompiledBodySchema` — the schema for the **final persisted script body** — therefore enforces only `turns.min(1)` and `text.min(1)`. `speaker: z.enum(['teacher','learner']).catch('learner')` means any unexpected speaker value is silently relabelled rather than rejected.
- why: The `schema.safeParse(obj)` step in `parseAndRepair` (LLMService.ts:435) is the pipeline's only guard against structurally wrong model output, and for the podcast path it is close to a no-op. A compiler pass that returns `{"turns":[{"text":"..."}]}` — one turn instead of ~120 — validates cleanly. `ScriptRoom.validate()` only falls back to the draft when `out.length === 0` (ScriptRoom.ts:388), so one turn is not zero: it passes through, is hashed, written to `podcast_scripts.body_json`, and the episode is flipped to `status: 'script_ready'` with `title` set (ScriptRoom.ts:291-301). The user is shown a finished, approvable episode consisting of a single line. The same applies to the delivery pass, whose `directed.turns.length >= compiled.turns.length` guard (ScriptRoom.ts:285) compares two equally-unvalidated bodies. A wrong-speaker body is worse than a rejected one — it is silently mis-attributed and then rendered to audio with the wrong voice.
- evidence: Read schemas.ts:161-175 (`CompiledBodySchema`, `CompilerTurnSchema`) and 93-106 (`PlaywrightDraftSchema`); ScriptRoom.ts:265-301 (compile → validate → persist → `script_ready`), 388-393 (fallback fires only at zero turns). The `.catch()` intent is documented at schemas.ts:1-9 as deliberate for *intermediate* passes — but `CompiledBodySchema` is the final body, and the file's own comment claims it "reuses the shared strict-ish PodcastScriptBody", which it does not.
- fix: Keep `.catch()` for the intermediate passes (A/B/D) where it is justified, and make the terminal schemas strict: drop `.catch()` from `CompilerTurnSchema.speaker` so a bad speaker rejects, and add a plausibility floor to `CompiledBodySchema` (e.g. `turns: z.array(CompilerTurnSchema).min(8)`). In `ScriptRoom`, additionally reject a compiled body whose turn count is a small fraction of `draft.turns.length` and fall back to the draft instead of persisting it.
- verify: unit test feeding `CompiledBodySchema` a one-turn body and a `speaker: "narrator"` turn — both must fail after the change; `pnpm -C podcast-saas --filter backend-api typecheck` clean.
- cross: @test-quality
- effort: M

### [P1] GeminiProvider never hands the AbortSignal to the SDK, so the default provider cannot be timed out or cancelled
- id: llm-003
- location: podcast-saas/backend-api/src/services/llm/GeminiProvider.ts:44
- category: bug
- confidence: high
- status: confirmed
- what: `this.client.models.generateContentStream({ model, contents, config })` is called with no abort plumbing. `opts.abortSignal` is consulted only *between* yielded chunks (`GeminiProvider.ts:58`), so it can only stop a stream that is already producing output. `ClaudeProvider` and `OpenAIProvider` both pass `{ signal: opts.abortSignal }` to their SDKs; Gemini is the outlier.
- why: `admin_settings.default_provider` defaults to `'gemini'` and `generation_model` to `'gemini-2.0-flash'` (db/schema.ts:270, 276), so this is the provider serving the utility, generation and complex tiers out of the box — `guidance_plan`, `structural_analysis`, `script_draft`, `bridge_plan`. If the request stalls before the first chunk (connection established, no tokens yet), nothing can interrupt it: the caller's signal is never consulted because the `for await` has not yielded, and unlike `@anthropic-ai/sdk` (10-min default request timeout, per the `claude-api` skill) `@google/genai` applies no default deadline. Every deadline the codebase does arm is defeated — `ScriptRoom`'s 10-minute `PASS_TIMEOUT_MS` and any signal `GuidanceService` receives from `SimulationService.ts:3291` both become inert the moment the tier resolves to Gemini. Inside a queue handler that is an indefinitely occupied worker slot indistinguishable from a stuck job.
- evidence: Read GeminiProvider.ts:44-71 (no `signal`/`abortSignal` in the call), vs ClaudeProvider.ts:109-114 and OpenAIProvider.ts:44-54 which both pass it. `@google/genai` version is **1.52.0** and its shipped types declare `abortSignal?: AbortSignal` on the request config (`backend-api/node_modules/@google/genai/dist/vertex_internal/index.d.ts:748`), so the option exists and is simply unused. `grep -rn "abortSignal" services/llm/GeminiProvider.ts` → only the two in-loop `.aborted` checks.
- fix: Pass the signal into the request config: `config: { systemInstruction, maxOutputTokens, temperature, abortSignal: opts.abortSignal, ... }`, and keep the in-loop check as a secondary guard. Confirm against the installed 1.52.0 typings that the field sits on the config object for `generateContentStream` before landing.
- verify: unit test mirroring `ClaudeProvider.test.ts`'s "throws AppError ABORTED when signal fires" — abort before the first chunk and assert the provider rejects rather than hanging.
- cross: @job-queue-reviewer, @test-quality
- effort: S

### [P2] Four LLM call sites pass a controller that is never aborted, so those paths have no deadline at all
- id: llm-004
- location: podcast-saas/backend-api/src/services/podcast/PodcastMemory.ts:41
- category: bug
- confidence: high
- status: confirmed
- what: `abortSignal` is a **required** field on `SendStructuredOpts` (LLMService.ts:26), which makes every call site look as though it carries a deadline. Four satisfy the type with `abortSignal: new AbortController().signal` — a controller nothing retains a reference to, so `abort()` can never be called: `PodcastMemory.ts:41`, `regenerateTurn.ts:48`, `VideoGenerationService.ts:76`, and `GuidanceService.ts:457` (`opts.signal ?? new AbortController().signal`, the default when a caller passes none).
- why: The required-field design is doing the opposite of its job — it converts "this path has no timeout" into something that reads as compliant. `PodcastMemory.writeEpisodeMemory` is the sharpest case: `podcast_memory` is `creative` tier (LLMService.ts:72), so it resolves to `settings.podcast_model` (default `claude-opus-4-8`) at `settings.podcast_effort` (default **`max`**) with `maxTokens` forced to `Math.max(settings.max_tokens, 64000)` (LLMService.ts:193). Per the `claude-api` skill, Opus at `max` effort is explicitly expected to run for many minutes. It is invoked fire-and-forget from two controllers (`podcast-script.controller.ts:293`, `podcast-render.controller.ts:73`), so a stall leaves a detached floating promise holding an expensive request with only the Anthropic SDK's 10-minute default timeout ×3 retries (~30 min) as a backstop. `VideoGenerationService.enhancePrompt` resolves to the default provider (Gemini), where per llm-003 there is no backstop at all.
- evidence: `grep -rn "abortSignal" src/ | grep -v services/llm/` returns 8 sites; 4 are `new AbortController().signal`. Only `ScriptRoom.ts:108` arms a real timer (ScriptRoom.ts:96-97, 110-112). Read PodcastMemory.ts:34-42 and LLMService.ts:169-193 for the creative-tier model/effort/maxTokens resolution.
- fix: Replace each with `AbortSignal.timeout(<ms>)` — the pattern `ContentModerationService.ts:60` already uses correctly. Suggested budgets: 10 min for `podcast_memory`, 90 s for `podcast_turn_regen` and `prompt_enhance` (both interactive), and make `GuidanceService`'s fallback `AbortSignal.timeout(...)` rather than an inert controller.
- verify: `grep -rn "new AbortController().signal" podcast-saas/backend-api/src` returns nothing outside tests.
- effort: S

### [P2] Claude Haiku 4.5 is priced 20% under its real rate, understating the highest-volume tier in the cost ledger
- id: llm-005
- location: podcast-saas/backend-api/src/services/llm/LLMProvider.ts:76
- category: data-integrity
- confidence: high
- status: confirmed
- what: The table encodes `'claude-haiku-4-5': { input: 0.00008, output: 0.0004 }`. The file's own convention (LLMProvider.ts:74, "Cents per token = $/1M tokens ÷ 10,000") makes that **$0.80 / $4.00 per MTok**. The published rate is **$1.00 / $5.00 per MTok** — verified against the `claude-api` skill's current-models table, not from memory. Both input and output are understated by exactly 20%; the `cached` value is internally consistent at 0.1× input, so it inherits the same error.
- why: `claude-haiku-4-5` is the default `utility_model` (db/schema.ts:275) and therefore serves `content_moderation` and `prompt_enhance` — the two highest-call-count tasks, both `QUOTA_EXEMPT_TASKS` (LLMService.ts:46-52) and so uncapped by the generation quota. Every `token_usage.cost_cents` row for the utility tier is 20% low, and admin cost reporting built on that column understates real Anthropic spend by the same margin. The other six Claude entries check out exactly ($3/$15 Sonnet 4.5 and 4.6, $5/$25 Opus 4.7 and 4.8, $10/$50 Fable 5), which makes the Haiku row look like a transcription slip rather than a stale price.
- evidence: Read LLMProvider.ts:68-99. Cross-checked all seven Claude rows against the `claude-api` skill's model/pricing table; only the two Haiku rows (bare alias and `-20251001`) disagree.
- fix: Set both Haiku rows to `{ input: 0.0001, output: 0.0005, cached: 0.00001 }`. Consider a unit test asserting each pricing row against a documented constant so the next model addition can't drift silently.
- verify: unit test — `estimateCostCents('claude-haiku-4-5', 1_000_000, 0, 0)` returns `100` cents ($1.00).
- cross: @billing-integrity
- effort: S

### [P2] `gpt-4.1` is offered but absent from the pricing table, so it bills at a fabricated default that contradicts the repo's own second table
- id: llm-006
- location: podcast-saas/backend-api/src/services/llm/LLMProvider.ts:85
- category: data-integrity
- confidence: high
- status: confirmed
- what: `OpenAIProvider.getAvailableModels()` advertises `['gpt-4o', 'gpt-4o-mini', 'gpt-4.1']` (OpenAIProvider.ts:21) but the `pricing` map in `estimateCostCents` has no `gpt-4.1` row. It falls through to `const p = pricing[model] ?? { input: 0.0001, output: 0.0001, cached: 0.00001 }` (LLMProvider.ts:93) — a made-up flat $1/$1 per MTok. Meanwhile `systemAi.ts`'s `CHAT_PRICING` **does** carry `'gpt-4.1': { input: 0.0002, output: 0.0008 }` = $2/$8 per MTok (systemAi.ts:106). Two tables in the same subsystem give different prices for the same model id.
- why: An admin who selects `gpt-4.1` via `llm-config` (nothing stops them — see llm-008) gets output billed at 1/8th of the rate the repo itself believes elsewhere. The silent-default fallback is the deeper problem: any model id not in the table produces a plausible-looking `cost_cents` rather than an error, so the ledger cannot distinguish "cheap" from "unpriced". Duplicating the price table across two files guarantees this drifts again.
- evidence: Read LLMProvider.ts:75-93 and systemAi.ts:103-110. `grep -n "gpt-4" services/llm/LLMProvider.ts` → only `gpt-4o` and `gpt-4o-mini`.
- fix: Export one shared pricing map (e.g. `services/llm/pricing.ts`) and import it from both `LLMProvider.estimateCostCents` and `systemAi.recordChatUsage`; add the missing `gpt-4.1` row. Replace the silent numeric default with a `logger.warn({ model }, 'unpriced model — cost recorded as 0')` plus an explicit `0`, so an unpriced model is visible in the ledger instead of guessed at.
- verify: unit test asserting the two modules return identical cost for `gpt-4.1`; `pnpm -C podcast-saas --filter backend-api typecheck` clean.
- cross: @billing-integrity
- effort: S

### [P2] `effort` is silently dropped for every non-adaptive Claude model, making the admin `podcast_effort` setting a no-op
- id: llm-007
- location: podcast-saas/backend-api/src/services/llm/ClaudeProvider.ts:62
- category: bug
- confidence: high
- status: confirmed
- what: `modelParams.output_config = { effort }` is set **only** inside the `if (adaptiveOnly)` branch (ClaudeProvider.ts:63-72). `adaptiveOnly` is true for exactly `claude-opus-4-7`, `claude-opus-4-8`, `claude-fable-5` (ClaudeProvider.ts:37-39). For any other Claude model the code falls into the legacy-thinking or temperature branch and `opts.effort` is discarded without a warning.
- why: `LLMService` passes `effort: settings.podcast_effort` for the whole creative tier (LLMService.ts:188-191), and the creative tier uses `settings.podcast_model`, which an admin may set to any string. `claude-sonnet-4-6` is advertised by `getAvailableModels()` and — verified against the `claude-api` skill — **does** support `effort` (`low`/`medium`/`high`/`max`). So an admin who selects Sonnet 4.6 to cut podcast cost silently loses the effort control entirely; the whole writers' room runs at the API default. The admin UI reports success, `admin_settings.podcast_effort` reflects the change, and nothing in the request body does. Note the correct fix is *capability-gated*, not "always send": per the same skill, `effort` **errors** on `claude-sonnet-4-5` and `claude-haiku-4-5`, and `xhigh` (an accepted value in `LlmConfigSchema`) exists only on Opus 4.7+/Fable 5 — Sonnet 4.6 tops out at `max`. Blindly forwarding `effort` would convert a silent no-op into a 400.
- evidence: Read ClaudeProvider.ts:41-77 (the three-way branch) and LLMService.ts:169-193 (effort resolution). Checked per-model `effort` support against the `claude-api` skill's Thinking & Effort table. No test in `ClaudeProvider.test.ts` covers `effort` passthrough.
- fix: Introduce an explicit capability map beside `isAdaptiveOnly` — e.g. `EFFORT_LEVELS: Record<string, EffortLevel[]>` listing what each model accepts — and emit `output_config` whenever the requested level is in the model's list. When the model supports effort but not the requested level, clamp and `logger.warn`; when it supports none, `logger.warn` that the setting is being ignored rather than dropping it silently.
- verify: unit test asserting the request body carries `output_config` for `claude-sonnet-4-6` at `effort: 'high'`, and carries none (with a warn) for `claude-haiku-4-5`.
- effort: M

### [P2] Admin model ids are accepted unvalidated, so a typo disables generation and an unlisted model bills at the fabricated default rate
- id: llm-008
- location: podcast-saas/backend-api/src/controllers/admin/v1/llm-config.controller.ts:20
- category: bug
- confidence: high
- status: confirmed
- what: `LlmConfigSchema` types `utility_model`, `generation_model`, `complex_model` and `podcast_model` as bare `z.string().optional()`. Any string is written straight to `admin_settings`. Note the inconsistency: the neighbouring `podcast_effort` **is** constrained to an enum (llm-config.controller.ts:32), and `default_provider` to three values (line 15) — only the model ids are unchecked.
- why: Two failure modes, both silent at write time. A typo (`claude-opus-4.8` for `claude-opus-4-8`) is accepted with a 200 and then 404s inside every subsequent provider call, taking down generation with an error that surfaces far from its cause. A *valid but unlisted* model is worse: it works, and `estimateCostCents` falls through to the `{ input: 0.0001, output: 0.0001 }` default (LLMProvider.ts:93), so every call is billed at an invented rate (see llm-006). Nothing cross-checks the model against `provider.getAvailableModels()`, which already exists on all three providers for exactly this purpose and is currently called by nothing in the request path.
- evidence: Read llm-config.controller.ts:14-60. `grep -rn "getAvailableModels" src/` shows the method is defined in all three providers and referenced only from `ClaudeProvider.test.ts` — it is dead in production code.
- fix: In the PUT handler, resolve the provider for each supplied model field and reject with 400 when the id is not in that provider's `getAvailableModels()`. Also validate the `podcast_model` × `podcast_effort` pair against the capability map added in llm-007, so an unsupported level is rejected at config time rather than silently dropped at call time.
- verify: `PUT /api/admin/v1/llm-config` with `{"podcast_model":"claude-opus-4.8"}` returns 400; a valid id still returns 200.
- cross: @backend
- effort: S

### [P2] Failed and aborted provider calls record no `token_usage`, so tokens already billed by the vendor are invisible to the ledger and the quota
- id: llm-009
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:223
- category: data-integrity
- confidence: high
- status: confirmed
- what: `usageTracking.record(...)` runs only after `provider.sendMessage()` returns normally. Every provider `catch` block (`ClaudeProvider.ts:152-158`, `OpenAIProvider.ts:85-91`, `GeminiProvider.ts:84-90`) throws away the `inputTokens` / `outputTokens` / `cachedTokens` locals accumulated up to the failure point and rethrows an `AppError` carrying only a message.
- why: These are streaming calls, so a mid-stream failure (network drop, 529 overload after `message_start`, abort) happens *after* the vendor has already generated and billed for the input and the emitted output. Those tokens are charged by Anthropic/OpenAI/Google, appear on the invoice, and never reach `token_usage` — so admin cost reporting under-reports real spend and the rolling-24h quota (which counts `token_usage` rows, LLMService.ts:143-151) under-counts a user who repeatedly triggers failures. The comment at LLMService.ts:220-222 shows the team already reasoned correctly about this for refusals ("a refused call is still billed, so it must be tracked") — the same logic applies to mid-stream errors and was not extended to them.
- evidence: Read LLMService.ts:206-250 (record-then-branch ordering) and all three provider catch blocks. `token_usage` has no `status`/`outcome` column (db/schema.ts) so there is currently no way to represent a partial call.
- fix: Attach the partial counters to the thrown error (e.g. `new AppError(..., { usage: { input, output, cached } })`) and have `_sendStructuredOnce` / `sendText` record them in a `catch` before rethrowing. Add a `token_usage.outcome` column (`ok` | `error` | `aborted`) so partials are distinguishable in cost reports and can be excluded from the quota count if desired.
- verify: unit test — provider throws after emitting two chunks; assert one `token_usage` row is written with `outcome: 'error'` and the accumulated token counts.
- cross: @database, @billing-integrity
- effort: M
- note: requires a migration; coordinate with `database-reviewer` on the ordered list in `db/migrate.ts`.

### [P2] `generateVideoMetadata` calls OpenAI with no timeout and parses the reply with an unguarded `JSON.parse`
- id: llm-010
- location: podcast-saas/backend-api/src/services/generateVideoMetadata.ts:298
- category: bug
- confidence: high
- status: confirmed
- what: `client.chat.completions.create({...})` is called with no second-argument `{ signal }` and no `timeout` override — unlike `OpenAIProvider.sendMessage`, which passes `{ signal: opts.abortSignal }` (OpenAIProvider.ts:53). Twenty lines later, `const parsed = JSON.parse(raw) as { title?; description? }` (line 318) runs with no `try`/`catch`.
- why: This is a post-transcode background path, so a hang occupies a worker slot; the only ceiling is the OpenAI SDK's 10-minute default timeout multiplied by its default 2 retries (~30 min, per the `claude-api` skill's client-config note). The `JSON.parse` is the sharper bug: `response_format: { type: 'json_object' }` guarantees *well-formed* JSON only for a completed response — with `max_tokens: 300` (line 300) a long title/description hits the cap, `finish_reason` comes back `length`, and the truncated fragment throws a raw `SyntaxError` out of the metadata step rather than degrading to the filename fallback the module otherwise implements (`humaniseFilename`, line 344). The `as { title?: string }` cast is also unchecked — the result is trusted straight into `.slice()` calls.
- evidence: Read generateVideoMetadata.ts:296-323. Compare with OpenAIProvider.ts:44-54, which passes the signal. No `try` wraps line 318.
- fix: Pass `{ signal: AbortSignal.timeout(60_000) }` as the second argument to `create()`. Wrap the parse in `try`/`catch` and fall back to `humaniseFilename`, and check `response.choices[0]?.finish_reason === 'length'` before trusting the payload. Validating with a small zod object instead of the `as` cast makes the failure explicit.
- verify: unit test — mock a truncated `json_object` reply and assert the caller falls back to the humanised filename instead of throwing.
- effort: S

### [P2] An aborted Claude stream returns partial content as a successful response
- id: llm-011
- location: podcast-saas/backend-api/src/services/llm/ClaudeProvider.ts:117
- category: bug
- confidence: high
- status: confirmed
- what: The stream loop opens with `for await (const event of stream) { if (opts.abortSignal?.aborted) break; ... }`. `break` exits the loop and falls through to the normal `return { content: chunks.join(''), stopReason, usage }` at line 141 — so an aborted request is reported as a success carrying a truncated body and a `stopReason` still reading `'end_turn'`.
- why: This races the SDK's own AbortError. When the `.aborted` check wins, `ScriptRoom`'s 10-minute pass timeout does not surface as a timeout: `LLMService` records usage for the partial, then `parseAndRepair` fails on the truncated JSON and raises `PARSING_ERROR`, which consumes a parse-retry attempt. That retry then calls the provider with the *already-aborted* signal, which rejects immediately as `ABORTED`. The operator sees "Failed to parse LLM response as valid JSON" or a bare `ABORTED` for what was actually a pass timeout, with one wasted extra call in between. `ClaudeProvider.test.ts` covers "throws AppError ABORTED when signal fires" — i.e. the SDK-wins path — so the branch that returns a partial success is untested.
- evidence: Read ClaudeProvider.ts:116-151 (`break` → normal return) and LLMService.ts:86-114 (parse-retry consumes the attempt). `GeminiProvider.ts:57-71` has the same `break`, though its `catch` at line 85 re-checks `.aborted`.
- fix: Replace `break` with `throw new AppError(LLMErrorType.ABORTED, 'Request aborted', 499)` in both providers so an aborted stream can never be mistaken for a completed one, and add `ABORTED` to the non-retryable set explicitly in `sendStructured`.
- verify: unit test — abort mid-stream after two chunks and assert `sendMessage` rejects with `ABORTED` rather than resolving.
- cross: @test-quality
- effort: S

### [P2] There is no way to reproduce which prompt version produced a stored script, and `system_prompts` has no length bound
- id: llm-012
- location: podcast-saas/backend-api/src/controllers/admin/v1/system-prompts.controller.ts:24
- category: maintainability
- confidence: high
- status: confirmed
- what: The PUT validates only `z.object({ content: z.string().min(1) })` — no maximum length. The row is overwritten in place with `updated_by` / `updated_at`; no prior version is retained. On the consumption side, `ScriptRoom` records `telemetry` per pass with `provider`, `model` and token counts (ScriptRoom.ts:66-73, 113-120) but no prompt identifier, and `podcast_scripts` stores `content_hash` over the *output* only (ScriptRoom.ts:429-432).
- why: When a stored script regresses, there is no way to tell whether the prompt changed between two runs — the only artefact is `updated_at` on a mutable row, and the previous text is gone. That makes prompt changes unrollbackable and A/B comparison impossible on the one artefact users pay for. The missing length bound compounds it: every creative-tier call embeds the prompt in the cached system block (`ClaudeProvider.ts:98-105`), so an oversized paste multiplies input cost across every pass of every episode with nothing rejecting it at write time.
- evidence: Read system-prompts.controller.ts:20-42 (no max, no history table) and ScriptRoom.ts:66-73, 113-120, 291-298 (telemetry carries no prompt identity). `grep -rn "system_prompts" src/db/schema.ts` shows a single mutable row per key with no version column.
- fix: Add `.max(20_000)` (or a bound sized to the longest current prompt) to the `content` schema. Store a `sha256` of each resolved system prompt in the per-pass `telemetry` object — a one-line change in `ScriptRoom.call()` that needs no migration — so a stored script names the exact prompt text that produced it. A `system_prompt_versions` history table is the fuller fix if prompt rollback is wanted.
- verify: PUT with a 100KB body returns 400; a regenerated script's `telemetry[].prompt_sha` changes when the prompt is edited.
- cross: @security
- effort: S

### [P3] The generation cap counts calls rather than cost, so one podcast run consumes the same quota as one moderation screen
- id: llm-013
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:143
- category: perf
- confidence: high
- status: confirmed
- what: The pre-call quota does the right structural thing — it runs **before** the provider call and only on `attempt === 0` — but it is `count(*)` over `token_usage` rows, compared against `generation_daily_limit` (default 50). It is also off by default (`generation_limit_enabled` defaults to `false`, db/schema.ts:267).
- why: Row count is a poor proxy for spend here because per-call cost varies by roughly three orders of magnitude across tiers. A `prompt_enhance` on Haiku and a `podcast_architect` on Opus 4.8 at `effort: 'max'` with `maxTokens: 64000` each consume exactly one unit of quota. A single `ScriptRoom.run()` issues 8–10 creative-tier calls (architect, materials, playwright, three parallel reviews, rewrite, re-audit, optional repair, compile, delivery), so the default limit of 50 permits roughly five full podcast runs — a materially larger bill than "50 generations" suggests. The `cost_cents` column needed to cap on spend is already populated on every row.
- evidence: Read LLMService.ts:132-159 (the `count(*)` query) and ScriptRoom.ts:128-286 (call count per run). db/schema.ts:266-268 for the defaults.
- fix: Change the guard to `sum(cost_cents)` over the same rolling window against a new `generation_daily_cost_cents` setting, keeping the row-count limit as a secondary rate guard. Note the ledger must first be trustworthy — llm-005, llm-006 and llm-009 all bias this sum low.
- verify: unit test — a user with one 500-cent row is refused under a 400-cent cap; a user with 50 one-cent rows is admitted.
- cross: @security, @billing-integrity
- effort: M
