/**
 * llm-pipeline-006 — a stalled provider stream must have a deadline.
 *
 * Several call sites hand the LLM layer `new AbortController().signal`, a signal
 * that can never fire. With no deadline of its own, the LLM layer then waits on
 * a hung stream forever (the job holds its claim until stale-claim recovery).
 * The backstop belongs in the LLM layer so it covers EVERY caller, not only the
 * ones that remember to build a timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../db/index.js', () => ({ db: { query: { admin_settings: { findFirst: vi.fn() } } } }));
vi.mock('../../../db/schema.js', () => ({
  admin_settings: {}, system_prompts: {}, api_keys: {}, token_usage: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), gte: vi.fn(), notInArray: vi.fn(), sql: vi.fn(),
}));
vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../ClaudeProvider.js', () => ({ ClaudeProvider: class {} }));
vi.mock('../OpenAIProvider.js', () => ({ OpenAIProvider: class {} }));
vi.mock('../GeminiProvider.js', () => ({ GeminiProvider: class {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { linkAbortWithDeadline, LLM_CALL_TIMEOUT_MS } from '../deadline.js';
import { LLMService } from '../LLMService.js';

// SIGNATURE NOTE: the second parameter is an ABSOLUTE deadline (ms since epoch), not a duration.
// It changed so that one budget can be shared across every retry of a logical call — a per-attempt
// duration let `sendStructured` run 45-60 minutes. `Date.now() + n` below reads as "n from now".
describe('linkAbortWithDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts once the deadline elapses even if the caller never aborts', () => {
    const never = new AbortController().signal;
    const { signal } = linkAbortWithDeadline(never, Date.now() + 1000);

    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it('forwards a caller abort immediately', () => {
    const caller = new AbortController();
    const { signal } = linkAbortWithDeadline(caller.signal, Date.now() + 60_000);

    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('is already aborted when the caller aborted before the call started', () => {
    const caller = new AbortController();
    caller.abort();
    const { signal } = linkAbortWithDeadline(caller.signal, Date.now() + 60_000);
    expect(signal.aborted).toBe(true);
  });

  it('tolerates an absent caller signal', () => {
    const { signal, dispose } = linkAbortWithDeadline(undefined, Date.now() + 1000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('dispose() stops the timer so a finished call cannot abort later', () => {
    const { signal, dispose } = linkAbortWithDeadline(new AbortController().signal, Date.now() + 1000);
    dispose();
    vi.advanceTimersByTime(10_000);
    expect(signal.aborted).toBe(false);
  });

  it('dispose() unsubscribes from the caller signal', () => {
    const caller = new AbortController();
    const { signal, dispose } = linkAbortWithDeadline(caller.signal, Date.now() + 1000);
    dispose();
    caller.abort();
    expect(signal.aborted).toBe(false);
  });

  it('ships a non-zero default deadline', () => {
    expect(LLM_CALL_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('LLMService.callProvider applies the deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeSvc() {
    return new LLMService({} as never, { record: vi.fn() } as never);
  }

  const BASE = {
    task: 'script_draft' as const,
    userId: null,
    projectId: null,
  };

  function payload(signal: AbortSignal) {
    return {
      model: 'claude-haiku-4-5',
      systemPrompt: 'sys',
      userPrompt: 'user',
      abortSignal: signal,
    };
  }

  it('hands the provider a signal that fires on the deadline, not the never-aborting caller signal', async () => {
    const never = new AbortController().signal;
    let seen: AbortSignal | undefined;

    const provider = {
      providerName: 'claude',
      sendMessage: vi.fn(async (p: { abortSignal?: AbortSignal }) => {
        seen = p.abortSignal;
        return {
          content: '{}',
          model: 'claude-haiku-4-5',
          stopReason: 'end_turn',
          usage: { input: 1, output: 1, cached_input: 0, cost_cents: 0 },
        };
      }),
    };

    await (makeSvc() as never as {
      callProvider(p: unknown, m: string, o: unknown, pay: unknown): Promise<unknown>;
    }).callProvider(provider, 'claude-haiku-4-5', BASE, payload(never));

    expect(seen).toBeDefined();
    expect(seen).not.toBe(never); // a linked signal, not the caller's dead one
  });

  it('aborts the in-flight provider call once the deadline passes', async () => {
    const never = new AbortController().signal;
    let seen: AbortSignal | undefined;

    const provider = {
      providerName: 'claude',
      sendMessage: vi.fn(
        (p: { abortSignal?: AbortSignal }) =>
          new Promise((resolve) => {
            seen = p.abortSignal;
            p.abortSignal?.addEventListener('abort', () =>
              resolve({
                content: '',
                model: 'claude-haiku-4-5',
                stopReason: 'end_turn',
                usage: { input: 0, output: 0, cached_input: 0, cost_cents: 0 },
              }),
            );
          }),
      ),
    };

    const call = (makeSvc() as never as {
      callProvider(p: unknown, m: string, o: unknown, pay: unknown): Promise<unknown>;
    }).callProvider(provider, 'claude-haiku-4-5', BASE, payload(never));

    // Let sendMessage register its listener before the clock moves.
    await Promise.resolve();
    expect(seen!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(LLM_CALL_TIMEOUT_MS);
    expect(seen!.aborted).toBe(true);
    await call;
  });

  it('clears the deadline once the call returns', async () => {
    const never = new AbortController().signal;
    let seen: AbortSignal | undefined;

    const provider = {
      providerName: 'claude',
      sendMessage: vi.fn(async (p: { abortSignal?: AbortSignal }) => {
        seen = p.abortSignal;
        return {
          content: '{}',
          model: 'claude-haiku-4-5',
          stopReason: 'end_turn',
          usage: { input: 1, output: 1, cached_input: 0, cost_cents: 0 },
        };
      }),
    };

    await (makeSvc() as never as {
      callProvider(p: unknown, m: string, o: unknown, pay: unknown): Promise<unknown>;
    }).callProvider(provider, 'claude-haiku-4-5', BASE, payload(never));

    await vi.advanceTimersByTimeAsync(LLM_CALL_TIMEOUT_MS * 2);
    expect(seen!.aborted).toBe(false);
  });
});
