/**
 * Tests for assertGenerationAllowed in systemAi.ts — the shared pause/limit gate
 * for the direct-SDK aux AI paths. Mirrors how LLMService gates its calls:
 *   - generation_paused → GENERATION_PAUSED (503)
 *   - over the rolling-24h cap → LIMIT_EXCEEDED (429)
 *   - otherwise resolves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  selectWhere: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      admin_settings: { findFirst: mocks.findFirst },
    },
    select: () => ({ from: () => ({ where: mocks.selectWhere }) }),
  },
}));

vi.mock('../../../db/schema.js', () => ({
  token_usage: { user_id: 'user_id', occurred_at: 'occurred_at', task: 'task' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({ type: 'and' })),
  eq: vi.fn(() => ({ type: 'eq' })),
  gte: vi.fn(() => ({ type: 'gte' })),
  notInArray: vi.fn(() => ({ type: 'notInArray' })),
  sql: vi.fn(() => ({ type: 'sql' })),
}));

// Keep the module import cheap — QUOTA_EXEMPT_TASKS is the only thing systemAi
// needs from LLMService, and the SDK clients are never constructed by the gate.
vi.mock('../LLMService.js', () => ({
  QUOTA_EXEMPT_TASKS: ['content_moderation', 'prompt_enhance', 'video_metadata'],
}));
vi.mock('../../secrets/ApiKeyService.js', () => ({
  ApiKeyService: class { invalidateCache() {} getSystemKey() { return null; } },
}));
vi.mock('../../usage/UsageTrackingService.js', () => ({
  UsageTrackingService: class { record() { return Promise.resolve(); } },
}));
vi.mock('openai', () => ({ default: class {} }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { assertGenerationAllowed } from '../systemAi.js';

describe('assertGenerationAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectWhere.mockResolvedValue([{ count: 0 }]);
  });

  it('resolves when there are no admin_settings', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(assertGenerationAllowed('u1')).resolves.toBeUndefined();
  });

  it('throws GENERATION_PAUSED (503) when generation_paused is true', async () => {
    mocks.findFirst.mockResolvedValue({
      generation_paused: true,
      generation_paused_message: 'Down for maintenance',
      generation_limit_enabled: false,
      generation_daily_limit: 100,
    });

    await expect(assertGenerationAllowed('u1')).rejects.toMatchObject({
      error_type: LLMErrorType.GENERATION_PAUSED,
      statusCode: 503,
    });
    // No count query when paused — we short-circuit before the limit check.
    expect(mocks.selectWhere).not.toHaveBeenCalled();
  });

  it('throws LIMIT_EXCEEDED (429) when the user is at/over the daily limit', async () => {
    mocks.findFirst.mockResolvedValue({
      generation_paused: false,
      generation_limit_enabled: true,
      generation_daily_limit: 5,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 5 }]);

    const err = await assertGenerationAllowed('u1').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).error_type).toBe(LLMErrorType.LIMIT_EXCEEDED);
    expect((err as AppError).statusCode).toBe(429);
  });

  it('resolves when the limit is enabled but the user is under the cap', async () => {
    mocks.findFirst.mockResolvedValue({
      generation_paused: false,
      generation_limit_enabled: true,
      generation_daily_limit: 5,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 2 }]);

    await expect(assertGenerationAllowed('u1')).resolves.toBeUndefined();
  });

  it('resolves without a count check when the limit is disabled', async () => {
    mocks.findFirst.mockResolvedValue({
      generation_paused: false,
      generation_limit_enabled: false,
      generation_daily_limit: 5,
    });

    await expect(assertGenerationAllowed('u1')).resolves.toBeUndefined();
    expect(mocks.selectWhere).not.toHaveBeenCalled();
  });

  it('resolves when userId is null even with the limit enabled (no count check)', async () => {
    mocks.findFirst.mockResolvedValue({
      generation_paused: false,
      generation_limit_enabled: true,
      generation_daily_limit: 1,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 999 }]);

    await expect(assertGenerationAllowed(null)).resolves.toBeUndefined();
    expect(mocks.selectWhere).not.toHaveBeenCalled();
  });
});
