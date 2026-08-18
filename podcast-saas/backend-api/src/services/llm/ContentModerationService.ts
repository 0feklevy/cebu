// Utility-tier content-safety pre-screen run BEFORE expensive generation
// (podcast scripts on the creative tier, thumbnail/banner image models) — a port
// of fiji's ContentModerationService.
//
// POLICY (llm-pipeline-002). Two different things used to be conflated:
//
//   (a) the screen RAN and returned a verdict → that verdict is obeyed. A
//       rejection blocks with CONTENT_REJECTED(400).
//   (b) the screen could not produce a usable verdict (provider error, timeout,
//       non-JSON, or JSON carrying no verdict field at all) → fail OPEN, but
//       LOUDLY: one warn line carrying the stable marker `moderation_fail_open`
//       so "the screen is broken" is greppable/alertable instead of invisible.
//
// Before the fix, (a) collapsed into (b) for every single request: migrations/
// 001_initial.sql seeds system_prompts('content_moderation') with a prompt that
// asks the model for {"flagged": boolean, ...}, the loader took that row
// unconditionally, and the verdict reader only looked at `allowed`. Since every
// VerdictSchema field is optional, {"flagged": true} parsed cleanly with
// `allowed === undefined`, so `allowed === false` was never true. The screen had
// never blocked anything, and never said so.
//
// Fail-open stays the DEFAULT deliberately: this pre-screen sits in front of
// essentially all generation, and flipping a never-exercised screen to
// fail-closed is its own incident (see also llm-pipeline-001 — the utility tier
// this screen runs on has shipped with a Claude model pointed at the Gemini
// provider, i.e. it errors on a stock install; fail-closed there would block
// 100% of generation platform-wide on first boot). Operators who want
// fail-closed opt in with MODERATION_FAIL_CLOSED=true, and both the switch state
// and every fail-open event are logged.

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { system_prompts } from '../../db/schema.js';
import { LLMService } from './LLMService.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../lib/logger.js';

const MAX_INPUT_CHARS = 8000;

/** Stable log marker — alert on this, not on prose. */
export const MODERATION_FAIL_OPEN_EVENT = 'moderation_fail_open';

// Accepts BOTH verdict contracts. `allowed` is what the current prompt asks for;
// `flagged` is the inverted legacy contract from the 001 seed row, which an admin
// may still be running as a customized prompt. A model that answers either way
// gets its verdict honoured rather than silently discarded.
const VerdictSchema = z.object({
  allowed: z.boolean().optional(),
  flagged: z.boolean().optional(),
  reason: z.string().nullish(),
});
type Verdict = z.infer<typeof VerdictSchema>;

// Module-level singleton — a fresh LLMService per call would defeat the
// key/provider caches and re-hit the DB for every screened request.
const llm = new LLMService(new ApiKeyService(), new UsageTrackingService());

// Admin-customizable via system_prompts key 'content_moderation'.
const DEFAULT_MODERATION_PROMPT = `You are a content-safety pre-screen for an educational content platform. Judge ONLY whether the user-provided text below is acceptable input for AI content generation (podcast scripts, video thumbnails, playlist banners).

Reject (allowed=false) ONLY when the text requests or contains: sexual content involving minors, instructions for serious violence or weapons, hate or harassment targeting people or groups, encouragement of self-harm, or clearly illegal activity.
Everything else is allowed — including edgy, political, medical, religious, or controversial educational topics.

Respond ONLY with JSON: {"allowed": boolean, "reason": string (one short sentence, empty when allowed)}`;

