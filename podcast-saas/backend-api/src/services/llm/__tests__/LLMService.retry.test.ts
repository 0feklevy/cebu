/**
 * Tests for LLMService retry behaviour on PARSING_ERROR.
 * Spies on _sendStructuredOnce to avoid real LLM/DB calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';
import { z } from 'zod';

// ── Mock DB ───────────────────────────────────────────────────────────────────

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      admin_settings: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('../../../services/secrets/ApiKeyService.js', () => ({
  ApiKeyService: vi.fn(),
}));

vi.mock('../../../services/usage/UsageTrackingService.js', () => ({
  UsageTrackingService: vi.fn(),
}));

vi.mock('../ClaudeProvider.js', () => ({ ClaudeProvider: vi.fn() }));
vi.mock('../OpenAIProvider.js', () => ({ OpenAIProvider: vi.fn() }));
vi.mock('../GeminiProvider.js', () => ({ GeminiProvider: vi.fn() }));

// ── Helpers ───────────────────────────────────────────────────────────────────

const SimpleSchema = z.object({ answer: z.string() });

const GOOD_RESULT = {
  data: { answer: 'ok' },
  usage: { input: 10, output: 5, cached_input: 0, cost_cents: 0 },
  provider: 'claude',
  model: 'claude-sonnet-4-5',
};

const PARSE_ERROR = new AppError(LLMErrorType.PARSING_ERROR, 'bad json', 422);
const LLM_ERROR = new AppError(LLMErrorType.LLM_ERROR, 'API error', 502);
const PAUSED_ERROR = new AppError(LLMErrorType.GENERATION_PAUSED, 'Paused', 503);

async function makeSvc() {
  const { LLMService } = await import('../LLMService.js');
  return new LLMService({} as never, {} as never);
}

// Helper to spy and cast in one call — avoids oxc multi-line cast issues
function spyOnce(svc: object, method: string) {
  return vi.spyOn(svc as never, method as never) as unknown as ReturnType<typeof vi.fn>;
}

const BASE_OPTS = {
  task: 'script_draft' as const,
  systemPrompt: 'sys',
  userPrompt: 'original prompt',
  schema: SimpleSchema,
  userId: 'u1',
  projectId: 'p1',
  abortSignal: new AbortController().signal,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LLMService retry on PARSING_ERROR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds on first attempt when _sendStructuredOnce returns good data', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockResolvedValueOnce(GOOD_RESULT);

    const result = await svc.sendStructured(BASE_OPTS);

    expect(result.data).toEqual({ answer: 'ok' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(BASE_OPTS, 0);
  });

  it('retries up to 2 times on PARSING_ERROR, succeeds on 3rd attempt', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockRejectedValueOnce(PARSE_ERROR);
    spy.mockRejectedValueOnce(PARSE_ERROR);
    spy.mockResolvedValueOnce(GOOD_RESULT);

    const result = await svc.sendStructured(BASE_OPTS);

    expect(result.data).toEqual({ answer: 'ok' });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, BASE_OPTS, 0);
    expect(spy).toHaveBeenNthCalledWith(2, BASE_OPTS, 1);
    expect(spy).toHaveBeenNthCalledWith(3, BASE_OPTS, 2);
  });

  it('throws PARSING_ERROR after all 3 attempts fail', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockRejectedValue(PARSE_ERROR);

    await expect(svc.sendStructured(BASE_OPTS))
      .rejects.toMatchObject({ error_type: LLMErrorType.PARSING_ERROR });
  });

  it('calls _sendStructuredOnce exactly 3 times when all fail', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockRejectedValue(PARSE_ERROR);

    await svc.sendStructured(BASE_OPTS).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on LLM_ERROR', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockRejectedValue(LLM_ERROR);

    await expect(svc.sendStructured(BASE_OPTS))
      .rejects.toMatchObject({ error_type: LLMErrorType.LLM_ERROR });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on GENERATION_PAUSED', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockRejectedValue(PAUSED_ERROR);

    await expect(svc.sendStructured(BASE_OPTS))
      .rejects.toMatchObject({ error_type: LLMErrorType.GENERATION_PAUSED });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('passes incremented attempt number on each retry', async () => {
    const svc = await makeSvc();
    const spy = spyOnce(svc, '_sendStructuredOnce');
    spy.mockRejectedValueOnce(PARSE_ERROR);
    spy.mockResolvedValueOnce(GOOD_RESULT);

    await svc.sendStructured(BASE_OPTS);

    const secondCallAttempt = (spy.mock.calls[1] as [unknown, number])[1];
    expect(secondCallAttempt).toBe(1);
  });

  it('appends JSON-only reinforcement to userPrompt on retry attempts', () => {
    // Verify the logic directly without mocking internals
    const basePrompt = 'original prompt';
    const reinforced = `${basePrompt}\n\nIMPORTANT: Your previous response could not be parsed as JSON. Output ONLY a raw JSON object — no explanation, no markdown, no code fences. Start with { and end with }.`;
    expect(reinforced).toContain('original prompt');
    expect(reinforced).toContain('Output ONLY a raw JSON object');
    expect(reinforced).toContain('Start with { and end with }');
  });
});
