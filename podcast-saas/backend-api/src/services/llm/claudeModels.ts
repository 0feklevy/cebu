/**
 * Which Claude model ids are "adaptive-only" (llm-pipeline-009).
 *
 * Claude Opus 4.7 and everything after it REMOVED `temperature`/`top_p`/`top_k`
 * and `thinking.budget_tokens`: sending any of them is a hard 400. Older Claude
 * models still accept both. Two hardcoded three-element allowlists used to encode
 * this — `ClaudeProvider.isAdaptiveOnly()` and `LLMService.ADAPTIVE_MODELS` —
 * which had two failure modes: they could drift apart, and any model id newer
 * than the day they were written (claude-opus-5, claude-sonnet-5, …) fell through
 * to the legacy branch and got a `temperature` the API rejects.
 *
 * So the allowlist is inverted. The set below names the models known to ACCEPT
 * the legacy parameters; every other `claude-*` id is treated as adaptive-only.
 * The two mistakes are not symmetric:
 *
 *   sending temperature/budget_tokens to a model that rejects them → 400, the
 *     call fails outright;
 *   omitting them from a model that accepts them → the API applies its own
 *     defaults and the call succeeds.
 *
 * An unknown id therefore defaults to adaptive-only, which is the direction that
 * degrades instead of breaking. Add an id here only when it is verified to accept
 * the legacy parameters.
 */

/** Claude models that still accept `temperature` and `thinking.budget_tokens`. */
const LEGACY_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-0',
]);

/** `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`. */
const DATE_SUFFIX = /-\d{8}$/;

/**
 * True when `model` must be called WITHOUT `temperature` and WITHOUT
 * `thinking.budget_tokens` (adaptive thinking + `output_config.effort` instead).
 * False for non-Claude ids — the other providers have their own parameter rules.
 */
export function isAdaptiveOnlyClaudeModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (!id.startsWith('claude-')) return false;
  const base = id.replace(DATE_SUFFIX, '');
  // The whole Claude 3 family (3, 3.5, 3.7) predates adaptive thinking.
  if (base.startsWith('claude-3')) return false;
  return !LEGACY_CLAUDE_MODELS.has(base);
}