/** true only for an explicit opt-in; anything else (unset, '', 'false', '0') is fail-open. */
function failClosedEnabled(): boolean {
  const raw = (process.env.MODERATION_FAIL_CLOSED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * Collapse the two accepted contracts into one decision.
 * Returns null when the payload carries no verdict at all — which is a BROKEN
 * SCREEN, not an approval.
 */
function readVerdict(v: Verdict): { rejected: boolean; reason: string } | null {
  if (typeof v.allowed === 'boolean') return { rejected: !v.allowed, reason: v.reason ?? '' };
  if (typeof v.flagged === 'boolean') return { rejected: v.flagged, reason: v.reason ?? '' };
  return null;
}

/**
 * Load the screen's system prompt. Matches the convention every other prompt
 * loader in this codebase uses (loadPodcastPrompt, GuidanceService.loadBasePrompt):
 * a DB row wins ONLY when an admin deliberately customized it. The 001 seed row
 * has is_customized=false, so the code prompt — the one whose output contract
 * this file actually reads — is what ships.
 */
async function loadModerationPrompt(): Promise<string> {
  const row = await db.query.system_prompts.findFirst({
    where: eq(system_prompts.key, 'content_moderation'),
  });
  const custom = row?.is_customized ? row.content?.trim() : '';
  return custom || DEFAULT_MODERATION_PROMPT;
}

/**
 * Screen user-supplied generation input. Throws AppError(CONTENT_REJECTED, 400)
 * when the screen rejects; returns silently when allowed or when the input is
 * empty. When the screen itself cannot produce a verdict, fails open (default)
 * or closed (MODERATION_FAIL_CLOSED=true) — loudly either way.
 */
export async function moderateGenerationInput(
  text: string,
  opts: { userId: string | null },
): Promise<void> {
  const input = text.trim();
  if (!input) return;

  /** No usable verdict: one loud line, then the configured direction. */
  const noVerdict = (cause: string, detail?: string): void => {
    const failClosed = failClosedEnabled();
    logger.warn(
      { event: MODERATION_FAIL_OPEN_EVENT, cause, detail, fail_closed: failClosed, userId: opts.userId },
      failClosed
        ? '[moderation] pre-screen produced no verdict — failing CLOSED (MODERATION_FAIL_CLOSED=true)'
        : '[moderation] pre-screen produced no verdict — failing open (content was NOT screened)',
    );
    if (failClosed) {
      throw new AppError(
        LLMErrorType.CONTENT_REJECTED,
        'The content-safety check is unavailable right now. Please try again shortly.',
        400,
        { moderation: true, fail_closed: true, cause },
      );
    }
  };

  let verdict: { rejected: boolean; reason: string } | null = null;
  try {
    const systemPrompt = await loadModerationPrompt();

    const res = await llm.sendText({
      task: 'content_moderation',
      systemPrompt,
      userPrompt: input.slice(0, MAX_INPUT_CHARS),
      userId: opts.userId,
      projectId: null,
      abortSignal: AbortSignal.timeout(20_000),
    });

    const match = res.text.match(/\{[\s\S]*\}/);
    if (!match) {
      noVerdict('non_json_response', res.text.slice(0, 160));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(match[0]);
    } catch {
      noVerdict('unparseable_json', match[0].slice(0, 160));
      return;
    }
    const parsed = VerdictSchema.safeParse(raw);
    verdict = parsed.success ? readVerdict(parsed.data) : null;
    if (!verdict) {
      noVerdict(parsed.success ? 'no_verdict_field' : 'malformed_verdict', match[0].slice(0, 160));
      return;
    }
  } catch (err) {
    // A CONTENT_REJECTED thrown by noVerdict above must not be swallowed here.
    if (err instanceof AppError && err.error_type === LLMErrorType.CONTENT_REJECTED) throw err;
    noVerdict('screen_error', (err as Error).message?.slice(0, 160));
    return;
  }

  if (verdict.rejected) {
    logger.info({ reason: verdict.reason }, '[moderation] generation input rejected');
    throw new AppError(
      LLMErrorType.CONTENT_REJECTED,
      'This request was declined by the content-safety check. Please adjust your text and try again.',
      400,
      { moderation: true, reason: verdict.reason },
    );
  }
}
