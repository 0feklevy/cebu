/**
 * Tests for moderateGenerationInput in ContentModerationService.ts — the
 * utility-tier content-safety pre-screen. Fail-open by design: only an explicit
 * {"allowed": false} verdict blocks; every other outcome (error, non-JSON,
 * empty input) resolves silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  findFirst: vi.fn(),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
