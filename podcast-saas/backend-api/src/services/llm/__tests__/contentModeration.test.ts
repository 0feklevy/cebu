/**
 * Tests for moderateGenerationInput in ContentModerationService.ts — the
 * utility-tier content-safety pre-screen. Fail-open by design: only an explicit
 * {"allowed": false} verdict blocks; every other outcome (error, non-JSON,
 * empty input) resolves silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  findFirst: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../LLMService.js', () => ({
  LLMService: class {
    sendText = mocks.sendText;
  },
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      system_prompts: { findFirst: mocks.findFirst },
    },
  },
}));

vi.mock('../../../db/schema.js', () => ({
  system_prompts: { key: 'key' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));

import { moderateGenerationInput } from '../ContentModerationService.js';

describe('moderateGenerationInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no admin override → the service uses its built-in prompt.
    mocks.findFirst.mockResolvedValue(undefined);
  });

  it('throws CONTENT_REJECTED (400) when the verdict is allowed:false', async () => {
    mocks.sendText.mockResolvedValue({
      text: '{"allowed": false, "reason": "Requests instructions for a weapon"}',
    });

    const err = await moderateGenerationInput('bad text', { userId: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).error_type).toBe(LLMErrorType.CONTENT_REJECTED);
    expect((err as AppError).statusCode).toBe(400);
  });

  it('resolves when the verdict is allowed:true', async () => {
    mocks.sendText.mockResolvedValue({ text: '{"allowed": true, "reason": ""}' });
    await expect(moderateGenerationInput('a fine topic', { userId: 'u1' })).resolves.toBeUndefined();
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
  });

  it('fails open (resolves) when the LLM call throws', async () => {
    mocks.sendText.mockRejectedValue(new Error('provider down'));
    await expect(moderateGenerationInput('some topic', { userId: 'u1' })).resolves.toBeUndefined();
  });

  it('fails open (resolves) when the response is not JSON', async () => {
    mocks.sendText.mockResolvedValue({ text: 'I think this is fine, sure.' });
    await expect(moderateGenerationInput('some topic', { userId: 'u1' })).resolves.toBeUndefined();
  });

  it('resolves without calling the LLM for empty/whitespace input', async () => {
    await expect(moderateGenerationInput('   \n\t ', { userId: 'u1' })).resolves.toBeUndefined();
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});

// ── llm-pipeline-002 — the pre-screen that had never blocked anything ─────────
//
// migrations/001_initial.sql seeds system_prompts('content_moderation') with a
// prompt that asks the model for {"flagged": boolean, "reason": string|null}.
// The loader took that row unconditionally (`row?.content?.trim() || DEFAULT`),
// so the SHIPPED prompt asked for `flagged` while the verdict reader only ever
// looked at `allowed`. Because every VerdictSchema field is `.optional()`,
// {"flagged": true} PARSES FINE and yields `allowed: undefined` — so
// `verdict.allowed === false` was never true and the screen returned "allowed"
// for literally every input, silently, with no log line.
//
// Two independent defects, both fixed here:
//   1. the loader ignored `is_customized`, unlike every other prompt loader in
//      this codebase (loadPodcastPrompt, GuidanceService.loadBasePrompt), so a
//      never-customized 2024 seed row outranked the current code prompt;
//   2. "no usable verdict" was indistinguishable from "verdict: allowed".

const SEEDED_001_PROMPT =
  'You are a content moderation system. Review the provided text and determine if it violates content policies. ' +
  'Check for: hate speech, explicit sexual content, graphic violence, illegal activity instructions, or harmful ' +
  'content targeting minors. Respond with JSON: {"flagged": boolean, "reason": string | null}';

describe('moderateGenerationInput — prompt/verdict contract (llm-pipeline-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MODERATION_FAIL_CLOSED;
  });

  it('does NOT use the seeded 001 row as the system prompt (is_customized is false)', async () => {
    mocks.findFirst.mockResolvedValue({ content: SEEDED_001_PROMPT, is_customized: false });
    mocks.sendText.mockResolvedValue({ text: '{"allowed": true}' });

    await moderateGenerationInput('a fine topic', { userId: 'u1' });

    const sent = mocks.sendText.mock.calls[0][0].systemPrompt as string;
    expect(sent).not.toContain('"flagged"');
    expect(sent).toContain('"allowed"');
  });

  it('DOES use an admin-customized row', async () => {
    mocks.findFirst.mockResolvedValue({ content: 'ADMIN CUSTOM PROMPT', is_customized: true });
    mocks.sendText.mockResolvedValue({ text: '{"allowed": true}' });

    await moderateGenerationInput('a fine topic', { userId: 'u1' });

    expect(mocks.sendText.mock.calls[0][0].systemPrompt).toContain('ADMIN CUSTOM PROMPT');
  });

  it('BLOCKS on a {"flagged": true} verdict (the legacy contract still rejects)', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    mocks.sendText.mockResolvedValue({
      text: '{"flagged": true, "reason": "asks for weapon instructions"}',
    });

    const err = await moderateGenerationInput('bad text', { userId: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).error_type).toBe(LLMErrorType.CONTENT_REJECTED);
    expect((err as AppError).statusCode).toBe(400);
  });

  it('allows a {"flagged": false} verdict', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    mocks.sendText.mockResolvedValue({ text: '{"flagged": false, "reason": null}' });
    await expect(moderateGenerationInput('a fine topic', { userId: 'u1' })).resolves.toBeUndefined();
  });

  it('logs LOUDLY, with a stable marker, when the screen produced no usable verdict', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    // Parses as JSON, but carries neither `allowed` nor `flagged` — the exact
    // shape that used to be silently treated as "allowed".
    mocks.sendText.mockResolvedValue({ text: '{"verdict": "fine"}' });

    await expect(moderateGenerationInput('some topic', { userId: 'u1' })).resolves.toBeUndefined();

    const markers = mocks.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(markers.some((m) => m.includes('moderation_fail_open'))).toBe(true);
  });

  it('logs the fail-open marker when the LLM call itself throws', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    mocks.sendText.mockRejectedValue(new Error('provider down'));

    await expect(moderateGenerationInput('some topic', { userId: 'u1' })).resolves.toBeUndefined();

    const markers = mocks.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(markers.some((m) => m.includes('moderation_fail_open'))).toBe(true);
  });

  it('does NOT log a fail-open marker on a clean allow', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    mocks.sendText.mockResolvedValue({ text: '{"allowed": true, "reason": ""}' });

    await moderateGenerationInput('a fine topic', { userId: 'u1' });

    const markers = mocks.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(markers.some((m) => m.includes('moderation_fail_open'))).toBe(false);
  });
});

describe('moderateGenerationInput — MODERATION_FAIL_CLOSED kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.MODERATION_FAIL_CLOSED;
  });

  it('is OFF by default — a broken screen still fails open', async () => {
    mocks.sendText.mockRejectedValue(new Error('provider down'));
    await expect(moderateGenerationInput('some topic', { userId: 'u1' })).resolves.toBeUndefined();
  });

  it('when ON, a broken screen blocks with CONTENT_REJECTED', async () => {
    process.env.MODERATION_FAIL_CLOSED = 'true';
    mocks.sendText.mockRejectedValue(new Error('provider down'));

    const err = await moderateGenerationInput('some topic', { userId: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).error_type).toBe(LLMErrorType.CONTENT_REJECTED);
    expect((err as AppError).details?.fail_closed).toBe(true);
  });

  it('when ON, empty input is still not screened (no LLM call, no block)', async () => {
    process.env.MODERATION_FAIL_CLOSED = 'true';
    await expect(moderateGenerationInput('   ', { userId: 'u1' })).resolves.toBeUndefined();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });
});
